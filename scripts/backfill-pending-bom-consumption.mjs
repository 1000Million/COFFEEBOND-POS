#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const REPORT_DIR = 'reports';
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const DEFAULT_STORE = 'GOLDEN_I';

const UOM_ALIASES = {
  G: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  KG: 'KG',
  KGS: 'KG',
  ML: 'ML',
  MILLILITRE: 'ML',
  MILLILITER: 'ML',
  L: 'L',
  LTR: 'L',
  LITRE: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  PIECE: 'PCS',
  SLICE: 'SLICE',
};

const UOM_SCALE = {
  G: { family: 'WEIGHT', baseFactor: 1 },
  KG: { family: 'WEIGHT', baseFactor: 1000 },
  ML: { family: 'VOLUME', baseFactor: 1 },
  L: { family: 'VOLUME', baseFactor: 1000 },
  PCS: { family: 'COUNT', baseFactor: 1 },
  SLICE: { family: 'COUNT', baseFactor: 1 },
};

const TAKEAWAY_PACKAGING_PATTERNS = [
  /\bbox(es)?\b/i,
  /\bcontainer(s)?\b/i,
  /\bcup(s)?\b/i,
  /\blid(s)?\b/i,
  /\bbag(s)?\b/i,
  /\bcarry\b/i,
  /\btake[\s_-]?away\b/i,
  /\bparcel\b/i,
  /\bcutlery\b/i,
  /\bspoon(s)?\b/i,
  /\bfork(s)?\b/i,
  /\bknife\b/i,
  /\bstraw(s)?\b/i,
];

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

function initializeAdmin() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required to read pending BOM records. No writes occur unless --apply is supplied.');
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

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundValue(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeUom(value) {
  const raw = text(value).toUpperCase();
  return UOM_ALIASES[raw] || raw;
}

function normalizeOrderType(value) {
  const normalized = text(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'DINE_IN' || normalized === 'DINEIN') return 'DINE_IN';
  if (normalized === 'TAKEAWAY' || normalized === 'PICKUP' || normalized === 'TAKE_OUT' || normalized === 'TAKEOUT') return 'TAKEAWAY';
  if (normalized === 'DELIVERY') return 'DELIVERY';
  return 'TAKEAWAY';
}

function normalizePackagingApplicabilityValue(value) {
  const normalized = text(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'DINE_IN' || normalized === 'DINEIN') return 'DINE_IN';
  if (normalized === 'TAKEAWAY' || normalized === 'PICKUP' || normalized === 'TAKE_OUT' || normalized === 'TAKEOUT') return 'TAKEAWAY';
  if (normalized === 'DELIVERY') return 'DELIVERY';
  if (normalized === 'ALL' || normalized === 'ANY') return 'ALL';
  return null;
}

function inferPackagingApplicability(line) {
  const label = `${line.componentCode || ''} ${line.componentName || ''}`.replace(/_/g, ' ');
  if (TAKEAWAY_PACKAGING_PATTERNS.some((pattern) => pattern.test(label))) {
    return ['TAKEAWAY', 'DELIVERY'];
  }
  return ['ALL'];
}

function resolvePackagingApplicability(line) {
  const rawValue = line.applicableOrderTypes
    ?? line.packagingApplicability
    ?? line.orderTypes
    ?? line.serviceTypes
    ?? line.serviceType
    ?? line.applicability;
  const values = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
  const explicit = Array.from(new Set(values.map(normalizePackagingApplicabilityValue).filter(Boolean)));
  return explicit.length > 0 ? explicit : inferPackagingApplicability(line);
}

function isPackagingComponentApplicable(line, orderType) {
  const applicability = resolvePackagingApplicability(line);
  return applicability.includes('ALL') || applicability.includes(orderType);
}

function convertQuantity(quantity, fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return null;
  if (from === to) return { quantity: roundValue(quantity), normalized: false };
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) return null;
  return { quantity: roundValue((quantity * fromMeta.baseFactor) / toMeta.baseFactor), normalized: true };
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOrBlank(value) {
  const date = toDate(value);
  return date ? date.toISOString() : '';
}

function getStockDocId(storeId, stockItemType, stockItemCode) {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

function orderValue(order) {
  return number(order?.grandTotal || order?.total || order?.netTotal);
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

async function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  rows.forEach((row) => lines.push(columns.map((column) => csvEscape(row[column])).join(',')));
  await fs.writeFile(filePath, `${lines.join('\n')}\n`);
}

async function loadPendingRecords(firestore, filters) {
  const snap = await firestore.collection('pendingInventoryConsumption')
    .where('status', '==', 'PENDING_BOM')
    .get();
  const fromDate = filters.from ? new Date(filters.from) : null;
  const toDateFilter = filters.to ? new Date(filters.to) : null;

  return snap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() || {} }))
    .filter((doc) => !filters.store || doc.data.storeId === filters.store || doc.data.storeCode === filters.store)
    .filter((doc) => !filters.finishedGood || doc.data.finishedGoodCode === filters.finishedGood)
    .filter((doc) => {
      const soldAt = toDate(doc.data.soldAt || doc.data.createdAt);
      if (!soldAt) return true;
      if (fromDate && soldAt < fromDate) return false;
      if (toDateFilter && soldAt > toDateFilter) return false;
      return true;
    })
    .sort((a, b) => {
      const aDate = toDate(a.data.soldAt || a.data.createdAt)?.getTime() || 0;
      const bDate = toDate(b.data.soldAt || b.data.createdAt)?.getTime() || 0;
      return aDate - bDate;
    });
}

