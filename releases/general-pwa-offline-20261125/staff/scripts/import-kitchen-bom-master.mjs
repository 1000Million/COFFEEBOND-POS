#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import xlsx from 'xlsx';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const DEFAULT_WORKBOOK = 'data/imports/Coffee_Bond_Recipe_BOM_Costing_Master.xlsx';
const APPLY = process.argv.includes('--apply');
const APPLY_COSTS = process.argv.includes('--apply-costs');
const DRY_RUN = !APPLY;
const DEFAULT_COMPONENT_MAPPING_PATH = 'data/imports/kitchen-bom-component-mappings.json';
const DEFAULT_PRODUCT_MAPPING_PATH = 'data/imports/kitchen-finished-product-mappings.json';

const REQUIRED_SHEETS = {
  raw: 'Raw Material Master',
  prep: 'Prep Recipe Master',
  prepBom: 'Prep BOM',
  final: 'Final Product Master',
  finalBom: 'Final Product BOM',
  review: 'Data Quality Review',
};

const REPORT_DIR = 'reports';
const IMPORT_SOURCE = 'PHASE_11A_KITCHEN_BOM_MASTER';
const STORE_CODES_TO_PRESERVE = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];
const BEVERAGE_CATEGORY_RE = /(COFFEE|LATTE|ESPRESSO|MATCHA|TEA|BEVERAGE|DRINK|SMOOTHIE|SHAKE|JUICE|COLD)/i;
const APPROVED_STATUSES = new Set(['APPROVED', 'APPROVED_DETERMINISTIC', 'OWNER_APPROVED']);
const COMPOSITE_COMPONENTS = new Set([
  'salt and pepper',
  'salt pepper',
  'salt plus pepper',
  'black pepper salt',
  'chilli flakes oregano',
]);
const PROPOSED_PREP_COMPONENTS = new Set([
  'honey lemon dressing',
  'olive oil dip',
  'quinoa salad',
  'coconut sugar dressing',
  'chilli oil',
  'cashew blend',
  'tomato relish',
  'tomato rellish',
  'boiled potato',
  'penne pasta boiled',
  'fettuccini pasta boiled',
  'fettuccini boiled pasta',
  'spaghetti boiled',
  'pickled onions',
  'pickled onions ring',
  'mustard dip',
  'rajma boiled',
  'masoor boiled',
  'boiled soya',
  'harissa sauce',
  'chilli beans',
  'vanilla ice cream',
]);
const PROPOSED_RAW_COMPONENTS = new Set([
  'apple',
  'orange',
  'pumpkin seed',
  'pumpkin seeds',
  'rocket leave',
  'rocket leaves',
  'micro green',
  'microgreen',
  'microgreens',
  'edible flower',
  'edible flowers',
  'cream cheese',
  'bocconcini',
  'bocconcini cheese',
  'black olives',
  'black sesame seeds',
  'black sesame seeds.',
  'roasted sesame seeds',
  'roasted seasme seed',
  'green peas',
  'coconut sugar',
  'garlic powder',
  'spinach',
  'soya chunks',
]);
const UNIT_DECISION_COMPONENTS = new Set([]);
const DETERMINISTIC_ALIAS_COMPONENTS = new Map([
  ['avocado slice', { targetType: 'RAW_INGREDIENT', targetCode: 'AVOCADO', note: 'Slice descriptor only; quantity is already in grams.' }],
  ['basil leaves', { targetType: 'RAW_INGREDIENT', targetCode: 'BASIL', note: 'Leaf descriptor maps to existing Basil master.' }],
  ['cherry tomato', { targetType: 'RAW_INGREDIENT', targetCode: 'CHERRY_TOMATOES', note: 'Singular/plural spelling alias.' }],
  ['chia seed', { targetType: 'RAW_INGREDIENT', targetCode: 'CHIA_SEEDS', note: 'Singular/plural spelling alias.' }],
  ['eggs', { targetType: 'RAW_INGREDIENT', targetCode: 'EGG', note: 'Plural spelling alias.' }],
  ['frozen blueberry', { targetType: 'RAW_INGREDIENT', targetCode: 'BLUEBERRY_FROZEN', note: 'Word-order alias for existing frozen blueberry master.' }],
  ['garli', { targetType: 'RAW_INGREDIENT', targetCode: 'GARLIC', note: 'Workbook typo for Garlic.' }],
  ['granola', { targetType: 'RAW_INGREDIENT', targetCode: 'HOUSE_GRANOLA', note: 'Workbook generic granola maps to existing House Granola master.' }],
  ['hen fruit eggs', { targetType: 'RAW_INGREDIENT', targetCode: 'EGG', note: 'Operational egg naming alias.' }],
  ['mozzarella chesse', { targetType: 'RAW_INGREDIENT', targetCode: 'MOZZARELLA_CHEESE', note: 'Workbook typo for Mozzarella Cheese.' }],
  ['sushi rice uncooked', { targetType: 'RAW_INGREDIENT', targetCode: 'SUSHI_RICE', note: 'Uncooked descriptor matches existing Sushi Rice master.' }],
]);

const UOM_ALIASES = {
  G: 'G',
  GM: 'G',
  GMS: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  KG: 'KG',
  KGS: 'KG',
  KILOGRAM: 'KG',
  KILOGRAMS: 'KG',
  ML: 'ML',
  MILLILITRE: 'ML',
  MILLILITER: 'ML',
  MILLILITRES: 'ML',
  MILLILITERS: 'ML',
  L: 'L',
  LTR: 'L',
  LTRS: 'L',
  LITRE: 'L',
  LITER: 'L',
  LITRES: 'L',
  LITERS: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  SLICE: 'SLICE',
  SLICES: 'SLICE',
};

const UOM_SCALE = {
  G: { family: 'WEIGHT', baseFactor: 1 },
  KG: { family: 'WEIGHT', baseFactor: 1000 },
  ML: { family: 'VOLUME', baseFactor: 1 },
  L: { family: 'VOLUME', baseFactor: 1000 },
  PCS: { family: 'COUNT', baseFactor: 1 },
  SLICE: { family: 'COUNT', baseFactor: 1 },
};

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function resolveWorkbookPath() {
  const requested = argValue('--workbook', DEFAULT_WORKBOOK);
  return path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested);
}

function resolveOptionalPath(requested) {
  if (!requested) return '';
  return path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested);
}

function requireRuntimeEnv() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required for Firestore reconciliation. No writes occur unless --apply is supplied.');
  }
}

function initializeAdmin() {
  const app = getApps().length > 0
    ? getApp()
    : initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  return getFirestore(app);
}

