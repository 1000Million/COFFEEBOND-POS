'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const DEFAULT_GEMINI_INVOICE_MODEL = 'gemini-3.5-flash';
const ALLOWED_GEMINI_INVOICE_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
]);
const FALLBACK_GEMINI_INVOICE_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_INVOICE_MODEL = defineString('GEMINI_INVOICE_MODEL', { default: DEFAULT_GEMINI_INVOICE_MODEL });
const INVOICE_STORAGE_BUCKET = defineString('INVOICE_STORAGE_BUCKET', { default: 'coffee-bond-pos.firebasestorage.app' });
const RETRYABLE_GEMINI_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const PRIMARY_GEMINI_MAX_RETRIES = 3;
const PRIMARY_GEMINI_RETRY_DELAYS_MS = [1500, 3000, 6000];

const MAX_INVOICE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_INVOICE_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);
const REGION = 'us-central1';
const FAILURE_STAGES = {
  AUTHORIZE: 'AUTHORIZE',
  DOWNLOAD_FILE: 'DOWNLOAD_FILE',
  GEMINI_REQUEST: 'GEMINI_REQUEST',
  GEMINI_RESPONSE: 'GEMINI_RESPONSE',
  JSON_PARSE: 'JSON_PARSE',
  SCHEMA_VALIDATION: 'SCHEMA_VALIDATION',
  ITEM_MATCHING: 'ITEM_MATCHING',
  SAVE_DRAFT: 'SAVE_DRAFT',
};
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    supplierName: { type: 'string' },
    invoiceNumber: { type: 'string' },
    invoiceDate: { type: 'string' },
    gstin: { type: 'string' },
    storeLocation: { type: 'string' },
    currency: { type: 'string' },
    totals: {
      type: 'object',
      properties: {
        subtotal: { type: 'number' },
        discount: { type: 'number' },
        taxableAmount: { type: 'number' },
        cgst: { type: 'number' },
        sgst: { type: 'number' },
        igst: { type: 'number' },
        otherCharges: { type: 'number' },
        grandTotal: { type: 'number' },
      },
    },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          supplierItemDescription: { type: 'string' },
          quantity: { type: 'number' },
          purchaseUnit: { type: 'string' },
          packContents: { type: 'number' },
          contentsUnit: { type: 'string' },
          rate: { type: 'number' },
          priceBasis: { type: 'string' },
          discount: { type: 'number' },
          taxPercentage: { type: 'number' },
          taxAmount: { type: 'number' },
          lineTotal: { type: 'number' },
          hsnSac: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function sanitizeErrorMessage(value, maxLength = 300) {
  return cleanText(value, maxLength)
    .replace(/key=([^&\s]+)/gi, 'key=[REDACTED]')
    .replace(/GEMINI_API_KEY\s*[:=]\s*[^,\s]+/gi, 'GEMINI_API_KEY=[REDACTED]');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

class InvoiceDraftError extends Error {
  constructor(stage, code, message, details = {}) {
    super(sanitizeErrorMessage(message || 'Invoice parsing failed.'));
    this.name = 'InvoiceDraftError';
    this.stage = stage;
    this.code = code || 'INVOICE_DRAFT_ERROR';
    this.httpStatus = details.httpStatus || null;
    this.model = details.model || '';
    this.responsePreview = details.responsePreview || '';
    this.causeName = details.causeName || '';
    this.parseMetadata = details.parseMetadata || null;
  }
}

function asInvoiceDraftError(error, fallbackStage, fallbackCode = 'INVOICE_DRAFT_ERROR') {
  if (error instanceof InvoiceDraftError) return error;
  return new InvoiceDraftError(
    fallbackStage,
    error?.code || fallbackCode,
    error?.message || String(error || 'Invoice parsing failed.'),
    { causeName: error?.name || '' },
  );
}

function draftFailureDetails(error) {
  const normalized = asInvoiceDraftError(error, FAILURE_STAGES.GEMINI_REQUEST);
  return {
    failureStage: normalized.stage,
    failureCode: cleanText(normalized.code, 80),
    failureMessage: sanitizeErrorMessage(normalized.message, 300),
  };
}

function logInvoiceDraftFailure(context) {
  const {
    draftId,
    storeId,
    stage,
    error,
    model,
    bucket,
    fileMimeType,
  } = context;
  const normalized = asInvoiceDraftError(error, stage);
  console.error('invoice-draft-parse-failed', {
    draftId: cleanText(draftId, 120),
    storeId: cleanText(storeId, 80),
    stage: normalized.stage || stage,
    errorName: normalized.causeName || normalized.name || error?.name || 'Error',
    errorCode: cleanText(normalized.code || error?.code || 'INVOICE_DRAFT_ERROR', 80),
    message: sanitizeErrorMessage(normalized.message || error?.message || 'Invoice parsing failed.', 300),
    httpStatus: normalized.httpStatus || null,
    model: cleanText(normalized.model || model || '', 120),
    bucket: cleanText(bucket || '', 160),
    fileMimeType: cleanText(fileMimeType || '', 120),
    responsePreview: sanitizeErrorMessage(normalized.responsePreview || '', 300),
  });
}

function normalizeLookup(value) {
  return cleanText(value, 200)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function validateInvoiceFileInput(data) {
  const storeId = cleanText(data.storeId, 80);
  const draftId = cleanText(data.draftId, 120);
  const sourceFilePath = cleanText(data.sourceFilePath, 400);
  const sourceFileName = cleanText(data.sourceFileName, 180);
  const mimeType = cleanText(data.mimeType, 120).toLowerCase();
  const sizeBytes = toNumber(data.sizeBytes);

  if (!storeId) fail('invalid-argument', 'Store is required.');
  if (!draftId || !/^[A-Za-z0-9_-]{8,}$/.test(draftId)) fail('invalid-argument', 'Draft ID is invalid.');
  if (!sourceFileName) fail('invalid-argument', 'File name is required.');
  if (!sourceFilePath || sourceFilePath.includes('..') || sourceFilePath.startsWith('/')) {
    fail('invalid-argument', 'Invoice file path is invalid.');
  }
  if (sourceFilePath !== `purchase-invoices/${storeId}/${draftId}/${sourceFileName}`) {
    fail('invalid-argument', 'Invoice file path does not match the selected store and draft.');
  }
  if (!ALLOWED_INVOICE_MIME_TYPES.has(mimeType)) fail('invalid-argument', 'Unsupported invoice file type.');
  if (sizeBytes <= 0 || sizeBytes > MAX_INVOICE_FILE_SIZE_BYTES) fail('invalid-argument', 'Invoice file must be 10 MB or smaller.');

  return { storeId, draftId, sourceFilePath, sourceFileName, mimeType, sizeBytes };
}

function userCanParseForStore(profile, storeId) {
  if (!profile || profile.isActive !== true) return false;
  if (profile.role === 'ADMIN') return true;
  if (profile.role !== 'STORE_MANAGER') return false;
  const storeIds = Array.isArray(profile.storeIds) && profile.storeIds.length
    ? profile.storeIds
    : (Array.isArray(profile.assignedStoreIds) ? profile.assignedStoreIds : []);
  return storeIds.includes(storeId);
}

function sanitizeExtractedInvoice(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const totals = source.totals && typeof source.totals === 'object' ? source.totals : {};
  const lines = Array.isArray(source.lines) ? source.lines : [];

  return {
    supplierName: cleanText(source.supplierName, 160),
    invoiceNumber: cleanText(source.invoiceNumber, 80),
    invoiceDate: cleanText(source.invoiceDate, 40),
    gstin: cleanText(source.gstin, 30),
    storeLocation: cleanText(source.storeLocation, 160),
    currency: cleanText(source.currency || 'INR', 12) || 'INR',
    extractedTotals: {
      subtotal: toNumber(totals.subtotal),
      discount: toNumber(totals.discount),
      taxableAmount: toNumber(totals.taxableAmount),
      cgst: toNumber(totals.cgst),
      sgst: toNumber(totals.sgst),
      igst: toNumber(totals.igst),
      otherCharges: toNumber(totals.otherCharges),
      grandTotal: toNumber(totals.grandTotal),
    },
    lines: lines.slice(0, 80).map((line) => ({
      supplierItemDescription: cleanText(line.supplierItemDescription || line.description || line.itemName, 200),
      quantity: toNumber(line.quantity),
      purchaseUnit: cleanText(line.purchaseUnit || line.unit, 24).toUpperCase(),
      packContents: toNumber(line.packContents || line.packSize),
      contentsUnit: cleanText(line.contentsUnit || line.packContentsUnit, 24).toUpperCase(),
      rate: toNumber(line.rate),
      priceBasis: cleanText(line.priceBasis || 'RATE_PER_PURCHASE_UNIT', 40),
      discount: toNumber(line.discount),
      taxPercentage: toNumber(line.taxPercentage || line.taxRate),
      taxAmount: toNumber(line.taxAmount),
      lineTotal: toNumber(line.lineTotal || line.totalAmount),
      hsnSac: cleanText(line.hsnSac || line.hsn || line.sac, 40),
    })).filter((line) => line.supplierItemDescription || line.quantity > 0 || line.lineTotal > 0),
    extractionConfidence: Math.max(0, Math.min(1, toNumber(source.confidence || source.extractionConfidence))),
    warnings: Array.isArray(source.warnings) ? source.warnings.map((warning) => cleanText(warning, 240)).filter(Boolean) : [],
  };
}

function tokenScore(left, right) {
  const leftTokens = new Set(normalizeLookup(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeLookup(right).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function buildItemCatalog(rawIngredients, prepItems, aliases = []) {
  const records = [
    ...rawIngredients.map((item) => ({
      itemType: 'RAW_INGREDIENT',
      itemCode: item.code || item.id,
      itemName: item.name || item.code || item.id,
      normalizedName: normalizeLookup(item.name || item.code || item.id),
      normalizedCode: normalizeLookup(item.code || item.id),
    })),
    ...prepItems.map((item) => ({
      itemType: 'PREP_ITEM',
      itemCode: item.code || item.id,
      itemName: item.name || item.code || item.id,
      normalizedName: normalizeLookup(item.name || item.code || item.id),
      normalizedCode: normalizeLookup(item.code || item.id),
    })),
  ];
  const aliasRecords = aliases.map((alias) => ({
    alias: normalizeLookup(alias.supplierDescription || alias.description || alias.alias),
    itemType: alias.itemType,
    itemCode: alias.itemCode,
  })).filter((alias) => alias.alias && alias.itemType && alias.itemCode);
  return { records, aliasRecords };
}

function matchExtractedLine(line, catalog) {
  const normalized = normalizeLookup(line.supplierItemDescription);
  if (!normalized) {
    return {
      status: 'UNRESOLVED',
      confidence: 0,
      suggestedItem: null,
      matchReason: 'No supplier description extracted.',
    };
  }

  const exactCode = catalog.records.find((record) => record.normalizedCode === normalized);
  if (exactCode) {
    return {
      status: 'CONFIRMED',
      confidence: 1,
      suggestedItem: exactCode,
      matchReason: 'Exact item code match.',
    };
  }

  const exactName = catalog.records.find((record) => record.normalizedName === normalized);
  if (exactName) {
    return {
      status: 'CONFIRMED',
      confidence: 0.98,
      suggestedItem: exactName,
      matchReason: 'Exact normalized item name match.',
    };
  }

  const alias = catalog.aliasRecords.find((record) => record.alias === normalized);
  if (alias) {
    const target = catalog.records.find((record) => record.itemType === alias.itemType && record.itemCode === alias.itemCode);
    if (target) {
      return {
        status: 'CONFIRMED',
        confidence: 0.95,
        suggestedItem: target,
        matchReason: 'Saved supplier item alias match.',
      };
    }
  }

  const scored = catalog.records
    .map((record) => ({ record, score: Math.max(tokenScore(normalized, record.normalizedName), tokenScore(normalized, record.normalizedCode)) }))
    .sort((a, b) => b.score - a.score)[0];

  if (scored && scored.score >= 0.82) {
    return {
      status: 'NEEDS_CONFIRMATION',
      confidence: Math.round(scored.score * 100) / 100,
      suggestedItem: scored.record,
      matchReason: 'High-confidence fuzzy match; human confirmation required.',
    };
  }

  return {
    status: 'UNRESOLVED',
    confidence: scored ? Math.round(scored.score * 100) / 100 : 0,
    suggestedItem: scored?.record || null,
    matchReason: 'No reliable match found.',
  };
}

function enrichLinesWithMatches(lines, catalog) {
  return lines.map((line, index) => {
    const match = matchExtractedLine(line, catalog);
    return {
      lineIndex: index,
      ...line,
      suggestedItem: match.suggestedItem ? {
        itemType: match.suggestedItem.itemType,
        itemCode: match.suggestedItem.itemCode,
        itemName: match.suggestedItem.itemName,
      } : null,
      matchConfidence: match.confidence,
      matchStatus: match.status,
      matchReason: match.matchReason,
    };
  });
}

function readGeminiApiKey(secretParam = GEMINI_API_KEY) {
  let apiKey = '';
  try {
    apiKey = cleanText(secretParam.value(), 512);
  } catch (error) {
    throw new InvoiceDraftError(
      FAILURE_STAGES.GEMINI_REQUEST,
      'GEMINI_SECRET_UNAVAILABLE',
      'Gemini API key secret is unavailable. Configure GEMINI_API_KEY before parsing invoices.',
    );
  }
  if (!apiKey) {
    throw new InvoiceDraftError(
      FAILURE_STAGES.GEMINI_REQUEST,
      'GEMINI_SECRET_UNAVAILABLE',
      'Gemini API key secret is unavailable. Configure GEMINI_API_KEY before parsing invoices.',
    );
  }
  return apiKey;
}

function readGeminiModel(modelParam = GEMINI_INVOICE_MODEL) {
  try {
    const model = cleanText(modelParam.value(), 120);
    return normalizeGeminiModel(model);
  } catch (error) {
    return DEFAULT_GEMINI_INVOICE_MODEL;
  }
}

function normalizeGeminiModel(model) {
  const normalized = cleanText(model, 120);
  return ALLOWED_GEMINI_INVOICE_MODELS.has(normalized) ? normalized : DEFAULT_GEMINI_INVOICE_MODEL;
}

function readInvoiceStorageBucket(bucketParam = INVOICE_STORAGE_BUCKET) {
  try {
    return cleanText(bucketParam.value(), 160) || 'coffee-bond-pos.firebasestorage.app';
  } catch (error) {
    return 'coffee-bond-pos.firebasestorage.app';
  }
}

function validateParsedInvoicePayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvoiceDraftError(FAILURE_STAGES.SCHEMA_VALIDATION, 'INVALID_SCHEMA', 'Invoice parser returned malformed JSON.');
  }
  if (parsed.totals !== undefined && (!parsed.totals || typeof parsed.totals !== 'object' || Array.isArray(parsed.totals))) {
    throw new InvoiceDraftError(FAILURE_STAGES.SCHEMA_VALIDATION, 'INVALID_TOTALS', 'Invoice parser returned invalid totals.');
  }
  if (parsed.lines !== undefined && !Array.isArray(parsed.lines)) {
    throw new InvoiceDraftError(FAILURE_STAGES.SCHEMA_VALIDATION, 'INVALID_LINES', 'Invoice parser returned invalid line items.');
  }
  if (Array.isArray(parsed.lines) && parsed.lines.some((line) => !line || typeof line !== 'object' || Array.isArray(line))) {
    throw new InvoiceDraftError(FAILURE_STAGES.SCHEMA_VALIDATION, 'MALFORMED_LINES', 'Invoice parser returned malformed line items.');
  }
  return parsed;
}

function parseGoogleErrorResponse(responseText) {
  try {
    const parsed = JSON.parse(responseText || '{}');
    const error = parsed.error || {};
    return {
      code: cleanText(error.status || error.code || 'GEMINI_HTTP_ERROR', 80),
      message: sanitizeErrorMessage(error.message || 'Gemini invoice parser request failed.', 300),
    };
  } catch (error) {
    return {
      code: 'GEMINI_HTTP_ERROR',
      message: 'Gemini invoice parser request failed.',
    };
  }
}

function isRetryableGeminiError(error) {
  const normalized = asInvoiceDraftError(error, FAILURE_STAGES.GEMINI_RESPONSE);
  return normalized.stage === FAILURE_STAGES.GEMINI_RESPONSE
    && RETRYABLE_GEMINI_HTTP_STATUSES.has(Number(normalized.httpStatus));
}

function cloneParseMetadata(metadata) {
  return {
    primaryModel: metadata.primaryModel,
    finalModel: metadata.finalModel,
    retryCount: metadata.retryCount,
    fallbackUsed: metadata.fallbackUsed,
    attemptedModels: metadata.attemptedModels.map((attempt) => ({ ...attempt })),
    lastRetryableStatus: metadata.lastRetryableStatus,
  };
}

function withParseMetadata(error, metadata) {
  const normalized = asInvoiceDraftError(error, FAILURE_STAGES.GEMINI_RESPONSE);
  normalized.parseMetadata = cloneParseMetadata(metadata);
  return normalized;
}

function retryDelayWithJitter(baseDelayMs, jitterImpl = Math.random) {
  const jitter = Math.round((Number(jitterImpl()) - 0.5) * 0.2 * baseDelayMs);
  return Math.max(0, baseDelayMs + jitter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logGeminiRetry(context) {
  console.error('invoice-draft-gemini-retry', {
    draftId: cleanText(context.draftId, 120),
    model: cleanText(context.model, 120),
    attempt: Number(context.attempt) || 0,
    httpStatus: Number(context.httpStatus) || null,
    delayMs: Number(context.delayMs) || 0,
    fallbackUsed: Boolean(context.fallbackUsed),
  });
}

function logGeminiFallback(context) {
  console.error('invoice-draft-model-fallback', {
    draftId: cleanText(context.draftId, 120),
    model: cleanText(context.model, 120),
    attempt: Number(context.attempt) || 0,
    httpStatus: Number(context.httpStatus) || null,
    delayMs: 0,
    fallbackUsed: true,
  });
}

async function callGeminiParser(fileBuffer, mimeType, options = {}) {
  const apiKey = readGeminiApiKey(options.apiKeyParam || GEMINI_API_KEY);
  const model = options.modelOverride
    ? normalizeGeminiModel(options.modelOverride)
    : readGeminiModel(options.modelParam || GEMINI_INVOICE_MODEL);
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            {
              text: [
                'Extract this supplier invoice for Coffee Bond POS.',
                'Return only JSON matching the provided schema.',
                'Use RATE_PER_PURCHASE_UNIT, RATE_PER_CONTENTS_UNIT, or RATE_PER_STOCK_UNIT for priceBasis when clear.',
                'If a value is uncertain, leave it blank/zero and add a warning.',
              ].join('\n'),
            },
            {
              inlineData: {
                mimeType,
                data: fileBuffer.toString('base64'),
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_SCHEMA,
        },
      }),
    });
  } catch (error) {
    throw new InvoiceDraftError(
      FAILURE_STAGES.GEMINI_REQUEST,
      error?.code || 'GEMINI_REQUEST_FAILED',
      error?.message || 'Gemini invoice parser request failed.',
      { model, causeName: error?.name || '' },
    );
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    const googleError = parseGoogleErrorResponse(responseText);
    throw new InvoiceDraftError(
      FAILURE_STAGES.GEMINI_RESPONSE,
      googleError.code,
      googleError.message,
      {
        httpStatus: response.status,
        model,
        responsePreview: sanitizeErrorMessage(responseText, 300),
      },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new InvoiceDraftError(
      FAILURE_STAGES.GEMINI_RESPONSE,
      'GEMINI_RESPONSE_JSON_INVALID',
      'Gemini invoice parser returned an unreadable response.',
      { model, causeName: error?.name || '' },
    );
  }
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new InvoiceDraftError(
      FAILURE_STAGES.GEMINI_RESPONSE,
      'GEMINI_EMPTY_STRUCTURED_RESPONSE',
      'Invoice parser returned no structured JSON.',
      { model },
    );
  }
  let parsedJson;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new InvoiceDraftError(
      FAILURE_STAGES.JSON_PARSE,
      'PARSED_JSON_INVALID',
      'Invoice parser returned invalid JSON.',
      { model, causeName: error?.name || '' },
    );
  }
  try {
    return { parsed: validateParsedInvoicePayload(parsedJson), warning: '' };
  } catch (error) {
    throw asInvoiceDraftError(error, FAILURE_STAGES.SCHEMA_VALIDATION, 'INVALID_SCHEMA');
  }
}