async function stockTargetForBomLine(firestore, pending, line, quantitySold, orderType) {
  const componentType = text(line.componentType);
  const componentCode = text(line.componentCode);
  const componentName = text(line.componentName || componentCode);
  const componentQuantity = number(line.quantity);
  const componentUnit = normalizeUom(line.uom);
  if (componentType === 'PACKAGING' && !isPackagingComponentApplicable(line, orderType)) {
    return null;
  }
  if (!componentType || !componentCode || componentQuantity <= 0 || !componentUnit) {
    throw new Error(`Incomplete BOM line for ${pending.finishedGoodCode}.`);
  }

  if (componentType === 'PREP_ITEM') {
    const prepSnap = await firestore.collection('prepItems').doc(componentCode).get();
    if (!prepSnap.exists) throw new Error(`Prep item ${componentCode} does not exist.`);
    const prep = prepSnap.data() || {};
    const outputUom = normalizeUom(prep.yieldUOM || prep.outputUOM);
    if (prep.isStockTracked !== true || !outputUom) {
      throw new Error(`Prep item ${componentCode} is not stock-tracked with an output unit.`);
    }
    const conversion = convertQuantity(componentQuantity * quantitySold, componentUnit, outputUom);
    if (!conversion) throw new Error(`Cannot convert ${componentUnit} to ${outputUom} for prep item ${componentCode}.`);
    return {
      stockItemType: 'PREP_ITEM',
      stockItemCode: componentCode,
      stockItemName: text(prep.name || componentName),
      quantity: conversion.quantity,
      unit: outputUom,
      costPerUnit: number(prep.costPerUnit),
    };
  }

  if (['RAW_INGREDIENT', 'PACKAGING', 'BOUGHT_COMPONENT', 'FINISHED_GOOD'].includes(componentType)) {
    let master = {};
    let stockType = componentType;
    if (componentType === 'RAW_INGREDIENT' || componentType === 'PACKAGING') {
      const rawSnap = await firestore.collection('rawIngredients').doc(componentCode).get();
      if (!rawSnap.exists) throw new Error(`Raw ingredient ${componentCode} does not exist.`);
      master = rawSnap.data() || {};
      stockType = componentType === 'PACKAGING' ? 'PACKAGING' : 'RAW_INGREDIENT';
    } else if (componentType === 'FINISHED_GOOD') {
      const fgSnap = await firestore.collection('finishedGoods').doc(componentCode).get();
      if (!fgSnap.exists) throw new Error(`Finished good component ${componentCode} does not exist.`);
      master = fgSnap.data() || {};
    }
    const stockUnit = normalizeUom(master.usageUOM || master.outputUOM || componentUnit);
    const conversion = convertQuantity(componentQuantity * quantitySold, componentUnit, stockUnit);
    if (!conversion) throw new Error(`Cannot convert ${componentUnit} to ${stockUnit} for ${componentCode}.`);
    return {
      stockItemType: stockType,
      stockItemCode: componentCode,
      stockItemName: text(master.name || master.displayName || componentName),
      quantity: conversion.quantity,
      unit: stockUnit,
      costPerUnit: number(master.costPerUsageUnit || master.costPerUnit || master.recipeCost),
    };
  }

  throw new Error(`Unsupported BOM component type ${componentType} for ${componentCode}.`);
}