function text(value) {
  return String(value ?? '').trim();
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value) {
  const parsed = number(value, NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeId(value) {
  return text(value).toUpperCase();
}

function normalizeName(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function codeFromName(name) {
  return text(name)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function normalizeUom(value) {
  const raw = text(value).toUpperCase().replace(/\./g, '');
  return UOM_ALIASES[raw] || raw;
}

function sameOrConvertible(fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  return Boolean(fromMeta && toMeta && fromMeta.family === toMeta.family);
}

function categoryCode(value) {
  return codeFromName(value || 'FOOD');
}

function rowStatus(row) {
  return text(row.Status).toUpperCase();
}

function isReviewStatus(row) {
  return rowStatus(row) && rowStatus(row) !== 'OK';
}

function readRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) fail(`Workbook is missing required sheet: ${sheetName}`);
  return xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

function duplicateValues(rows, keyFn) {
  const seen = new Map();
  const duplicates = [];
  rows.forEach((row, index) => {
    const key = keyFn(row);
    if (!key) return;
    if (seen.has(key)) {
      duplicates.push({ key, firstRow: seen.get(key), duplicateRow: index + 2 });
    } else {
      seen.set(key, index + 2);
    }
  });
  return duplicates;
}

function mapByDocAndCode(docs) {
  const byCode = new Map();
  const byName = new Map();
  const byWorkbookId = new Map();
  const duplicateNames = new Map();

  docs.forEach((doc) => {
    const data = doc.data;
    const codes = [
      doc.id,
      data.code,
      data.workbookId,
      data.sourceWorkbookId,
      data.rawMaterialId,
      data.prepId,
      data.productId,
    ].map(normalizeId).filter(Boolean);
    codes.forEach((code) => byCode.set(code, doc));

    const nameKey = normalizeName(data.name || data.displayName);
    if (nameKey) {
      if (byName.has(nameKey)) {
        duplicateNames.set(nameKey, [...(duplicateNames.get(nameKey) || [byName.get(nameKey)]), doc]);
      } else {
        byName.set(nameKey, doc);
      }
    }
  });

  return { byCode, byName, byWorkbookId, duplicateNames };
}

function withCatalogSource(doc, sourceCatalog) {
  return { ...doc, sourceCatalog };
}

function findExactMatch(index, workbookId, name) {
  const idKey = normalizeId(workbookId);
  if (idKey && index.byCode.has(idKey)) return { doc: index.byCode.get(idKey), matchType: 'ID' };
  const nameKey = normalizeName(name);
  if (nameKey && index.byName.has(nameKey) && !index.duplicateNames.has(nameKey)) {
    return { doc: index.byName.get(nameKey), matchType: 'NORMALIZED_NAME' };
  }
  return null;
}

async function loadMappingFile(filePath, label) {
  const resolvedPath = resolveOptionalPath(filePath);
  if (!resolvedPath) return { path: '', mappings: [], rawMaterialDefinitions: [], prepItemDefinitions: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
    const mappings = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.mappings) ? parsed.mappings : []);
    const rawMaterialDefinitions = Array.isArray(parsed.rawMaterialDefinitions) ? parsed.rawMaterialDefinitions : [];
    const prepItemDefinitions = Array.isArray(parsed.prepItemDefinitions) ? parsed.prepItemDefinitions : [];
    return { path: resolvedPath, mappings, rawMaterialDefinitions, prepItemDefinitions };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: resolvedPath, mappings: [], rawMaterialDefinitions: [], prepItemDefinitions: [] };
    fail(`Could not read ${label} mapping file ${resolvedPath}: ${error.message || error}`);
  }
}

function approvalStatus(entry) {
  return text(entry.approvalStatus || entry.status).toUpperCase();
}

function isApprovedMapping(entry) {
  return APPROVED_STATUSES.has(approvalStatus(entry));
}

function componentMappingKey(entry) {
  return normalizeName(entry.componentName || entry.workbookComponentName || entry.sourceComponentName);
}

function productMappingKey(entry) {
  return normalizeId(entry.workbookProductId || entry.productId || entry.sourceProductId);
}

function assertNoMappingConflicts(mappings, keyFn, label) {
  const seen = new Map();
  mappings.forEach((entry) => {
    const key = keyFn(entry);
    if (!key) return;
    const target = normalizeId(entry.targetCode || entry.targetId || entry.targetFinishedGoodCode
      || (Array.isArray(entry.outputs) ? JSON.stringify(entry.outputs) : '')
      || (Array.isArray(entry.splitLines) ? JSON.stringify(entry.splitLines) : ''));
    const targetType = text(entry.targetType || entry.type
      || (Array.isArray(entry.outputs) ? 'OUTPUTS' : '')
      || (Array.isArray(entry.splitLines) ? 'SPLIT_LINES' : '')).toUpperCase();
    const previous = seen.get(key);
    const signature = `${targetType}:${target}`;
    if (previous && previous !== signature) {
      fail(`${label} mapping conflict for ${key}: ${previous} vs ${signature}`);
    }
    seen.set(key, signature);
  });
}

function buildComponentMappingIndex(mappingFile) {
  assertNoMappingConflicts(mappingFile.mappings, componentMappingKey, 'Component');
  const byComponentName = new Map();
  mappingFile.mappings.forEach((entry) => {
    const key = componentMappingKey(entry);
    if (!key) return;
    byComponentName.set(key, entry);
  });
  return { ...mappingFile, byComponentName };
}