async function persistParsingMetadata(updateDraft, metadata) {
  if (typeof updateDraft !== 'function') return;
  await updateDraft({
    parsingStatus: 'PARSING',
    ...cloneParseMetadata(metadata),
  });
}

async function parseInvoiceWithGeminiResilience(fileBuffer, mimeType, options = {}) {
  const primaryModel = normalizeGeminiModel(options.primaryModel || readGeminiModel(options.modelParam || GEMINI_INVOICE_MODEL));
  const fallbackModel = FALLBACK_GEMINI_INVOICE_MODEL;
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const jitterImpl = options.jitterImpl || Math.random;
  const metadata = {
    primaryModel,
    finalModel: primaryModel,
    retryCount: 0,
    fallbackUsed: false,
    attemptedModels: [],
    lastRetryableStatus: null,
  };

  await persistParsingMetadata(options.updateDraft, metadata);

  let lastRetryableError = null;
  const maxPrimaryAttempts = PRIMARY_GEMINI_MAX_RETRIES + 1;
  for (let attempt = 1; attempt <= maxPrimaryAttempts; attempt += 1) {
    try {
      const result = await callGeminiParser(fileBuffer, mimeType, {
        ...options,
        fetchImpl,
        modelOverride: primaryModel,
      });
      metadata.finalModel = primaryModel;
      metadata.attemptedModels.push({
        model: primaryModel,
        attempt,
        result: 'SUCCESS',
        httpStatus: null,
      });
      return { ...result, parseMetadata: cloneParseMetadata(metadata) };
    } catch (error) {
      const normalized = asInvoiceDraftError(error, FAILURE_STAGES.GEMINI_RESPONSE);
      metadata.attemptedModels.push({
        model: primaryModel,
        attempt,
        result: 'ERROR',
        httpStatus: normalized.httpStatus || null,
        code: cleanText(normalized.code, 80),
      });

      if (!isRetryableGeminiError(normalized)) {
        throw withParseMetadata(normalized, metadata);
      }

      lastRetryableError = normalized;
      metadata.lastRetryableStatus = normalized.httpStatus;

      if (attempt > PRIMARY_GEMINI_MAX_RETRIES) {
        break;
      }

      metadata.retryCount += 1;
      const delayMs = retryDelayWithJitter(
        PRIMARY_GEMINI_RETRY_DELAYS_MS[metadata.retryCount - 1] || PRIMARY_GEMINI_RETRY_DELAYS_MS[PRIMARY_GEMINI_RETRY_DELAYS_MS.length - 1],
        jitterImpl,
      );
      logGeminiRetry({
        draftId: options.draftId,
        model: primaryModel,
        attempt,
        httpStatus: normalized.httpStatus,
        delayMs,
        fallbackUsed: false,
      });
      await persistParsingMetadata(options.updateDraft, metadata);
      await sleepImpl(delayMs);
    }
  }

  metadata.fallbackUsed = true;
  metadata.finalModel = fallbackModel;
  logGeminiFallback({
    draftId: options.draftId,
    model: fallbackModel,
    attempt: 1,
    httpStatus: lastRetryableError?.httpStatus || null,
  });
  await persistParsingMetadata(options.updateDraft, metadata);

  try {
    const result = await callGeminiParser(fileBuffer, mimeType, {
      ...options,
      fetchImpl,
      modelOverride: fallbackModel,
    });
    metadata.attemptedModels.push({
      model: fallbackModel,
      attempt: 1,
      result: 'SUCCESS',
      httpStatus: null,
    });
    metadata.finalModel = fallbackModel;
    return { ...result, parseMetadata: cloneParseMetadata(metadata) };
  } catch (error) {
    const normalized = asInvoiceDraftError(error, FAILURE_STAGES.GEMINI_RESPONSE);
    metadata.attemptedModels.push({
      model: fallbackModel,
      attempt: 1,
      result: 'ERROR',
      httpStatus: normalized.httpStatus || null,
      code: cleanText(normalized.code, 80),
    });
    metadata.lastRetryableStatus = isRetryableGeminiError(normalized)
      ? normalized.httpStatus
      : metadata.lastRetryableStatus;
    throw withParseMetadata(normalized, metadata);
  }
}

