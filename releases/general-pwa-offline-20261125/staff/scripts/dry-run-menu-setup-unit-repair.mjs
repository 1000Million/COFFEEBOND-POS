#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  canConvertUom,
  CONFIRMED_UNIT_LABEL_REPAIR_CODES,
  deriveLiquidPrepUnitDecision,
  normalizeUom,
  TARGET_LIQUID_PREP_CODES,
} from './menu-setup-unit-rules.mjs';

const PROJECT_ID = 'coffee-bond-pos';
const REPORT_JSON = 'reports/menu-setup-unit-repair-dry-run.json';
const REPORT_CSV = 'reports/menu-setup-unit-repair-dry-run.csv';
const BACKUP_DIR = 'reports/backups';
const APPLY = process.argv.includes('--apply');
const EXPECTED_APPLY_PREP_COUNT = 6;
const EXPECTED_APPLY_STOCK_COUNT = 18;
const UNIT_FIELDS_TO_REPAIR = [
  'outputUOM',
  'yieldUOM',
  'stockUOM',
  'stockUnit',
  'uom',
  'unit',
  'baseUOM',
  'baseUnit',
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function initializeAdmin() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required. This script reads Firestore and writes only when --apply is passed.');
  }

  const app = getApps().length > 0
    ? getApp()
    : initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });

  return getFirestore(app);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function stableDocData(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    path: doc.ref.path,
    data,
  };
}

function unitFieldsForPrep(prep) {
  return UNIT_FIELDS_TO_REPAIR
    .filter((field) => Object.prototype.hasOwnProperty.call(prep, field))
    .map((field) => ({
      field,
      value: normalizeUom(prep[field]),
    }));
}

function validateUnitLabel(value, path, field) {
  const unit = normalizeUom(value);
  if (unit !== 'G' && unit !== 'ML') {
    fail(`${path}.${field} has unit ${unit || 'blank'}; expected G before first apply or ML if already corrected.`);
  }
  return unit;
}

function backupPath() {
  return `${BACKUP_DIR}/menu-setup-unit-repair-backup-${timestampForFile()}.json`;
}

