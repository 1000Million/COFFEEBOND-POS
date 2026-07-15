import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  ALLOWED_GEMINI_INVOICE_MODELS,
  buildItemCatalog,
  buildFailedDraftPayload,
  buildPurchaseDraftPayload,
  callGeminiParser,
  DEFAULT_GEMINI_INVOICE_MODEL,
  FALLBACK_GEMINI_INVOICE_MODEL,
  enrichLinesWithMatches,
  FAILURE_STAGES,
  InvoiceDraftError,
  logInvoiceDraftFailure,
  matchExtractedLine,
  parseInvoiceWithGeminiResilience,
  PRIMARY_GEMINI_MAX_RETRIES,
  PRIMARY_GEMINI_RETRY_DELAYS_MS,
  readGeminiApiKey,
  readGeminiModel,
  readInvoiceStorageBucket,
  RETRYABLE_GEMINI_HTTP_STATUSES,
  sanitizeErrorMessage,
  sanitizeExtractedInvoice,
  userCanParseForStore,
  validateParsedInvoicePayload,
  validateInvoiceFileInput,
} = require('../functions/invoiceDraft.js');

const repoRoot = process.cwd();
const purchaseEntrySource = fs.readFileSync(path.join(repoRoot, 'frontend/pages/inventory/PurchaseEntry.tsx'), 'utf8');
const invoiceDraftSource = fs.readFileSync(path.join(repoRoot, 'functions/invoiceDraft.js'), 'utf8');
const retiredInvoiceModel = ['gemini', '2.5', 'flash'].join('-');

assert.equal(DEFAULT_GEMINI_INVOICE_MODEL, 'gemini-3.5-flash');
assert.equal(readGeminiModel(), 'gemini-3.5-flash');
assert.equal(readGeminiModel({ value: () => 'gemini-3.1-flash-lite' }), 'gemini-3.1-flash-lite');
assert.equal(readGeminiModel({ value: () => retiredInvoiceModel }), 'gemini-3.5-flash');
assert.equal(ALLOWED_GEMINI_INVOICE_MODELS.has('gemini-3.5-flash'), true);
assert.equal(ALLOWED_GEMINI_INVOICE_MODELS.has('gemini-3.1-flash-lite'), true);
assert.equal(ALLOWED_GEMINI_INVOICE_MODELS.has(retiredInvoiceModel), false);
assert.equal(FALLBACK_GEMINI_INVOICE_MODEL, 'gemini-3.1-flash-lite');
assert.equal(PRIMARY_GEMINI_MAX_RETRIES, 3);
assert.deepEqual(PRIMARY_GEMINI_RETRY_DELAYS_MS, [1500, 3000, 6000]);
assert.equal(RETRYABLE_GEMINI_HTTP_STATUSES.has(429), true);
assert.equal(RETRYABLE_GEMINI_HTTP_STATUSES.has(503), true);
assert.equal(RETRYABLE_GEMINI_HTTP_STATUSES.has(404), false);
assert.equal(invoiceDraftSource.includes(retiredInvoiceModel), false, 'Old invoice parser model must not be present.');

const validPdf = validateInvoiceFileInput({
  storeId: 'UDAY_PARK',
  draftId: 'draft_12345678',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_12345678/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
});
assert.equal(validPdf.mimeType, 'application/pdf');
assert.equal(validPdf.sourceFilePath, 'purchase-invoices/UDAY_PARK/draft_12345678/invoice.pdf');
assert.equal(readInvoiceStorageBucket(), 'coffee-bond-pos.firebasestorage.app');
assert.equal(readInvoiceStorageBucket({ value: () => 'coffee-bond-pos.firebasestorage.app' }), 'coffee-bond-pos.firebasestorage.app');

const validImage = validateInvoiceFileInput({
  storeId: 'UDAY_PARK',
  draftId: 'draft_12345679',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_12345679/invoice.png',
  sourceFileName: 'invoice.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
});
assert.equal(validImage.mimeType, 'image/png');

