import { collection, doc, serverTimestamp, Transaction } from 'firebase/firestore';
import { db } from './firebase';
import { isPackagingComponentApplicable } from './packagingApplicability';
import { OrderType, StaffProfile, Store } from '../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StockItemType, StoreStock } from '../types/menu-management';

export type InventoryDeductionSource = 'POS' | 'CUSTOMER_WEB_ACCEPT';
export type InventoryPolicy = 'STRICT' | 'ALLOW_NEGATIVE' | 'ALLOW_NEGATIVE_DEFER_BOM';
export type InventoryConsumptionStatus = 'APPLIED' | 'PENDING_BOM' | 'NOT_REQUIRED';

export type InventoryDeductionBlockerType =
  | 'Missing finished good'
  | 'Missing stock record'
  | 'Missing BOM'
  | 'Missing prep/raw ingredient reference'
  | 'Invalid quantity'
  | 'Finished good unavailable'
  | 'Unit conversion impossible';

export type InventoryDeductionBlocker = {
  itemName: string;
  itemCode: string;
  finishedGoodCode?: string;
  blockerType: InventoryDeductionBlockerType;
  componentType?: string;
  componentCode?: string;
  componentName?: string;
  requiredQuantity?: number;
  availableQuantity?: number;
  unit?: string;
  confirmedZero?: boolean;
  storeName: string;
  storeId: string;
  suggestedAdminAction: string;
};

export type InventoryDeductionWarningType =
  | 'NEGATIVE_STOCK'
  | 'MISSING_COST'
  | 'UNIT_NORMALIZED'
  | 'MISSING_STOCK_ROW_CREATED'
  | 'STOCK_ROW_CREATED_NEGATIVE'
  | 'PENDING_BOM_DEFERRED';

export type InventoryDeductionWarning = {
  type: InventoryDeductionWarningType;
  message: string;
  storeId: string;
  storeName: string;
  stockItemType?: StockItemType;
  stockItemCode?: string;
  stockItemName?: string;
  finishedGoodCode?: string;
  finishedGoodName?: string;
  previousQty?: number;
  newQty?: number;
  unit?: string;
};

export type InventoryDeductionLineInput = {
  lineKey: string;
  quantity: number;
  finishedGood: Partial<FinishedGood> & {
    code: string;
    name: string;
    [key: string]: unknown;
  };
};

type PlannedMovementEntry = {
  stockDocId: string;
  stockRef: ReturnType<typeof doc>;
  stockItemType: StockItemType;
  stockItemCode: string;
  stockItemName: string;
  unit: string;
  quantity: number;
  lineKey: string;
  finishedGoodCode: string;
  finishedGoodName: string;
  itemCode: string;
  itemName: string;
  costPerUnit: number;
  warnings: InventoryDeductionWarning[];
};

type StockRowSnapshot = {
  id: string;
  ref: ReturnType<typeof doc>;
  stockItemType: StockItemType;
  stockItemCode: string;
  stockItemName: string;
  currentStock: number;
  uom: string;
  costPerUnit: number;
  confirmedZero: boolean;
  exists: boolean;
};

export type InventoryMovementPayload = {
  storeId: string;
  storeCode: string;
  storeName: string;
  inventoryItemId: string;
  inventoryItemName: string;
  movementType: 'SALE_DEDUCTION';
  quantity: number;
  quantityDelta: number;
  unit: string;
  referenceType: 'ORDER';
  referenceId: string;
  orderId: string;
  orderNumber: string;
  businessDate: string;
  notes: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: ReturnType<typeof serverTimestamp>;
  stockSystem: 'MENU_MANAGEMENT';
  stockItemType: StockItemType;
  stockItemCode: string;
  previousQty: number;
  newQty: number;
  wentNegative: boolean;
  cogsAmount: number;
  finishedGoodCode: string;
  finishedGoodName: string;
  source: InventoryDeductionSource;
  orderLineKey: string;
};

export type PendingInventoryConsumptionPayload = {
  storeId: string;
  storeCode: string;
  storeName: string;
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  finishedGoodId: string;
  finishedGoodCode: string;
  finishedGoodName: string;
  quantitySold: number;
  soldAt: ReturnType<typeof serverTimestamp>;
  source: InventoryDeductionSource;
  status: 'PENDING_BOM';
  reason: string;
  createdAt: ReturnType<typeof serverTimestamp>;
  resolvedAt: null;
  resolvedBy: null;
  appliedBomVersion: null;
  inventoryMovementIds: string[];
  idempotencyKey: string;
};

export type InventoryStockUpdate = {
  stockDocId: string;
  stockRef: ReturnType<typeof doc>;
  previousQty: number;
  newQty: number;
  existed: boolean;
  seedData: {
    storeId: string;
    storeCode: string;
    storeName: string;
    stockItemType: StockItemType;
    stockItemCode: string;
    stockItemName: string;
    uom: string;
    openingStock: number;
    minimumStock: number;
    costPerUnit: number;
  };
};