function writeBackup({ prepDocs, stockDocs, mode }) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const outPath = backupPath();
  const payload = {
    projectId: PROJECT_ID,
    mode,
    generatedAt: new Date().toISOString(),
    confirmedRepairCodes: CONFIRMED_UNIT_LABEL_REPAIR_CODES,
    prepItems: prepDocs.map(stableDocData),
    storeStock: stockDocs.map(stableDocData),
    note: 'Backup captured before any apply writes. Quantities are preserved exactly by the repair script.',
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

function buildApplyPlan({ prepDocs, stockDocs }) {
  if (prepDocs.length !== EXPECTED_APPLY_PREP_COUNT) {
    fail(`Apply aborted: expected ${EXPECTED_APPLY_PREP_COUNT} confirmed prepItems, found ${prepDocs.length}.`);
  }
  if (stockDocs.length !== EXPECTED_APPLY_STOCK_COUNT) {
    fail(`Apply aborted: expected ${EXPECTED_APPLY_STOCK_COUNT} confirmed storeStock rows, found ${stockDocs.length}.`);
  }

  const prepUpdates = [];
  const stockUpdates = [];
  const alreadyCorrected = [];
  const quantitySnapshots = [];

  for (const doc of prepDocs) {
    const data = doc.data() || {};
    const code = data.code || doc.id;
    if (!CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(code)) {
      fail(`Apply aborted: unexpected prepItem target ${doc.ref.path}.`);
    }

    const outputUOM = validateUnitLabel(data.outputUOM, doc.ref.path, 'outputUOM');
    const yieldUOM = validateUnitLabel(data.yieldUOM, doc.ref.path, 'yieldUOM');
    const unitFields = unitFieldsForPrep(data);
    unitFields.forEach(({ field, value }) => validateUnitLabel(value, doc.ref.path, field));

    const fields = {};
    if (outputUOM === 'G') fields.outputUOM = 'ML';
    if (yieldUOM === 'G') fields.yieldUOM = 'ML';
    unitFields.forEach(({ field, value }) => {
      if (value === 'G') fields[field] = 'ML';
    });
    fields.outputUOM ||= outputUOM === 'ML' ? undefined : 'ML';
    fields.yieldUOM ||= yieldUOM === 'ML' ? undefined : 'ML';

    Object.keys(fields).forEach((field) => {
      if (fields[field] === undefined) delete fields[field];
    });

    if (Object.keys(fields).length > 0) {
      prepUpdates.push({
        ref: doc.ref,
        path: doc.ref.path,
        code,
        fields,
      });
    } else {
      alreadyCorrected.push(doc.ref.path);
    }
  }

  for (const doc of stockDocs) {
    const data = doc.data() || {};
    const code = data.stockItemCode || data.code || doc.id;
    if (data.stockItemType !== 'PREP_ITEM' || !CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(code)) {
      fail(`Apply aborted: unexpected storeStock target ${doc.ref.path}.`);
    }

    const uom = validateUnitLabel(data.uom, doc.ref.path, 'uom');
    quantitySnapshots.push({
      path: doc.ref.path,
      code,
      storeId: data.storeId,
      openingStock: data.openingStock,
      currentStock: data.currentStock,
      beforeUOM: uom,
    });

    if (uom === 'G') {
      stockUpdates.push({
        ref: doc.ref,
        path: doc.ref.path,
        code,
        fields: { uom: 'ML' },
      });
    } else {
      alreadyCorrected.push(doc.ref.path);
    }
  }

  return {
    prepUpdates,
    stockUpdates,
    alreadyCorrected,
    quantitySnapshots,
    totalWrites: prepUpdates.length + stockUpdates.length,
  };
}

async function applyPlan(firestore, plan) {
  if (plan.totalWrites === 0) {
    return { changedDocuments: [], skippedReason: 'All targeted prepItems and storeStock rows are already corrected.' };
  }

  const batch = firestore.batch();
  const changedDocuments = [];
  plan.prepUpdates.forEach((update) => {
    batch.update(update.ref, update.fields);
    changedDocuments.push({ path: update.path, fields: update.fields });
  });
  plan.stockUpdates.forEach((update) => {
    batch.update(update.ref, update.fields);
    changedDocuments.push({ path: update.path, fields: update.fields });
  });
  await batch.commit();
  return { changedDocuments, skippedReason: '' };
}

async function reloadPrepAndStock(firestore) {
  const [prepSnap, stockSnap] = await Promise.all([
    firestore.collection('prepItems').get(),
    firestore.collection('storeStock').get(),
  ]);
  return {
    prepItems: prepSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
    storeStock: stockSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
    prepDocs: prepSnap.docs,
    stockDocs: stockSnap.docs,
  };
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isStoreAssigned(item, storeId) {
  const ids = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return ids.length === 0 || ids.includes(storeId);
}

function isActiveFinishedGood(item, storeId) {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isStoreAssigned(item, storeId);
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
    return canConvertUom(line.uom, raw?.usageUOM || line.uom);
  }
  if (line.componentType === 'PREP_ITEM') {
    const prep = prepByCode.get(line.componentCode);
    return canConvertUom(line.uom, prep?.yieldUOM || prep?.outputUOM || line.uom);
  }
  if (line.componentType === 'FINISHED_GOOD') return canConvertUom(line.uom, 'PCS');
  return false;
}

function setupBlockersForStore(store, rawIngredients, prepItems, finishedGoods) {
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));
  const blockers = [];

  const addBlocker = (item, type, detail, line = null) => {
    blockers.push({
      storeId: store.id,
      storeCode: store.code || store.id,
      finishedGoodCode: item.code,
      finishedGoodName: item.displayName || item.name,
      type,
      detail,
      componentType: line?.componentType || '',
      componentCode: line?.componentCode || '',
      componentUom: line?.uom || '',
    });
  };

  finishedGoods.forEach((item) => {
    if (!isStoreAssigned(item, store.id) || item.isAvailable === false) return;
    if (item.isActive === false || item.isSellable === false) {
      addBlocker(item, 'Inactive / not sellable', 'Finished good is inactive or not sellable.');
      return;
    }
    if (numberValue(item.salePrice) <= 0 || !['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
      addBlocker(item, 'Invalid sale setup', 'Finished good needs a positive sale price and valid KOT station.');
      return;
    }
    if (isNoStockItem(item) || !usesBom(item)) return;
    if (!Array.isArray(item.bom) || item.bom.length === 0) {
      addBlocker(item, 'Missing BOM', 'BOM-based finished good has no BOM rows.');
      return;
    }
    item.bom.forEach((line) => {
      const componentCode = String(line.componentCode || '').trim();
      const componentType = String(line.componentType || '').trim();
      const quantity = numberValue(line.quantity);
      const uom = normalizeUom(line.uom);
      if (!componentCode || !componentType || quantity <= 0 || !uom) {
        addBlocker(item, 'Invalid BOM quantity', 'BOM row is missing component type, code, quantity, or UOM.', line);
        return;
      }
      if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
        addBlocker(item, 'Missing raw/prep master', `${componentType} / ${componentCode} is missing from master data.`, line);
        return;
      }
      if (!componentUomCompatible(line, rawByCode, prepByCode)) {
        addBlocker(item, 'Impossible unit conversion', `${componentType} / ${componentCode} cannot convert ${uom} to the stock unit.`, line);
      }
    });
  });

  const deduped = new Map();
  blockers.forEach((blocker) => {
    const key = `${blocker.storeId}|${blocker.finishedGoodCode}|${blocker.type}|${blocker.detail}`;
    if (!deduped.has(key)) deduped.set(key, blocker);
  });
  return Array.from(deduped.values());
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeReports(report) {
  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  const headers = [
    'prepItemCode',
    'prepItemName',
    'currentOutputUOM',
    'currentYieldUOM',
    'bomConsumptionUnits',
    'proposedOutputUOM',
    'proposedYieldUOM',
    'decisionStatus',
    'affectedFinishedGoods',
    'affectedStores',
    'storeStockRows',
    'storeStockMigrationRequired',
    'proposedPrepItemUpdate',
    'proposedStoreStockUpdates',
    'rootCause',
  ];
  const rows = report.items.map((item) => [
    item.prepItemCode,
    item.prepItemName,
    item.currentOutputUOM,
    item.currentYieldUOM,
    item.bomConsumptionUnits.join(' | '),
    item.proposedOutputUOM,
    item.proposedYieldUOM,
    item.decisionStatus,
    item.affectedFinishedGoods.map((fg) => `${fg.code} (${fg.quantity} ${fg.uom})`).join(' | '),
    item.affectedStores.map((store) => `${store.code || store.id}:${store.name}`).join(' | '),
    item.storeStockRows.length,
    item.storeStockMigrationRequired ? 'YES' : 'NO',
    item.proposedPrepItemUpdate ? JSON.stringify(item.proposedPrepItemUpdate) : '',
    item.proposedStoreStockUpdates.map((update) => update.path).join(' | '),
    item.rootCause,
  ]);
  fs.writeFileSync(REPORT_CSV, `${headers.map(csvEscape).join(',')}\n${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`);
}