assert.throws(() => validateInvoiceFileInput({
  storeId: 'UDAY_PARK',
  draftId: 'draft_unsupported',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_unsupported/invoice.exe',
  sourceFileName: 'invoice.exe',
  mimeType: 'application/x-msdownload',
  sizeBytes: 100,
}), /Unsupported invoice file type/);

assert.throws(() => validateInvoiceFileInput({
  storeId: 'UDAY_PARK',
  draftId: 'draft_oversized',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_oversized/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 11 * 1024 * 1024,
}), /10 MB or smaller/);

assert.equal(userCanParseForStore(null, 'UDAY_PARK'), false, 'Unauthenticated/no profile denied.');
assert.equal(userCanParseForStore({ role: 'CASHIER', isActive: true, storeIds: ['UDAY_PARK'] }, 'UDAY_PARK'), false, 'Cashier denied.');
assert.equal(userCanParseForStore({ role: 'STORE_MANAGER', isActive: true, storeIds: ['NOIDA_29'] }, 'UDAY_PARK'), false, 'Cross-store manager denied.');
assert.equal(userCanParseForStore({ role: 'STORE_MANAGER', isActive: true, storeIds: ['UDAY_PARK'] }, 'UDAY_PARK'), true, 'Assigned manager allowed.');
assert.equal(userCanParseForStore({ role: 'ADMIN', isActive: true, storeIds: [] }, 'UDAY_PARK'), true, 'Admin allowed.');
assert.throws(() => readGeminiApiKey({ value: () => '' }), /Gemini API key secret is unavailable/);
assert.throws(() => validateParsedInvoicePayload(null), /malformed JSON/);
assert.throws(() => validateParsedInvoicePayload({ lines: 'not-an-array' }), /invalid line items/);
assert.deepEqual(validateParsedInvoicePayload({ totals: {}, lines: [] }), { totals: {}, lines: [] });
assert.equal(sanitizeErrorMessage('bad key=SECRET123 invoice full content'.repeat(20)).includes('SECRET123'), false);
assert.equal(sanitizeErrorMessage('bad key=SECRET123').includes('key=[REDACTED]'), true);

let capturedGeminiUrl = '';
let capturedGeminiBody = null;
await callGeminiParser(Buffer.from('%PDF-fake'), 'application/pdf', {
  apiKeyParam: { value: () => 'unit-test-api-key' },
  fetchImpl: async (url, init) => {
    capturedGeminiUrl = url;
    capturedGeminiBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ totals: {}, lines: [] }) }] } }] }),
    };
  },
});
assert.ok(capturedGeminiUrl.includes('/models/gemini-3.5-flash:generateContent'), 'PDF parser request must target gemini-3.5-flash.');
assert.equal(capturedGeminiUrl.includes(retiredInvoiceModel), false);
assert.equal(capturedGeminiBody.contents[0].parts[1].inlineData.mimeType, 'application/pdf');

const geminiSuccessResponse = (parsed = { totals: {}, lines: [] }) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(parsed) }] } }] }),
});
const geminiHttpErrorResponse = (status, message = 'temporary model busy') => ({
  ok: false,
  status,
  text: async () => JSON.stringify({
    error: {
      status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
      message,
    },
  }),
});