async function duplicateWarnings(db, storeId, supplierName, invoiceNumber, grandTotal) {
  if (!invoiceNumber || !supplierName) return [];
  const warnings = [];
  const [postedSnap, draftSnap] = await Promise.all([
    db.collection('purchaseEntries')
      .where('storeId', '==', storeId)
      .where('invoiceNumber', '==', invoiceNumber)
      .limit(5)
      .get(),
    db.collection('purchaseDrafts')
      .where('storeId', '==', storeId)
      .where('invoiceNumber', '==', invoiceNumber)
      .limit(5)
      .get(),
  ]);
  const matches = [...postedSnap.docs, ...draftSnap.docs]
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((doc) => normalizeLookup(doc.supplierName) === normalizeLookup(supplierName))
    .filter((doc) => !grandTotal || Math.abs(toNumber(doc.grandTotal || doc.totalAmount || doc.extractedTotals?.grandTotal) - grandTotal) < 0.01);
  if (matches.length > 0) warnings.push(`Possible duplicate invoice found: ${supplierName} / ${invoiceNumber}.`);
  return warnings;
}

async function buildPurchaseDraftPayload(args) {
  const {
    admin,
    db,
    store,
    profile,
    uid,
    sourceFilePath,
    sourceFileName,
    mimeType,
    sizeBytes,
    rawExtraction,
    parserWarning,
    parserError,
    parseMetadata,
  } = args;
  const failure = parserError ? draftFailureDetails(parserError) : null;
  const operationalMetadata = parseMetadata
    || parserError?.parseMetadata
    || {
      primaryModel: readGeminiModel(),
      finalModel: readGeminiModel(),
      retryCount: 0,
      fallbackUsed: false,
      attemptedModels: [],
      lastRetryableStatus: null,
    };

  const [rawSnap, prepSnap, aliasSnap] = await Promise.all([
    db.collection('rawIngredients').get(),
    db.collection('prepItems').get(),
    db.collection('supplierItemAliases').limit(500).get().catch(() => ({ docs: [] })),
  ]);

  const rawIngredients = rawSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const prepItems = prepSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const aliases = aliasSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const sanitized = sanitizeExtractedInvoice(rawExtraction);
  const catalog = buildItemCatalog(rawIngredients, prepItems, aliases);
  const matchedLines = enrichLinesWithMatches(sanitized.lines, catalog);
  const unresolvedCount = matchedLines.filter((line) => line.matchStatus !== 'CONFIRMED').length;
  const duplicateInvoiceWarnings = await duplicateWarnings(
    db,
    store.id,
    sanitized.supplierName,
    sanitized.invoiceNumber,
    sanitized.extractedTotals.grandTotal,
  );
  const warnings = [
    ...sanitized.warnings,
    ...duplicateInvoiceWarnings,
    ...(parserWarning ? [parserWarning] : []),
    ...(unresolvedCount > 0 ? [`${unresolvedCount} invoice line(s) need item review.`] : []),
  ];

  const parsingStatus = parserError
    ? 'FAILED'
    : (matchedLines.length > 0 && unresolvedCount === 0 && warnings.length === 0 ? 'READY_FOR_REVIEW' : 'NEEDS_REVIEW');

  return {
    storeId: store.id,
    storeCode: store.code,
    storeName: store.name,
    createdBy: uid,
    createdByName: profile.name || profile.displayName || profile.email || uid,
    sourceType: 'INVOICE_UPLOAD',
    sourceFilePath,
    sourceFileName,
    sourceMimeType: mimeType,
    sourceSizeBytes: sizeBytes,
    parsingStatus,
    supplierName: sanitized.supplierName,
    invoiceNumber: sanitized.invoiceNumber,
    invoiceDate: sanitized.invoiceDate,
    gstin: sanitized.gstin,
    storeLocation: sanitized.storeLocation,
    currency: sanitized.currency,
    extractedTotals: sanitized.extractedTotals,
    subtotal: sanitized.extractedTotals.subtotal,
    discountAmount: sanitized.extractedTotals.discount,
    taxableAmount: sanitized.extractedTotals.taxableAmount,
    taxAmount: sanitized.extractedTotals.cgst + sanitized.extractedTotals.sgst + sanitized.extractedTotals.igst,
    grandTotal: sanitized.extractedTotals.grandTotal,
    lines: matchedLines,
    extractionConfidence: sanitized.extractionConfidence,
    warnings,
    primaryModel: operationalMetadata.primaryModel || readGeminiModel(),
    finalModel: operationalMetadata.finalModel || operationalMetadata.primaryModel || readGeminiModel(),
    retryCount: Number(operationalMetadata.retryCount) || 0,
    fallbackUsed: Boolean(operationalMetadata.fallbackUsed),
    attemptedModels: Array.isArray(operationalMetadata.attemptedModels) ? operationalMetadata.attemptedModels : [],
    lastRetryableStatus: operationalMetadata.lastRetryableStatus || null,
    parserError: failure?.failureMessage || null,
    failureStage: failure?.failureStage || null,
    failureCode: failure?.failureCode || null,
    failureMessage: failure?.failureMessage || null,
    failedAt: failure ? admin.firestore.FieldValue.serverTimestamp() : null,
    originalExtractionJson: rawExtraction || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function buildFailedDraftPayload(args) {
  const {
    admin,
    store,
    profile,
    uid,
    sourceFilePath,
    sourceFileName,
    mimeType,
    sizeBytes,
    parserError,
    parseMetadata,
  } = args;
  const failure = draftFailureDetails(parserError);
  const operationalMetadata = parseMetadata || parserError?.parseMetadata || {
    primaryModel: readGeminiModel(),
    finalModel: readGeminiModel(),
    retryCount: 0,
    fallbackUsed: false,
    attemptedModels: [],
    lastRetryableStatus: null,
  };
  return {
    storeId: store.id,
    storeCode: store.code,
    storeName: store.name,
    createdBy: uid,
    createdByName: profile.name || profile.displayName || profile.email || uid,
    sourceType: 'INVOICE_UPLOAD',
    sourceFilePath,
    sourceFileName,
    sourceMimeType: mimeType,
    sourceSizeBytes: sizeBytes,
    parsingStatus: 'FAILED',
    supplierName: '',
    invoiceNumber: '',
    invoiceDate: '',
    gstin: '',
    storeLocation: '',
    currency: 'INR',
    extractedTotals: {
      subtotal: 0,
      discount: 0,
      taxableAmount: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      otherCharges: 0,
      grandTotal: 0,
    },
    subtotal: 0,
    discountAmount: 0,
    taxableAmount: 0,
    taxAmount: 0,
    grandTotal: 0,
    lines: [],
    extractionConfidence: 0,
    warnings: [],
    primaryModel: operationalMetadata.primaryModel || readGeminiModel(),
    finalModel: operationalMetadata.finalModel || operationalMetadata.primaryModel || readGeminiModel(),
    retryCount: Number(operationalMetadata.retryCount) || 0,
    fallbackUsed: Boolean(operationalMetadata.fallbackUsed),
    attemptedModels: Array.isArray(operationalMetadata.attemptedModels) ? operationalMetadata.attemptedModels : [],
    lastRetryableStatus: operationalMetadata.lastRetryableStatus || null,
    parserError: failure.failureMessage,
    failureStage: failure.failureStage,
    failureCode: failure.failureCode,
    failureMessage: failure.failureMessage,
    failedAt: admin.firestore.FieldValue.serverTimestamp(),
    originalExtractionJson: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function buildParsingDraftPayload(args) {
  const {
    admin,
    store,
    profile,
    uid,
    sourceFilePath,
    sourceFileName,
    mimeType,
    sizeBytes,
    existingData = {},
  } = args;
  const primaryModel = readGeminiModel();
  return {
    storeId: store.id,
    storeCode: store.code,
    storeName: store.name,
    createdBy: uid,
    createdByName: profile.name || profile.displayName || profile.email || uid,
    sourceType: 'INVOICE_UPLOAD',
    sourceFilePath,
    sourceFileName,
    sourceMimeType: mimeType,
    sourceSizeBytes: sizeBytes,
    parsingStatus: 'PARSING',
    primaryModel,
    finalModel: primaryModel,
    retryCount: 0,
    fallbackUsed: false,
    attemptedModels: [],
    lastRetryableStatus: null,
    parserError: null,
    failureStage: null,
    failureCode: null,
    failureMessage: null,
    failedAt: null,
    createdAt: existingData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function createParseSupplierInvoiceDraft({ admin, db, region = REGION }) {
  return onCall({ region, timeoutSeconds: 180, memory: '1GiB', secrets: [GEMINI_API_KEY] }, async (request) => {
    let stage = FAILURE_STAGES.AUTHORIZE;
    let input = null;
    let uid = '';
    let profile = {};
    let store = null;
    let draftRef = null;
    const bucketName = readInvoiceStorageBucket();
    let storedMimeType = '';
    let storedSize = 0;
    let parserError = null;
    let parseMetadata = null;

    try {
      if (!request.auth?.uid) fail('unauthenticated', 'Sign in to upload supplier invoices.');
      input = validateInvoiceFileInput(request.data || {});
      uid = request.auth.uid;
      const profileSnap = await db.collection('users').doc(uid).get();
      if (!profileSnap.exists) fail('permission-denied', 'Staff profile is required.');
      profile = profileSnap.data() || {};
      if (!userCanParseForStore(profile, input.storeId)) fail('permission-denied', 'You cannot parse invoices for this store.');

      const storeSnap = await db.collection('stores').doc(input.storeId).get();
      if (!storeSnap.exists) fail('failed-precondition', 'Selected store was not found.');
      store = { id: storeSnap.id, ...storeSnap.data() };
    } catch (error) {
      logInvoiceDraftFailure({
        draftId: input?.draftId || request.data?.draftId || '',
        storeId: input?.storeId || request.data?.storeId || '',
        stage,
        error,
        bucket: bucketName,
        fileMimeType: input?.mimeType || request.data?.mimeType || '',
      });
      throw error;
    }

    draftRef = db.collection('purchaseDrafts').doc(input.draftId);
    const existingDraft = await draftRef.get();
    if (existingDraft.exists && existingDraft.data()?.sourceFilePath === input.sourceFilePath && !request.data?.retry) {
      return { draftId: input.draftId, draft: { id: existingDraft.id, ...existingDraft.data() }, idempotent: true };
    }
    if (existingDraft.exists && existingDraft.data()?.userReviewedAt) {
      fail('failed-precondition', 'This draft has already been reviewed. Create a new upload to parse again.');
    }

    const existingDraftData = existingDraft.exists ? (existingDraft.data() || {}) : {};
    await draftRef.set(buildParsingDraftPayload({
      admin,
      store,
      profile,
      uid,
      sourceFilePath: input.sourceFilePath,
      sourceFileName: input.sourceFileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      existingData: existingDraftData,
    }), { merge: true });

    let rawExtraction = null;
    let parserWarning = '';

    stage = FAILURE_STAGES.DOWNLOAD_FILE;
    let fileBuffer = null;
    try {
      const bucket = admin.storage().bucket(bucketName);
      const file = bucket.file(input.sourceFilePath);
      const [exists] = await file.exists();
      if (!exists) fail('not-found', 'Uploaded invoice file was not found.');
      const [metadata] = await file.getMetadata();
      storedMimeType = cleanText(metadata.contentType, 120).toLowerCase();
      storedSize = toNumber(metadata.size);
      if (!ALLOWED_INVOICE_MIME_TYPES.has(storedMimeType)) fail('invalid-argument', 'Stored invoice file type is unsupported.');
      if (storedSize <= 0 || storedSize > MAX_INVOICE_FILE_SIZE_BYTES) fail('invalid-argument', 'Stored invoice file must be 10 MB or smaller.');
      [fileBuffer] = await file.download();
    } catch (error) {
      parserError = asInvoiceDraftError(error, FAILURE_STAGES.DOWNLOAD_FILE, 'DOWNLOAD_FILE_FAILED');
      storedMimeType = storedMimeType || input.mimeType;
      storedSize = storedSize || input.sizeBytes;
      logInvoiceDraftFailure({
        draftId: input.draftId,
        storeId: input.storeId,
        stage: FAILURE_STAGES.DOWNLOAD_FILE,
        error: parserError,
        bucket: bucketName,
        fileMimeType: storedMimeType,
      });
    }

    if (!parserError) {
      try {
        const parsed = await parseInvoiceWithGeminiResilience(fileBuffer, storedMimeType, {
          draftId: input.draftId,
          storeId: input.storeId,
          bucket: bucketName,
          fileMimeType: storedMimeType,
          updateDraft: async (patch) => {
            await draftRef.set({
              ...patch,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          },
        });
        rawExtraction = parsed.parsed;
        parserWarning = parsed.warning;
        parseMetadata = parsed.parseMetadata;
      } catch (error) {
        parserError = asInvoiceDraftError(error, FAILURE_STAGES.GEMINI_REQUEST);
        parseMetadata = parserError.parseMetadata || null;
        logInvoiceDraftFailure({
          draftId: input.draftId,
          storeId: input.storeId,
          stage: parserError.stage || FAILURE_STAGES.GEMINI_REQUEST,
          error: parserError,
          model: parserError.model || readGeminiModel(),
          bucket: bucketName,
          fileMimeType: storedMimeType,
        });
      }
    }

    let draftPayload = null;
    stage = FAILURE_STAGES.ITEM_MATCHING;
    try {
      draftPayload = await buildPurchaseDraftPayload({
        admin,
        db,
        store,
        profile,
        uid,
        sourceFilePath: input.sourceFilePath,
        sourceFileName: input.sourceFileName,
        mimeType: storedMimeType,
        sizeBytes: storedSize,
        rawExtraction,
        parserWarning,
        parserError,
        parseMetadata,
      });
    } catch (error) {
      const itemMatchingError = asInvoiceDraftError(error, FAILURE_STAGES.ITEM_MATCHING, 'ITEM_MATCHING_FAILED');
      logInvoiceDraftFailure({
        draftId: input.draftId,
        storeId: input.storeId,
        stage: FAILURE_STAGES.ITEM_MATCHING,
        error: itemMatchingError,
        bucket: bucketName,
        fileMimeType: storedMimeType,
      });
      draftPayload = buildFailedDraftPayload({
        admin,
        store,
        profile,
        uid,
        sourceFilePath: input.sourceFilePath,
        sourceFileName: input.sourceFileName,
        mimeType: storedMimeType,
        sizeBytes: storedSize,
        parserError: itemMatchingError,
        parseMetadata,
      });
    }

    stage = FAILURE_STAGES.SAVE_DRAFT;
    try {
      await draftRef.set(draftPayload, { merge: false });
      const saved = await draftRef.get();
      return { draftId: input.draftId, draft: { id: saved.id, ...saved.data() }, idempotent: false };
    } catch (error) {
      logInvoiceDraftFailure({
        draftId: input.draftId,
        storeId: input.storeId,
        stage,
        error,
        bucket: bucketName,
        fileMimeType: storedMimeType,
      });
      throw error;
    }
  });
}

module.exports = {
  ALLOWED_INVOICE_MIME_TYPES,
  ALLOWED_GEMINI_INVOICE_MODELS,
  DEFAULT_GEMINI_INVOICE_MODEL,
  FALLBACK_GEMINI_INVOICE_MODEL,
  EXTRACTION_SCHEMA,
  PRIMARY_GEMINI_MAX_RETRIES,
  PRIMARY_GEMINI_RETRY_DELAYS_MS,
  RETRYABLE_GEMINI_HTTP_STATUSES,
  MAX_INVOICE_FILE_SIZE_BYTES,
  buildItemCatalog,
  buildFailedDraftPayload,
  buildParsingDraftPayload,
  buildPurchaseDraftPayload,
  callGeminiParser,
  createParseSupplierInvoiceDraft,
  enrichLinesWithMatches,
  FAILURE_STAGES,
  InvoiceDraftError,
  isRetryableGeminiError,
  matchExtractedLine,
  logInvoiceDraftFailure,
  parseInvoiceWithGeminiResilience,
  readGeminiApiKey,
  readGeminiModel,
  readInvoiceStorageBucket,
  retryDelayWithJitter,
  sanitizeErrorMessage,
  validateParsedInvoicePayload,
  sanitizeExtractedInvoice,
  validateInvoiceFileInput,
  userCanParseForStore,
};