async function planBackfillForPending(firestore, pendingDoc) {
  const pending = pendingDoc.data;
  const orderSnap = await firestore.collection('orders').doc(pending.orderId).get();
  if (!orderSnap.exists) {
    return { action: 'FAILED_REVIEW', reason: 'Order not found', pendingDoc, movements: [] };
  }
  const order = orderSnap.data() || {};
  if (order.status === 'VOIDED' || order.status === 'CANCELLED') {
    return { action: 'CANCELLED', reason: `Order is ${order.status}`, pendingDoc, order, movements: [] };
  }
  if (order.status && order.status !== 'COMPLETED') {
    return { action: 'FAILED_REVIEW', reason: `Order status is ${order.status}`, pendingDoc, order, movements: [] };
  }

  const fgSnap = await firestore.collection('finishedGoods').doc(pending.finishedGoodCode).get();
  if (!fgSnap.exists) {
    return { action: 'FAILED_REVIEW', reason: `Finished good ${pending.finishedGoodCode} not found`, pendingDoc, order, movements: [] };
  }
  const finishedGood = fgSnap.data() || {};
  const bom = Array.isArray(finishedGood.bom) ? finishedGood.bom : [];
  if (bom.length === 0) {
    return { action: 'PENDING_BOM', reason: 'Finished good still has no BOM', pendingDoc, order, movements: [] };
  }

  try {
    const movementTargets = [];
    const orderType = normalizeOrderType(order.orderType);
    for (const line of bom) {
      const target = await stockTargetForBomLine(firestore, pending, line, number(pending.quantitySold), orderType);
      if (target) movementTargets.push(target);
    }
    return {
      action: 'READY_FOR_BACKFILL',
      reason: 'Complete BOM is available',
      pendingDoc,
      order,
      finishedGood,
      appliedBomVersion: number(finishedGood.bomVersion),
      movements: movementTargets,
    };
  } catch (error) {
    return {
      action: 'PENDING_BOM',
      reason: error instanceof Error ? error.message : String(error),
      pendingDoc,
      order,
      finishedGood,
      movements: [],
    };
  }
}