const secondAttemptDelays = [];
const secondAttemptUpdates = [];
const secondAttemptUrls = [];
const secondAttemptResult = await parseInvoiceWithGeminiResilience(Buffer.from('retry invoice'), 'application/pdf', {
  draftId: 'draft_retry_second',
  apiKeyParam: { value: () => 'unit-test-api-key' },
  jitterImpl: () => 0.5,
  sleepImpl: async (delayMs) => secondAttemptDelays.push(delayMs),
  updateDraft: async (patch) => secondAttemptUpdates.push(patch),
  fetchImpl: async (url) => {
    secondAttemptUrls.push(url);
    if (secondAttemptUrls.length === 1) return geminiHttpErrorResponse(503, 'This model is currently experiencing high demand.');
    return geminiSuccessResponse();
  },
});
assert.deepEqual(secondAttemptDelays, [1500], 'First retry delay should be approximately 1.5 seconds without jitter.');
assert.equal(secondAttemptResult.parseMetadata.retryCount, 1);
assert.equal(secondAttemptResult.parseMetadata.fallbackUsed, false);
assert.equal(secondAttemptUrls.every((url) => url.includes('/models/gemini-3.5-flash:generateContent')), true, 'Successful second attempt must not use fallback.');
assert.equal(secondAttemptUpdates.some((patch) => patch.parsingStatus === 'PARSING' && patch.retryCount === 1), true);

const primaryRetryDelays = [];
const primaryRetryUrls = [];
const primaryRetryResult = await parseInvoiceWithGeminiResilience(Buffer.from('busy invoice'), 'application/pdf', {
  draftId: 'draft_retry_three_times',
  apiKeyParam: { value: () => 'unit-test-api-key' },
  jitterImpl: () => 0.5,
  sleepImpl: async (delayMs) => primaryRetryDelays.push(delayMs),
  updateDraft: async () => {},
  fetchImpl: async (url) => {
    primaryRetryUrls.push(url);
    if (primaryRetryUrls.length <= 3) return geminiHttpErrorResponse(503, 'This model is currently experiencing high demand.');
    return geminiSuccessResponse();
  },
});
assert.deepEqual(primaryRetryDelays, [1500, 3000, 6000], '503 should retry three times with the configured exponential delay sequence.');
assert.equal(primaryRetryUrls.length, 4, 'Initial call plus three retries should be attempted before success.');
assert.equal(primaryRetryResult.parseMetadata.retryCount, 3);
assert.equal(primaryRetryResult.parseMetadata.fallbackUsed, false);

let rateLimitCalls = 0;
const rateLimitResult = await parseInvoiceWithGeminiResilience(Buffer.from('rate limited invoice'), 'application/pdf', {
  draftId: 'draft_429',
  apiKeyParam: { value: () => 'unit-test-api-key' },
  jitterImpl: () => 0.5,
  sleepImpl: async () => {},
  updateDraft: async () => {},
  fetchImpl: async () => {
    rateLimitCalls += 1;
    if (rateLimitCalls === 1) return geminiHttpErrorResponse(429, 'Quota temporarily exhausted.');
    return geminiSuccessResponse();
  },
});
assert.equal(rateLimitResult.parseMetadata.retryCount, 1, '429 should be retryable.');

let notFoundCalls = 0;
let notFoundError;
try {
  await parseInvoiceWithGeminiResilience(Buffer.from('missing model invoice'), 'application/pdf', {
    draftId: 'draft_404',
    apiKeyParam: { value: () => 'unit-test-api-key' },
    jitterImpl: () => 0.5,
    sleepImpl: async () => { throw new Error('404 should not sleep'); },
    updateDraft: async () => {},
    fetchImpl: async () => {
      notFoundCalls += 1;
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { status: 'NOT_FOUND', message: 'model not found' } }),
      };
    },
  });
} catch (error) {
  notFoundError = error;
}
assert.equal(notFoundCalls, 1, '404 must not be retried.');
assert.equal(notFoundError.httpStatus, 404);
assert.equal(notFoundError.parseMetadata.fallbackUsed, false);