export type InventoryDeductionPlan = {
  blockers: InventoryDeductionBlocker[];
  warnings: InventoryDeductionWarning[];
  totalCogs: number;
  perLineCogs: Record<string, number>;
  perLineConsumptionStatus: Record<string, InventoryConsumptionStatus>;
  stockUpdates: InventoryStockUpdate[];
  movementPayloads: InventoryMovementPayload[];
  pendingConsumptionPayloads: PendingInventoryConsumptionPayload[];
};

type PlanInput = {
  transaction: Transaction;
  store: Store;
  orderId: string;
  orderNumber: string;
  orderType: OrderType;
  businessDate: string;
  source: InventoryDeductionSource;
  staffProfile: Pick<StaffProfile, 'uid' | 'name'>;
  lines: InventoryDeductionLineInput[];
};

type ExpandComponentInput = {
  lineKey: string;
  soldQuantity: number;
  finishedGoodCode: string;
  finishedGoodName: string;
  itemCode: string;
  itemName: string;
  componentType: string;
  componentCode: string;
  componentName: string;
  quantity: number;
  unit: string;
  prepPath: string[];
};

const UOM_ALIASES: Record<string, string> = {
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

const UOM_SCALE: Record<string, { family: 'WEIGHT' | 'VOLUME' | 'COUNT'; baseFactor: number }> = {
  G: { family: 'WEIGHT', baseFactor: 1 },
  KG: { family: 'WEIGHT', baseFactor: 1000 },
  ML: { family: 'VOLUME', baseFactor: 1 },
  L: { family: 'VOLUME', baseFactor: 1000 },
  PCS: { family: 'COUNT', baseFactor: 1 },
};

function roundValue(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundMoney(value: number): number {
  return roundValue(value, 2);
}

function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUom(value: unknown): string {
  const raw = String(value || '').trim().toUpperCase();
  return UOM_ALIASES[raw] || raw;
}

function convertQuantity(quantity: number, fromUom: string, toUom: string): { quantity: number; normalized: boolean } | null {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return null;
  if (from === to) return { quantity: roundValue(quantity), normalized: false };

  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) {
    return null;
  }

  const baseQuantity = quantity * fromMeta.baseFactor;
  return {
    quantity: roundValue(baseQuantity / toMeta.baseFactor),
    normalized: true,
  };
}

function usesBom(item: Partial<FinishedGood> & Record<string, unknown>): boolean {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

function isDirectStockSale(item: Partial<FinishedGood> & Record<string, unknown>): boolean {
  return item.itemType === 'DIRECT_STOCK' || item.productionMode === 'BOUGHT_AND_SOLD';
}

function isNoStockItem(item: Partial<FinishedGood> & Record<string, unknown>): boolean {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

function isStoreAssigned(item: Partial<FinishedGood> & Record<string, unknown>, storeId: string): boolean {
  const availableStoreIds = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return availableStoreIds.length === 0 || availableStoreIds.includes(storeId);
}

function getStockDocId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

function buildSaleNote(source: InventoryDeductionSource, orderNumber: string): string {
  return source === 'CUSTOMER_WEB_ACCEPT'
    ? `Online order ${orderNumber}`
    : `Order ${orderNumber}`;
}

function effectiveInventoryPolicy(store: Store): InventoryPolicy {
  const policy = String((store as Store & Record<string, unknown>).inventoryPolicy || '').trim().toUpperCase();
  if (policy === 'ALLOW_NEGATIVE_DEFER_BOM') return 'ALLOW_NEGATIVE_DEFER_BOM';
  if (policy === 'ALLOW_NEGATIVE') return 'ALLOW_NEGATIVE';
  if (store.id === 'GOLDEN_I' || store.code === 'GOLDEN_I') return 'ALLOW_NEGATIVE_DEFER_BOM';
  return 'STRICT';
}

function pendingConsumptionDocId(storeId: string, orderId: string, orderLineId: string): string {
  return `${storeId}_${orderId}_${orderLineId}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export async function planInventoryDeductionForSale(input: PlanInput): Promise<InventoryDeductionPlan> {
  const { transaction, store, orderId, orderNumber, orderType, businessDate, source, staffProfile, lines } = input;
  const inventoryPolicy = effectiveInventoryPolicy(store);
  const allowDeferredBom = inventoryPolicy === 'ALLOW_NEGATIVE_DEFER_BOM';

  const blockers: InventoryDeductionBlocker[] = [];
  const warnings: InventoryDeductionWarning[] = [];
  const warningKeys = new Set<string>();
  const movementEntries: PlannedMovementEntry[] = [];
  const perLineCogs: Record<string, number> = {};
  const perLineConsumptionStatus: Record<string, InventoryConsumptionStatus> = {};
  const pendingConsumptionPayloads: PendingInventoryConsumptionPayload[] = [];

  const rawCache = new Map<string, RawIngredient | null>();
  const prepCache = new Map<string, PrepItem | null>();
  const finishedCache = new Map<string, FinishedGood | null>();
  const stockCache = new Map<string, StockRowSnapshot | null>();

  const pushWarning = (warning: InventoryDeductionWarning) => {
    const key = JSON.stringify([
      warning.type,
      warning.finishedGoodCode || '',
      warning.stockItemType || '',
      warning.stockItemCode || '',
      warning.message,
      warning.previousQty ?? '',
      warning.newQty ?? '',
    ]);
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  };

  const addBlocker = (blocker: Omit<InventoryDeductionBlocker, 'storeName' | 'storeId'>) => {
    blockers.push({
      ...blocker,
      storeName: store.name,
      storeId: store.id,
    });
  };

  const deferLineBomIfAllowed = (
    line: InventoryDeductionLineInput,
    lineMeta: {
      blockerStart: number;
      movementStart: number;
      finishedGoodCode: string;
      finishedGoodName: string;
      soldQuantity: number;
      finishedGoodId: string;
      bomVersion: number | null;
    },
  ): boolean => {
    const lineBlockers = blockers.slice(lineMeta.blockerStart);
    if (!allowDeferredBom || lineBlockers.length === 0) return false;

    blockers.splice(lineMeta.blockerStart);
    movementEntries.splice(lineMeta.movementStart);
    perLineConsumptionStatus[line.lineKey] = 'PENDING_BOM';

    const reason = lineBlockers
      .map((blocker) => `${blocker.blockerType}${blocker.componentCode ? ` ${blocker.componentType || ''}/${blocker.componentCode}` : ''}`)
      .join('; ');
    const idempotencyKey = pendingConsumptionDocId(store.id, orderId, line.lineKey);

    pendingConsumptionPayloads.push({
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      orderId,
      orderNumber,
      orderLineId: line.lineKey,
      finishedGoodId: lineMeta.finishedGoodId,
      finishedGoodCode: lineMeta.finishedGoodCode,
      finishedGoodName: lineMeta.finishedGoodName,
      quantitySold: lineMeta.soldQuantity,
      soldAt: serverTimestamp(),
      source,
      status: 'PENDING_BOM',
      reason: reason || 'Finished good BOM is incomplete or not approved for immediate inventory consumption.',
      createdAt: serverTimestamp(),
      resolvedAt: null,
      resolvedBy: null,
      appliedBomVersion: null,
      inventoryMovementIds: [],
      idempotencyKey,
    });

    pushWarning({
      type: 'PENDING_BOM_DEFERRED',
      message: `${lineMeta.finishedGoodName}: inventory will be reconciled after BOM completion.`,
      storeId: store.id,
      storeName: store.name,
      finishedGoodCode: lineMeta.finishedGoodCode,
      finishedGoodName: lineMeta.finishedGoodName,
      unit: 'BOM',
    });
    return true;
  };

  const getRawIngredient = async (code: string): Promise<RawIngredient | null> => {
    if (rawCache.has(code)) return rawCache.get(code) || null;
    const snap = await transaction.get(doc(db, 'rawIngredients', code));
    const value = snap.exists() ? ({ id: snap.id, ...snap.data() } as RawIngredient) : null;
    rawCache.set(code, value);
    return value;
  };

  const getPrepItem = async (code: string): Promise<PrepItem | null> => {
    if (prepCache.has(code)) return prepCache.get(code) || null;
    const snap = await transaction.get(doc(db, 'prepItems', code));
    const value = snap.exists() ? ({ id: snap.id, ...snap.data() } as PrepItem) : null;
    prepCache.set(code, value);
    return value;
  };

  const getFinishedGood = async (code: string): Promise<FinishedGood | null> => {
    if (finishedCache.has(code)) return finishedCache.get(code) || null;
    const snap = await transaction.get(doc(db, 'finishedGoods', code));
    const value = snap.exists() ? ({ id: snap.id, ...snap.data() } as FinishedGood) : null;
    finishedCache.set(code, value);
    return value;
  };

  const getStockRow = async (
    stockItemType: string,
    stockItemCode: string,
    fallback?: {
      stockItemName?: string;
      stockItemType?: StockItemType;
      unit?: string;
      costPerUnit?: number;
    },
  ): Promise<StockRowSnapshot | null> => {
    const directId = getStockDocId(store.id, stockItemType, stockItemCode);
    if (stockCache.has(directId)) return stockCache.get(directId) || null;

    let stockRef = doc(db, 'storeStock', directId);
    let stockSnap = await transaction.get(stockRef);
    let resolvedType = stockItemType as StockItemType;

    if (!stockSnap.exists() && stockItemType === 'PACKAGING') {
      const fallbackId = getStockDocId(store.id, 'RAW_INGREDIENT', stockItemCode);
      stockRef = doc(db, 'storeStock', fallbackId);
      stockSnap = await transaction.get(stockRef);
      resolvedType = 'RAW_INGREDIENT';
      if (stockSnap.exists()) {
        const data = stockSnap.data() as StoreStock & Record<string, unknown>;
        const resolved = {
          id: fallbackId,
          ref: stockRef,
          stockItemType: resolvedType,
          stockItemCode,
          stockItemName: String(data.stockItemName || stockItemCode),
          currentStock: toNumber(data.currentStock),
          uom: normalizeUom(data.uom),
          costPerUnit: toNumber(data.costPerUnit),
          confirmedZero: data.confirmedZero === true,
          exists: true,
        } satisfies StockRowSnapshot;
        stockCache.set(fallbackId, resolved);
        stockCache.set(directId, resolved);
        return resolved;
      }
    }

    if (!stockSnap.exists()) {
      if (!fallback) {
        stockCache.set(directId, null);
        return null;
      }

      const resolvedType = fallback.stockItemType || (stockItemType as StockItemType);
      const resolvedId = getStockDocId(store.id, resolvedType, stockItemCode);
      const syntheticRef = doc(db, 'storeStock', resolvedId);
      const synthetic = {
        id: resolvedId,
        ref: syntheticRef,
        stockItemType: resolvedType,
        stockItemCode,
        stockItemName: String(fallback.stockItemName || stockItemCode),
        currentStock: 0,
        uom: normalizeUom(fallback.unit),
        costPerUnit: toNumber(fallback.costPerUnit),
        confirmedZero: false,
        exists: false,
      } satisfies StockRowSnapshot;
      stockCache.set(resolvedId, synthetic);
      stockCache.set(directId, synthetic);
      return synthetic;
    }

    const data = stockSnap.data() as StoreStock & Record<string, unknown>;
    const resolved = {
      id: stockRef.id,
      ref: stockRef,
      stockItemType: resolvedType,
      stockItemCode,
      stockItemName: String(data.stockItemName || stockItemCode),
      currentStock: toNumber(data.currentStock),
      uom: normalizeUom(data.uom),
      costPerUnit: toNumber(data.costPerUnit),
      confirmedZero: data.confirmedZero === true,
      exists: true,
    } satisfies StockRowSnapshot;
    stockCache.set(directId, resolved);
    return resolved;
  };

  const scheduleMovement = async (
    stockItemType: string,
    stockItemCode: string,
    stockItemName: string,
    requiredQuantity: number,
    fromUnit: string,
    context: {
      lineKey: string;
      itemCode: string;
      itemName: string;
      finishedGoodCode: string;
      finishedGoodName: string;
      componentName: string;
      componentType: string;
      suggestedAction?: string;
      defaultStockUnit?: string;
      defaultCostPerUnit?: number;
      createMissingStockType?: StockItemType;
    },
  ) => {
    const stockRow = await getStockRow(stockItemType, stockItemCode, {
      stockItemName,
      stockItemType: context.createMissingStockType,
      unit: context.defaultStockUnit || fromUnit,
      costPerUnit: context.defaultCostPerUnit,
    });
    if (!stockRow) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: 'Missing stock record',
        componentType: context.componentType,
        componentCode: stockItemCode,
        componentName: context.componentName,
        requiredQuantity: requiredQuantity,
        availableQuantity: 0,
        unit: normalizeUom(fromUnit),
        suggestedAdminAction: context.suggestedAction || `Create a storeStock row for ${context.componentType} / ${stockItemCode} at ${store.name}.`,
      });
      return;
    }

    const stockUnit = normalizeUom(stockRow.uom || fromUnit);
    if (!stockRow.exists) {
      pushWarning({
        type: 'MISSING_STOCK_ROW_CREATED',
        message: `${context.finishedGoodName}: created missing store stock row for ${stockRow.stockItemType} / ${stockItemCode} at ${store.name} with a starting quantity of 0 ${stockUnit}.`,
        storeId: store.id,
        storeName: store.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode,
        stockItemName,
        finishedGoodCode: context.finishedGoodCode,
        finishedGoodName: context.finishedGoodName,
        previousQty: 0,
        newQty: 0,
        unit: stockUnit,
      });
    }

    const conversion = convertQuantity(requiredQuantity, fromUnit, stockUnit);
    if (!conversion) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: 'Unit conversion impossible',
        componentType: stockRow.stockItemType,
        componentCode: stockItemCode,
        componentName: stockItemName,
        requiredQuantity,
        availableQuantity: stockRow.currentStock,
        unit: `${normalizeUom(fromUnit)} -> ${stockUnit}`,
        suggestedAdminAction: `Align BOM and store stock units for ${stockItemCode}.`,
      });
      return;
    }

    if (conversion.normalized) {
      pushWarning({
        type: 'UNIT_NORMALIZED',
        message: `${context.finishedGoodName}: normalized ${stockItemCode} from ${normalizeUom(fromUnit)} to ${stockUnit}.`,
        storeId: store.id,
        storeName: store.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode,
        stockItemName,
        finishedGoodCode: context.finishedGoodCode,
        finishedGoodName: context.finishedGoodName,
        unit: stockUnit,
      });
    }

    const costPerUnit = stockRow.costPerUnit > 0 ? stockRow.costPerUnit : 0;
    if (costPerUnit <= 0) {
      pushWarning({
        type: 'MISSING_COST',
        message: `${context.finishedGoodName}: ${stockItemName} has no cost configured, so COGS was recorded as 0 for this component.`,
        storeId: store.id,
        storeName: store.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode,
        stockItemName,
        finishedGoodCode: context.finishedGoodCode,
        finishedGoodName: context.finishedGoodName,
        unit: stockUnit,
      });
    }

    movementEntries.push({
      stockDocId: stockRow.id,
      stockRef: stockRow.ref,
      stockItemType: stockRow.stockItemType,
      stockItemCode,
      stockItemName,
      unit: stockUnit,
      quantity: conversion.quantity,
      lineKey: context.lineKey,
      finishedGoodCode: context.finishedGoodCode,
      finishedGoodName: context.finishedGoodName,
      itemCode: context.itemCode,
      itemName: context.itemName,
      costPerUnit,
      warnings: [],
    });
  };

  const expandPrepBom = async (
    prepItem: PrepItem,
    requiredOutputQuantity: number,
    context: Omit<ExpandComponentInput, 'componentType' | 'componentCode' | 'componentName' | 'quantity' | 'unit'> & { prepPath: string[] },
  ) => {
    const prepYieldUom = normalizeUom(prepItem.yieldUOM || prepItem.outputUOM);
    const yieldQuantity = toNumber(prepItem.yieldQuantity, 0);

    if (!prepYieldUom || yieldQuantity <= 0) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: 'Invalid quantity',
        componentType: 'PREP_ITEM',
        componentCode: prepItem.code,
        componentName: prepItem.name,
        requiredQuantity: requiredOutputQuantity,
        availableQuantity: 0,
        unit: prepYieldUom || 'PREP',
        suggestedAdminAction: `Fix yieldQuantity/yieldUOM for prep item ${prepItem.code}.`,
      });
      return;
    }

    if (!Array.isArray(prepItem.bom) || prepItem.bom.length === 0) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: 'Missing BOM',
        componentType: 'PREP_ITEM',
        componentCode: prepItem.code,
        componentName: prepItem.name,
        requiredQuantity: requiredOutputQuantity,
        availableQuantity: 0,
        unit: prepYieldUom,
        suggestedAdminAction: `Add a BOM for prep item ${prepItem.code} or mark it as stock-tracked and maintain prep stock.`,
      });
      return;
    }

    const scaleFactor = requiredOutputQuantity / yieldQuantity;

    for (const line of prepItem.bom) {
      const componentCode = String(line.componentCode || '').trim();
      const componentType = String(line.componentType || '').trim();
      const componentName = String(line.componentName || componentCode).trim();
      const componentQuantity = toNumber(line.quantity, 0);
      const componentUnit = normalizeUom(line.uom);

      if (!componentCode || !componentType || componentQuantity <= 0 || !componentUnit) {
        addBlocker({
          itemName: context.itemName,
          itemCode: context.itemCode,
          finishedGoodCode: context.finishedGoodCode,
          blockerType: 'Missing prep/raw ingredient reference',
          componentType: componentType || 'UNKNOWN',
          componentCode: componentCode || 'UNKNOWN',
          componentName: componentName || 'Missing component',
          requiredQuantity: componentQuantity,
          availableQuantity: 0,
          unit: componentUnit || prepYieldUom,
          suggestedAdminAction: `Fix the BOM row on prep item ${prepItem.code}.`,
        });
        continue;
      }

      await expandComponent({
        ...context,
        componentType,
        componentCode,
        componentName,
        quantity: componentQuantity * scaleFactor,
        unit: componentUnit,
        prepPath: [...context.prepPath, prepItem.code],
      });
    }
  };

  const expandComponent = async (component: ExpandComponentInput): Promise<void> => {
    const {
      lineKey,
      finishedGoodCode,
      finishedGoodName,
      itemCode,
      itemName,
      componentType,
      componentCode,
      componentName,
      quantity,
      unit,
      prepPath,
    } = component;

    const normalizedType = String(componentType || '').trim() as StockItemType;
    const normalizedUnit = normalizeUom(unit);
    const normalizedQuantity = toNumber(quantity, 0);

    if (!componentCode || !normalizedType || normalizedQuantity <= 0 || !normalizedUnit) {
      addBlocker({
        itemName,
        itemCode,
        finishedGoodCode,
        blockerType: 'Missing prep/raw ingredient reference',
        componentType: normalizedType || 'UNKNOWN',
        componentCode: componentCode || 'UNKNOWN',
        componentName: componentName || 'Missing component',
        requiredQuantity: normalizedQuantity,
        availableQuantity: 0,
        unit: normalizedUnit,
        suggestedAdminAction: `Fix the BOM row for ${finishedGoodCode}.`,
      });
      return;
    }

    if (normalizedType === 'RAW_INGREDIENT' || normalizedType === 'PACKAGING' || normalizedType === 'BOUGHT_COMPONENT' || normalizedType === 'FINISHED_GOOD') {
      let rawIngredient: RawIngredient | null = null;
      if (normalizedType === 'RAW_INGREDIENT' || normalizedType === 'PACKAGING') {
        rawIngredient = await getRawIngredient(componentCode);
        if (!rawIngredient) {
          addBlocker({
            itemName,
            itemCode,
            finishedGoodCode,
            blockerType: 'Missing prep/raw ingredient reference',
            componentType: normalizedType,
            componentCode,
            componentName,
            requiredQuantity: normalizedQuantity,
            availableQuantity: 0,
            unit: normalizedUnit,
            suggestedAdminAction: `Create raw ingredient master ${componentCode} before billing.`,
          });
          return;
        }
      }

      if (normalizedType === 'FINISHED_GOOD') {
        const componentFinishedGood = await getFinishedGood(componentCode);
        if (!componentFinishedGood) {
          addBlocker({
            itemName,
            itemCode,
            finishedGoodCode,
            blockerType: 'Missing prep/raw ingredient reference',
            componentType: normalizedType,
            componentCode,
            componentName,
            requiredQuantity: normalizedQuantity,
            availableQuantity: 0,
            unit: normalizedUnit,
            suggestedAdminAction: `Create finished good master ${componentCode} before billing.`,
          });
          return;
        }
      }

      await scheduleMovement(normalizedType, componentCode, componentName, normalizedQuantity, normalizedUnit, {
        lineKey,
        itemCode,
        itemName,
        finishedGoodCode,
        finishedGoodName,
        componentName,
        componentType: normalizedType,
        defaultStockUnit: rawIngredient?.usageUOM || normalizedUnit,
        defaultCostPerUnit: rawIngredient?.costPerUsageUnit,
        createMissingStockType: normalizedType,
      });
      return;
    }

    if (normalizedType === 'PREP_ITEM') {
      const prepItem = await getPrepItem(componentCode);
      if (!prepItem) {
        addBlocker({
          itemName,
          itemCode,
          finishedGoodCode,
          blockerType: 'Missing prep/raw ingredient reference',
          componentType: normalizedType,
          componentCode,
          componentName,
          requiredQuantity: normalizedQuantity,
          availableQuantity: 0,
          unit: normalizedUnit,
          suggestedAdminAction: `Create prep item master ${componentCode} before billing.`,
        });
        return;
      }

      const prepOutputUom = normalizeUom(prepItem.yieldUOM || prepItem.outputUOM);
      const prepQuantityConversion = convertQuantity(normalizedQuantity, normalizedUnit, prepOutputUom || normalizedUnit);
      if (!prepQuantityConversion) {
        addBlocker({
          itemName,
          itemCode,
          finishedGoodCode,
          blockerType: 'Unit conversion impossible',
          componentType: normalizedType,
          componentCode,
          componentName: prepItem.name,
          requiredQuantity: normalizedQuantity,
          availableQuantity: 0,
          unit: `${normalizedUnit} -> ${prepOutputUom || 'UNKNOWN'}`,
          suggestedAdminAction: `Align BOM units for prep item ${componentCode}.`,
        });
        return;
      }

      if (prepItem.isStockTracked) {
        await scheduleMovement('PREP_ITEM', componentCode, prepItem.name, prepQuantityConversion.quantity, prepOutputUom || normalizedUnit, {
          lineKey,
          itemCode,
          itemName,
          finishedGoodCode,
          finishedGoodName,
          componentName: prepItem.name,
          componentType: 'PREP_ITEM',
          defaultStockUnit: prepOutputUom || normalizedUnit,
          defaultCostPerUnit: prepItem.costPerUnit,
          createMissingStockType: 'PREP_ITEM',
        });
        return;
      }

      if (prepPath.includes(componentCode)) {
        addBlocker({
          itemName,
          itemCode,
          finishedGoodCode,
          blockerType: 'Missing BOM',
          componentType: 'PREP_ITEM',
          componentCode,
          componentName: prepItem.name,
          requiredQuantity: prepQuantityConversion.quantity,
          availableQuantity: 0,
          unit: prepOutputUom || normalizedUnit,
          suggestedAdminAction: `Resolve circular prep BOM references involving ${componentCode}.`,
        });
        return;
      }

      await expandPrepBom(prepItem, prepQuantityConversion.quantity, {
        lineKey,
        soldQuantity: component.soldQuantity,
        finishedGoodCode,
        finishedGoodName,
        itemCode,
        itemName,
        prepPath,
      });
      return;
    }

    addBlocker({
      itemName,
      itemCode,
      finishedGoodCode,
      blockerType: 'Missing prep/raw ingredient reference',
      componentType: normalizedType,
      componentCode,
      componentName,
      requiredQuantity: normalizedQuantity,
      availableQuantity: 0,
      unit: normalizedUnit,
      suggestedAdminAction: `Unsupported BOM component type ${normalizedType} for ${componentCode}.`,
    });
  };

  for (const line of lines) {
    const finishedGoodCode = String(line.finishedGood.code || '').trim();
    const finishedGoodName = String(line.finishedGood.displayName || line.finishedGood.name || finishedGoodCode).trim();
    const soldQuantity = toNumber(line.quantity, 0);
    const itemType = String(line.finishedGood.itemType || '');
    const bom = Array.isArray(line.finishedGood.bom) ? line.finishedGood.bom as BOMComponent[] : [];
    const lineBlockerStart = blockers.length;
    const lineMovementStart = movementEntries.length;

    if (!finishedGoodCode || !finishedGoodName || soldQuantity <= 0) {
      addBlocker({
        itemName: finishedGoodName || 'Unknown item',
        itemCode: finishedGoodCode || 'UNKNOWN',
        finishedGoodCode: finishedGoodCode || 'UNKNOWN',
        blockerType: 'Invalid quantity',
        requiredQuantity: soldQuantity,
        availableQuantity: 0,
        unit: 'QTY',
        suggestedAdminAction: 'Fix the sale line before billing.',
      });
      continue;
    }

    const isAvailable = line.finishedGood.isActive !== false
      && line.finishedGood.isSellable !== false
      && line.finishedGood.isAvailable !== false
      && isStoreAssigned(line.finishedGood, store.id);

    if (!isAvailable) {
      addBlocker({
        itemName: finishedGoodName,
        itemCode: finishedGoodCode,
        finishedGoodCode,
        blockerType: 'Finished good unavailable',
        requiredQuantity: soldQuantity,
        availableQuantity: 0,
        unit: 'QTY',
        suggestedAdminAction: 'Make the finished good active, sellable, available, and assigned to this store before billing.',
      });
      continue;
    }

    if (isNoStockItem(line.finishedGood)) {
      perLineConsumptionStatus[line.lineKey] = 'NOT_REQUIRED';
      continue;
    }

    if (usesBom(line.finishedGood)) {
      if (bom.length === 0) {
        addBlocker({
          itemName: finishedGoodName,
          itemCode: finishedGoodCode,
          finishedGoodCode,
          blockerType: 'Missing BOM',
          requiredQuantity: soldQuantity,
          availableQuantity: 0,
          unit: 'BOM',
          suggestedAdminAction: 'Add a BOM/recipe for this finished good in Menu Management.',
        });
        if (deferLineBomIfAllowed(line, {
          blockerStart: lineBlockerStart,
          movementStart: lineMovementStart,
          finishedGoodCode,
          finishedGoodName,
          soldQuantity,
          finishedGoodId: String((line.finishedGood as Record<string, unknown>).id || finishedGoodCode),
          bomVersion: typeof line.finishedGood.bomVersion === 'number' ? line.finishedGood.bomVersion : null,
        })) {
          continue;
        }
        continue;
      }

      for (const bomLine of bom) {
        const componentCode = String(bomLine.componentCode || '').trim();
        const componentType = String(bomLine.componentType || '').trim();
        const componentName = String(bomLine.componentName || componentCode).trim();
        const componentQuantity = toNumber(bomLine.quantity, 0);
        const componentUnit = normalizeUom(bomLine.uom);

        if (componentType === 'PACKAGING' && !isPackagingComponentApplicable(bomLine, orderType)) {
          continue;
        }

        if (!componentCode || !componentType || componentQuantity <= 0 || !componentUnit) {
          addBlocker({
            itemName: finishedGoodName,
            itemCode: finishedGoodCode,
            finishedGoodCode,
            blockerType: 'Missing prep/raw ingredient reference',
            componentType: componentType || 'UNKNOWN',
            componentCode: componentCode || 'UNKNOWN',
            componentName: componentName || 'Missing component',
            requiredQuantity: componentQuantity,
            availableQuantity: 0,
            unit: componentUnit,
            suggestedAdminAction: 'Fix the BOM row so it has a valid component type, component code, quantity, and UOM.',
          });
          continue;
        }

        await expandComponent({
          lineKey: line.lineKey,
          soldQuantity,
          finishedGoodCode,
          finishedGoodName,
          itemCode: finishedGoodCode,
          itemName: finishedGoodName,
          componentType,
          componentCode,
          componentName,
          quantity: componentQuantity * soldQuantity,
          unit: componentUnit,
          prepPath: [],
        });
      }
      if (deferLineBomIfAllowed(line, {
        blockerStart: lineBlockerStart,
        movementStart: lineMovementStart,
        finishedGoodCode,
        finishedGoodName,
        soldQuantity,
        finishedGoodId: String((line.finishedGood as Record<string, unknown>).id || finishedGoodCode),
        bomVersion: typeof line.finishedGood.bomVersion === 'number' ? line.finishedGood.bomVersion : null,
      })) {
        continue;
      }
      if (!perLineConsumptionStatus[line.lineKey]) perLineConsumptionStatus[line.lineKey] = 'APPLIED';
      continue;
    }

    if (isDirectStockSale(line.finishedGood)) {
      await scheduleMovement('FINISHED_GOOD', finishedGoodCode, finishedGoodName, soldQuantity, 'PCS', {
        lineKey: line.lineKey,
        itemCode: finishedGoodCode,
        itemName: finishedGoodName,
        finishedGoodCode,
        finishedGoodName,
        componentName: finishedGoodName,
        componentType: 'FINISHED_GOOD',
        defaultStockUnit: 'PCS',
        defaultCostPerUnit: toNumber(line.finishedGood.recipeCost),
        createMissingStockType: 'FINISHED_GOOD',
      });
      if (!perLineConsumptionStatus[line.lineKey]) perLineConsumptionStatus[line.lineKey] = 'APPLIED';
      continue;
    }

    if (!perLineConsumptionStatus[line.lineKey]) perLineConsumptionStatus[line.lineKey] = 'NOT_REQUIRED';
  }

  if (blockers.length > 0) {
    return {
      blockers,
      warnings,
      totalCogs: 0,
      perLineCogs: {},
      perLineConsumptionStatus: {},
      stockUpdates: [],
      movementPayloads: [],
      pendingConsumptionPayloads: [],
    };
  }

  const movementGroups = new Map<string, PlannedMovementEntry[]>();
  movementEntries.forEach(entry => {
    if (!movementGroups.has(entry.stockDocId)) movementGroups.set(entry.stockDocId, []);
    movementGroups.get(entry.stockDocId)!.push(entry);
  });

  const stockUpdates: InventoryStockUpdate[] = [];
  const movementPayloads: InventoryMovementPayload[] = [];

  for (const [stockDocId, entries] of movementGroups.entries()) {
    const stockRow = await getStockRow(entries[0].stockItemType, entries[0].stockItemCode, {
      stockItemName: entries[0].stockItemName,
      stockItemType: entries[0].stockItemType,
      unit: entries[0].unit,
      costPerUnit: entries[0].costPerUnit,
    });
    if (!stockRow) continue;

    let runningQty = stockRow.currentStock;
    entries.forEach(entry => {
      const previousQty = runningQty;
      const newQty = roundValue(previousQty - entry.quantity);
      runningQty = newQty;

      const cogsAmount = roundMoney(entry.quantity * entry.costPerUnit);
      perLineCogs[entry.lineKey] = roundMoney((perLineCogs[entry.lineKey] || 0) + cogsAmount);

      if (newQty < 0) {
        if (!stockRow.exists) {
          pushWarning({
            type: 'STOCK_ROW_CREATED_NEGATIVE',
            message: `${entry.finishedGoodName}: created ${entry.stockItemName} store stock at ${store.name} and immediately deducted it below zero (${previousQty.toFixed(2)} → ${newQty.toFixed(2)} ${entry.unit}).`,
            storeId: store.id,
            storeName: store.name,
            stockItemType: entry.stockItemType,
            stockItemCode: entry.stockItemCode,
            stockItemName: entry.stockItemName,
            finishedGoodCode: entry.finishedGoodCode,
            finishedGoodName: entry.finishedGoodName,
            previousQty,
            newQty,
            unit: entry.unit,
          });
        } else {
          pushWarning({
            type: 'NEGATIVE_STOCK',
            message: `${entry.finishedGoodName}: ${entry.stockItemName} dropped below zero (${previousQty.toFixed(2)} → ${newQty.toFixed(2)} ${entry.unit}).`,
            storeId: store.id,
            storeName: store.name,
            stockItemType: entry.stockItemType,
            stockItemCode: entry.stockItemCode,
            stockItemName: entry.stockItemName,
            finishedGoodCode: entry.finishedGoodCode,
            finishedGoodName: entry.finishedGoodName,
            previousQty,
            newQty,
            unit: entry.unit,
          });
        }
      }

      movementPayloads.push({
        storeId: store.id,
        storeCode: store.code,
        storeName: store.name,
        inventoryItemId: entry.stockItemCode,
        inventoryItemName: entry.stockItemName,
        movementType: 'SALE_DEDUCTION',
        quantity: -entry.quantity,
        quantityDelta: -entry.quantity,
        unit: entry.unit,
        referenceType: 'ORDER',
        referenceId: orderId,
        orderId,
        orderNumber,
        businessDate,
        notes: buildSaleNote(source, orderNumber),
        createdByUserId: staffProfile.uid,
        createdByName: staffProfile.name,
        createdAt: serverTimestamp(),
        stockSystem: 'MENU_MANAGEMENT',
        stockItemType: entry.stockItemType,
        stockItemCode: entry.stockItemCode,
        previousQty: roundValue(previousQty),
        newQty: roundValue(newQty),
        wentNegative: newQty < 0,
        cogsAmount,
        finishedGoodCode: entry.finishedGoodCode,
        finishedGoodName: entry.finishedGoodName,
        source,
        orderLineKey: entry.lineKey,
      });
    });

    stockUpdates.push({
      stockDocId,
      stockRef: stockRow.ref,
      previousQty: roundValue(stockRow.currentStock),
      newQty: roundValue(runningQty),
      existed: stockRow.exists,
      seedData: {
        storeId: store.id,
        storeCode: store.code,
        storeName: store.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode: stockRow.stockItemCode,
        stockItemName: stockRow.stockItemName,
        uom: stockRow.uom,
        openingStock: 0,
        minimumStock: 0,
        costPerUnit: stockRow.costPerUnit,
      },
    });
  }

  const totalCogs = roundMoney(Object.values(perLineCogs).reduce((sum, value) => sum + value, 0));

  return {
    blockers,
    warnings,
    totalCogs,
    perLineCogs,
    perLineConsumptionStatus,
    stockUpdates,
    movementPayloads,
    pendingConsumptionPayloads,
  };
}
