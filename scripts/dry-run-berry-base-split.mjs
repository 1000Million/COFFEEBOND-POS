#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const REPORT_JSON = 'reports/berry-base-split-dry-run.json';
const REPORT_CSV = 'reports/berry-base-split-dry-run.csv';

const OLD_BASE_CODE = 'BERRY_ME_BASE';
const DRINK_BASE_CODE = 'BERRY_ME_DRINK_BASE';
const BOWL_BASE_CODE = 'BERRY_SMOOTHIE_BOWL_BASE';
const DRINK_FG_CODE = 'BERRY_ME';
const BOWL_FG_CODE = 'BERRY_SMOOTHIE_BOWL';

const TARGET_PREP_ITEMS = [
  {
    code: DRINK_BASE_CODE,
    name: 'Berry Me Drink Base',
    stockUnit: 'ML',
    sourceFinishedGoodCode: DRINK_FG_CODE,
    expectedConsumptionQuantity: 350,
    expectedConsumptionUom: 'ML',
  },
  {
    code: BOWL_BASE_CODE,
    name: 'Berry Smoothie Bowl Base',
    stockUnit: 'G',
    sourceFinishedGoodCode: BOWL_FG_CODE,
    expectedConsumptionQuantity: 250,
    expectedConsumptionUom: 'G',
  },
];

const UOM_ALIASES = {
  G: 'G',
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
};

const UOM_SCALE = {
  G: { family: 'WEIGHT', baseFactor: 1 },
  KG: { family: 'WEIGHT', baseFactor: 1000 },
  ML: { family: 'VOLUME', baseFactor: 1 },
  L: { family: 'VOLUME', baseFactor: 1000 },
  PCS: { family: 'COUNT', baseFactor: 1 },
};

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function initializeAdmin() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required for the Berry base split dry run. The script reads Firestore and writes reports only.');
  }

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