async function main() {
  const firestore = initializeAdmin();
  const [storeSnap, rawSnap, prepSnap, finishedSnap, stockSnap] = await Promise.all([
    firestore.collection('stores').get(),
    firestore.collection('rawIngredients').get(),
    firestore.collection('prepItems').get(),
    firestore.collection('finishedGoods').get(),
    firestore.collection('storeStock').get(),
  ]);

  const stores = storeSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const rawIngredients = rawSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const prepItems = prepSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const finishedGoods = finishedSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const storeStock = stockSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));

  const storesById = new Map(stores.map((store) => [store.id, store]));
  const targetPrepByCode = new Map(prepItems.filter((prep) => TARGET_LIQUID_PREP_CODES.includes(prep.code)).map((prep) => [prep.code, prep]));
  const applyPrepDocs = prepSnap.docs.filter((doc) => CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes((doc.data() || {}).code || doc.id));
  const applyStockDocs = stockSnap.docs.filter((doc) => {
    const data = doc.data() || {};
    return data.stockItemType === 'PREP_ITEM' && CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(data.stockItemCode);
  });
  const beforeBlockers = stores.flatMap((store) => setupBlockersForStore(store, rawIngredients, prepItems, finishedGoods));

  const projectedPrepItems = prepItems.map((prep) => {
    if (!CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(prep.code)) return prep;
    return {
      ...prep,
      outputUOM: 'ML',
      yieldUOM: 'ML',
    };
  });
  const afterBlockers = stores.flatMap((store) => setupBlockersForStore(store, rawIngredients, projectedPrepItems, finishedGoods));

  const items = TARGET_LIQUID_PREP_CODES.map((prepCode) => {
    const prep = targetPrepByCode.get(prepCode);
    const affectedFinishedGoods = finishedGoods.flatMap((fg) => {
      const bom = Array.isArray(fg.bom) ? fg.bom : [];
      return bom
        .filter((line) => line.componentType === 'PREP_ITEM' && line.componentCode === prepCode)
        .map((line) => ({
          code: fg.code || fg.id,
          name: fg.displayName || fg.name || fg.id,
          quantity: numberValue(line.quantity),
          uom: normalizeUom(line.uom),
          stores: Array.isArray(fg.availableStoreIds) ? fg.availableStoreIds : [],
        }));
    });

    const affectedStoreIds = new Set();
    affectedFinishedGoods.forEach((fg) => fg.stores.forEach((storeId) => affectedStoreIds.add(storeId)));
    const affectedStores = Array.from(affectedStoreIds).map((storeId) => storesById.get(storeId) || { id: storeId, code: storeId, name: storeId });
    const bomConsumptionUnits = Array.from(new Set(affectedFinishedGoods.map((fg) => normalizeUom(fg.uom)).filter(Boolean)));
    const currentOutputUOM = normalizeUom(prep?.outputUOM);
    const currentYieldUOM = normalizeUom(prep?.yieldUOM);
    const currentStockUnit = currentYieldUOM || currentOutputUOM;
    const decision = deriveLiquidPrepUnitDecision({
      prepCode,
      currentUnit: currentStockUnit,
      consumptionUnits: bomConsumptionUnits,
    });

    const stockRows = storeStock
      .filter((row) => row.stockItemType === 'PREP_ITEM' && row.stockItemCode === prepCode)
      .map((row) => {
        const uom = normalizeUom(row.uom);
        const quantityPresent = Math.abs(numberValue(row.openingStock)) > 0.0001 || Math.abs(numberValue(row.currentStock)) > 0.0001;
        const needsUomChange = CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(prepCode) && decision.proposedUnit === 'ML' && uom && uom !== 'ML';
        return {
          path: `storeStock/${row.id}`,
          storeId: row.storeId,
          storeCode: storesById.get(row.storeId)?.code || row.storeId,
          storeName: row.storeName || storesById.get(row.storeId)?.name || row.storeId,
          currentUOM: uom,
          openingStock: numberValue(row.openingStock),
          currentStock: numberValue(row.currentStock),
          needsUomChange,
          quantityMigrationRequired: false,
          quantityRelabelOnly: needsUomChange && quantityPresent,
        };
      });

    const isConfirmedApplyTarget = CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(prepCode);
    const proposedPrepItemUpdate = isConfirmedApplyTarget && prep && decision.proposedUnit === 'ML' && (currentOutputUOM !== 'ML' || currentYieldUOM !== 'ML')
      ? {
        path: `prepItems/${prep.id || prepCode}`,
        fields: {
          outputUOM: 'ML',
          yieldUOM: 'ML',
        },
      }
      : null;
    const proposedStoreStockUpdates = stockRows
      .filter((row) => row.needsUomChange)
      .map((row) => ({
        path: row.path,
        fields: { uom: 'ML' },
        reason: 'Confirmed label-only correction. Preserve openingStock/currentStock exactly; only relabel UOM from G to ML.',
      }));
    const storeStockMigrationRequired = stockRows.some((row) => row.quantityMigrationRequired);
    const beforeForPrep = beforeBlockers.filter((blocker) => blocker.componentType === 'PREP_ITEM' && blocker.componentCode === prepCode && blocker.type === 'Impossible unit conversion');
    const afterForPrep = afterBlockers.filter((blocker) => blocker.componentType === 'PREP_ITEM' && blocker.componentCode === prepCode && blocker.type === 'Impossible unit conversion');

    return {
      prepItemCode: prepCode,
      prepItemName: prep?.name || prepCode,
      prepItemExists: Boolean(prep),
      currentOutputUOM,
      currentYieldUOM,
      currentStockUnit,
      bomConsumptionUnits,
      proposedOutputUOM: decision.proposedUnit,
      proposedYieldUOM: decision.proposedUnit,
      decisionStatus: isConfirmedApplyTarget ? decision.status : 'EXCLUDED_FROM_CONFIRMED_APPLY',
      decisionReason: isConfirmedApplyTarget ? decision.reason : 'Berry Me Base is intentionally excluded from the six confirmed unit-label corrections.',
      rootCause: prep
        ? `Finished goods consume ${prepCode} in ${bomConsumptionUnits.join('/')} but prep stock unit is ${currentStockUnit || 'missing'}.`
        : `Prep item ${prepCode} is missing.`,
      affectedFinishedGoods,
      affectedStores,
      storeStockRows: stockRows,
      storeStockMigrationRequired,
      proposedPrepItemUpdate,
      proposedStoreStockUpdates,
      beforeUnitBlockerCount: beforeForPrep.length,
      afterUnitBlockerCount: afterForPrep.length,
      afterUnitBlockers: afterForPrep,
    };
  });

  const goldenI = stores.find((store) => store.id === 'GOLDEN_I' || store.code === 'GOLDEN_I');
  const report = {
    projectId: PROJECT_ID,
    mode: APPLY ? 'APPLY_REQUESTED' : 'DRY_RUN_ONLY',
    generatedAt: new Date().toISOString(),
    targetPrepItemCodes: TARGET_LIQUID_PREP_CODES,
    confirmedApplyCodes: CONFIRMED_UNIT_LABEL_REPAIR_CODES,
    summary: {
      targetItemsFound: items.filter((item) => item.prepItemExists).length,
      proposedPrepItemUpdates: items.filter((item) => item.proposedPrepItemUpdate).length,
      proposedStoreStockUomUpdates: items.reduce((sum, item) => sum + item.proposedStoreStockUpdates.length, 0),
      storeStockRowsNeedingManualQuantityMigration: items.reduce((sum, item) => sum + item.storeStockRows.filter((row) => row.quantityMigrationRequired).length, 0),
      storeStockRowsRelabeledWithoutQuantityConversion: items.reduce((sum, item) => sum + item.storeStockRows.filter((row) => row.quantityRelabelOnly).length, 0),
      unitBlockersBeforeForTargetItems: items.reduce((sum, item) => sum + item.beforeUnitBlockerCount, 0),
      unitBlockersAfterForTargetItems: items.reduce((sum, item) => sum + item.afterUnitBlockerCount, 0),
      confirmedTargetUnitBlockersAfterCorrection: items
        .filter((item) => CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(item.prepItemCode))
        .reduce((sum, item) => sum + item.afterUnitBlockerCount, 0),
      remainingBerryMeUnitBlockers: items.find((item) => item.prepItemCode === 'BERRY_ME_BASE')?.afterUnitBlockerCount ?? 0,
      allConfirmedUnitBlockersClearAfterPrepUnitCorrection: items
        .filter((item) => CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes(item.prepItemCode))
        .every((item) => item.afterUnitBlockerCount === 0),
      goldenIInventoryPolicy: goldenI?.inventoryPolicy || (goldenI ? 'DEFAULT_ALLOW_NEGATIVE_DEFER_BOM_BY_CODE' : 'STORE_NOT_FOUND'),
      goldenINegativeInventoryExpected: goldenI ? (goldenI.inventoryPolicy === 'ALLOW_NEGATIVE_DEFER_BOM' || goldenI.inventoryPolicy === 'ALLOW_NEGATIVE' || goldenI.id === 'GOLDEN_I' || goldenI.code === 'GOLDEN_I') : false,
    },
    items,
    apply: {
      requested: APPLY,
      backupPath: null,
      changedDocuments: [],
      alreadyCorrected: [],
      unchangedQuantities: [],
      skippedReason: '',
    },
    notes: [
      'No Firestore writes were performed.',
      'Apply mode updates only the six confirmed prepItems and 18 related storeStock UOM labels.',
      'No density values were inferred or invented.',
      'G to ML is a label correction only for confirmed rows. Opening/current stock quantities are preserved exactly.',
      'BERRY_ME_BASE is intentionally excluded from apply mode.',
    ],
  };

  if (APPLY) {
    const plan = buildApplyPlan({ prepDocs: applyPrepDocs, stockDocs: applyStockDocs });
    const backup = writeBackup({ prepDocs: applyPrepDocs, stockDocs: applyStockDocs, mode: 'APPLY_BACKUP_BEFORE_UNIT_LABEL_REPAIR' });
    const result = await applyPlan(firestore, plan);
    const reloaded = await reloadPrepAndStock(firestore);
    const afterApplyBlockers = stores.flatMap((store) => setupBlockersForStore(store, rawIngredients, reloaded.prepItems, finishedGoods));
    const afterStockByPath = new Map(
      reloaded.stockDocs.map((doc) => [doc.ref.path, doc.data() || {}]),
    );
    const unchangedQuantities = plan.quantitySnapshots.map((snapshot) => {
      const after = afterStockByPath.get(snapshot.path) || {};
      return {
        path: snapshot.path,
        openingStockBefore: snapshot.openingStock,
        openingStockAfter: after.openingStock,
        currentStockBefore: snapshot.currentStock,
        currentStockAfter: after.currentStock,
        unchanged: snapshot.openingStock === after.openingStock && snapshot.currentStock === after.currentStock,
        beforeUOM: snapshot.beforeUOM,
        afterUOM: normalizeUom(after.uom),
      };
    });
    const changedPaths = new Set(result.changedDocuments.map((doc) => doc.path));

    report.mode = 'APPLY_COMPLETED';
    report.apply = {
      requested: true,
      backupPath: backup,
      changedDocuments: result.changedDocuments,
      alreadyCorrected: plan.alreadyCorrected,
      unchangedQuantities,
      skippedReason: result.skippedReason,
    };
    report.summary.actualUnitBlockersAfterApplyForConfirmedItems = CONFIRMED_UNIT_LABEL_REPAIR_CODES.reduce((sum, code) => (
      sum + afterApplyBlockers.filter((blocker) => blocker.componentType === 'PREP_ITEM' && blocker.componentCode === code && blocker.type === 'Impossible unit conversion').length
    ), 0);
    report.summary.actualRemainingBerryMeBlockersAfterApply = afterApplyBlockers.filter((blocker) => blocker.componentType === 'PREP_ITEM' && blocker.componentCode === 'BERRY_ME_BASE' && blocker.type === 'Impossible unit conversion').length;
    report.summary.changedDocumentCount = changedPaths.size;
    report.summary.quantitiesPreserved = unchangedQuantities.every((row) => row.unchanged);
    report.notes[0] = result.changedDocuments.length > 0
      ? 'Firestore writes were performed for confirmed unit-label corrections only.'
      : 'No Firestore writes were needed because all confirmed rows were already corrected.';
  }

  writeReports(report);

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Target prep items found: ${report.summary.targetItemsFound}/${TARGET_LIQUID_PREP_CODES.length}`);
  console.log(`Unit blockers before for target items: ${report.summary.unitBlockersBeforeForTargetItems}`);
  console.log(`Projected unit blockers after prep unit correction: ${report.summary.unitBlockersAfterForTargetItems}`);
  console.log(`Projected unit blockers after correction for confirmed six: ${report.summary.confirmedTargetUnitBlockersAfterCorrection}`);
  console.log(`Projected remaining Berry Me blockers: ${report.summary.remainingBerryMeUnitBlockers}`);
  console.log(`Proposed prepItems updates: ${report.summary.proposedPrepItemUpdates}`);
  console.log(`Proposed storeStock UOM label updates: ${report.summary.proposedStoreStockUomUpdates}`);
  console.log(`storeStock rows relabeled without quantity conversion: ${report.summary.storeStockRowsRelabeledWithoutQuantityConversion}`);
  console.log(`Golden I inventory policy: ${report.summary.goldenIInventoryPolicy}`);
  if (APPLY) {
    console.log(`Backup: ${report.apply.backupPath}`);
    console.log(`Changed documents: ${report.apply.changedDocuments.length}`);
    console.log(`Quantities preserved: ${report.summary.quantitiesPreserved === true ? 'yes' : 'no'}`);
    console.log(`Actual confirmed unit blockers after apply: ${report.summary.actualUnitBlockersAfterApplyForConfirmedItems}`);
    console.log(`Actual remaining Berry Me blockers after apply: ${report.summary.actualRemainingBerryMeBlockersAfterApply}`);
    if (report.apply.skippedReason) console.log(report.apply.skippedReason);
  }
  console.log(`Reports written: ${REPORT_JSON}, ${REPORT_CSV}`);
  console.log('');
  items.forEach((item) => {
    console.log(`${item.prepItemCode}: ${item.currentStockUnit || 'missing'} -> ${item.proposedYieldUOM || 'blocked'} (${item.decisionStatus})`);
    console.log(`  Finished goods: ${item.affectedFinishedGoods.map((fg) => `${fg.code} ${fg.quantity}${fg.uom}`).join(', ') || 'none'}`);
  });
}

main().catch((error) => {
  console.error('Dry-run menu setup unit repair failed:', error);
  process.exitCode = 1;
});