async function applyBackfillPlan(firestore, plan) {
  await firestore.runTransaction(async (transaction) => {
    const pendingSnap = await transaction.get(plan.pendingDoc.ref);
    if (!pendingSnap.exists) return;
    const pending = pendingSnap.data() || {};
    if (pending.status !== 'PENDING_BOM') return;

    const orderRef = firestore.collection('orders').doc(pending.orderId);
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists || ['VOIDED', 'CANCELLED'].includes(orderSnap.data()?.status)) {
      transaction.update(plan.pendingDoc.ref, {
        status: 'CANCELLED',
        reason: 'Order was voided/cancelled before BOM backfill.',
        resolvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const stockReads = [];
    for (const movement of plan.movements) {
      const stockId = getStockDocId(pending.storeId, movement.stockItemType, movement.stockItemCode);
      const stockRef = firestore.collection('storeStock').doc(stockId);
      stockReads.push({ movement, stockId, stockRef, snap: await transaction.get(stockRef) });
    }

    const movementIds = [];
    for (const stockRead of stockReads) {
      const current = stockRead.snap.exists ? number(stockRead.snap.data()?.currentStock) : 0;
      const newQty = roundValue(current - stockRead.movement.quantity);
      const movementRef = firestore.collection('stockMovements').doc();
      movementIds.push(movementRef.id);

      if (stockRead.snap.exists) {
        transaction.update(stockRead.stockRef, {
          currentStock: newQty,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.set(stockRead.stockRef, {
          storeId: pending.storeId,
          storeCode: pending.storeCode,
          storeName: pending.storeName,
          stockItemType: stockRead.movement.stockItemType,
          stockItemCode: stockRead.movement.stockItemCode,
          stockItemName: stockRead.movement.stockItemName,
          uom: stockRead.movement.unit,
          openingStock: 0,
          currentStock: newQty,
          minimumStock: 0,
          costPerUnit: stockRead.movement.costPerUnit,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.set(movementRef, {
        storeId: pending.storeId,
        storeCode: pending.storeCode,
        storeName: pending.storeName,
        inventoryItemId: stockRead.movement.stockItemCode,
        inventoryItemName: stockRead.movement.stockItemName,
        movementType: 'ORDER_BOM_BACKFILL',
        quantity: -stockRead.movement.quantity,
        quantityDelta: -stockRead.movement.quantity,
        unit: stockRead.movement.unit,
        referenceType: 'ORDER',
        referenceId: pending.orderId,
        orderId: pending.orderId,
        orderNumber: pending.orderNumber,
        notes: `BOM backfill for ${pending.orderNumber} / ${pending.finishedGoodCode}`,
        createdByUserId: 'SYSTEM_BACKFILL',
        createdByName: 'Pending BOM Backfill',
        createdAt: FieldValue.serverTimestamp(),
        stockSystem: 'MENU_MANAGEMENT',
        stockItemType: stockRead.movement.stockItemType,
        stockItemCode: stockRead.movement.stockItemCode,
        previousQty: current,
        newQty,
        wentNegative: newQty < 0,
        cogsAmount: roundValue(stockRead.movement.quantity * number(stockRead.movement.costPerUnit), 2),
        costPerUnitSnapshot: number(stockRead.movement.costPerUnit),
        finishedGoodCode: pending.finishedGoodCode,
        finishedGoodName: pending.finishedGoodName,
        orderLineKey: pending.orderLineId,
        source: pending.source,
        pendingInventoryConsumptionId: plan.pendingDoc.id,
      });
    }

    transaction.update(plan.pendingDoc.ref, {
      status: 'APPLIED',
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: 'SYSTEM_BACKFILL',
      appliedBomVersion: plan.appliedBomVersion || null,
      inventoryMovementIds: movementIds,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function loadNegativeBalances(firestore, store) {
  const snap = await firestore.collection('storeStock').where('storeId', '==', store).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => number(row.currentStock) < 0)
    .map((row) => ({
      stockId: row.id,
      storeId: row.storeId,
      storeName: row.storeName || '',
      stockItemType: row.stockItemType || '',
      stockItemCode: row.stockItemCode || '',
      stockItemName: row.stockItemName || '',
      currentStock: number(row.currentStock),
      uom: row.uom || '',
      costPerUnit: number(row.costPerUnit),
    }));
}

async function main() {
  const filters = {
    store: argValue('--store', DEFAULT_STORE),
    from: argValue('--from', ''),
    to: argValue('--to', ''),
    finishedGood: argValue('--finished-good', ''),
  };
  const firestore = initializeAdmin();
  const pendingRecords = await loadPendingRecords(firestore, filters);
  const plans = [];
  for (const pending of pendingRecords) {
    plans.push(await planBackfillForPending(firestore, pending));
  }

  if (APPLY) {
    for (const plan of plans.filter((item) => item.action === 'READY_FOR_BACKFILL')) {
      await applyBackfillPlan(firestore, plan);
    }
  }

  const negativeBalances = await loadNegativeBalances(firestore, filters.store);
  const detailRows = plans.map((plan) => ({
    pendingId: plan.pendingDoc.id,
    storeId: plan.pendingDoc.data.storeId,
    orderId: plan.pendingDoc.data.orderId,
    orderNumber: plan.pendingDoc.data.orderNumber,
    orderLineId: plan.pendingDoc.data.orderLineId,
    finishedGoodCode: plan.pendingDoc.data.finishedGoodCode,
    finishedGoodName: plan.pendingDoc.data.finishedGoodName,
    quantitySold: number(plan.pendingDoc.data.quantitySold),
    soldAt: isoOrBlank(plan.pendingDoc.data.soldAt || plan.pendingDoc.data.createdAt),
    currentStatus: plan.pendingDoc.data.status,
    plannedAction: APPLY && plan.action === 'READY_FOR_BACKFILL' ? 'APPLIED' : plan.action,
    reason: plan.reason,
    movementCount: plan.movements.length,
    plannedMovements: plan.movements.map((movement) => `${movement.stockItemType}/${movement.stockItemCode}:${movement.quantity}${movement.unit}`).join(' | '),
  }));

  const pendingQuantityByFinishedGood = {};
  plans
    .filter((plan) => plan.action === 'PENDING_BOM' || plan.action === 'READY_FOR_BACKFILL')
    .forEach((plan) => {
      const code = plan.pendingDoc.data.finishedGoodCode || 'UNKNOWN';
      const current = pendingQuantityByFinishedGood[code] || {
        finishedGoodCode: code,
        finishedGoodName: plan.pendingDoc.data.finishedGoodName || code,
        quantitySold: 0,
        orderLineCount: 0,
      };
      current.quantitySold = roundValue(current.quantitySold + number(plan.pendingDoc.data.quantitySold));
      current.orderLineCount += 1;
      pendingQuantityByFinishedGood[code] = current;
    });
  const activePendingOrderIds = new Set(
    plans
      .filter((plan) => plan.action === 'PENDING_BOM' || plan.action === 'READY_FOR_BACKFILL')
      .map((plan) => plan.pendingDoc.data.orderId)
      .filter(Boolean),
  );
  const pendingOrderValue = plans
    .filter((plan, index, array) => {
      const orderId = plan.pendingDoc.data.orderId;
      return activePendingOrderIds.has(orderId) && array.findIndex((candidate) => candidate.pendingDoc.data.orderId === orderId) === index;
    })
    .reduce((sum, plan) => sum + orderValue(plan.order), 0);
  const oldestPendingSale = plans
    .filter((plan) => plan.action === 'PENDING_BOM' || plan.action === 'READY_FOR_BACKFILL')
    .map((plan) => toDate(plan.pendingDoc.data.soldAt || plan.pendingDoc.data.createdAt))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0] || null;

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await writeCsv(path.join(REPORT_DIR, 'pending-bom-consumption-detail.csv'), detailRows, [
    'pendingId',
    'storeId',
    'orderId',
    'orderNumber',
    'orderLineId',
    'finishedGoodCode',
    'finishedGoodName',
    'quantitySold',
    'soldAt',
    'currentStatus',
    'plannedAction',
    'reason',
    'movementCount',
    'plannedMovements',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'negative-inventory-balances.csv'), negativeBalances, [
    'stockId',
    'storeId',
    'storeName',
    'stockItemType',
    'stockItemCode',
    'stockItemName',
    'currentStock',
    'uom',
    'costPerUnit',
  ]);

  const summary = {
    mode: DRY_RUN ? 'DRY_RUN' : 'APPLY',
    generatedAt: new Date().toISOString(),
    filters,
    pendingBomOrderLineCount: plans.filter((plan) => plan.action === 'PENDING_BOM').length,
    pendingQuantityByFinishedGood: Object.values(pendingQuantityByFinishedGood),
    oldestPendingSale: oldestPendingSale ? oldestPendingSale.toISOString() : null,
    pendingOrderCount: activePendingOrderIds.size,
    pendingOrderValue: roundValue(pendingOrderValue, 2),
    readyForBackfillCount: plans.filter((plan) => plan.action === 'READY_FOR_BACKFILL').length,
    backfilledOrderLineCount: APPLY ? plans.filter((plan) => plan.action === 'READY_FOR_BACKFILL').length : 0,
    failedBackfillCount: plans.filter((plan) => plan.action === 'FAILED_REVIEW').length,
    cancelledCount: plans.filter((plan) => plan.action === 'CANCELLED').length,
    negativeRawMaterialBalances: negativeBalances.filter((row) => row.stockItemType === 'RAW_INGREDIENT').length,
    negativePrepItemBalances: negativeBalances.filter((row) => row.stockItemType === 'PREP_ITEM').length,
    noSalesTaxPaymentKotChanges: true,
    idempotency: 'Only PENDING_BOM records are processed; APPLIED/CANCELLED records are ignored on repeat runs.',
    reports: {
      detail: path.join(REPORT_DIR, 'pending-bom-consumption-detail.csv'),
      negativeInventoryBalances: path.join(REPORT_DIR, 'negative-inventory-balances.csv'),
    },
  };
  await fs.writeFile(path.join(REPORT_DIR, 'pending-bom-consumption-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`Mode: ${summary.mode}`);
  console.log(`Store: ${filters.store}`);
  console.log(`Pending records scanned: ${plans.length}`);
  console.log(`Ready for backfill: ${summary.readyForBackfillCount}`);
  console.log(`Still pending BOM: ${summary.pendingBomOrderLineCount}`);
  console.log(`Cancelled/voided: ${summary.cancelledCount}`);
  console.log(APPLY ? `Applied backfills: ${summary.backfilledOrderLineCount}` : 'Dry run complete. No Firestore writes were performed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