function normalizeUom(value) {
  const raw = text(value).toUpperCase();
  return UOM_ALIASES[raw] || raw;
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundValue(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function canConvertUom(fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  return Boolean(fromMeta && toMeta && fromMeta.family === toMeta.family);
}

function clonePlain(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function rowIdForStoreStock(storeId, stockItemCode) {
  return `${storeId}_PREP_ITEM_${stockItemCode}`;
}

function storeLabel(store) {
  return store?.code || store?.id || '';
}

function isAssignedToStore(item, storeId) {
  const ids = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return ids.length === 0 || ids.includes(storeId);
}

function isActiveFinishedGood(item, storeId) {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isAssignedToStore(item, storeId);
}

function usesBom(item) {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

function isNoStockItem(item) {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

function componentMasterExists(line, rawByCode, prepByCode, finishedByCode) {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING' || line.componentType === 'BOUGHT_COMPONENT') {
    return rawByCode.has(line.componentCode);
  }
  if (line.componentType === 'PREP_ITEM') return prepByCode.has(line.componentCode);
  if (line.componentType === 'FINISHED_GOOD') return finishedByCode.has(line.componentCode);
  return false;
}

function componentUomCompatible(line, rawByCode, prepByCode) {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING' || line.componentType === 'BOUGHT_COMPONENT') {
    const raw = rawByCode.get(line.componentCode);
    return canConvertUom(line.uom, raw?.usageUOM || raw?.uom || line.uom);
  }
  if (line.componentType === 'PREP_ITEM') {
    const prep = prepByCode.get(line.componentCode);
    return canConvertUom(line.uom, prep?.yieldUOM || prep?.outputUOM || prep?.uom || line.uom);
  }
  if (line.componentType === 'FINISHED_GOOD') return canConvertUom(line.uom, 'PCS');
  return false;
}

export function setupBlockersForStores(stores, rawIngredients, prepItems, finishedGoods) {
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));
  const blockers = [];

  const addBlocker = (store, item, type, detail, line = null) => {
    blockers.push({
      storeId: store.id,
      storeCode: storeLabel(store),
      finishedGoodCode: item.code,
      finishedGoodName: item.displayName || item.name || item.code,
      type,
      detail,
      componentType: line?.componentType || '',
      componentCode: line?.componentCode || '',
      componentUom: line?.uom || '',
    });
  };

  stores.forEach((store) => {
    finishedGoods.forEach((item) => {
      if (!isAssignedToStore(item, store.id) || item.isAvailable === false) return;
      if (item.isActive === false || item.isSellable === false) {
        addBlocker(store, item, 'Inactive / not sellable', 'Finished good is inactive or not sellable.');
        return;
      }
      if (numberValue(item.salePrice) <= 0 || !['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
        addBlocker(store, item, 'Invalid sale setup', 'Finished good needs a positive sale price and valid KOT station.');
        return;
      }
      if (isNoStockItem(item) || !usesBom(item)) return;
      if (!Array.isArray(item.bom) || item.bom.length === 0) {
        addBlocker(store, item, 'Missing BOM', 'BOM-based finished good has no BOM rows.');
        return;
      }
      item.bom.forEach((line) => {
        const componentCode = text(line.componentCode);
        const componentType = text(line.componentType);
        const quantity = numberValue(line.quantity);
        const uom = normalizeUom(line.uom);
        if (!componentCode || !componentType || quantity <= 0 || !uom) {
          addBlocker(store, item, 'Invalid BOM quantity', 'BOM row is missing component type, code, quantity, or UOM.', line);
          return;
        }
        if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
          addBlocker(store, item, 'Missing raw/prep master', `${componentType} / ${componentCode} is missing from master data.`, line);
          return;
        }
        if (!componentUomCompatible(line, rawByCode, prepByCode)) {
          addBlocker(store, item, 'Impossible unit conversion', `${componentType} / ${componentCode} cannot convert ${uom} to the stock unit.`, line);
        }
      });
    });
  });

  const deduped = new Map();
  blockers.forEach((blocker) => {
    const key = `${blocker.storeId}|${blocker.finishedGoodCode}|${blocker.type}|${blocker.detail}|${blocker.componentCode}`;
    if (!deduped.has(key)) deduped.set(key, blocker);
  });
  return Array.from(deduped.values());
}

function buildTargetPrepPayload(sourcePrep, target) {
  const payload = {
    ...clonePlain(sourcePrep),
    id: undefined,
    code: target.code,
    name: target.name,
    outputUOM: target.stockUnit,
    yieldUOM: target.stockUnit,
    uom: sourcePrep && Object.prototype.hasOwnProperty.call(sourcePrep, 'uom') ? target.stockUnit : sourcePrep?.uom,
    stockUOM: sourcePrep && Object.prototype.hasOwnProperty.call(sourcePrep, 'stockUOM') ? target.stockUnit : sourcePrep?.stockUOM,
    stockUnit: sourcePrep && Object.prototype.hasOwnProperty.call(sourcePrep, 'stockUnit') ? target.stockUnit : sourcePrep?.stockUnit,
    baseUnit: sourcePrep && Object.prototype.hasOwnProperty.call(sourcePrep, 'baseUnit') ? target.stockUnit : sourcePrep?.baseUnit,
    isStockTracked: true,
    isActive: true,
    splitSourcePrepItemCode: OLD_BASE_CODE,
    splitMigrationStatus: 'PLANNED_DRY_RUN_ONLY',
  };

  delete payload.id;
  return payload;
}

function projectedBomForFinishedGood(item) {
  if (!Array.isArray(item.bom)) return { bom: [], changed: false, replacements: [] };

  let changed = false;
  const replacements = [];
  const bom = item.bom.map((line) => {
    if (line.componentType !== 'PREP_ITEM' || line.componentCode !== OLD_BASE_CODE) return line;

    const target = item.code === DRINK_FG_CODE
      ? TARGET_PREP_ITEMS[0]
      : item.code === BOWL_FG_CODE
        ? TARGET_PREP_ITEMS[1]
        : null;

    if (!target) return line;
    changed = true;
    const replacement = {
      ...line,
      componentType: 'PREP_ITEM',
      componentCode: target.code,
      componentName: target.name,
      quantity: target.expectedConsumptionQuantity,
      uom: target.expectedConsumptionUom,
    };
    replacements.push({
      oldComponentCode: OLD_BASE_CODE,
      newComponentCode: target.code,
      oldQuantity: numberValue(line.quantity),
      oldUom: normalizeUom(line.uom),
      newQuantity: target.expectedConsumptionQuantity,
      newUom: target.expectedConsumptionUom,
    });
    return replacement;
  });

  return { bom, changed, replacements };
}

function proposedPrepChanges(prepByCode, sourcePrep) {
  return TARGET_PREP_ITEMS.map((target) => {
    const existing = prepByCode.get(target.code);
    const proposedPayload = buildTargetPrepPayload(sourcePrep || {}, target);
    const existsWithCorrectUnit = Boolean(existing)
      && normalizeUom(existing.outputUOM || existing.yieldUOM || existing.uom) === target.stockUnit
      && normalizeUom(existing.yieldUOM || existing.outputUOM || existing.uom) === target.stockUnit;

    return {
      action: existing ? (existsWithCorrectUnit ? 'SKIP_ALREADY_EXISTS' : 'UPDATE_EXISTING_TARGET') : 'CREATE_TARGET_PREP_ITEM',
      path: `prepItems/${target.code}`,
      targetCode: target.code,
      targetName: target.name,
      stockUnit: target.stockUnit,
      sourcePath: `prepItems/${sourcePrep?.id || OLD_BASE_CODE}`,
      preservesRecipeFrom: OLD_BASE_CODE,
      proposedPayload,
    };
  });
}

function proposedFinishedGoodChanges(finishedGoods) {
  return finishedGoods
    .filter((item) => item.code === DRINK_FG_CODE || item.code === BOWL_FG_CODE)
    .map((item) => {
      const projection = projectedBomForFinishedGood(item);
      return {
        action: projection.changed ? 'UPDATE_FINISHED_GOOD_BOM' : 'SKIP_ALREADY_UPDATED_OR_NO_OLD_REFERENCE',
        path: `finishedGoods/${item.id || item.code}`,
        finishedGoodCode: item.code,
        finishedGoodName: item.displayName || item.name || item.code,
        replacements: projection.replacements,
        proposedBom: projection.bom,
      };
    });
}

function projectedFinishedGoods(finishedGoods) {
  return finishedGoods.map((item) => {
    if (item.code !== DRINK_FG_CODE && item.code !== BOWL_FG_CODE) return item;
    const projection = projectedBomForFinishedGood(item);
    return projection.changed ? { ...item, bom: projection.bom } : item;
  });
}

function projectedPrepItems(prepItems, sourcePrep) {
  const byCode = new Map(prepItems.map((item) => [item.code, item]));
  const next = prepItems.map((item) => (
    item.code === OLD_BASE_CODE
      ? {
        ...item,
        isActive: false,
        splitMigrationStatus: 'LEGACY_REPLACED_BY_BERRY_BASE_SPLIT_PENDING_ALLOCATION',
      }
      : item
  ));
  TARGET_PREP_ITEMS.forEach((target) => {
    const payload = buildTargetPrepPayload(sourcePrep || {}, target);
    if (byCode.has(target.code)) {
      next.splice(next.findIndex((item) => item.code === target.code), 1, {
        ...byCode.get(target.code),
        ...payload,
      });
    } else {
      next.push(payload);
    }
  });
  return next;
}

function collectAffectedStoreIds(finishedGoods, oldStockRows) {
  const ids = new Set();
  finishedGoods
    .filter((item) => item.code === DRINK_FG_CODE || item.code === BOWL_FG_CODE)
    .forEach((item) => {
      if (Array.isArray(item.availableStoreIds) && item.availableStoreIds.length > 0) {
        item.availableStoreIds.forEach((id) => ids.add(id));
      }
    });
  oldStockRows.forEach((row) => {
    if (row.storeId) ids.add(row.storeId);
  });
  return Array.from(ids).sort();
}

function proposedStoreStockChanges(storesById, affectedStoreIds, oldStockRows, existingStoreStock) {
  const existingById = new Map(existingStoreStock.map((row) => [row.id || rowIdForStoreStock(row.storeId, row.stockItemCode), row]));
  const oldStockByStore = new Map(oldStockRows.map((row) => [row.storeId, row]));
  const rows = [];

  affectedStoreIds.forEach((storeId) => {
    const store = storesById.get(storeId) || { id: storeId, code: storeId, name: storeId };
    TARGET_PREP_ITEMS.forEach((target) => {
      const docId = rowIdForStoreStock(storeId, target.code);
      const existing = existingById.get(docId);
      rows.push({
        action: existing ? 'SKIP_EXISTING_TARGET_STOCK_ROW' : 'CREATE_TARGET_STOCK_ROW_AFTER_OWNER_ALLOCATION',
        path: `storeStock/${docId}`,
        storeId,
        storeCode: storeLabel(store),
        storeName: store.name || storeId,
        stockItemType: 'PREP_ITEM',
        stockItemCode: target.code,
        stockItemName: target.name,
        uom: target.stockUnit,
        openingStock: 'OWNER_REQUIRED',
        currentStock: 'OWNER_REQUIRED',
        costPerUnit: oldStockByStore.get(storeId)?.costPerUnit ?? 0,
        sourceOldStockPath: oldStockByStore.has(storeId) ? `storeStock/${oldStockByStore.get(storeId).id}` : '',
        note: 'Do not copy or convert BERRY_ME_BASE quantity. Owner must provide explicit opening/current balance for this replacement base.',
      });
    });
  });

  return rows;
}

function referenceContainsBerryBase(value) {
  return JSON.stringify(value || {}).includes(OLD_BASE_CODE);
}

function collectCollectionReferences(collectionName, docs, options = {}) {
  const rows = [];
  docs.forEach((doc) => {
    const data = doc;
    const id = doc.id || doc._id || '';
    const pathLabel = `${collectionName}/${id || '[unknown]'}`;
    if (data.code === OLD_BASE_CODE || data.stockItemCode === OLD_BASE_CODE || data.inventoryItemId === OLD_BASE_CODE || data.itemCode === OLD_BASE_CODE) {
      rows.push({ collection: collectionName, path: pathLabel, referenceType: 'DIRECT_FIELD', field: 'code/stockItemCode/inventoryItemId/itemCode', detail: OLD_BASE_CODE });
    }
    if (options.scanBom && Array.isArray(data.bom)) {
      data.bom.forEach((line, index) => {
        if (line.componentCode === OLD_BASE_CODE) {
          rows.push({
            collection: collectionName,
            path: pathLabel,
            referenceType: 'BOM_LINE',
            field: `bom[${index}].componentCode`,
            detail: `${data.code || id} uses ${OLD_BASE_CODE} ${numberValue(line.quantity)} ${normalizeUom(line.uom)}`,
          });
        }
      });
    }
    if (options.scanLines && Array.isArray(data.lines)) {
      data.lines.forEach((line, index) => {
        if (referenceContainsBerryBase(line)) {
          rows.push({
            collection: collectionName,
            path: pathLabel,
            referenceType: 'LINE_REFERENCE',
            field: `lines[${index}]`,
            detail: JSON.stringify(line).slice(0, 500),
          });
        }
      });
    }
    if (options.scanWholeDocument && referenceContainsBerryBase(data)) {
      const alreadySpecific = rows.some((row) => row.path === pathLabel);
      if (!alreadySpecific) {
        rows.push({
          collection: collectionName,
          path: pathLabel,
          referenceType: 'DOCUMENT_TEXT_REFERENCE',
          field: '*',
          detail: 'Document contains BERRY_ME_BASE in a non-standard field.',
        });
      }
    }
  });
  return rows;
}

async function collectLocalImportMappingReferences(rootDir) {
  const importsDir = path.join(rootDir, 'data/imports');
  const refs = [];
  try {
    const names = await fs.readdir(importsDir);
    await Promise.all(names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const filePath = path.join(importsDir, name);
        const content = await fs.readFile(filePath, 'utf8');
        if (content.includes(OLD_BASE_CODE)) {
          refs.push({
            collection: 'local-import-mappings',
            path: path.relative(rootDir, filePath),
            referenceType: 'LOCAL_FILE_TEXT_REFERENCE',
            field: '*',
            detail: `File contains ${OLD_BASE_CODE}.`,
          });
        }
      }));
  } catch {
    return refs;
  }
  return refs.sort((a, b) => a.path.localeCompare(b.path));
}