function buildRawDefinitionPayload(definition) {
  const code = normalizeId(definition.code || definition.rawMaterialId);
  const name = text(definition.name);
  const baseUom = normalizeUom(definition.baseUOM || definition.usageUOM || 'G');
  const category = text(definition.category || 'KITCHEN');
  if (!code || !name) return null;
  return {
    code,
    name,
    category,
    purchaseUOM: normalizeUom(definition.purchaseUOM || baseUom),
    usageUOM: baseUom,
    conversionFactor: positiveNumber(definition.conversionFactor) || 1,
    supplierName: '',
    isInventoryTracked: definition.isInventoryTracked !== false,
    isActive: true,
    importSource: IMPORT_SOURCE,
    workbookId: text(definition.workbookId || `OWNER_DEFINED_${code}`),
    workbookStatus: approvalStatus(definition) || 'OWNER_APPROVED',
    workbookNotes: text(definition.notes || 'Owner-approved Phase 11A.2 raw material definition.'),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function hasCompletePrepDefinition(definition) {
  const code = normalizeId(definition.code || definition.prepId);
  const name = text(definition.name);
  const yieldQuantity = positiveNumber(definition.yieldQuantity || definition.defaultBatchSize || definition.batchOutputQty);
  const yieldUOM = normalizeUom(definition.yieldUOM || definition.outputUOM);
  return Boolean(code && name && yieldQuantity && yieldUOM && Array.isArray(definition.bom) && definition.bom.length > 0);
}

function buildPrepDefinitionPayload(definition) {
  if (!hasCompletePrepDefinition(definition)) return null;
  const code = normalizeId(definition.code || definition.prepId);
  const yieldQuantity = positiveNumber(definition.yieldQuantity || definition.defaultBatchSize || definition.batchOutputQty) || 1;
  const yieldUOM = normalizeUom(definition.yieldUOM || definition.outputUOM);
  return {
    code,
    name: text(definition.name),
    outputUOM: yieldUOM,
    defaultBatchSize: yieldQuantity,
    yieldQuantity,
    yieldUOM,
    isStockTracked: true,
    bom: definition.bom,
    bomVersion: 1,
    isActive: true,
    importSource: IMPORT_SOURCE,
    workbookId: text(definition.workbookId || `OWNER_DEFINED_${code}`),
    workbookStatus: approvalStatus(definition) || 'OWNER_APPROVED',
    workbookNotes: text(definition.notes || 'Owner-approved prep definition with complete recipe and yield.'),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function buildProductMappingIndex(mappingFile) {
  assertNoMappingConflicts(mappingFile.mappings, productMappingKey, 'Finished product');
  const byWorkbookProductId = new Map();
  mappingFile.mappings.forEach((entry) => {
    const key = productMappingKey(entry);
    if (!key) return;
    byWorkbookProductId.set(key, entry);
  });
  return { ...mappingFile, byWorkbookProductId };
}

function normalizeMappingTargetType(value) {
  const cleaned = text(value).toUpperCase();
  if (cleaned === 'RAW_MATERIAL' || cleaned === 'RAW_INGREDIENT') return 'RAW_INGREDIENT';
  if (cleaned === 'PREP' || cleaned === 'PREP_ITEM') return 'PREP_ITEM';
  return cleaned;
}

function mappingOutputs(entry) {
  if (Array.isArray(entry.outputs) && entry.outputs.length > 0) return entry.outputs;
  if (Array.isArray(entry.splitLines) && entry.splitLines.length > 0) return entry.splitLines;
  return [entry];
}

function resolveMappedComponent(row, componentMappings, rawIndex, prepIndex, mappingStats) {
  const componentName = text(row['Standard Component'] || row['Ingredient (Source)'] || row['Component (Source)']);
  const entry = componentMappings.byComponentName.get(normalizeName(componentName));
  if (!entry) return null;
  if (!isApprovedMapping(entry)) {
    return {
      type: 'UNRESOLVED',
      unresolved: true,
      reason: `Component mapping for ${componentName} is not approved`,
    };
  }

  const outputs = mappingOutputs(entry);
  if (outputs.length > 1) mappingStats.splitComponentRows += 1;
  else mappingStats.transformedComponentRows += 1;

  if (outputs.length > 1) {
    const splitLines = outputs.map((line) => resolveMappedLine(componentName, line, rawIndex, prepIndex, entry, mappingStats));
    return {
      splitLines,
      mappingSource: text(entry.mappingSource || 'MAPPING_FILE'),
      approvalStatus: approvalStatus(entry),
    };
  }

  return resolveMappedLine(componentName, outputs[0], rawIndex, prepIndex, entry, mappingStats);
}

function validateMappedTargetName(componentName, line, target) {
  const expectedName = text(line.targetName || line.name);
  if (!expectedName) return '';
  const actualName = text(target.data.name || target.data.displayName);
  if (!actualName || normalizeName(actualName) !== normalizeName(expectedName)) {
    return `Approved component mapping target name mismatch for ${componentName}: expected ${expectedName}, found ${actualName || 'blank'}`;
  }
  return '';
}

function resolveMappedLine(componentName, line, rawIndex, prepIndex, parentEntry, mappingStats) {
  const targetType = normalizeMappingTargetType(line.targetType || line.type);
  const targetCode = normalizeId(line.targetId || line.targetCode);
  const quantityOverride = positiveNumber(line.quantity ?? line.quantityOverride);
  const uomOverride = normalizeUom(line.unit || line.uomOverride);
  if (!targetCode) {
    mappingStats.invalidTransformationRows += 1;
    return {
      type: 'UNRESOLVED',
      unresolved: true,
      quantityOverride,
      uomOverride,
      reason: `Component mapping for ${componentName} has no target code`,
    };
  }

  const targetIndex = targetType === 'PREP_ITEM' ? prepIndex : rawIndex;
  const expectedType = targetType === 'PREP_ITEM' ? 'PREP_ITEM' : 'RAW_INGREDIENT';
  const target = targetIndex.byCode.get(targetCode);
  if (!target) {
    if (expectedType === 'PREP_ITEM') {
      return {
        type: expectedType,
        unresolved: true,
        quantityOverride,
        uomOverride,
        reason: `Prep item mapping target ${targetCode} requires a complete recipe and yield before import`,
      };
    }
    mappingStats.invalidTransformationRows += 1;
    return {
      type: expectedType,
      unresolved: true,
      quantityOverride,
      uomOverride,
      reason: `Approved component mapping target ${targetCode} not found`,
    };
  }

  const nameError = validateMappedTargetName(componentName, line, target);
  if (nameError) {
    mappingStats.invalidTransformationRows += 1;
    return {
      type: expectedType,
      unresolved: true,
      quantityOverride,
      uomOverride,
      reason: nameError,
    };
  }

  mappingStats.plannedTargetMappingsResolved += 1;
  if (target.sourceCatalog === 'OWNER_DEFINED_CREATE') mappingStats.mappingsResolvedAgainstOwnerDefinedCreates += 1;
  else if (target.sourceCatalog === 'WORKBOOK_PLANNED_CREATE') mappingStats.mappingsResolvedAgainstWorkbookPlannedCreates += 1;
  else mappingStats.mappingsResolvedAgainstExistingFirestore += 1;

  return {
    type: expectedType,
    code: target.data.code || target.id,
    name: target.data.name || target.data.displayName || componentName,
    doc: target,
    quantityOverride,
    uomOverride,
    mappingSource: text(parentEntry.mappingSource || line.mappingSource || 'MAPPING_FILE'),
    approvalStatus: approvalStatus(parentEntry) || approvalStatus(line),
  };
}

function findFinishedProductMatch(index, workbookId, name, productMappings) {
  const mapping = productMappings.byWorkbookProductId.get(normalizeId(workbookId));
  if (mapping) {
    if (!isApprovedMapping(mapping)) {
      fail(`Finished product mapping for ${workbookId} ${name} is not approved.`);
    }
    const targetCode = normalizeId(mapping.targetCode || mapping.targetFinishedGoodCode || mapping.targetId);
    const target = index.byCode.get(targetCode);
    if (!target) {
      fail(`Finished product mapping target ${targetCode} for ${workbookId} ${name} does not exist.`);
    }
    return { doc: target, matchType: 'PRODUCT_MAPPING', mapping };
  }
  return findExactMatch(index, workbookId, name);
}

function suggestions(index, name, limit = 5) {
  const target = normalizeName(name);
  if (!target) return [];
  const targetParts = new Set(target.split(' ').filter((part) => part.length > 2));
  const ranked = [];
  index.byName.forEach((doc, key) => {
    const parts = key.split(' ');
    const overlap = parts.filter((part) => targetParts.has(part)).length;
    if (overlap > 0 || key.includes(target) || target.includes(key)) {
      ranked.push({
        code: doc.data.code || doc.id,
        name: doc.data.name || doc.data.displayName || '',
        score: overlap + (key.includes(target) || target.includes(key) ? 2 : 0),
      });
    }
  });
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

function bomType(value) {
  const cleaned = text(value).toUpperCase();
  if (cleaned.includes('PREP')) return 'PREP_ITEM';
  if (cleaned.includes('RAW')) return 'RAW_INGREDIENT';
  if (cleaned.includes('DIRECT') || cleaned.includes('MANUAL')) return 'UNRESOLVED';
  return 'UNRESOLVED';
}

function buildWorkbookModel(workbookPath) {
  const workbook = xlsx.readFile(workbookPath, { cellDates: true, raw: false });
  const sheetNames = new Set(workbook.SheetNames);
  Object.values(REQUIRED_SHEETS).forEach((sheet) => {
    if (!sheetNames.has(sheet)) fail(`Workbook is missing required sheet: ${sheet}`);
  });

  const rawRows = readRows(workbook, REQUIRED_SHEETS.raw);
  const prepRows = readRows(workbook, REQUIRED_SHEETS.prep);
  const prepBomRows = readRows(workbook, REQUIRED_SHEETS.prepBom);
  const finalRows = readRows(workbook, REQUIRED_SHEETS.final);
  const finalBomRows = readRows(workbook, REQUIRED_SHEETS.finalBom);
  const reviewRows = readRows(workbook, REQUIRED_SHEETS.review);

  return {
    workbookPath,
    rawRows,
    prepRows,
    prepBomRows,
    finalRows,
    finalBomRows,
    reviewRows,
    duplicates: {
      rawIds: duplicateValues(rawRows, (row) => normalizeId(row['Raw Material ID'])),
      rawNames: duplicateValues(rawRows, (row) => normalizeName(row['Standard Ingredient'])),
      prepIds: duplicateValues(prepRows, (row) => normalizeId(row['Prep ID'])),
      prepNames: duplicateValues(prepRows, (row) => normalizeName(row['Prep Recipe'])),
      finalIds: duplicateValues(finalRows, (row) => normalizeId(row['Product ID'])),
      finalNames: duplicateValues(finalRows, (row) => normalizeName(row['Menu Item'])),
    },
  };
}

async function loadFirestoreData(firestore) {
  const [rawSnap, prepSnap, finishedSnap, storeSnap] = await Promise.all([
    firestore.collection('rawIngredients').get(),
    firestore.collection('prepItems').get(),
    firestore.collection('finishedGoods').get(),
    firestore.collection('stores').get(),
  ]);

  const toDocs = (snap) => snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() || {} }));

  return {
    rawDocs: toDocs(rawSnap),
    prepDocs: toDocs(prepSnap),
    finishedDocs: toDocs(finishedSnap),
    storeDocs: toDocs(storeSnap),
  };
}

function buildRawPayload(row, match) {
  const workbookId = normalizeId(row['Raw Material ID']);
  const name = text(row['Standard Ingredient']);
  const baseUom = normalizeUom(row['Preferred Base UOM']);
  const packUom = normalizeUom(row['Pack UOM']) || baseUom;
  const packQty = positiveNumber(row['Pack Qty']) || 1;
  const packPrice = positiveNumber(row['Pack Price']);
  const activeRate = positiveNumber(row['Active Rate / Base UOM']);
  const existing = match?.doc?.data || {};
  const existingCost = positiveNumber(existing.costPerUsageUnit);
  const costPerUsageUnit = activeRate ?? existingCost ?? 0;
  const purchaseCost = packPrice ?? positiveNumber(existing.purchaseCost) ?? (costPerUsageUnit > 0 ? costPerUsageUnit * packQty : 0);

  const payload = {
    code: existing.code || workbookId,
    name: name || existing.name || workbookId,
    category: existing.category || 'KITCHEN',
    purchaseUOM: packUom || existing.purchaseUOM || baseUom || 'G',
    usageUOM: baseUom || existing.usageUOM || packUom || 'G',
    conversionFactor: packQty || positiveNumber(existing.conversionFactor) || 1,
    supplierName: existing.supplierName || '',
    isActive: existing.isActive !== false,
    importSource: IMPORT_SOURCE,
    workbookId,
    workbookStatus: rowStatus(row),
    workbookNotes: text(row.Notes),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (APPLY_COSTS) {
    payload.purchaseCost = purchaseCost;
    payload.costPerUsageUnit = costPerUsageUnit;
  }
  return payload;
}

function componentUnitForResolved(resolved) {
  if (!resolved) return '';
  if (resolved.type === 'RAW_INGREDIENT') return normalizeUom(resolved.doc?.data.usageUOM || resolved.payload?.usageUOM);
  return normalizeUom(resolved.doc?.data.yieldUOM || resolved.doc?.data.outputUOM || resolved.payload?.yieldUOM || resolved.payload?.outputUOM);
}

function resolveComponent(row, rawIndex, prepIndex, rawPayloadsByWorkbookId, prepPayloadsByWorkbookId, componentMappings, mappingStats) {
  const type = bomType(row['Component Type']);
  const linkedId = normalizeId(row['Linked ID']);
  const componentName = text(row['Standard Component'] || row['Ingredient (Source)'] || row['Component (Source)']);
  const mappedComponent = resolveMappedComponent(row, componentMappings, rawIndex, prepIndex, mappingStats);
  if (mappedComponent) return mappedComponent;

  if (type === 'RAW_INGREDIENT') {
    const payload = rawPayloadsByWorkbookId.get(linkedId);
    if (payload) return { type, code: payload.code, name: payload.name, payload };
    const match = findExactMatch(rawIndex, linkedId, componentName);
    if (match) return { type, code: match.doc.data.code || match.doc.id, name: match.doc.data.name || componentName, doc: match.doc };
    return { type, unresolved: true, reason: linkedId ? `Raw material ID ${linkedId} not found` : 'Raw material has no linked ID or exact name match' };
  }

  if (type === 'PREP_ITEM') {
    const payload = prepPayloadsByWorkbookId.get(linkedId);
    if (payload) return { type, code: payload.code, name: payload.name, payload };
    const match = findExactMatch(prepIndex, linkedId, componentName);
    if (match) return { type, code: match.doc.data.code || match.doc.id, name: match.doc.data.name || componentName, doc: match.doc };
    return { type, unresolved: true, reason: linkedId ? `Prep item ID ${linkedId} not found` : 'Prep item has no linked ID or exact name match' };
  }

  const rawMatch = findExactMatch(rawIndex, '', componentName);
  if (rawMatch) return { type: 'RAW_INGREDIENT', code: rawMatch.doc.data.code || rawMatch.doc.id, name: rawMatch.doc.data.name || componentName, doc: rawMatch.doc };
  const prepMatch = findExactMatch(prepIndex, '', componentName);
  if (prepMatch) return { type: 'PREP_ITEM', code: prepMatch.doc.data.code || prepMatch.doc.id, name: prepMatch.doc.data.name || componentName, doc: prepMatch.doc };

  return { type: 'UNRESOLVED', unresolved: true, reason: 'Direct/manual component has no linked ID and no exact normalized master match' };
}

function buildBomLine(row, resolved, parentLabel, sourceSheet, unresolved, unitBlockers, mappingStats) {
  const qtyInBase = positiveNumber(row['Qty in Linked Base UOM']);
  const rawQty = positiveNumber(row.Qty);
  const linkedUnit = componentUnitForResolved(resolved);
  const rowUom = normalizeUom(row.UOM);
  const quantity = positiveNumber(resolved?.quantityOverride) ?? qtyInBase ?? rawQty ?? 0;
  const uom = normalizeUom(resolved?.uomOverride) || (qtyInBase && linkedUnit ? linkedUnit : rowUom);

  if (!resolved || resolved.unresolved) {
    const componentName = text(row['Standard Component'] || row['Ingredient (Source)'] || row['Component (Source)']);
    const componentKey = componentReviewKey(componentName);
    const isMissingPrepRecipe = PROPOSED_PREP_COMPONENTS.has(componentKey)
      || /requires a complete recipe and yield/i.test(resolved?.reason || '');
    unresolved.push({
      parent: parentLabel,
      componentName,
      workbookRow: row.__rowNumber,
      sourceFile: sourceSheet,
      linkedId: text(row['Linked ID']),
      componentType: text(row['Component Type']),
      quantity: positiveNumber(resolved?.quantityOverride) ?? rawQty ?? '',
      requiredUnit: normalizeUom(resolved?.uomOverride) || rowUom,
      reason: isMissingPrepRecipe
        ? 'Required PREP_ITEM has no approved recipe and batch yield'
        : (resolved?.reason || 'Component unresolved'),
    });
    return null;
  }

  if (!quantity || quantity <= 0) {
    if (resolved?.mappingSource) mappingStats.invalidTransformationRows += 1;
    unresolved.push({
      parent: parentLabel,
      componentName: resolved.name,
      workbookRow: row.__rowNumber,
      sourceFile: sourceSheet,
      linkedId: text(row['Linked ID']),
      componentType: resolved.type,
      quantity: rawQty ?? '',
      requiredUnit: rowUom,
      reason: 'Missing or invalid quantity',
    });
    return null;
  }

  if (!qtyInBase && linkedUnit && rowUom && !sameOrConvertible(rowUom, linkedUnit)) {
    if (resolved?.uomOverride && sameOrConvertible(uom, linkedUnit)) {
      // Owner-approved mapping unit override resolves the workbook unit mismatch.
    } else {
      unitBlockers.push({
        parent: parentLabel,
        componentName: resolved.name,
        workbookRow: row.__rowNumber,
        sourceFile: sourceSheet,
        linkedId: text(row['Linked ID']),
        componentType: resolved.type,
        quantity: rawQty ?? '',
        requiredUnit: rowUom,
        linkedUnit,
        reason: `Cannot convert ${rowUom} to ${linkedUnit}`,
      });
      return null;
    }
  }

  const costPerUnit = positiveNumber(row['Linked Unit Cost']) ?? positiveNumber(row['Active Rate / Linked UOM']) ?? 0;
  const lineCost = positiveNumber(row['Calculated Line Cost']) ?? positiveNumber(row['Source Line Cost']) ?? Number((costPerUnit * quantity).toFixed(4));

  const line = {
    componentType: resolved.type,
    componentCode: resolved.code,
    componentName: resolved.name,
    quantity,
    uom,
    workbookStatus: rowStatus(row),
    workbookNotes: text(row.Notes),
  };
  if (APPLY_COSTS) {
    line.costPerUnit = costPerUnit;
    line.lineCost = lineCost;
  }
  return line;
}

function buildBomLines(row, resolved, parentLabel, sourceSheet, unresolved, unitBlockers, mappingStats) {
  if (resolved?.splitLines) {
    return resolved.splitLines
      .map((lineResolved) => buildBomLine(row, lineResolved, parentLabel, sourceSheet, unresolved, unitBlockers, mappingStats))
      .filter(Boolean);
  }
  const line = buildBomLine(row, resolved, parentLabel, sourceSheet, unresolved, unitBlockers, mappingStats);
  return line ? [line] : [];
}

function addRowNumbers(rows) {
  return rows.map((row, index) => ({ ...row, __rowNumber: index + 2 }));
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function prepHasCircularDependency(prepCode, graph, pathStack = []) {
  if (pathStack.includes(prepCode)) return [...pathStack, prepCode];
  const children = graph.get(prepCode) || [];
  for (const child of children) {
    const found = prepHasCircularDependency(child, graph, [...pathStack, prepCode]);
    if (found) return found;
  }
  return null;
}

function canonicalForCompare(value) {
  if (value && typeof value === 'object') {
    if ('_methodName' in value) return '[serverTimestamp]';
    if (Array.isArray(value)) return value.map(canonicalForCompare);
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['updatedAt', 'createdAt'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, canonicalForCompare(val)]));
  }
  return value;
}

function isMeaningfullySame(current, proposed) {
  const merged = { ...(current || {}), ...(proposed || {}) };
  return JSON.stringify(canonicalForCompare(current || {})) === JSON.stringify(canonicalForCompare(merged));
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function componentReviewKey(value) {
  return normalizeName(value)
    .replace(/\brellish\b/g, 'relish')
    .replace(/\bchesse\b/g, 'cheese')
    .replace(/\bseasme\b/g, 'sesame');
}

function classifyComponentRow(row) {
  const rawName = text(row.componentName);
  const key = componentReviewKey(rawName);
  const deterministic = DETERMINISTIC_ALIAS_COMPONENTS.get(normalizeName(rawName));
  const unitDecision = UNIT_DECISION_COMPONENTS.has(key) || /Cannot convert/i.test(row.reason || '');

  if (/Approved component mapping target .* not found/i.test(row.reason || '')) {
    return {
      classification: 'approved mapping target missing',
      targetType: text(row.componentType).toUpperCase(),
      targetCode: '',
      approvalStatus: 'BLOCKED_TARGET_MISSING',
      decisionNeeded: 'Create or correct the approved target master before import can proceed.',
    };
  }

  if (COMPOSITE_COMPONENTS.has(key)) {
    return {
      classification: 'composite BOM line that must be split',
      targetType: '',
      targetCode: '',
      approvalStatus: 'OWNER_DECISION_REQUIRED',
      decisionNeeded: 'Split into separate ingredient BOM rows with approved quantities.',
    };
  }

  if (unitDecision) {
    return {
      classification: 'ambiguous and requiring owner approval',
      targetType: '',
      targetCode: '',
      approvalStatus: 'OWNER_DECISION_REQUIRED',
      decisionNeeded: 'Approve unit conversion/yield before mapping.',
    };
  }

  if (deterministic) {
    return {
      classification: deterministic.targetType === 'PREP_ITEM'
        ? 'deterministic alias to existing PREP_ITEM'
        : 'deterministic alias to existing RAW_MATERIAL',
      targetType: deterministic.targetType,
      targetCode: deterministic.targetCode,
      approvalStatus: 'APPROVED_DETERMINISTIC',
      decisionNeeded: deterministic.note,
    };
  }

  if (PROPOSED_PREP_COMPONENTS.has(key)) {
    return {
      classification: 'new PREP_ITEM required',
      targetType: 'PREP_ITEM',
      targetCode: codeFromName(rawName),
      approvalStatus: 'OWNER_DECISION_REQUIRED',
      decisionNeeded: 'Create prep item only after recipe, yield and production unit are approved.',
    };
  }

  if (PROPOSED_RAW_COMPONENTS.has(key)) {
    return {
      classification: 'new RAW_MATERIAL required',
      targetType: 'RAW_INGREDIENT',
      targetCode: codeFromName(rawName),
      approvalStatus: 'OWNER_DECISION_REQUIRED',
      decisionNeeded: 'Create raw material only after purchase/usage UOM and costing basis are approved.',
    };
  }

  if (/garnish/i.test(rawName)) {
    return {
      classification: 'non-inventory instruction/garnish',
      targetType: '',
      targetCode: '',
      approvalStatus: 'OWNER_DECISION_REQUIRED',
      decisionNeeded: 'Confirm whether this is a non-stock garnish note or a stock-tracked ingredient.',
    };
  }

  return {
    classification: 'ambiguous and requiring owner approval',
    targetType: '',
    targetCode: '',
    approvalStatus: 'OWNER_DECISION_REQUIRED',
    decisionNeeded: 'Owner must choose an existing master, create a new master, or split the workbook line.',
  };
}

function buildReviewReports(unresolvedRows) {
  const mappingReviewRows = [];
  const newRawRows = [];
  const newPrepRows = [];
  const compositeRows = [];
  const unitBlockerRows = [];
  const classificationCounts = {};

  unresolvedRows.forEach((row) => {
    const decision = classifyComponentRow(row);
    classificationCounts[decision.classification] = (classificationCounts[decision.classification] || 0) + 1;
    const reviewRow = {
      parent: row.parent,
      componentName: row.componentName,
      workbookRow: row.workbookRow,
      sourceFile: row.sourceFile,
      linkedId: row.linkedId,
      componentType: row.componentType,
      quantity: row.quantity,
      requiredUnit: row.requiredUnit,
      linkedUnit: row.linkedUnit || '',
      reason: row.reason,
      classification: decision.classification,
      targetType: decision.targetType,
      targetCode: decision.targetCode,
      approvalStatus: decision.approvalStatus,
      mappingSource: decision.approvalStatus === 'APPROVED_DETERMINISTIC' ? 'DETERMINISTIC_ALIAS' : 'OWNER_REVIEW',
      decisionNeeded: decision.decisionNeeded,
      suggestedMatches: row.suggestedMatches || '',
    };
    mappingReviewRows.push(reviewRow);

    if (decision.classification === 'new RAW_MATERIAL required') {
      newRawRows.push({
        code: decision.targetCode,
        name: row.componentName,
        seenInParent: row.parent,
        sourceFile: row.sourceFile,
        exampleQuantity: row.quantity,
        exampleUOM: row.requiredUnit,
        suggestedPurchaseUOM: '',
        suggestedUsageUOM: row.requiredUnit,
        suggestedConversionFactor: '',
        notes: decision.decisionNeeded,
      });
    }

    if (decision.classification === 'new PREP_ITEM required') {
      newPrepRows.push({
        code: decision.targetCode,
        name: row.componentName,
        seenInParent: row.parent,
        sourceFile: row.sourceFile,
        exampleQuantity: row.quantity,
        exampleUOM: row.requiredUnit,
        requiredYieldUOM: row.requiredUnit,
        notes: decision.decisionNeeded,
      });
    }

    if (decision.classification === 'composite BOM line that must be split') {
      compositeRows.push({
        parent: row.parent,
        componentName: row.componentName,
        originalQuantity: row.quantity,
        originalUOM: row.requiredUnit,
        sourceFile: row.sourceFile,
        requiredSplitDecision: decision.decisionNeeded,
      });
    }

    if (/Cannot convert/i.test(row.reason || '')) {
      unitBlockerRows.push({
        parent: row.parent,
        componentName: row.componentName,
        originalQuantity: row.quantity,
        originalUOM: row.requiredUnit,
        linkedUnit: row.linkedUnit || '',
        sourceFile: row.sourceFile,
        blockerReason: row.reason,
        requiredDecision: decision.decisionNeeded,
      });
    }
  });

  const uniqueByCode = (rows) => {
    const seen = new Map();
    rows.forEach((row) => {
      if (!seen.has(row.code)) seen.set(row.code, row);
    });
    return [...seen.values()];
  };

  return {
    mappingReviewRows,
    newRawRows: uniqueByCode(newRawRows),
    newPrepRows: uniqueByCode(newPrepRows),
    compositeRows,
    unitBlockerRows,
    classificationCounts,
  };
}

async function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  });
  await fs.writeFile(filePath, `${lines.join('\n')}\n`);
}

