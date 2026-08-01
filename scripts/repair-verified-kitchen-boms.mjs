#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import xlsx from 'xlsx';
import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export const PROJECT_ID = 'coffee-bond-pos';
export const APPROVED_WORKBOOK_SHA256 = '6e2a89c4bb5b7c24b10b96e4400efe8d7f969cd60a45b9e88e4f17b64817fabf';
export const IMPORT_SOURCE = 'TARGETED_VERIFIED_KITCHEN_BOM_REPAIR_2026_08_01';
export const PUBLIC_SNAPSHOT_PATH = 'publicMenuAvailability/GOLDEN_I';
export const DEFAULT_MAPPING_PATH = 'data/imports/kitchen-finished-product-mappings.json';
export const DEFAULT_COMPONENT_MAPPING_PATH = 'data/imports/kitchen-bom-component-mappings.json';
export const DEFAULT_REPORT_PATH = 'reports/kitchen-bom-two-product-repair-dry-run.json';

export const TARGET_PRODUCTS = [
  {
    workbookProductId: 'MENU-028',
    workbookName: 'The Melbourne Fold',
    finishedGoodCode: 'THE_MELBOURNE_FOLD',
    requiredPrepIds: ['PREP-003', 'PREP-015'],
  },
  {
    workbookProductId: 'MENU-029',
    workbookName: 'Hung curd & Charred Veg Tartine',
    finishedGoodCode: 'HUNG_CURD__CHARED_VEG_TARTINE',
    requiredPrepIds: ['PREP-001', 'PREP-025'],
  },
];

export const OTHER_SETUP_INCOMPLETE_PRODUCTS = [
  'CHEESE_GARLIC_BREAD',
  'CHILLI_CRISP_HUNG_CURD_FOLD',
  'GARLIC_BREAD',
  'HUMMUS_GREENS_AND_PICKLED_ONION',
  'ICED_CAPPUCCINO',
  'MIX_BUSINESS',
  'MR_PESTO',
  'PROTEIN_NACHOS',
  'THE_GREEN_HARISSA_SMASH',
  'THE_MIGHTY_MUSHROOM',
  'TRES_LECHES_NUTTY',
];

const REQUIRED_PREP_IDS = [...new Set(TARGET_PRODUCTS.flatMap((item) => item.requiredPrepIds))].sort();
const APPROVED_MAPPING_STATUSES = new Set(['APPROVED', 'OWNER_APPROVED', 'APPROVED_DETERMINISTIC']);
const REQUIRED_SHEETS = {
  raw: 'Raw Material Master',
  prep: 'Prep Recipe Master',
  prepBom: 'Prep BOM',
  final: 'Final Product Master',
  finalBom: 'Final Product BOM',
};
const UOM_ALIASES = {
  G: 'G',
  GM: 'G',
  GMS: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  KG: 'KG',
  KGS: 'KG',
  ML: 'ML',
  L: 'L',
  LTR: 'L',
  LTRS: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  SLICE: 'SLICE',
  SLICES: 'SLICE',
};
const UOM_FAMILY = {
  G: 'WEIGHT',
  KG: 'WEIGHT',
  ML: 'VOLUME',
  L: 'VOLUME',
  PCS: 'COUNT',
  SLICE: 'SLICE',
};

function fail(message) {
  const error = new Error(message);
  error.name = 'VerifiedKitchenBomRepairError';
  throw error;
}

function text(value) {
  return String(value ?? '').trim();
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

function normalizeUom(value) {
  const raw = text(value).toUpperCase().replace(/\./g, '');
  return UOM_ALIASES[raw] || raw;
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canConvertUom(fromValue, toValue) {
  const from = normalizeUom(fromValue);
  const to = normalizeUom(toValue);
  if (!from || !to) return false;
  if (from === to) return true;
  return Boolean(UOM_FAMILY[from] && UOM_FAMILY[from] === UOM_FAMILY[to]);
}

function serialize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, serialize(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(serialize(value));
}

function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : (typeof value === 'string' ? value : stableJson(value));
  return crypto.createHash('sha256').update(input).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(serialize(value)));
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function samePayload(left, right) {
  return stableJson(left) === stableJson(right);
}

function rowStatus(row) {
  return text(row.Status).toUpperCase();
}

function rowsForSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) fail(`Approved workbook is missing required sheet: ${sheetName}`);
  return xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
    .map((row, index) => ({ ...row, __rowNumber: index + 2 }));
}