function buildCurrentStockRows(storesById, storeStock) {
  return storeStock
    .filter((row) => row.stockItemType === 'PREP_ITEM' && row.stockItemCode === OLD_BASE_CODE)
    .map((row) => {
      const store = storesById.get(row.storeId) || { id: row.storeId, code: row.storeId, name: row.storeName || row.storeId };
      return {
        path: `storeStock/${row.id || rowIdForStoreStock(row.storeId, OLD_BASE_CODE)}`,
        storeId: row.storeId,
        storeCode: storeLabel(store),
        storeName: row.storeName || store.name || row.storeId,
        uom: normalizeUom(row.uom),
        openingStock: numberValue(row.openingStock),
        currentStock: numberValue(row.currentStock),
        costPerUnit: numberValue(row.costPerUnit),
        allocationStatus: 'OWNER_ALLOCATION_REQUIRED',
      };
    })
    .sort((a, b) => a.storeCode.localeCompare(b.storeCode));
}

function buildLegacyPrepUpdate(sourcePrep) {
  if (!sourcePrep) {
    return {
      action: 'SKIP_SOURCE_PREP_MISSING',
      path: `prepItems/${OLD_BASE_CODE}`,
      fields: {},
      note: 'Old BERRY_ME_BASE was not found.',
    };
  }
  if (sourcePrep.isActive === false && sourcePrep.splitMigrationStatus === 'LEGACY_REPLACED_BY_BERRY_BASE_SPLIT_PENDING_ALLOCATION') {
    return {
      action: 'SKIP_SOURCE_ALREADY_LEGACY',
      path: `prepItems/${sourcePrep.id || OLD_BASE_CODE}`,
      fields: {},
      note: 'Old BERRY_ME_BASE is already marked legacy for the planned split.',
    };
  }
  return {
    action: 'MARK_LEGACY_INACTIVE_AFTER_REPLACEMENTS_READY',
    path: `prepItems/${sourcePrep.id || OLD_BASE_CODE}`,
    fields: {
      isActive: false,
      splitMigrationStatus: 'LEGACY_REPLACED_BY_BERRY_BASE_SPLIT_PENDING_ALLOCATION',
    },
    note: 'Old BERRY_ME_BASE remains preserved for audit. It should not be deleted or quantity-converted.',
  };
}