const fallbackUrls = [];
const fallbackUpdates = [];
const fallbackResult = await parseInvoiceWithGeminiResilience(Buffer.from('fallback invoice'), 'application/pdf', {
  draftId: 'draft_fallback',
  apiKeyParam: { value: () => 'unit-test-api-key' },
  jitterImpl: () => 0.5,
  sleepImpl: async () => {},
  updateDraft: async (patch) => fallbackUpdates.push(patch),
  fetchImpl: async (url) => {
    fallbackUrls.push(url);
    if (url.includes('/models/gemini-3.5-flash:generateContent')) return geminiHttpErrorResponse(503, 'busy');
    return geminiSuccessResponse({ totals: {}, lines: [{ supplierItemDescription: 'Unknown item' }] });
  },
});
assert.equal(fallbackResult.parseMetadata.fallbackUsed, true, 'Exhausted primary retries should use fallback.');
assert.equal(fallbackResult.parseMetadata.finalModel, 'gemini-3.1-flash-lite');
assert.equal(fallbackUrls.some((url) => url.includes('/models/gemini-3.1-flash-lite:generateContent')), true);
assert.equal(fallbackUpdates.some((patch) => patch.parsingStatus === 'PARSING' && patch.fallbackUsed === true), true);

let fallbackFailedError;
try {
  await parseInvoiceWithGeminiResilience(Buffer.from('failed fallback invoice'), 'application/pdf', {
    draftId: 'draft_fallback_failed',
    apiKeyParam: { value: () => 'unit-test-api-key' },
    jitterImpl: () => 0.5,
    sleepImpl: async () => {},
    updateDraft: async () => {},
    fetchImpl: async () => geminiHttpErrorResponse(503, 'busy'),
  });
} catch (error) {
  fallbackFailedError = error;
}
assert.equal(fallbackFailedError.parseMetadata.fallbackUsed, true, 'Failed fallback must carry fallback metadata for FAILED draft state.');
assert.equal(fallbackFailedError.parseMetadata.finalModel, 'gemini-3.1-flash-lite');
assert.equal(JSON.stringify(fallbackFailedError.parseMetadata).includes('stockMovements'), false, 'Retry metadata must not describe stock writes.');

let httpParserError;
try {
  await callGeminiParser(Buffer.from('fake invoice bytes that must never be logged'), 'application/pdf', {
    apiKeyParam: { value: () => 'unit-test-api-key' },
    modelParam: { value: () => 'gemini-test-model' },
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: `Quota failed for key=unit-test-api-key ${'x'.repeat(500)}`,
        },
      }),
    }),
  });
} catch (error) {
  httpParserError = error;
}
assert.equal(httpParserError.stage, FAILURE_STAGES.GEMINI_RESPONSE);
assert.equal(httpParserError.code, 'RESOURCE_EXHAUSTED');
assert.equal(httpParserError.httpStatus, 429);
assert.equal(httpParserError.responsePreview.includes('unit-test-api-key'), false);
assert.ok(httpParserError.responsePreview.length <= 300);

let invalidJsonError;
try {
  await callGeminiParser(Buffer.from('fake invoice'), 'application/pdf', {
    apiKeyParam: { value: () => 'unit-test-api-key' },
    modelParam: { value: () => 'gemini-test-model' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
    }),
  });
} catch (error) {
  invalidJsonError = error;
}
assert.equal(invalidJsonError.stage, FAILURE_STAGES.JSON_PARSE);
assert.equal(invalidJsonError.code, 'PARSED_JSON_INVALID');

let schemaError;
try {
  await callGeminiParser(Buffer.from('fake invoice'), 'application/pdf', {
    apiKeyParam: { value: () => 'unit-test-api-key' },
    modelParam: { value: () => 'gemini-test-model' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lines: 'bad' }) }] } }] }),
    }),
  });
} catch (error) {
  schemaError = error;
}
assert.equal(schemaError.stage, FAILURE_STAGES.SCHEMA_VALIDATION);
assert.equal(schemaError.code, 'INVALID_LINES');