async function writeReports(summary, unresolvedRows, costRows, existingMissingRows) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const reviewReports = buildReviewReports(unresolvedRows);
  await fs.writeFile(path.join(REPORT_DIR, 'kitchen-bom-import-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-unresolved-components.csv'), unresolvedRows, [
    'parent',
    'componentName',
    'workbookRow',
    'sourceFile',
    'linkedId',
    'componentType',
    'quantity',
    'requiredUnit',
    'reason',
    'suggestedMatches',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-mapping-review.csv'), reviewReports.mappingReviewRows, [
    'parent',
    'componentName',
    'workbookRow',
    'sourceFile',
    'linkedId',
    'componentType',
    'quantity',
    'requiredUnit',
    'linkedUnit',
    'reason',
    'classification',
    'targetType',
    'targetCode',
    'approvalStatus',
    'mappingSource',
    'decisionNeeded',
    'suggestedMatches',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-new-raw-materials.csv'), reviewReports.newRawRows, [
    'code',
    'name',
    'seenInParent',
    'sourceFile',
    'exampleQuantity',
    'exampleUOM',
    'suggestedPurchaseUOM',
    'suggestedUsageUOM',
    'suggestedConversionFactor',
    'notes',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-new-prep-items.csv'), reviewReports.newPrepRows, [
    'code',
    'name',
    'seenInParent',
    'sourceFile',
    'exampleQuantity',
    'exampleUOM',
    'requiredYieldUOM',
    'notes',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-composite-lines.csv'), reviewReports.compositeRows, [
    'parent',
    'componentName',
    'originalQuantity',
    'originalUOM',
    'sourceFile',
    'requiredSplitDecision',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-unit-blockers.csv'), reviewReports.unitBlockerRows, [
    'parent',
    'componentName',
    'originalQuantity',
    'originalUOM',
    'linkedUnit',
    'sourceFile',
    'blockerReason',
    'requiredDecision',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-cost-variance.csv'), costRows, [
    'collection',
    'code',
    'name',
    'workbookCost',
    'currentFirestoreCost',
    'proposedCost',
    'variance',
    'reviewStatus',
    'notes',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'kitchen-bom-existing-products-not-in-workbook.csv'), existingMissingRows, [
    'code',
    'name',
    'category',
    'prepStation',
    'isActive',
    'isSellable',
    'availableStoreIds',
    'reason',
  ]);
}