export async function readApprovedWorkbook(workbookPath) {
  const bytes = await fs.readFile(workbookPath);
  const workbookSha256 = sha256(bytes);
  if (workbookSha256 !== APPROVED_WORKBOOK_SHA256) {
    fail(`Workbook checksum mismatch. Expected ${APPROVED_WORKBOOK_SHA256}, found ${workbookSha256}.`);
  }

  const workbook = xlsx.read(bytes, { type: 'buffer', raw: false });
  const model = {
    workbookPath,
    workbookSha256,
    rawRows: rowsForSheet(workbook, REQUIRED_SHEETS.raw),
    prepRows: rowsForSheet(workbook, REQUIRED_SHEETS.prep),
    prepBomRows: rowsForSheet(workbook, REQUIRED_SHEETS.prepBom),
    finalRows: rowsForSheet(workbook, REQUIRED_SHEETS.final),
    finalBomRows: rowsForSheet(workbook, REQUIRED_SHEETS.finalBom),
  };
  return model;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function mappingStatus(mapping) {
  return normalizeId(mapping?.approvalStatus || mapping?.status);
}

function mappingByWorkbookId(mappingFile) {
  const mappings = Array.isArray(mappingFile) ? mappingFile : mappingFile?.mappings;
  if (!Array.isArray(mappings)) fail('Finished-product mapping manifest has no mappings array.');
  return new Map(mappings.map((mapping) => [normalizeId(mapping.workbookProductId || mapping.productId), mapping]));
}

function mappingByComponentName(mappingFile) {
  const mappings = Array.isArray(mappingFile) ? mappingFile : mappingFile?.mappings;
  if (!Array.isArray(mappings)) fail('Component mapping manifest has no mappings array.');
  return new Map(mappings.map((mapping) => [normalizeName(mapping.componentName || mapping.workbookComponentName), mapping]));
}

function assertTargetMappings(mappingFile, workbookModel) {
  const mappingIndex = mappingByWorkbookId(mappingFile);
  for (const target of TARGET_PRODUCTS) {
    const mapping = mappingIndex.get(target.workbookProductId);
    if (!mapping) fail(`Missing deterministic finished-product mapping for ${target.workbookProductId}.`);
    if (!APPROVED_MAPPING_STATUSES.has(mappingStatus(mapping))) {
      fail(`Finished-product mapping ${target.workbookProductId} is not approved.`);
    }
    if (normalizeId(mapping.targetFinishedGoodCode || mapping.targetCode || mapping.targetId) !== target.finishedGoodCode) {
      fail(`Finished-product mapping ${target.workbookProductId} does not target ${target.finishedGoodCode}.`);
    }
    if (normalizeName(mapping.workbookName) !== normalizeName(target.workbookName)) {
      fail(`Finished-product mapping ${target.workbookProductId} has an unexpected workbook name.`);
    }
    const workbookRow = workbookModel.finalRows.find((row) => normalizeId(row['Product ID']) === target.workbookProductId);
    if (!workbookRow || normalizeName(workbookRow['Menu Item']) !== normalizeName(target.workbookName)) {
      fail(`Approved workbook product ${target.workbookProductId} name does not match the mapping manifest.`);
    }
  }
}

function documentIndex(documents) {
  const byCode = new Map();
  const byName = new Map();
  const duplicateNames = new Set();
  for (const document of documents) {
    const data = document.data || {};
    [document.id, data.code, data.workbookId, data.sourceWorkbookId]
      .map(normalizeId)
      .filter(Boolean)
      .forEach((code) => byCode.set(code, document));
    const name = normalizeName(data.name || data.displayName);
    if (!name) continue;
    if (byName.has(name)) duplicateNames.add(name);
    else byName.set(name, document);
  }
  return { byCode, byName, duplicateNames };
}

function findUniqueDocument(index, code, name, label) {
  const codeKey = normalizeId(code);
  if (codeKey && index.byCode.has(codeKey)) return index.byCode.get(codeKey);
  const nameKey = normalizeName(name);
  if (nameKey && index.duplicateNames.has(nameKey)) fail(`${label} has ambiguous existing matches for ${name}.`);
  if (nameKey && index.byName.has(nameKey)) return index.byName.get(nameKey);
  return null;
}

function componentMappingOutputs(mapping) {
  if (Array.isArray(mapping?.outputs) && mapping.outputs.length > 0) return mapping.outputs;
  if (Array.isArray(mapping?.splitLines) && mapping.splitLines.length > 0) return mapping.splitLines;
  return mapping ? [mapping] : [];
}

function rawDescriptor(row, context) {
  const componentName = text(row['Standard Component'] || row['Ingredient (Source)'] || row['Component (Source)']);
  const linkedId = normalizeId(row['Linked ID']);
  const mapping = context.componentMappings.get(normalizeName(componentName));
  let targetCode = '';
  let targetName = componentName;
  let quantityOverride = null;
  let uomOverride = '';

  if (mapping) {
    if (!APPROVED_MAPPING_STATUSES.has(mappingStatus(mapping))) {
      fail(`Component mapping for ${componentName} is not approved.`);
    }
    const outputs = componentMappingOutputs(mapping);
    if (outputs.length !== 1) fail(`Targeted repair does not accept split mapping for ${componentName}.`);
    const output = outputs[0];
    const targetType = normalizeId(output.targetType || mapping.targetType);
    if (!['RAW_MATERIAL', 'RAW_INGREDIENT'].includes(targetType)) {
      fail(`Component mapping for ${componentName} does not target a raw ingredient.`);
    }
    targetCode = normalizeId(output.targetId || output.targetCode || mapping.targetId || mapping.targetCode);
    targetName = text(output.targetName || output.name || mapping.targetName || componentName);
    quantityOverride = positiveNumber(output.quantity ?? output.quantityOverride ?? mapping.quantityOverride);
    uomOverride = normalizeUom(output.unit || output.uomOverride || mapping.uomOverride);
  }

  let workbookRaw = null;
  if (targetCode.startsWith('RAW-')) workbookRaw = context.rawRowsById.get(targetCode) || null;
  if (!workbookRaw && linkedId) workbookRaw = context.rawRowsById.get(linkedId) || null;
  if (workbookRaw) targetName = text(workbookRaw['Standard Ingredient']) || targetName;

  return {
    componentName,
    linkedId,
    targetCode,
    targetName,
    quantityOverride,
    uomOverride,
    workbookRaw,
  };
}

function buildRawCreatePayload(workbookRaw) {
  const code = normalizeId(workbookRaw['Raw Material ID']);
  const name = text(workbookRaw['Standard Ingredient']);
  const usageUOM = normalizeUom(workbookRaw['Preferred Base UOM']);
  const purchaseUOM = normalizeUom(workbookRaw['Pack UOM']) || usageUOM;
  if (!code || !name || !usageUOM || !purchaseUOM) {
    fail(`Workbook raw material ${code || name || 'UNKNOWN'} is incomplete.`);
  }
  return {
    code,
    name,
    category: 'KITCHEN',
    purchaseUOM,
    usageUOM,
    conversionFactor: positiveNumber(workbookRaw['Pack Qty']) || 1,
    supplierName: '',
    isActive: true,
    importSource: IMPORT_SOURCE,
    workbookId: code,
    workbookStatus: rowStatus(workbookRaw),
    workbookNotes: text(workbookRaw.Notes),
  };
}

function targetRawDocuments(workbookModel, catalog, componentMappingFile) {
  const rawIndex = documentIndex(catalog.rawIngredients);
  const rawRowsById = new Map(workbookModel.rawRows.map((row) => [normalizeId(row['Raw Material ID']), row]));
  const componentMappings = mappingByComponentName(componentMappingFile);
  const targetProductIds = new Set(TARGET_PRODUCTS.map((target) => target.workbookProductId));
  const requiredRows = [
    ...workbookModel.prepBomRows.filter((row) => REQUIRED_PREP_IDS.includes(normalizeId(row['Prep ID']))),
    ...workbookModel.finalBomRows.filter((row) => targetProductIds.has(normalizeId(row['Product ID']))
      && !normalizeId(row['Component Type']).includes('PREP')),
  ];
  const planned = new Map();

  for (const row of requiredRows) {
    const descriptor = rawDescriptor(row, { rawRowsById, componentMappings });
    const existing = findUniqueDocument(
      rawIndex,
      descriptor.targetCode || descriptor.linkedId,
      descriptor.targetName,
      'Raw ingredient',
    );
    if (existing) {
      if (existing.data.isActive === false) fail(`Raw ingredient ${existing.path} is inactive.`);
      continue;
    }
    if (!descriptor.workbookRaw) {
      fail(`Raw ingredient target not found for ${descriptor.componentName} (${descriptor.targetCode || descriptor.linkedId || descriptor.targetName}).`);
    }

    const desired = buildRawCreatePayload(descriptor.workbookRaw);
    if (descriptor.targetCode && descriptor.targetCode !== desired.code) {
      fail(`Missing mapped raw target ${descriptor.targetCode} cannot be replaced by workbook raw ${desired.code}.`);
    }
    const previous = planned.get(desired.code);
    if (previous && !samePayload(previous.desired, desired)) {
      fail(`Conflicting planned raw ingredient payloads for ${desired.code}.`);
    }
    planned.set(desired.code, {
      rawId: desired.code,
      path: `rawIngredients/${desired.code}`,
      desired,
    });
  }
  return planned;
}

function rawCatalogWithPlans(catalog, rawPlans) {
  return [
    ...catalog.rawIngredients,
    ...[...rawPlans.values()].map((plan) => ({
      id: plan.rawId,
      path: plan.path,
      data: plan.desired,
    })),
  ];
}

function resolveRawComponent(row, context) {
  const descriptor = rawDescriptor(row, context);

  const liveTarget = findUniqueDocument(
    context.rawIndex,
    descriptor.targetCode || descriptor.linkedId,
    descriptor.targetName,
    'Raw ingredient',
  );
  if (!liveTarget) {
    fail(`Raw ingredient target not found for ${descriptor.componentName} (${descriptor.targetCode || descriptor.linkedId || descriptor.targetName}).`);
  }
  if (liveTarget.data.isActive === false) fail(`Raw ingredient ${liveTarget.path} is inactive.`);

  const targetUnit = normalizeUom(liveTarget.data.usageUOM || liveTarget.data.uom || liveTarget.data.unit);
  if (!targetUnit) fail(`Raw ingredient ${liveTarget.path} has no usage unit.`);
  const qtyInBase = positiveNumber(row['Qty in Linked Base UOM']);
  const rowQuantity = positiveNumber(row.Qty);
  const quantity = descriptor.quantityOverride ?? qtyInBase ?? rowQuantity;
  const rowUnit = normalizeUom(row.UOM);
  const unit = descriptor.uomOverride || (qtyInBase ? targetUnit : rowUnit);
  if (!quantity || !unit) fail(`Invalid quantity or unit for ${descriptor.componentName} at workbook row ${row.__rowNumber}.`);
  if (!canConvertUom(unit, targetUnit)) {
    fail(`Unit mismatch for ${descriptor.componentName}: ${unit} cannot convert to ${targetUnit}.`);
  }

  return {
    componentType: 'RAW_INGREDIENT',
    componentCode: liveTarget.data.code || liveTarget.id,
    componentName: liveTarget.data.name || descriptor.targetName,
    quantity,
    uom: unit,
    workbookStatus: rowStatus(row),
    workbookNotes: text(row.Notes),
  };
}

function prepRowsById(workbookModel) {
  return new Map(REQUIRED_PREP_IDS.map((prepId) => [
    prepId,
    workbookModel.prepBomRows.filter((row) => normalizeId(row['Prep ID']) === prepId),
  ]));
}

function targetPrepDocuments(workbookModel, catalog, componentMappingFile, rawPlans) {
  const rawIndex = documentIndex(rawCatalogWithPlans(catalog, rawPlans));
  const prepIndex = documentIndex(catalog.prepItems);
  const rawRowsById = new Map(workbookModel.rawRows.map((row) => [normalizeId(row['Raw Material ID']), row]));
  const componentMappings = mappingByComponentName(componentMappingFile);
  const bomRowsByPrepId = prepRowsById(workbookModel);
  const planned = new Map();

  for (const prepId of REQUIRED_PREP_IDS) {
    const header = workbookModel.prepRows.find((row) => normalizeId(row['Prep ID']) === prepId);
    if (!header) fail(`Approved prep header ${prepId} is missing.`);
    const name = text(header['Prep Recipe']);
    const yieldQuantity = positiveNumber(header['Batch Output Qty']);
    const yieldUOM = normalizeUom(header['Output UOM']);
    const bomRows = bomRowsByPrepId.get(prepId) || [];
    if (!name || !yieldQuantity || !yieldUOM || bomRows.length === 0) {
      fail(`Approved prep ${prepId} does not have a complete recipe and batch yield.`);
    }

    const existing = findUniqueDocument(prepIndex, prepId, name, 'Prep item');
    const code = existing?.data.code || existing?.id || prepId;
    const bom = bomRows.map((row) => resolveRawComponent(row, {
      rawIndex,
      rawRowsById,
      componentMappings,
    }));
    const desired = {
      code,
      name,
      outputUOM: yieldUOM,
      defaultBatchSize: yieldQuantity,
      yieldQuantity,
      yieldUOM,
      isStockTracked: true,
      bom,
      bomVersion: Number(existing?.data.bomVersion || 0) + 1,
      isActive: existing?.data.isActive !== false,
      importSource: IMPORT_SOURCE,
      workbookId: prepId,
      workbookStatus: rowStatus(header),
      workbookNotes: text(header.Notes),
    };

    if (existing) {
      const comparable = { ...desired, bomVersion: Number(existing.data.bomVersion || 0) };
      const existingComparable = Object.fromEntries(Object.keys(comparable).map((key) => [key, existing.data[key]]));
      if (samePayload(existingComparable, comparable)) desired.bomVersion = Number(existing.data.bomVersion || 0);
      else fail(`Existing prep ${existing.path} conflicts with the approved targeted payload; refusing to overwrite it.`);
    }

    planned.set(prepId, {
      prepId,
      path: existing?.path || `prepItems/${code}`,
      existing,
      desired,
    });
  }
  return planned;
}

function buildFinalBom(target, workbookModel, rawContext, prepPlans) {
  const rows = workbookModel.finalBomRows
    .filter((row) => normalizeId(row['Product ID']) === target.workbookProductId)
    .sort((left, right) => Number(left['Line #']) - Number(right['Line #']));
  if (rows.length === 0) fail(`Approved final BOM ${target.workbookProductId} has no rows.`);

  return rows.map((row) => {
    const type = normalizeId(row['Component Type']);
    if (type.includes('PREP')) {
      const prepId = normalizeId(row['Linked ID']);
      const prep = prepPlans.get(prepId);
      if (!prep || !target.requiredPrepIds.includes(prepId)) {
        fail(`${target.workbookProductId} references unexpected prep ${prepId || 'UNKNOWN'}.`);
      }
      const quantity = positiveNumber(row['Qty in Linked Base UOM']) ?? positiveNumber(row.Qty);
      const unit = normalizeUom(row['Qty in Linked Base UOM'] ? prep.desired.yieldUOM : row.UOM);
      if (!quantity || !canConvertUom(unit, prep.desired.yieldUOM)) {
        fail(`Invalid prep quantity or unit for ${prepId} in ${target.workbookProductId}.`);
      }
      return {
        componentType: 'PREP_ITEM',
        componentCode: prep.desired.code,
        componentName: prep.desired.name,
        quantity,
        uom: unit,
        workbookStatus: rowStatus(row),
        workbookNotes: text(row.Notes),
      };
    }
    return resolveRawComponent(row, rawContext);
  });
}

function finishedGoodOperations(workbookModel, catalog, mappingFile, componentMappingFile, prepPlans, rawPlans) {
  assertTargetMappings(mappingFile, workbookModel);
  const finishedIndex = documentIndex(catalog.finishedGoods);
  const rawIndex = documentIndex(rawCatalogWithPlans(catalog, rawPlans));
  const rawRowsById = new Map(workbookModel.rawRows.map((row) => [normalizeId(row['Raw Material ID']), row]));
  const componentMappings = mappingByComponentName(componentMappingFile);
  const operations = [];

  for (const target of TARGET_PRODUCTS) {
    const document = finishedIndex.byCode.get(target.finishedGoodCode);
    if (!document || document.id !== target.finishedGoodCode) {
      fail(`Existing target finished good ${target.finishedGoodCode} was not found at its stable document ID.`);
    }
    if (normalizeId(document.data.code || document.id) !== target.finishedGoodCode) {
      fail(`Finished good ${document.path} has an unexpected product code.`);
    }
    const header = workbookModel.finalRows.find((row) => normalizeId(row['Product ID']) === target.workbookProductId);
    const bom = buildFinalBom(target, workbookModel, { rawIndex, rawRowsById, componentMappings }, prepPlans);
    const beforeFields = {
      bom: clone(document.data.bom || []),
      bomVersion: Number(document.data.bomVersion || 0),
      workbookId: document.data.workbookId ?? null,
      importSource: document.data.importSource ?? null,
      workbookStatus: document.data.workbookStatus ?? null,
      workbookNotes: document.data.workbookNotes ?? null,
    };
    const desiredFields = {
      bom,
      bomVersion: beforeFields.bomVersion + 1,
      workbookId: target.workbookProductId,
      importSource: IMPORT_SOURCE,
      workbookStatus: rowStatus(header),
      workbookNotes: text(header.Notes),
    };
    const currentBomMatches = samePayload(beforeFields.bom, desiredFields.bom);
    const currentProvenanceMatches = beforeFields.workbookId === desiredFields.workbookId
      && beforeFields.importSource === desiredFields.importSource
      && beforeFields.workbookStatus === desiredFields.workbookStatus
      && beforeFields.workbookNotes === desiredFields.workbookNotes;
    if (currentBomMatches && currentProvenanceMatches) continue;
    if (beforeFields.bom.length > 0 && !currentBomMatches) {
      fail(`Finished good ${document.path} already has a different non-empty BOM; refusing to overwrite it.`);
    }
    operations.push({
      kind: 'FINISHED_GOOD_UPDATE',
      action: 'UPDATE',
      path: document.path,
      beforeDocumentHash: sha256(document.data),
      before: beforeFields,
      after: { ...desiredFields, updatedAt: 'SERVER_TIMESTAMP' },
      applyPayload: desiredFields,
    });
  }
  return operations;
}

function prepOperations(prepPlans) {
  const operations = [];
  for (const plan of prepPlans.values()) {
    if (plan.existing) continue;
    operations.push({
      kind: 'PREP_ITEM_CREATE',
      action: 'CREATE',
      path: plan.path,
      beforeDocumentHash: sha256(null),
      before: null,
      after: { ...clone(plan.desired), createdAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP' },
      applyPayload: plan.desired,
    });
  }
  return operations;
}

function rawOperations(rawPlans) {
  return [...rawPlans.values()].map((plan) => ({
    kind: 'RAW_INGREDIENT_CREATE',
    action: 'CREATE',
    path: plan.path,
    beforeDocumentHash: sha256(null),
    before: null,
    after: { ...clone(plan.desired), createdAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP' },
    applyPayload: plan.desired,
  }));
}

function buildPublicSnapshotOperation(catalog) {
  const document = catalog.publicMenuAvailability;
  if (!document?.data) fail(`${PUBLIC_SNAPSHOT_PATH} does not exist.`);
  const data = document.data;
  const items = data.items && typeof data.items === 'object' ? data.items : {};
  const menuItems = data.menuItems && typeof data.menuItems === 'object' ? data.menuItems : {};
  if (Object.keys(items).length !== 80 || Object.keys(menuItems).length !== 80 || Number(data.itemCount) !== 80) {
    fail(`${PUBLIC_SNAPSHOT_PATH} must remain an 80-item snapshot for this targeted repair.`);
  }

  const beforeItems = {};
  const afterItems = {};
  let changedCount = 0;
  for (const target of TARGET_PRODUCTS) {
    const before = items[target.finishedGoodCode];
    if (!before) fail(`${PUBLIC_SNAPSHOT_PATH}.items.${target.finishedGoodCode} is missing.`);
    beforeItems[target.finishedGoodCode] = clone(before);
    const after = {
      itemCode: target.finishedGoodCode,
      fgCode: target.finishedGoodCode,
      available: true,
      publicStatus: 'AVAILABLE',
      publicMessage: 'Available',
    };
    afterItems[target.finishedGoodCode] = after;
    if (!samePayload(before, after)) {
      if (before.available !== false || before.publicStatus !== 'SETUP_INCOMPLETE') {
        fail(`${target.finishedGoodCode} is not in the expected SETUP_INCOMPLETE public state.`);
      }
      changedCount += 1;
    }
  }

  const remainingBefore = Object.fromEntries(OTHER_SETUP_INCOMPLETE_PRODUCTS.map((code) => [code, clone(items[code])]));
  if (Object.values(remainingBefore).some((item) => !item)) {
    fail('One or more of the remaining 11 setup-incomplete public products is missing from the snapshot.');
  }
  if (changedCount === 0) return null;
  if (changedCount !== TARGET_PRODUCTS.length) fail('Public availability is partially applied; refusing a mixed-state repair.');

  const currentAvailable = Object.values(items).filter((item) => item?.available === true).length;
  const currentUnavailable = Object.values(items).filter((item) => item?.available !== true).length;
  const afterAvailable = currentAvailable + changedCount;
  const afterUnavailable = currentUnavailable - changedCount;
  if (afterAvailable + afterUnavailable !== 80 || afterUnavailable < 0) fail('Projected public availability counts are invalid.');

  return {
    kind: 'PUBLIC_AVAILABILITY_UPDATE',
    action: 'UPDATE',
    path: document.path,
    beforeDocumentHash: sha256(data),
    before: {
      itemCount: data.itemCount,
      availableCount: data.availableCount,
      unavailableCount: data.unavailableCount,
      targetItems: beforeItems,
      remainingSetupIncompleteItems: remainingBefore,
    },
    after: {
      itemCount: 80,
      availableCount: afterAvailable,
      unavailableCount: afterUnavailable,
      targetItems: afterItems,
      remainingSetupIncompleteItems: remainingBefore,
      updatedAt: 'SERVER_TIMESTAMP',
      updatedBy: 'targeted-kitchen-bom-repair',
    },
    applyPayload: {
      targetItems: afterItems,
      itemCount: 80,
      availableCount: afterAvailable,
      unavailableCount: afterUnavailable,
      updatedBy: 'targeted-kitchen-bom-repair',
    },
  };
}

function assertNoCostFields(operations) {
  const prohibited = new Set(['recipeCost', 'costPerUnit', 'lineCost', 'grossMargin', 'cogsPercent']);
  const visit = (value, currentPath) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (prohibited.has(key)) fail(`Cost field ${currentPath}.${key} is prohibited in this repair.`);
      visit(child, `${currentPath}.${key}`);
    }
  };
  operations.forEach((operation) => visit(operation.applyPayload, operation.path));
}

function reportOperation(operation) {
  return withoutUndefined({
    collection: operation.path.split('/')[0],
    documentPath: operation.path,
    action: operation.action,
    before: operation.before,
    after: operation.after,
  });
}

export function buildRepairPlan({ workbookModel, mappingFile, componentMappingFile, catalog, generatedAt = new Date().toISOString() }) {
  const rawPlans = targetRawDocuments(workbookModel, catalog, componentMappingFile);
  const prepPlans = targetPrepDocuments(workbookModel, catalog, componentMappingFile, rawPlans);
  const operations = [
    ...rawOperations(rawPlans),
    ...prepOperations(prepPlans),
    ...finishedGoodOperations(workbookModel, catalog, mappingFile, componentMappingFile, prepPlans, rawPlans),
  ];
  const publicOperation = buildPublicSnapshotOperation(catalog);
  if (publicOperation) operations.push(publicOperation);
  assertNoCostFields(operations);

  const allowedPaths = new Set([
    ...[...rawPlans.values()].map((plan) => plan.path),
    ...REQUIRED_PREP_IDS.map((prepId) => prepPlans.get(prepId).path),
    ...TARGET_PRODUCTS.map((target) => `finishedGoods/${target.finishedGoodCode}`),
    PUBLIC_SNAPSHOT_PATH,
  ]);
  const unexpectedPaths = operations.map((operation) => operation.path).filter((itemPath) => !allowedPaths.has(itemPath));
  if (unexpectedPaths.length > 0) fail(`Unexpected write path(s): ${unexpectedPaths.join(', ')}`);

  const reportOperations = operations.map(reportOperation);
  const checksumInput = {
    projectId: PROJECT_ID,
    workbookSha256: workbookModel.workbookSha256,
    targetProducts: TARGET_PRODUCTS,
    operations: operations.map((operation) => ({
      path: operation.path,
      action: operation.action,
      beforeDocumentHash: operation.beforeDocumentHash,
      after: operation.after,
    })),
  };
  const dryRunChecksum = sha256(checksumInput);
  const remainingPublicItems = catalog.publicMenuAvailability.data.items || {};

  return {
    report: {
      mode: 'DRY_RUN',
      projectId: PROJECT_ID,
      generatedAt,
      workbookPath: workbookModel.workbookPath,
      workbookSha256: workbookModel.workbookSha256,
      targetProducts: TARGET_PRODUCTS,
      requiredRawIngredients: [...rawPlans.values()].map((plan) => ({
        workbookId: plan.rawId,
        documentPath: plan.path,
        name: plan.desired.name,
        usageUOM: plan.desired.usageUOM,
      })),
      requiredPrepItems: REQUIRED_PREP_IDS,
      writeCount: reportOperations.length,
      writesByCollection: reportOperations.reduce((counts, operation) => {
        counts[operation.collection] = (counts[operation.collection] || 0) + 1;
        return counts;
      }, {}),
      operations: reportOperations,
      invariants: {
        targetFinishedGoodCount: TARGET_PRODUCTS.length,
        requiredRawIngredientCreateCount: rawPlans.size,
        requiredPrepItemCount: REQUIRED_PREP_IDS.length,
        publicMenuItemCountBefore: Object.keys(catalog.publicMenuAvailability.data.menuItems || {}).length,
        publicMenuItemCountAfter: 80,
        remainingElevenUnchanged: OTHER_SETUP_INCOMPLETE_PRODUCTS.every((code) => {
          const projected = publicOperation?.after.remainingSetupIncompleteItems?.[code] ?? remainingPublicItems[code];
          return samePayload(remainingPublicItems[code], projected);
        }),
        otherStoreWrites: 0,
        finishedGoodFieldsPreserved: ['name', 'displayName', 'salePrice', 'taxRate', 'availableStoreIds', 'addOnGroupIds', 'prepStation', 'isActive', 'isSellable', 'isAvailable'],
        costFieldsWritten: [],
        firestoreWritesPerformed: 0,
      },
      dryRunChecksum,
      applyReadiness: operations.length === 0 ? 'ALREADY_APPLIED' : 'READY_AWAITING_OWNER_APPROVAL',
    },
    operations,
    dryRunChecksum,
  };
}

async function loadCatalog(firestore) {
  const [rawSnapshot, prepSnapshot, finishedSnapshots, publicSnapshot] = await Promise.all([
    firestore.collection('rawIngredients').get(),
    firestore.collection('prepItems').get(),
    Promise.all(TARGET_PRODUCTS.map((target) => firestore.collection('finishedGoods').doc(target.finishedGoodCode).get())),
    firestore.doc(PUBLIC_SNAPSHOT_PATH).get(),
  ]);
  const toDocument = (snapshot) => ({ id: snapshot.id, path: snapshot.ref.path, data: snapshot.data() || {} });
  return {
    rawIngredients: rawSnapshot.docs.map(toDocument),
    prepItems: prepSnapshot.docs.map(toDocument),
    finishedGoods: finishedSnapshots.map(toDocument),
    publicMenuAvailability: publicSnapshot.exists ? toDocument(publicSnapshot) : null,
  };
}

async function applyPlan(firestore, plan, confirmationChecksum) {
  if (confirmationChecksum !== plan.dryRunChecksum) {
    fail(`Dry-run checksum mismatch. Expected --confirm-checksum=${plan.dryRunChecksum}.`);
  }
  if (plan.operations.length === 0) return;

  await firestore.runTransaction(async (transaction) => {
    const refs = plan.operations.map((operation) => firestore.doc(operation.path));
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    snapshots.forEach((snapshot, index) => {
      const operation = plan.operations[index];
      const currentHash = sha256(snapshot.exists ? snapshot.data() : null);
      if (currentHash !== operation.beforeDocumentHash) {
        fail(`Document changed after dry run: ${operation.path}. Re-run the dry run and request approval again.`);
      }
    });

    plan.operations.forEach((operation, index) => {
      const ref = refs[index];
      if (operation.kind === 'RAW_INGREDIENT_CREATE' || operation.kind === 'PREP_ITEM_CREATE') {
        transaction.create(ref, {
          ...operation.applyPayload,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      if (operation.kind === 'FINISHED_GOOD_UPDATE') {
        transaction.update(ref, {
          ...operation.applyPayload,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      if (operation.kind === 'PUBLIC_AVAILABILITY_UPDATE') {
        const update = {
          itemCount: operation.applyPayload.itemCount,
          availableCount: operation.applyPayload.availableCount,
          unavailableCount: operation.applyPayload.unavailableCount,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: operation.applyPayload.updatedBy,
        };
        Object.entries(operation.applyPayload.targetItems).forEach(([code, item]) => {
          update[`items.${code}`] = item;
        });
        transaction.update(ref, update);
      }
    });
  });
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : fallback;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const explicitConfirmation = process.argv.includes('--confirm-two-product-repair');
  const projectId = argValue('--project', PROJECT_ID);
  const workbookArg = argValue('--workbook');
  const mappingPath = path.resolve(argValue('--product-mappings', DEFAULT_MAPPING_PATH));
  const componentMappingPath = path.resolve(argValue('--mappings', DEFAULT_COMPONENT_MAPPING_PATH));
  const reportPath = path.resolve(argValue('--report', DEFAULT_REPORT_PATH));
  const confirmationChecksum = argValue('--confirm-checksum');
  if (projectId !== PROJECT_ID) fail(`This repair is restricted to Firebase project ${PROJECT_ID}.`);
  if (!workbookArg) fail('--workbook=<approved workbook path> is required.');
  if (apply && !explicitConfirmation) fail('--apply requires --confirm-two-product-repair.');
  if (apply && !confirmationChecksum) fail('--apply requires --confirm-checksum=<approved dry-run checksum>.');

  const workbookPath = path.resolve(workbookArg);
  const [workbookModel, mappingFile, componentMappingFile] = await Promise.all([
    readApprovedWorkbook(workbookPath),
    readJson(mappingPath),
    readJson(componentMappingPath),
  ]);
  const app = initializeApp({ credential: applicationDefault(), projectId }, `verified-kitchen-bom-repair-${Date.now()}`);
  try {
    const firestore = getFirestore(app);
    const catalog = await loadCatalog(firestore);
    const plan = buildRepairPlan({ workbookModel, mappingFile, componentMappingFile, catalog });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(plan.report, null, 2)}\n`);

    console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    console.log(`Project: ${projectId}`);
    console.log(`Targets: ${TARGET_PRODUCTS.map((target) => target.finishedGoodCode).join(', ')}`);
    console.log(`Proposed writes: ${plan.report.writeCount}`);
    console.log(`Dry-run checksum: ${plan.dryRunChecksum}`);
    console.log(`Report: ${reportPath}`);
    if (!apply) {
      console.log('Dry run complete. No Firestore writes were performed.');
      return;
    }

    await applyPlan(firestore, plan, confirmationChecksum);
    console.log(plan.operations.length === 0
      ? 'Repair is already applied; no Firestore writes were performed.'
      : `Applied ${plan.operations.length} document writes atomically.`);
  } finally {
    await deleteApp(app);
  }
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