const extracted = sanitizeExtractedInvoice({
  supplierName: 'Test Supplier',
  invoiceNumber: 'INV-001',
  invoiceDate: '2026-07-15',
  gstin: '09ABCDE1234F1Z5',
  totals: {
    subtotal: '500',
    taxableAmount: '500',
    cgst: '12.5',
    sgst: '12.5',
    grandTotal: '525',
  },
  lines: [{
    supplierItemDescription: 'Avocado',
    quantity: 2,
    purchaseUnit: 'BAG',
    packContents: 1,
    contentsUnit: 'KG',
    rate: 250,
    priceBasis: 'RATE_PER_PURCHASE_UNIT',
    taxPercentage: 5,
    taxAmount: 25,
    lineTotal: 525,
    hsnSac: '0804',
  }],
  confidence: 0.9,
});
assert.equal(extracted.supplierName, 'Test Supplier');
assert.equal(extracted.extractedTotals.grandTotal, 525);
assert.equal(extracted.lines.length, 1);

const catalog = buildItemCatalog([
  { id: 'AVOCADO', code: 'AVOCADO', name: 'Avocado' },
  { id: 'MILK', code: 'MILK', name: 'Milk' },
], [
  { id: 'WHITE_SAUCE', code: 'WHITE_SAUCE', name: 'White Sauce' },
]);

const exactMatch = matchExtractedLine(extracted.lines[0], catalog);
assert.equal(exactMatch.status, 'CONFIRMED');
assert.equal(exactMatch.suggestedItem.itemCode, 'AVOCADO');

const unresolved = matchExtractedLine({ supplierItemDescription: 'Unknown imported fancy garnish' }, catalog);
assert.equal(unresolved.status, 'UNRESOLVED');

const enriched = enrichLinesWithMatches(extracted.lines, catalog);
assert.equal(enriched[0].matchStatus, 'CONFIRMED');
assert.equal(enriched[0].suggestedItem.itemCode, 'AVOCADO');

const fakeAdmin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP',
    },
  },
};

const fakeDoc = (id, data) => ({ id, data: () => data });
const fakeSnap = (docs) => ({ docs });
const chain = (docs) => ({
  where() {
    return this;
  },
  limit() {
    return this;
  },
  async get() {
    return fakeSnap(docs);
  },
});

const fakeDb = {
  collection(name) {
    if (name === 'rawIngredients') return { get: async () => fakeSnap([fakeDoc('AVOCADO', { code: 'AVOCADO', name: 'Avocado' })]) };
    if (name === 'prepItems') return { get: async () => fakeSnap([]) };
    if (name === 'supplierItemAliases') return { limit: () => ({ get: async () => fakeSnap([]) }) };
    if (name === 'purchaseEntries') {
      return chain([fakeDoc('posted-1', {
        storeId: 'UDAY_PARK',
        supplierName: 'Test Supplier',
        invoiceNumber: 'INV-001',
        grandTotal: 525,
      })]);
    }
    if (name === 'purchaseDrafts') return chain([]);
    throw new Error(`Unexpected collection ${name}`);
  },
};