async function commitInBatches(firestore, operations) {
  let batch = firestore.batch();
  let count = 0;
  for (const operation of operations) {
    batch.set(operation.ref, operation.payload, { merge: true });
    count += 1;
    if (count === 450) {
      await batch.commit();
      batch = firestore.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

async function main() {
  const workbookPath = resolveWorkbookPath();
  const componentMappingPath = argValue('--mappings', DEFAULT_COMPONENT_MAPPING_PATH);
  const productMappingPath = argValue('--product-mappings', DEFAULT_PRODUCT_MAPPING_PATH);
  requireRuntimeEnv();

  const model = buildWorkbookModel(workbookPath);
  const firestore = initializeAdmin();
  const data = await loadFirestoreData(firestore);
  const componentMappings = buildComponentMappingIndex(await loadMappingFile(componentMappingPath, 'component'));
  const productMappings = buildProductMappingIndex(await loadMappingFile(productMappingPath, 'finished product'));

  const rawIndex = mapByDocAndCode(data.rawDocs);
  const prepIndex = mapByDocAndCode(data.prepDocs);
  const finishedIndex = mapByDocAndCode(data.finishedDocs);
  const prepRowsById = groupBy(addRowNumbers(model.prepBomRows), (row) => normalizeId(row['Prep ID']));
  const finalRowsById = groupBy(addRowNumbers(model.finalBomRows), (row) => normalizeId(row['Product ID']));

  const rawPayloadsByWorkbookId = new Map();
  const rawOperations = [];
  const prepPayloadsByWorkbookId = new Map();
  const prepMatchesByWorkbookId = new Map();
  const ownerPrepDefinitionPayloads = [];
  const prepOperations = [];
  const finalOperations = [];
  const unresolved = [];
  const unitBlockers = [];
  const costVariance = [];
  const mappingStats = {
    plannedTargetMappingsResolved: 0,
    mappingsResolvedAgainstExistingFirestore: 0,
    mappingsResolvedAgainstWorkbookPlannedCreates: 0,
    mappingsResolvedAgainstOwnerDefinedCreates: 0,
    transformedComponentRows: 0,
    splitComponentRows: 0,
    invalidTransformationRows: 0,
  };
  const blockedFinalProductIds = new Set();
  const blockedPrepIds = new Set();
  const matchedFinalWorkbookIds = new Set();
  const ownerRawDefinitionPayloads = [];

  for (const row of model.rawRows) {
    const workbookId = normalizeId(row['Raw Material ID']);
    const name = text(row['Standard Ingredient']);
    if (!workbookId || !name) continue;
    const match = findExactMatch(rawIndex, workbookId, name);
    const payload = buildRawPayload(row, match);
    rawPayloadsByWorkbookId.set(workbookId, payload);
    const ref = match?.doc?.ref || firestore.collection('rawIngredients').doc(payload.code);
    const currentCost = positiveNumber(match?.doc?.data.costPerUsageUnit) ?? 0;
    const proposedCost = positiveNumber(row['Active Rate / Base UOM']) ?? currentCost;
    costVariance.push({
      collection: 'rawIngredients',
      code: payload.code,
      name: payload.name,
      workbookCost: positiveNumber(row['Active Rate / Base UOM']) ?? '',
      currentFirestoreCost: currentCost,
      proposedCost,
      variance: Number((proposedCost - currentCost).toFixed(4)),
      reviewStatus: rowStatus(row),
      notes: text(row.Notes),
    });
    if (!match?.doc || !isMeaningfullySame(match.doc.data, payload)) {
      rawOperations.push({ ref, payload, action: match?.doc ? 'UPDATE' : 'CREATE' });
    }
  }

  for (const definition of componentMappings.rawMaterialDefinitions) {
    if (!isApprovedMapping(definition)) continue;
    const payload = buildRawDefinitionPayload(definition);
    if (!payload) continue;
    const match = rawIndex.byCode.get(payload.code);
    ownerRawDefinitionPayloads.push(payload);
    const ref = match?.ref || firestore.collection('rawIngredients').doc(payload.code);
    if (!match || !isMeaningfullySame(match.data, payload)) {
      rawOperations.push({ ref, payload, action: match ? 'UPDATE' : 'CREATE' });
    }
  }

  const rawCombinedIndex = mapByDocAndCode([
    ...data.rawDocs.map((doc) => withCatalogSource(doc, 'EXISTING_FIRESTORE')),
    ...[...rawPayloadsByWorkbookId.values()].map((payload) => ({
      id: payload.code,
      ref: firestore.collection('rawIngredients').doc(payload.code),
      data: payload,
      sourceCatalog: 'WORKBOOK_PLANNED_CREATE',
    })),
    ...ownerRawDefinitionPayloads.map((payload) => ({
      id: payload.code,
      ref: firestore.collection('rawIngredients').doc(payload.code),
      data: payload,
      sourceCatalog: 'OWNER_DEFINED_CREATE',
    })),
  ]);

  for (const row of model.prepRows) {
    const workbookId = normalizeId(row['Prep ID']);
    const name = text(row['Prep Recipe']);
    if (!workbookId || !name) continue;
    const match = findExactMatch(prepIndex, workbookId, name);
    prepMatchesByWorkbookId.set(workbookId, match);
    const code = match?.doc?.data.code || workbookId;
    const yieldQuantity = positiveNumber(row['Batch Output Qty']) || positiveNumber(match?.doc?.data.yieldQuantity) || 1;
    const costPerUnit = positiveNumber(row['Cost / Output Unit'])
      ?? (positiveNumber(row['Calculated Batch Cost']) ? Number((positiveNumber(row['Calculated Batch Cost']) / yieldQuantity).toFixed(4)) : null)
      ?? positiveNumber(match?.doc?.data.costPerUnit)
      ?? 0;
    prepPayloadsByWorkbookId.set(workbookId, {
      code,
      name,
      outputUOM: normalizeUom(row['Output UOM']) || match?.doc?.data.outputUOM || 'G',
      defaultBatchSize: yieldQuantity,
      yieldQuantity,
      yieldUOM: normalizeUom(row['Output UOM']) || match?.doc?.data.yieldUOM || 'G',
      isStockTracked: true,
      bom: [],
      bomVersion: Number(match?.doc?.data.bomVersion || 0),
      isActive: match?.doc?.data.isActive !== false,
    });
    if (APPLY_COSTS) {
      prepPayloadsByWorkbookId.get(workbookId).costPerUnit = costPerUnit;
    }
  }

  for (const definition of componentMappings.prepItemDefinitions) {
    if (!isApprovedMapping(definition)) continue;
    const payload = buildPrepDefinitionPayload(definition);
    if (!payload) continue;
    const match = prepIndex.byCode.get(payload.code);
    ownerPrepDefinitionPayloads.push(payload);
    const ref = match?.ref || firestore.collection('prepItems').doc(payload.code);
    if (!match || !isMeaningfullySame(match.data, payload)) {
      prepOperations.push({ ref, payload, action: match ? 'UPDATE' : 'CREATE' });
    }
  }

  for (const row of model.prepRows) {
    const workbookId = normalizeId(row['Prep ID']);
    const name = text(row['Prep Recipe']);
    if (!workbookId || !name) continue;
    const match = prepMatchesByWorkbookId.get(workbookId);
    const bomRows = prepRowsById.get(workbookId) || [];
    const bom = [];

    for (const bomRow of bomRows) {
      const resolved = resolveComponent(bomRow, rawCombinedIndex, prepIndex, rawPayloadsByWorkbookId, prepPayloadsByWorkbookId, componentMappings, mappingStats);
      bom.push(...buildBomLines(bomRow, resolved, `${workbookId} ${name}`, REQUIRED_SHEETS.prepBom, unresolved, unitBlockers, mappingStats));
    }

    const hasBlocker = unresolved.some((rowItem) => String(rowItem.parent).startsWith(`${workbookId} `))
      || unitBlockers.some((rowItem) => String(rowItem.parent).startsWith(`${workbookId} `));
    if (hasBlocker) blockedPrepIds.add(workbookId);

    const yieldQuantity = positiveNumber(row['Batch Output Qty']) || positiveNumber(match?.doc?.data.yieldQuantity) || 1;
    const costPerUnit = positiveNumber(row['Cost / Output Unit'])
      ?? (positiveNumber(row['Calculated Batch Cost']) ? Number((positiveNumber(row['Calculated Batch Cost']) / yieldQuantity).toFixed(4)) : null)
      ?? positiveNumber(match?.doc?.data.costPerUnit)
      ?? 0;
    const code = match?.doc?.data.code || workbookId;
    const payload = {
      code,
      name: name || match?.doc?.data.name || workbookId,
      outputUOM: normalizeUom(row['Output UOM']) || match?.doc?.data.outputUOM || 'G',
      defaultBatchSize: yieldQuantity,
      yieldQuantity,
      yieldUOM: normalizeUom(row['Output UOM']) || match?.doc?.data.yieldUOM || 'G',
      isStockTracked: true,
      bom,
      bomVersion: Number(match?.doc?.data.bomVersion || 0) + 1,
      isActive: match?.doc?.data.isActive !== false,
      importSource: IMPORT_SOURCE,
      workbookId,
      workbookStatus: rowStatus(row),
      workbookNotes: text(row.Notes),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (APPLY_COSTS) {
      payload.costPerUnit = costPerUnit;
    }
    prepPayloadsByWorkbookId.set(workbookId, payload);
    const ref = match?.doc?.ref || firestore.collection('prepItems').doc(code);
    const currentCost = positiveNumber(match?.doc?.data.costPerUnit) ?? 0;
    costVariance.push({
      collection: 'prepItems',
      code,
      name: payload.name,
      workbookCost: positiveNumber(row['Cost / Output Unit']) ?? '',
      currentFirestoreCost: currentCost,
      proposedCost: costPerUnit,
      variance: Number((costPerUnit - currentCost).toFixed(4)),
      reviewStatus: rowStatus(row),
      notes: text(row.Notes),
    });
    if (!hasBlocker && (!match?.doc || !isMeaningfullySame(match.doc.data, payload))) {
      prepOperations.push({ ref, payload, action: match?.doc ? 'UPDATE' : 'CREATE' });
    }
  }

  const prepCombinedIndex = mapByDocAndCode([
    ...data.prepDocs.map((doc) => withCatalogSource(doc, 'EXISTING_FIRESTORE')),
    ...[...prepPayloadsByWorkbookId.values()].map((payload) => ({
      id: payload.code,
      ref: firestore.collection('prepItems').doc(payload.code),
      data: payload,
      sourceCatalog: 'WORKBOOK_PLANNED_CREATE',
    })),
    ...ownerPrepDefinitionPayloads.map((payload) => ({
      id: payload.code,
      ref: firestore.collection('prepItems').doc(payload.code),
      data: payload,
      sourceCatalog: 'OWNER_DEFINED_CREATE',
    })),
  ]);

  const prepGraph = new Map();
  for (const [prepId, bomRows] of prepRowsById.entries()) {
    const childPrepIds = bomRows
      .filter((row) => bomType(row['Component Type']) === 'PREP_ITEM')
      .map((row) => normalizeId(row['Linked ID']))
      .filter(Boolean);
    prepGraph.set(prepId, childPrepIds);
  }
  const circularDependencies = [];
  prepGraph.forEach((_, prepId) => {
    const cycle = prepHasCircularDependency(prepId, prepGraph);
    if (cycle) circularDependencies.push(cycle.join(' -> '));
  });

  for (const row of model.finalRows) {
    const workbookId = normalizeId(row['Product ID']);
    const name = text(row['Menu Item']);
    if (!workbookId || !name) continue;
    const match = findFinishedProductMatch(finishedIndex, workbookId, name, productMappings);
    if (match) matchedFinalWorkbookIds.add(match.doc.id);
    const bomRows = finalRowsById.get(workbookId) || [];
    const bom = [];

    for (const bomRow of bomRows) {
      const resolved = resolveComponent(bomRow, rawCombinedIndex, prepCombinedIndex, rawPayloadsByWorkbookId, prepPayloadsByWorkbookId, componentMappings, mappingStats);
      bom.push(...buildBomLines(bomRow, resolved, `${workbookId} ${name}`, REQUIRED_SHEETS.finalBom, unresolved, unitBlockers, mappingStats));
    }

    const hasBlocker = unresolved.some((rowItem) => String(rowItem.parent).startsWith(`${workbookId} `))
      || unitBlockers.some((rowItem) => String(rowItem.parent).startsWith(`${workbookId} `));
    if (hasBlocker) blockedFinalProductIds.add(workbookId);

    const existing = match?.doc?.data || {};
    const workbookSalePrice = positiveNumber(row['Selling Price (Input)']);
    const salePrice = workbookSalePrice ?? positiveNumber(existing.salePrice) ?? 0;
    const recipeCost = positiveNumber(row['Calculated Cost']) ?? positiveNumber(row['Source Line Sum']) ?? bom.reduce((sum, line) => sum + number(line.lineCost), 0);
    const taxRate = positiveNumber(existing.taxRate) ?? 5;
    const category = text(row.Category) || existing.posCategoryName || 'Food';
    const code = existing.code || workbookId;
    const hasSafePrice = salePrice > 0;
    const existingStoreIds = Array.isArray(existing.availableStoreIds) ? existing.availableStoreIds : [];
    const preservedStoreIds = existingStoreIds.filter(Boolean);
    const existingSellable = existing.isSellable === true;
    const nextSellable = hasBlocker ? existingSellable : (match?.doc ? existingSellable : hasSafePrice);
    const nextAvailable = hasBlocker ? existing.isAvailable === true : (match?.doc ? existing.isAvailable !== false : hasSafePrice);

    const payload = {
      code,
      name,
      displayName: existing.displayName || name,
      description: existing.description || '',
      posCategoryCode: existing.posCategoryCode || categoryCode(category),
      posCategoryName: existing.posCategoryName || category,
      salePrice,
      productionMode: existing.productionMode || 'MADE_TO_ORDER',
      itemType: existing.itemType || 'MADE_TO_ORDER',
      prepStation: existing.prepStation || 'KITCHEN',
      taxRate,
      bom: hasBlocker ? (Array.isArray(existing.bom) ? existing.bom : []) : bom,
      bomVersion: Number(existing.bomVersion || 0) + (hasBlocker ? 0 : 1),
      sortOrder: typeof existing.sortOrder === 'number' ? existing.sortOrder : 999,
      availableStoreIds: preservedStoreIds,
      isSellable: nextSellable,
      isAvailable: nextAvailable,
      isActive: existing.isActive !== false,
      importSource: IMPORT_SOURCE,
      workbookId,
      workbookStatus: rowStatus(row),
      workbookNotes: text(row.Notes),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (APPLY_COSTS) {
      payload.recipeCost = recipeCost;
      payload.grossMargin = salePrice > 0 ? Number((((salePrice - recipeCost) / salePrice) * 100).toFixed(2)) : 0;
      payload.cogsPercent = salePrice > 0 ? Number(((recipeCost / salePrice) * 100).toFixed(2)) : 0;
    }

    const currentCost = positiveNumber(existing.recipeCost) ?? 0;
    costVariance.push({
      collection: 'finishedGoods',
      code,
      name,
      workbookCost: positiveNumber(row['Calculated Cost']) ?? '',
      currentFirestoreCost: currentCost,
      proposedCost: recipeCost,
      variance: Number((recipeCost - currentCost).toFixed(4)),
      reviewStatus: rowStatus(row),
      notes: text(row.Notes),
    });

    if (!hasBlocker && (!match?.doc || !isMeaningfullySame(existing, payload))) {
      const ref = match?.doc?.ref || firestore.collection('finishedGoods').doc(code);
      finalOperations.push({ ref, payload, action: match?.doc ? 'UPDATE' : 'CREATE' });
    }
  }

  unresolved.forEach((row) => {
    const index = row.componentType === 'Prep' || String(row.componentType).includes('Prep') ? prepIndex : rawIndex;
    row.suggestedMatches = suggestions(index, row.componentName).map((match) => `${match.code}:${match.name}`).join(' | ');
  });

  unitBlockers.forEach((row) => {
    unresolved.push({
      ...row,
      suggestedMatches: '',
    });
  });
  const reviewReports = buildReviewReports(unresolved);

  const finalWorkbookNameKeys = new Set(model.finalRows.map((row) => normalizeName(row['Menu Item'])).filter(Boolean));
  const existingKitchenNotInWorkbook = data.finishedDocs
    .filter((doc) => {
      if (matchedFinalWorkbookIds.has(doc.id)) return false;
      const dataItem = doc.data;
      const nameKey = normalizeName(dataItem.name || dataItem.displayName);
      if (finalWorkbookNameKeys.has(nameKey)) return false;
      const category = `${dataItem.posCategoryCode || ''} ${dataItem.posCategoryName || ''}`;
      const looksKitchen = dataItem.prepStation === 'KITCHEN' || (!BEVERAGE_CATEGORY_RE.test(category) && dataItem.prepStation !== 'BARISTA');
      return looksKitchen && dataItem.isActive !== false;
    })
    .map((doc) => ({
      code: doc.data.code || doc.id,
      name: doc.data.displayName || doc.data.name || doc.id,
      category: doc.data.posCategoryName || doc.data.posCategoryCode || '',
      prepStation: doc.data.prepStation || '',
      isActive: doc.data.isActive !== false,
      isSellable: doc.data.isSellable === true,
      availableStoreIds: Array.isArray(doc.data.availableStoreIds) ? doc.data.availableStoreIds.join('|') : '',
      reason: 'Existing active kitchen-like finished good not found in workbook; left unchanged.',
    }));

  const beveragePreservedCount = data.finishedDocs.filter((doc) => {
    const category = `${doc.data.posCategoryCode || ''} ${doc.data.posCategoryName || ''} ${doc.data.name || ''}`;
    return BEVERAGE_CATEGORY_RE.test(category) || doc.data.prepStation === 'BARISTA';
  }).length;

  const operations = [...rawOperations, ...prepOperations, ...finalOperations];
  const summary = {
    mode: DRY_RUN ? 'DRY_RUN' : 'APPLY',
    workbookPath,
    generatedAt: new Date().toISOString(),
    counts: {
      rawMaterials: model.rawRows.length,
      prepItems: model.prepRows.length,
      prepBomLines: model.prepBomRows.length,
      finalFoodItems: model.finalRows.length,
      finalBomLines: model.finalBomRows.length,
      dataQualityReviewRows: model.reviewRows.length,
    },
    operations: {
      rawIngredients: {
        createOrUpdate: rawOperations.length,
        ownerDefinedRawMaterials: ownerRawDefinitionPayloads.length,
      },
      prepItems: {
        createOrUpdate: prepOperations.length,
        blocked: blockedPrepIds.size,
      },
      finishedGoods: {
        createOrUpdate: finalOperations.length,
        blocked: blockedFinalProductIds.size,
      },
      totalWrites: operations.length,
    },
    reconciliation: {
      unresolvedComponents: unresolved.length,
      unitBlockers: unitBlockers.length,
      classificationCounts: reviewReports.classificationCounts,
      plannedTargetMappingsResolved: mappingStats.plannedTargetMappingsResolved,
      mappingsResolvedAgainstExistingFirestore: mappingStats.mappingsResolvedAgainstExistingFirestore,
      mappingsResolvedAgainstWorkbookPlannedCreates: mappingStats.mappingsResolvedAgainstWorkbookPlannedCreates,
      mappingsResolvedAgainstOwnerDefinedCreates: mappingStats.mappingsResolvedAgainstOwnerDefinedCreates,
      transformedComponentRows: mappingStats.transformedComponentRows,
      splitComponentRows: mappingStats.splitComponentRows,
      invalidTransformationRows: mappingStats.invalidTransformationRows,
      circularDependencies,
      duplicateWorkbookRisks: model.duplicates,
      beverageProductsPreservedCount: beveragePreservedCount,
      existingKitchenProductsNotInWorkbookCount: existingKitchenNotInWorkbook.length,
      storeAvailabilityChanged: false,
      goldenIEnabled: false,
    },
    mappings: {
      componentMappingsPath: componentMappings.path || '',
      componentMappingsLoaded: componentMappings.mappings.length,
      rawMaterialDefinitionsLoaded: componentMappings.rawMaterialDefinitions.length,
      prepItemDefinitionsLoaded: componentMappings.prepItemDefinitions.length,
      productMappingsPath: productMappings.path || '',
      productMappingsLoaded: productMappings.mappings.length,
    },
    costHandling: {
      workbookCostsAreReportOnly: !APPLY_COSTS,
      applyCostsRequested: APPLY_COSTS,
      normalApplyWritesCostFields: false,
    },
    safeToApply: unresolved.length === 0 && unitBlockers.length === 0 && circularDependencies.length === 0,
    reports: {
      summary: path.join(REPORT_DIR, 'kitchen-bom-import-summary.json'),
      unresolvedComponents: path.join(REPORT_DIR, 'kitchen-bom-unresolved-components.csv'),
      mappingReview: path.join(REPORT_DIR, 'kitchen-bom-mapping-review.csv'),
      newRawMaterials: path.join(REPORT_DIR, 'kitchen-bom-new-raw-materials.csv'),
      newPrepItems: path.join(REPORT_DIR, 'kitchen-bom-new-prep-items.csv'),
      compositeLines: path.join(REPORT_DIR, 'kitchen-bom-composite-lines.csv'),
      unitBlockers: path.join(REPORT_DIR, 'kitchen-bom-unit-blockers.csv'),
      costVariance: path.join(REPORT_DIR, 'kitchen-bom-cost-variance.csv'),
      existingProductsNotInWorkbook: path.join(REPORT_DIR, 'kitchen-bom-existing-products-not-in-workbook.csv'),
    },
  };

  await writeReports(summary, unresolved, costVariance, existingKitchenNotInWorkbook);

  if (APPLY) {
    if (!summary.safeToApply) {
      fail('Import is blocked. Resolve unresolved components, unit blockers, and circular dependencies before running --apply.');
    }
    await commitInBatches(firestore, operations);
  }

  console.log(`Mode: ${summary.mode}`);
  console.log(`Workbook: ${workbookPath}`);
  console.log(`Raw materials: ${summary.counts.rawMaterials}`);
  console.log(`Prep items: ${summary.counts.prepItems}`);
  console.log(`Prep BOM lines: ${summary.counts.prepBomLines}`);
  console.log(`Final food items: ${summary.counts.finalFoodItems}`);
  console.log(`Final BOM lines: ${summary.counts.finalBomLines}`);
  console.log(`Unresolved components: ${summary.reconciliation.unresolvedComponents}`);
  console.log(`Unit blockers: ${summary.reconciliation.unitBlockers}`);
  console.log(`Circular dependencies: ${summary.reconciliation.circularDependencies.length}`);
  console.log(`Safe to apply: ${summary.safeToApply ? 'yes' : 'no'}`);
  console.log(`Reports written to ${REPORT_DIR}/`);
  console.log(APPLY ? `Applied writes: ${operations.length}` : 'Dry run complete. No Firestore writes were performed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