function targetFinishedGoodReadiness(finishedGoods) {
  return [DRINK_FG_CODE, BOWL_FG_CODE].map((code) => {
    const fg = finishedGoods.find((item) => item.code === code);
    const lines = Array.isArray(fg?.bom) ? fg.bom.filter((line) => line.componentType === 'PREP_ITEM') : [];
    return {
      finishedGoodCode: code,
      found: Boolean(fg),
      oldBaseReferences: lines.filter((line) => line.componentCode === OLD_BASE_CODE).length,
      drinkBaseReferences: lines.filter((line) => line.componentCode === DRINK_BASE_CODE).length,
      bowlBaseReferences: lines.filter((line) => line.componentCode === BOWL_BASE_CODE).length,
    };
  });
}

export function buildBerryBaseSplitPlan(input) {
  const stores = input.stores || [];
  const rawIngredients = input.rawIngredients || [];
  const prepItems = input.prepItems || [];
  const finishedGoods = input.finishedGoods || [];
  const storeStock = input.storeStock || [];
  const storeInventory = input.storeInventory || [];
  const stockMovements = input.stockMovements || [];
  const purchaseEntries = input.purchaseEntries || [];
  const pendingInventoryConsumption = input.pendingInventoryConsumption || [];
  const localImportMappingReferences = input.localImportMappingReferences || [];
  const generatedAt = input.generatedAt || new Date().toISOString();

  const storesById = new Map(stores.map((store) => [store.id, store]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const sourcePrep = prepByCode.get(OLD_BASE_CODE) || null;
  const oldStockRows = buildCurrentStockRows(storesById, storeStock);
  const affectedStoreIds = collectAffectedStoreIds(finishedGoods, oldStockRows);
  const projectedPreps = projectedPrepItems(prepItems, sourcePrep);
  const projectedFgs = projectedFinishedGoods(finishedGoods);

  const beforeBlockers = setupBlockersForStores(stores, rawIngredients, prepItems, finishedGoods)
    .filter((blocker) => blocker.componentCode === OLD_BASE_CODE || blocker.finishedGoodCode === DRINK_FG_CODE || blocker.finishedGoodCode === BOWL_FG_CODE);
  const afterBlockers = setupBlockersForStores(stores, rawIngredients, projectedPreps, projectedFgs)
    .filter((blocker) => [OLD_BASE_CODE, DRINK_BASE_CODE, BOWL_BASE_CODE].includes(blocker.componentCode)
      || blocker.finishedGoodCode === DRINK_FG_CODE
      || blocker.finishedGoodCode === BOWL_FG_CODE);

  const oldReferences = [
    ...collectCollectionReferences('prepItems', prepItems, { scanBom: true, scanWholeDocument: true }),
    ...collectCollectionReferences('finishedGoods', finishedGoods, { scanBom: true, scanWholeDocument: true }),
    ...collectCollectionReferences('storeStock', storeStock, { scanWholeDocument: true }),
    ...collectCollectionReferences('storeInventory', storeInventory, { scanWholeDocument: true }),
    ...collectCollectionReferences('stockMovements', stockMovements, { scanWholeDocument: true }),
    ...collectCollectionReferences('purchaseEntries', purchaseEntries, { scanLines: true, scanWholeDocument: true }),
    ...collectCollectionReferences('pendingInventoryConsumption', pendingInventoryConsumption, { scanWholeDocument: true }),
    ...localImportMappingReferences,
  ];

  const prepChanges = proposedPrepChanges(prepByCode, sourcePrep);
  const finishedGoodChanges = proposedFinishedGoodChanges(finishedGoods);
  const stockChanges = proposedStoreStockChanges(storesById, affectedStoreIds, oldStockRows, storeStock);
  const legacyPrepChange = buildLegacyPrepUpdate(sourcePrep);
  const residualOldFgReferences = projectedFgs.flatMap((fg) => (
    Array.isArray(fg.bom)
      ? fg.bom
        .filter((line) => line.componentType === 'PREP_ITEM' && line.componentCode === OLD_BASE_CODE)
        .map((line) => ({ finishedGoodCode: fg.code, finishedGoodName: fg.displayName || fg.name || fg.code, line }))
      : []
  ));
  const requiredOpeningBalances = stockChanges.filter((row) => row.action !== 'SKIP_EXISTING_TARGET_STOCK_ROW');
  const targetReadiness = targetFinishedGoodReadiness(projectedFgs);
  const targetBlockers = afterBlockers.filter((blocker) => blocker.finishedGoodCode === DRINK_FG_CODE || blocker.finishedGoodCode === BOWL_FG_CODE);
  const invalidUnitProjection = targetBlockers.filter((blocker) => blocker.type === 'Impossible unit conversion');

  const warnings = [];
  if (!sourcePrep) warnings.push('Source prepItems/BERRY_ME_BASE was not found.');
  if (residualOldFgReferences.length > 0) warnings.push('One or more projected finished goods still reference BERRY_ME_BASE.');
  if (oldStockRows.length === 0) warnings.push('No existing BERRY_ME_BASE storeStock rows were found.');
  if (requiredOpeningBalances.length > 0) warnings.push('Opening/current balances are required for every replacement storeStock row before any apply.');
  if (invalidUnitProjection.length > 0) warnings.push('Projected unit blockers remain after the split plan.');

  const readyForApply = sourcePrep
    && residualOldFgReferences.length === 0
    && invalidUnitProjection.length === 0
    && requiredOpeningBalances.length === 0;

  return {
    projectId: PROJECT_ID,
    mode: 'DRY_RUN_ONLY',
    generatedAt,
    sourcePrepItem: sourcePrep
      ? {
        path: `prepItems/${sourcePrep.id || OLD_BASE_CODE}`,
        code: sourcePrep.code,
        name: sourcePrep.name,
        outputUOM: normalizeUom(sourcePrep.outputUOM),
        yieldUOM: normalizeUom(sourcePrep.yieldUOM),
        isActive: sourcePrep.isActive !== false,
      }
      : null,
    proposedTargets: TARGET_PREP_ITEMS,
    referencesFound: oldReferences,
    documentsToCreate: [
      ...prepChanges.filter((change) => change.action === 'CREATE_TARGET_PREP_ITEM'),
      ...stockChanges.filter((change) => change.action === 'CREATE_TARGET_STOCK_ROW_AFTER_OWNER_ALLOCATION'),
    ],
    documentsToUpdate: [
      ...(legacyPrepChange.action === 'MARK_LEGACY_INACTIVE_AFTER_REPLACEMENTS_READY' ? [legacyPrepChange] : []),
      ...prepChanges.filter((change) => change.action === 'UPDATE_EXISTING_TARGET'),
      ...finishedGoodChanges.filter((change) => change.action === 'UPDATE_FINISHED_GOOD_BOM'),
    ],
    documentsSkipped: [
      ...(legacyPrepChange.action !== 'MARK_LEGACY_INACTIVE_AFTER_REPLACEMENTS_READY' ? [legacyPrepChange] : []),
      ...prepChanges.filter((change) => change.action === 'SKIP_ALREADY_EXISTS'),
      ...stockChanges.filter((change) => change.action === 'SKIP_EXISTING_TARGET_STOCK_ROW'),
      ...finishedGoodChanges.filter((change) => change.action === 'SKIP_ALREADY_UPDATED_OR_NO_OLD_REFERENCE'),
    ],
    oldReferences: oldReferences,
    proposedNewReferences: finishedGoodChanges.flatMap((change) => change.replacements.map((replacement) => ({
      finishedGoodCode: change.finishedGoodCode,
      finishedGoodName: change.finishedGoodName,
      oldComponentCode: replacement.oldComponentCode,
      newComponentCode: replacement.newComponentCode,
      quantity: replacement.newQuantity,
      uom: replacement.newUom,
    }))),
    currentStockByStore: oldStockRows,
    proposedReplacementStoreStockRows: stockChanges,
    requiredOwnerProvidedOpeningBalances: requiredOpeningBalances.map((row) => ({
      storeId: row.storeId,
      storeCode: row.storeCode,
      storeName: row.storeName,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      requiredUnit: row.uom,
      requiredOpeningStock: 'OWNER_REQUIRED',
      requiredCurrentStock: 'OWNER_REQUIRED',
      reason: 'BERRY_ME_BASE stock is mixed G/ML history and cannot be split automatically.',
    })),
    validation: {
      targetFinishedGoods: targetReadiness,
      beforeBlockers,
      afterBlockers,
      projectedUnitBlockersAfter: invalidUnitProjection,
      noFinishedGoodReferencesOldBaseAfterProjection: residualOldFgReferences.length === 0,
      noStockQuantitiesConvertedOrLost: true,
      idempotency: {
        deterministicDocIds: true,
        replacementPrepItemIds: TARGET_PREP_ITEMS.map((target) => target.code),
        replacementStoreStockIds: stockChanges.map((row) => path.basename(row.path)),
      },
    },
    warnings,
    applyReadiness: readyForApply ? 'READY' : 'BLOCKED',
    applyBlockedReasons: readyForApply ? [] : [
      ...(!sourcePrep ? ['Source prep item is missing.'] : []),
      ...(residualOldFgReferences.length > 0 ? ['Projected finished-good BOMs still contain BERRY_ME_BASE.'] : []),
      ...(invalidUnitProjection.length > 0 ? ['Projected unit blockers remain.'] : []),
      ...(requiredOpeningBalances.length > 0 ? [`${requiredOpeningBalances.length} owner-provided replacement storeStock opening/current balances are required.`] : []),
    ],
    notes: [
      'No Firestore writes were performed.',
      'BERRY_ME_BASE quantities are not copied or converted.',
      'G and ML are never treated as interchangeable.',
      'Old BERRY_ME_BASE is preserved as legacy until owner allocation is approved.',
    ],
    summary: {
      referencesFound: oldReferences.length,
      currentStoreStockRows: oldStockRows.length,
      documentsToCreate: prepChanges.filter((change) => change.action === 'CREATE_TARGET_PREP_ITEM').length
        + stockChanges.filter((change) => change.action === 'CREATE_TARGET_STOCK_ROW_AFTER_OWNER_ALLOCATION').length,
      documentsToUpdate: (legacyPrepChange.action === 'MARK_LEGACY_INACTIVE_AFTER_REPLACEMENTS_READY' ? 1 : 0)
        + prepChanges.filter((change) => change.action === 'UPDATE_EXISTING_TARGET').length
        + finishedGoodChanges.filter((change) => change.action === 'UPDATE_FINISHED_GOOD_BOM').length,
      oldReferencesInFinishedGoodsBefore: finishedGoods.reduce((count, fg) => (
        count + (Array.isArray(fg.bom) ? fg.bom.filter((line) => line.componentCode === OLD_BASE_CODE).length : 0)
      ), 0),
      oldReferencesInFinishedGoodsAfterProjection: residualOldFgReferences.length,
      unitBlockersBefore: beforeBlockers.filter((blocker) => blocker.type === 'Impossible unit conversion').length,
      projectedUnitBlockersAfter: invalidUnitProjection.length,
      requiredOwnerOpeningBalances: requiredOpeningBalances.length,
      applyReadiness: readyForApply ? 'READY' : 'BLOCKED',
    },
  };
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

async function writeReports(report) {
  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  const rows = [
    ...report.documentsToCreate.map((row) => ({ section: 'documentsToCreate', ...row })),
    ...report.documentsToUpdate.map((row) => ({ section: 'documentsToUpdate', ...row })),
    ...report.currentStockByStore.map((row) => ({ section: 'currentStockByStore', ...row })),
    ...report.requiredOwnerProvidedOpeningBalances.map((row) => ({ section: 'requiredOwnerOpeningBalance', ...row })),
    ...report.referencesFound.map((row) => ({ section: 'referencesFound', ...row })),
  ];
  const columns = [
    'section',
    'action',
    'path',
    'storeCode',
    'storeName',
    'stockItemCode',
    'stockItemName',
    'uom',
    'openingStock',
    'currentStock',
    'requiredUnit',
    'requiredOpeningStock',
    'requiredCurrentStock',
    'collection',
    'referenceType',
    'field',
    'detail',
    'note',
  ];
  const lines = [columns.join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  });
  await fs.writeFile(REPORT_CSV, `${lines.join('\n')}\n`);
}

async function getCollection(firestore, collectionName) {
  const snap = await firestore.collection(collectionName).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function main() {
  if (process.argv.includes('--apply')) {
    fail('Apply is intentionally not implemented for the Berry base split. This phase is dry-run only.');
  }

  const firestore = initializeAdmin();
  const rootDir = process.cwd();
  const [
    stores,
    rawIngredients,
    prepItems,
    finishedGoods,
    storeStock,
    storeInventory,
    stockMovements,
    purchaseEntries,
    pendingInventoryConsumption,
    localImportMappingReferences,
  ] = await Promise.all([
    getCollection(firestore, 'stores'),
    getCollection(firestore, 'rawIngredients'),
    getCollection(firestore, 'prepItems'),
    getCollection(firestore, 'finishedGoods'),
    getCollection(firestore, 'storeStock'),
    getCollection(firestore, 'storeInventory'),
    getCollection(firestore, 'stockMovements'),
    getCollection(firestore, 'purchaseEntries'),
    getCollection(firestore, 'pendingInventoryConsumption'),
    collectLocalImportMappingReferences(rootDir),
  ]);

  const report = buildBerryBaseSplitPlan({
    stores,
    rawIngredients,
    prepItems,
    finishedGoods,
    storeStock,
    storeInventory,
    stockMovements,
    purchaseEntries,
    pendingInventoryConsumption,
    localImportMappingReferences,
  });

  await writeReports(report);

  console.log(`Project: ${PROJECT_ID}`);
  console.log('Mode: DRY_RUN_ONLY');
  console.log(`References found: ${report.summary.referencesFound}`);
  console.log(`Current BERRY_ME_BASE storeStock rows: ${report.summary.currentStoreStockRows}`);
  console.log(`Finished-good BERRY_ME_BASE references before: ${report.summary.oldReferencesInFinishedGoodsBefore}`);
  console.log(`Finished-good BERRY_ME_BASE references after projection: ${report.summary.oldReferencesInFinishedGoodsAfterProjection}`);
  console.log(`Unit blockers before: ${report.summary.unitBlockersBefore}`);
  console.log(`Projected unit blockers after: ${report.summary.projectedUnitBlockersAfter}`);
  console.log(`Required owner opening/current balances: ${report.summary.requiredOwnerOpeningBalances}`);
  console.log(`Apply readiness: ${report.applyReadiness}`);
  report.currentStockByStore.forEach((row) => {
    console.log(`- ${row.storeCode}: opening ${row.openingStock} ${row.uom}, current ${row.currentStock} ${row.uom}`);
  });
  console.log(`Reports written: ${REPORT_JSON}, ${REPORT_CSV}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('Berry base split dry run failed:', error);
    process.exitCode = 1;
  });
}