const draftPayload = await buildPurchaseDraftPayload({
  admin: fakeAdmin,
  db: fakeDb,
  store: { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' },
  profile: { name: 'Uday Manager', email: 'manager.uday@coffeebond.in' },
  uid: 'manager-uid',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_12345678/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  rawExtraction: {
    supplierName: 'Test Supplier',
    invoiceNumber: 'INV-001',
    invoiceDate: '2026-07-15',
    totals: { subtotal: 500, taxableAmount: 500, cgst: 12.5, sgst: 12.5, grandTotal: 525 },
    lines: extracted.lines,
    confidence: 0.91,
  },
  parserWarning: '',
  parserError: null,
});
assert.equal(draftPayload.sourceType, 'INVOICE_UPLOAD');
assert.equal(draftPayload.parsingStatus, 'NEEDS_REVIEW');
assert.equal(draftPayload.lines[0].matchStatus, 'CONFIRMED');
assert.equal(draftPayload.warnings.some((warning) => warning.includes('Possible duplicate invoice')), true, 'Duplicate invoice warning present.');
assert.equal(draftPayload.sourceFilePath.includes('purchase-invoices/UDAY_PARK'), true);
assert.equal('stockMovements' in draftPayload, false, 'Draft payload must not contain stock movement writes.');
assert.equal('purchaseEntries' in draftPayload, false, 'Draft payload must not create a posted purchase.');

const fallbackDraftPayload = await buildPurchaseDraftPayload({
  admin: fakeAdmin,
  db: { ...fakeDb, collection: (name) => (name === 'purchaseEntries' || name === 'purchaseDrafts' ? chain([]) : fakeDb.collection(name)) },
  store: { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' },
  profile: { email: 'manager.uday@coffeebond.in' },
  uid: 'manager-uid',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_fallback/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  rawExtraction: fallbackResult.parsed,
  parserWarning: '',
  parserError: null,
  parseMetadata: fallbackResult.parseMetadata,
});
assert.ok(['READY_FOR_REVIEW', 'NEEDS_REVIEW'].includes(fallbackDraftPayload.parsingStatus), 'Successful fallback must produce a reviewable draft status.');
assert.equal(fallbackDraftPayload.fallbackUsed, true);
assert.equal(fallbackDraftPayload.finalModel, 'gemini-3.1-flash-lite');

const failedDraftPayload = await buildPurchaseDraftPayload({
  admin: fakeAdmin,
  db: { ...fakeDb, collection: (name) => (name === 'purchaseEntries' || name === 'purchaseDrafts' ? chain([]) : fakeDb.collection(name)) },
  store: { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' },
  profile: { email: 'manager.uday@coffeebond.in' },
  uid: 'manager-uid',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_failed/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  rawExtraction: null,
  parserWarning: '',
  parserError: new Error('Synthetic parser failure'),
});
assert.equal(failedDraftPayload.parsingStatus, 'FAILED');
assert.equal(failedDraftPayload.parserError, 'Synthetic parser failure');

const failedFallbackDraftPayload = await buildPurchaseDraftPayload({
  admin: fakeAdmin,
  db: { ...fakeDb, collection: (name) => (name === 'purchaseEntries' || name === 'purchaseDrafts' ? chain([]) : fakeDb.collection(name)) },
  store: { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' },
  profile: { email: 'manager.uday@coffeebond.in' },
  uid: 'manager-uid',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_failed_fallback/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  rawExtraction: null,
  parserWarning: '',
  parserError: fallbackFailedError,
});
assert.equal(failedFallbackDraftPayload.parsingStatus, 'FAILED');
assert.equal(failedFallbackDraftPayload.fallbackUsed, true);
assert.equal(failedFallbackDraftPayload.finalModel, 'gemini-3.1-flash-lite');

const downloadFailureDraft = buildFailedDraftPayload({
  admin: fakeAdmin,
  store: { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' },
  profile: { email: 'manager.uday@coffeebond.in' },
  uid: 'manager-uid',
  sourceFilePath: 'purchase-invoices/UDAY_PARK/draft_download/invoice.pdf',
  sourceFileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  parserError: new InvoiceDraftError(FAILURE_STAGES.DOWNLOAD_FILE, 'storage/not-found', 'Uploaded invoice file was not found.'),
});
assert.equal(downloadFailureDraft.parsingStatus, 'FAILED');
assert.equal(downloadFailureDraft.failureStage, FAILURE_STAGES.DOWNLOAD_FILE);
assert.equal(downloadFailureDraft.failureCode, 'storage/not-found');
assert.equal(downloadFailureDraft.failureMessage, 'Uploaded invoice file was not found.');

const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args);
try {
  logInvoiceDraftFailure({
    draftId: 'draft_log',
    storeId: 'UDAY_PARK',
    stage: FAILURE_STAGES.GEMINI_RESPONSE,
    error: httpParserError,
    model: 'gemini-test-model',
    bucket: 'coffee-bond-pos.firebasestorage.app',
    fileMimeType: 'application/pdf',
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(loggedErrors.length, 1);
assert.equal(loggedErrors[0][0], 'invoice-draft-parse-failed');
assert.equal(loggedErrors[0][1].stage, FAILURE_STAGES.GEMINI_RESPONSE);
assert.equal(loggedErrors[0][1].httpStatus, 429);
assert.equal(loggedErrors[0][1].message.includes('unit-test-api-key'), false);
assert.equal(JSON.stringify(loggedErrors[0][1]).includes('fake invoice bytes'), false);

assert.equal(purchaseEntrySource.includes("setSuccess(draft.parsingStatus === 'READY_FOR_REVIEW' ?"), false, 'Upload flow must not use the global green success banner.');
assert.ok(purchaseEntrySource.includes("state.status === 'READY_FOR_REVIEW'"), 'READY_FOR_REVIEW must have an explicit banner state.');
assert.ok(purchaseEntrySource.includes("state.status === 'PARSING'"), 'PARSING must have an explicit neutral banner state.');
assert.ok(purchaseEntrySource.includes('Invoice uploaded; parsing in progress.'), 'PARSING must not use ready-for-review wording.');
assert.ok(purchaseEntrySource.includes('Gemini is temporarily busy. Retrying invoice parsing...'), 'Retry state must show a busy parser message.');
assert.ok(purchaseEntrySource.includes('Primary parser is busy. Trying the backup parser...'), 'Fallback state must show a backup parser message.');
assert.ok(purchaseEntrySource.includes('retryCount: 0'), 'Retry parsing should reset retry metadata before restarting.');
assert.ok(purchaseEntrySource.includes('fallbackUsed: false'), 'Retry parsing should reset fallback metadata before restarting.');
assert.equal(purchaseEntrySource.includes('Parsing invoice on server'), false, 'Old parsing wording should be removed.');
assert.ok(purchaseEntrySource.includes('Invoice parsing failed at ${stage}: ${message}'), 'FAILED state must show stage and message.');

console.log('Purchase invoice draft tests passed.');
console.log('- default invoice parser model is gemini-3.5-flash');
console.log(`- old ${retiredInvoiceModel} model is not allowed or used`);
console.log('- PDF request targets gemini-3.5-flash with inlineData');
console.log('- valid PDF upload input');
console.log('- valid image upload input');
console.log('- unsupported file type blocked');
console.log('- oversized file blocked');
console.log('- unauthenticated/no profile denied');
console.log('- cashier denied');
console.log('- cross-store manager denied');
console.log('- missing Gemini secret fails clearly');
console.log('- Gemini HTTP error records GEMINI_RESPONSE and safe log metadata');
console.log('- 503 capacity errors retry three times with exponential backoff');
console.log('- 429 capacity errors are retryable');
console.log('- 404 model errors are not retried');
console.log('- successful second attempt does not use fallback');
console.log('- exhausted primary retries use gemini-3.1-flash-lite fallback');
console.log('- successful fallback produces a reviewable draft');
console.log('- failed fallback produces a FAILED draft with safe metadata');
console.log('- invalid parser JSON records JSON_PARSE');
console.log('- malformed parser output fails validation');
console.log('- schema failure records SCHEMA_VALIDATION');
console.log('- bucket download failure records DOWNLOAD_FILE');
console.log('- structured extraction sanitized');
console.log('- low-confidence/unmatched line remains unresolved');
console.log('- duplicate invoice warning emitted');
console.log('- parser failure creates FAILED draft payload without posting');
console.log('- FAILED status cannot show the green success banner');
console.log('- PARSING status does not use ready-for-review wording');
console.log('- retry/fallback parsing states have clear staff messages');
console.log('- API key and invoice contents are not logged');
console.log('- no stock movement or purchase entry is created by these draft helpers');
