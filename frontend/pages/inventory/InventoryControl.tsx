import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  PackagePlus,
  Package,
  RefreshCw,
  ShieldAlert,
  Store as StoreIcon,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { collection, doc, getDoc, getDocs, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import {
  DayClosing,
  KotItem,
  OnlineOrder,
  Order,
  PaymentMethod,
  Store,
  StockMovement,
} from '../../types';
import {
  BOMComponent,
  FinishedGood,
  PrepItem,
  RawIngredient,
  StockItemType,
  StoreStock,
} from '../../types/menu-management';

type DatePreset = 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS' | 'CUSTOM';
type MovementTypeFilter = 'ALL' | 'SALE_DEDUCTION' | 'ORDER_BOM_BACKFILL' | 'PURCHASE_INWARD' | 'ORDER_VOID_REVERSAL' | 'ADJUSTMENT' | 'OPENING_STOCK' | 'STOCK_CORRECTION';
type ItemTypeFilter = 'ALL' | 'RAW_INGREDIENT' | 'PREP_ITEM';
type AuditStatus = 'PASS' | 'WARNING' | 'FAIL';
type PendingInventoryConsumptionStatus = 'PENDING_BOM' | 'READY_FOR_BACKFILL' | 'APPLIED' | 'CANCELLED' | 'FAILED_REVIEW';

type PendingInventoryConsumption = {
  id: string;
  storeId: string;
  storeCode?: string;
  storeName?: string;
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  finishedGoodCode: string;
  finishedGoodName: string;
  quantitySold: number;
  soldAt?: unknown;
  source?: string;
  status: PendingInventoryConsumptionStatus;
  reason?: string;
  createdAt?: unknown;
  resolvedAt?: unknown;
  resolvedBy?: string | null;
  appliedBomVersion?: number | null;
  inventoryMovementIds?: string[];
};

type AppGstConfig = {
  exists: boolean;
  defaultRate: number;
  defaultSource: string;
  storeOverrides: Record<string, number>;
};

type InventoryControlData = {
  rawIngredients: RawIngredient[];
  prepItems: PrepItem[];
  finishedGoods: FinishedGood[];
  storeStock: StoreStock[];
  orders: Order[];
  onlineOrders: OnlineOrder[];
  kotItems: KotItem[];
  stockMovements: StockMovement[];
  pendingInventoryConsumption: PendingInventoryConsumption[];
  dayClosing: DayClosing | null;
  gstConfig: AppGstConfig;
};

type SummaryCardData = {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red';
};

type AuditCardData = {
  title: string;
  status: AuditStatus;
  detail: string;
};

type SetupBlockerRow = {
  finishedGoodCode: string;
  finishedGoodName: string;
  categoryName: string;
  blockerType: string;
  internalNote: string;
  suggestedAction: string;
};

type NegativeStockRow = {
  itemName: string;
  stockItemType: StockItemType;
  storeName: string;
  currentStock: number;
  unit: string;
  lastMovementDate: string;
  lastMovementSource: string;
  createdBySale: boolean;
};

type MissingStockCreatedRow = {
  itemName: string;
  stockItemType: StockItemType;
  storeName: string;
  orderNumber: string;
  quantityDeducted: number;
  newStock: number;
  dateTime: string;
  warning: string;
};

type MissingCostRow = {
  dateTime: string;
  orderNumber: string;
  finishedGoodName: string;
  rawPrepItemName: string;
  quantityConsumed: number;
  unit: string;
  warning: string;
  cogsImpact: number;
};

type RawConsumptionRow = {
  itemName: string;
  stockItemType: StockItemType;
  totalConsumedQuantity: number;
  unit: string;
  estimatedCogs: number;
  ordersCount: number;
  lastConsumedAt: string;
};

type OrderCogsRow = {
  dateTime: string;
  orderNumber: string;
  source: 'POS' | 'CUSTOMER_WEB_ACCEPT';
  netSale: number | null;
  cogs: number | null;
  foodCostPct: number | null;
  inventoryWarningCount: number;
  stockMovementCount: number;
  paymentMethod: string;
  orderId: string;
};

type MovementAuditRow = {
  dateTime: string;
  storeName: string;
  movementType: string;
  source: string;
  orderNumber: string;
  itemType: string;
  itemName: string;
  quantityDelta: number;
  previousQty: number;
  newQty: number;
  wentNegative: boolean;
  cogsAmount: number;
  createdBy: string;
};

type PendingBomRow = {
  soldAt: string;
  orderNumber: string;
  finishedGoodName: string;
  finishedGoodCode: string;
  quantitySold: number;
  source: string;
  status: PendingInventoryConsumptionStatus;
  reason: string;
  movementCount: number;
};

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY', 'PAY_AT_COUNTER'];
const GST_CONFIG_DOC_ID = 'gstConfig';
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const RANGE_PRESETS: DatePreset[] = ['TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'CUSTOM'];
const MOVEMENT_FILTERS: { value: MovementTypeFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'SALE_DEDUCTION', label: 'Sale deduction' },
  { value: 'ORDER_BOM_BACKFILL', label: 'BOM backfill' },
  { value: 'PURCHASE_INWARD', label: 'Purchase inward' },
  { value: 'ORDER_VOID_REVERSAL', label: 'Void reversal' },
  { value: 'ADJUSTMENT', label: 'Manual adjustment' },
  { value: 'OPENING_STOCK', label: 'Opening stock' },
  { value: 'STOCK_CORRECTION', label: 'Stock correction' },
];
const ITEM_FILTERS: { value: ItemTypeFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'RAW_INGREDIENT', label: 'Raw' },
  { value: 'PREP_ITEM', label: 'Prep' },
];
const STATUS_TONE: Record<AuditStatus, string> = {
  PASS: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  WARNING: 'border-amber-200 bg-amber-50 text-amber-900',
  FAIL: 'border-red-200 bg-red-50 text-red-900',
};
const STATUS_ICON: Record<AuditStatus, ReactNode> = {
  PASS: <CheckCircle2 size={18} />,
  WARNING: <AlertTriangle size={18} />,
  FAIL: <XCircle size={18} />,
};

function todayIso(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() - days);
  return next;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfDay(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

function endOfDay(key: string): Date {
  return new Date(`${key}T23:59:59.999`);
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value: unknown): string {
  return `₹${money(value).toFixed(2)}`;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value: any): string {
  const date = toDate(value);
  return date ? date.toLocaleString() : '-';
}

function ageMinutes(value: any): number {
  const date = toDate(value);
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
}

function allowedStoreIds(profile: NonNullable<ReturnType<typeof useAuth>['staffProfile']>): string[] {
  return profile.assignedStoreIds?.length ? profile.assignedStoreIds : (profile.storeIds || []);
}

function parseRate(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pickRate(source: Record<string, unknown> | null | undefined, keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const rate = parseRate(source[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce((acc, [key, rate]) => {
    const parsed = parseRate(rate);
    if (parsed > 0) acc[key] = parsed;
    return acc;
  }, {} as Record<string, number>);
}

function normalizeUom(value: unknown): string {
  const raw = String(value || '').trim().toUpperCase();
  const aliases: Record<string, string> = {
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
  return aliases[raw] || raw;
}

function canConvertUom(fromUom: unknown, toUom: unknown): boolean {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  const family: Record<string, 'WEIGHT' | 'VOLUME' | 'COUNT'> = {
    G: 'WEIGHT',
    KG: 'WEIGHT',
    ML: 'VOLUME',
    L: 'VOLUME',
    PCS: 'COUNT',
  };
  return !!family[from] && family[from] === family[to];
}

function loadGstConfig(): Promise<AppGstConfig> {
  return getDoc(doc(db, 'appSettings', GST_CONFIG_DOC_ID)).then((snap) => {
    if (!snap.exists()) {
      return {
        exists: false,
        defaultRate: 0,
        defaultSource: `appSettings/${GST_CONFIG_DOC_ID}`,
        storeOverrides: {},
      };
    }

    const data = snap.data() as Record<string, unknown>;
    return {
      exists: true,
      defaultRate: pickRate(data, APP_TAX_RATE_KEYS),
      defaultSource: `appSettings/${GST_CONFIG_DOC_ID}`,
      storeOverrides: normalizeStoreOverrides(data.storeOverrides),
    };
  });
}

function isStoreAssigned(item: FinishedGood, storeId: string): boolean {
  const availableStoreIds = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return availableStoreIds.length === 0 || availableStoreIds.includes(storeId);
}

function isActiveSellable(item: FinishedGood, storeId: string): boolean {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isStoreAssigned(item, storeId);
}

function usesBom(item: FinishedGood): boolean {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

function isNoStockItem(item: FinishedGood): boolean {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

function effectiveOrderStatus(order: Order): 'COMPLETED' | 'VOIDED' | 'CANCELLED' {
  if (order.status === 'VOIDED') return 'VOIDED';
  if (order.status === 'CANCELLED') return 'CANCELLED';
  return 'COMPLETED';
}

function isCompletedOrder(order: Order): boolean {
  return effectiveOrderStatus(order) === 'COMPLETED';
}

function orderTaxTotal(order: Order): number {
  const gstTotal = money(order.gstTotal);
  return gstTotal > 0 ? gstTotal : money(order.taxTotal);
}

function orderDiscountTotal(order: Order): number {
  const discountAmount = money(order.discountAmount);
  if (discountAmount > 0) return discountAmount;
  const discountTotal = money(order.discountTotal);
  if (discountTotal > 0) return discountTotal;
  return money(order.discount);
}

function orderTaxableAmount(order: Order): number {
  const taxable = money(order.taxableAmount);
  if (taxable > 0) return taxable;
  return Math.max(0, money(order.subtotal) - orderDiscountTotal(order));
}

function orderPaymentBreakdown(order: Order): { method: PaymentMethod | string; amount: number }[] {
  const rawBreakdown = (order as Order & { paymentBreakdown?: { method: PaymentMethod | string; amount: number }[] }).paymentBreakdown;
  if (Array.isArray(rawBreakdown) && rawBreakdown.length > 0) {
    const normalized = rawBreakdown
      .map((payment) => ({
        method: payment.method || 'UNKNOWN',
        amount: money(payment.amount),
      }))
      .filter((payment) => payment.amount > 0);
    if (normalized.length > 0) return normalized;
  }

  return [{
    method: order.paymentMethod || 'UNKNOWN',
    amount: money(order.grandTotal),
  }];
}

function orderSourceLabel(order: Order): 'POS' | 'CUSTOMER_WEB_ACCEPT' {
  const record = order as Order & Record<string, unknown>;
  if (record.source === 'CUSTOMER_WEB' || record.onlineOrderId || record.linkedOnlineOrderId || record.linkedOnlineOrderNumber) {
    return 'CUSTOMER_WEB_ACCEPT';
  }
  return 'POS';
}

function currentStoreTaxRate(store: Store, gstConfig: AppGstConfig, finishedGoods: FinishedGood[]): { rate: number; source: string } {
  const overrideRate = gstConfig.storeOverrides[store.id] || gstConfig.storeOverrides[store.code] || 0;
  if (overrideRate > 0) {
    return { rate: overrideRate, source: `appSettings/${GST_CONFIG_DOC_ID}.storeOverrides.${store.code}` };
  }

  const storeRate = pickRate(store as unknown as Record<string, unknown>, STORE_TAX_RATE_KEYS);
  if (storeRate > 0) {
    return { rate: storeRate, source: `stores/${store.id}` };
  }

  const itemRates = finishedGoods
    .map((item) => parseRate((item as FinishedGood & Record<string, unknown>).taxRate))
    .filter((rate) => rate > 0);
  if (itemRates.length > 0) {
    return { rate: itemRates[0], source: 'item' };
  }

  if (gstConfig.defaultRate > 0) {
    return { rate: gstConfig.defaultRate, source: gstConfig.defaultSource };
  }

  return { rate: 0, source: 'missing' };
}

function movementDocKey(movement: StockMovement): string {
  return `${movement.stockItemType || 'UNKNOWN'}|${movement.stockItemCode || movement.inventoryItemId || 'UNKNOWN'}`;
}

function componentMasterExists(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING' || line.componentType === 'BOUGHT_COMPONENT') {
    return rawByCode.has(line.componentCode);
  }
  if (line.componentType === 'PREP_ITEM') return prepByCode.has(line.componentCode);
  if (line.componentType === 'FINISHED_GOOD') return finishedByCode.has(line.componentCode);
  return false;
}

function componentUomCompatible(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING' || line.componentType === 'BOUGHT_COMPONENT') {
    const raw = rawByCode.get(line.componentCode);
    return canConvertUom(line.uom, raw?.usageUOM || line.uom);
  }

  if (line.componentType === 'PREP_ITEM') {
    const prep = prepByCode.get(line.componentCode);
    return canConvertUom(line.uom, prep?.yieldUOM || prep?.outputUOM || line.uom);
  }

  if (line.componentType === 'FINISHED_GOOD') {
    return canConvertUom(line.uom, 'PCS');
  }

  return false;
}

function analyzePrepStructure(
  prepItem: PrepItem,
  store: Store,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
  parentFinishedGood: FinishedGood,
  visited: Set<string>,
): SetupBlockerRow[] {
  if (visited.has(prepItem.code)) {
    return [{
      finishedGoodCode: parentFinishedGood.code,
      finishedGoodName: parentFinishedGood.displayName || parentFinishedGood.name,
      categoryName: parentFinishedGood.posCategoryName || 'Other',
      blockerType: 'Missing BOM',
      internalNote: `Circular prep BOM reference detected at PREP_ITEM / ${prepItem.code}.`,
      suggestedAction: `Break the circular prep BOM loop in ${prepItem.code}.`,
    }];
  }

  if (prepItem.isStockTracked) return [];

  const yieldQty = money(prepItem.yieldQuantity);
  const yieldUom = normalizeUom(prepItem.yieldUOM || prepItem.outputUOM);
  if (yieldQty <= 0 || !yieldUom) {
    return [{
      finishedGoodCode: parentFinishedGood.code,
      finishedGoodName: parentFinishedGood.displayName || parentFinishedGood.name,
      categoryName: parentFinishedGood.posCategoryName || 'Other',
      blockerType: 'Invalid BOM quantity',
      internalNote: `Prep item ${prepItem.code} needs a valid yield quantity/UOM.`,
      suggestedAction: `Fix yieldQuantity and yieldUOM on ${prepItem.code}.`,
    }];
  }

  if (!Array.isArray(prepItem.bom) || prepItem.bom.length === 0) {
    return [{
      finishedGoodCode: parentFinishedGood.code,
      finishedGoodName: parentFinishedGood.displayName || parentFinishedGood.name,
      categoryName: parentFinishedGood.posCategoryName || 'Other',
      blockerType: 'Missing BOM',
      internalNote: `Prep item ${prepItem.code} has no BOM rows.`,
      suggestedAction: `Add a BOM to prep item ${prepItem.code} or mark it stock-tracked.`,
    }];
  }

  const nextVisited = new Set(visited);
  nextVisited.add(prepItem.code);
  const blockers: SetupBlockerRow[] = [];

  prepItem.bom.forEach((line) => {
    const componentCode = String(line.componentCode || '').trim();
    const componentType = String(line.componentType || '').trim();
    const componentQuantity = money(line.quantity);
    const componentUom = normalizeUom(line.uom);

    if (!componentCode || !componentType || componentQuantity <= 0 || !componentUom) {
      blockers.push({
        finishedGoodCode: parentFinishedGood.code,
        finishedGoodName: parentFinishedGood.displayName || parentFinishedGood.name,
        categoryName: parentFinishedGood.posCategoryName || 'Other',
        blockerType: 'Invalid BOM quantity',
        internalNote: `Prep BOM row on ${prepItem.code} is incomplete.`,
        suggestedAction: `Fix the component type, code, quantity, and UOM on ${prepItem.code}.`,
      });
      return;
    }

    if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
      blockers.push({
        finishedGoodCode: parentFinishedGood.code,
        finishedGoodName: parentFinishedGood.displayName || parentFinishedGood.name,
        categoryName: parentFinishedGood.posCategoryName || 'Other',
        blockerType: 'Missing raw/prep master',
        internalNote: `Prep BOM on ${prepItem.code} references missing ${componentType} / ${componentCode}.`,
        suggestedAction: `Create or restore ${componentType} / ${componentCode}.`,
      });
      return;
    }

    if (!componentUomCompatible(line, rawByCode, prepByCode)) {
      blockers.push({
        finishedGoodCode: parentFinishedGood.code,
        finishedGoodName: parentFinishedGood.displayName || parentFinishedGood.name,
        categoryName: parentFinishedGood.posCategoryName || 'Other',
        blockerType: 'Impossible unit conversion',
        internalNote: `${componentType} / ${componentCode} cannot convert ${componentUom} to the stock master unit.`,
        suggestedAction: `Align the units for ${componentCode} and the prep BOM on ${prepItem.code}.`,
      });
      return;
    }

    if (componentType === 'PREP_ITEM') {
      const nestedPrep = prepByCode.get(componentCode);
      if (nestedPrep) {
        blockers.push(...analyzePrepStructure(nestedPrep, store, rawByCode, prepByCode, finishedByCode, parentFinishedGood, nextVisited));
      }
    }
  });

  return blockers;
}

function buildSetupBlockers(
  store: Store,
  rawIngredients: RawIngredient[],
  prepItems: PrepItem[],
  finishedGoods: FinishedGood[],
): SetupBlockerRow[] {
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));

  const blockers: SetupBlockerRow[] = [];
  finishedGoods.forEach((item) => {
    if (!isStoreAssigned(item, store.id) || item.isAvailable === false) {
      blockers.push({
        finishedGoodCode: item.code,
        finishedGoodName: item.displayName || item.name,
        categoryName: item.posCategoryName || 'Other',
        blockerType: 'Store disabled',
        internalNote: 'The item is not assigned to this store or online/POS availability is turned off.',
        suggestedAction: 'Assign this item to the store or re-enable availability.',
      });
      return;
    }

    if (item.isActive === false || item.isSellable === false) {
      blockers.push({
        finishedGoodCode: item.code,
        finishedGoodName: item.displayName || item.name,
        categoryName: item.posCategoryName || 'Other',
        blockerType: 'Inactive / not sellable',
        internalNote: 'The item is inactive or not sellable.',
        suggestedAction: 'Make the finished good active and sellable in Menu Management.',
      });
      return;
    }

    if (money(item.salePrice) <= 0 || !['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
      blockers.push({
        finishedGoodCode: item.code,
        finishedGoodName: item.displayName || item.name,
        categoryName: item.posCategoryName || 'Other',
        blockerType: 'Invalid sale setup',
        internalNote: 'The finished good needs a sale price and valid prep station.',
        suggestedAction: 'Set a positive sale price and a valid prep station.',
      });
      return;
    }

    if (isNoStockItem(item)) return;

    if (!usesBom(item)) return;

    if (!Array.isArray(item.bom) || item.bom.length === 0) {
      blockers.push({
        finishedGoodCode: item.code,
        finishedGoodName: item.displayName || item.name,
        categoryName: item.posCategoryName || 'Other',
        blockerType: 'Missing BOM',
        internalNote: 'The finished good is BOM-based but has no BOM rows.',
        suggestedAction: 'Add a BOM or change the production mode if this is a direct-stock item.',
      });
      return;
    }

    item.bom.forEach((line) => {
      const componentCode = String(line.componentCode || '').trim();
      const componentType = String(line.componentType || '').trim();
      const componentQuantity = money(line.quantity);
      const componentUom = normalizeUom(line.uom);

      if (!componentCode || !componentType || componentQuantity <= 0 || !componentUom) {
        blockers.push({
          finishedGoodCode: item.code,
          finishedGoodName: item.displayName || item.name,
          categoryName: item.posCategoryName || 'Other',
          blockerType: 'Invalid BOM quantity',
          internalNote: `BOM row on ${item.code} is missing a component code, type, quantity, or UOM.`,
          suggestedAction: `Fix the BOM row for ${item.code}.`,
        });
        return;
      }

      if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
        blockers.push({
          finishedGoodCode: item.code,
          finishedGoodName: item.displayName || item.name,
          categoryName: item.posCategoryName || 'Other',
          blockerType: 'Missing raw/prep master',
          internalNote: `${componentType} / ${componentCode} does not exist in the master data.`,
          suggestedAction: `Create or restore ${componentType} / ${componentCode}.`,
        });
        return;
      }

      if (!componentUomCompatible(line, rawByCode, prepByCode)) {
        blockers.push({
          finishedGoodCode: item.code,
          finishedGoodName: item.displayName || item.name,
          categoryName: item.posCategoryName || 'Other',
          blockerType: 'Impossible unit conversion',
          internalNote: `${componentType} / ${componentCode} cannot convert ${componentUom} into the stock unit.`,
          suggestedAction: `Align the units for ${componentCode} and the BOM on ${item.code}.`,
        });
        return;
      }

      if (componentType === 'PREP_ITEM') {
        const nestedPrep = prepByCode.get(componentCode);
        if (nestedPrep) {
          blockers.push(...analyzePrepStructure(nestedPrep, store, rawByCode, prepByCode, finishedByCode, item, new Set([item.code])));
        }
      }
    });
  });

  const deduped = new Map<string, SetupBlockerRow>();
  blockers.forEach((blocker) => {
    const key = [
      blocker.finishedGoodCode,
      blocker.blockerType,
      blocker.internalNote,
      blocker.suggestedAction,
    ].join('|');
    if (!deduped.has(key)) deduped.set(key, blocker);
  });
  return Array.from(deduped.values());
}

function buildPaymentTotals(orders: Order[]): Record<PaymentMethod, number> {
  return PAYMENT_METHODS.reduce((acc, method) => {
    acc[method] = 0;
    return acc;
  }, {} as Record<PaymentMethod, number>);
}

function buildRawConsumptionRows(movements: StockMovement[]): RawConsumptionRow[] {
  const grouped = new Map<string, RawConsumptionRow & { orderIds: Set<string> }>();
  movements.forEach((movement) => {
    if (movement.movementType !== 'SALE_DEDUCTION' && movement.movementType !== 'ORDER_BOM_BACKFILL') return;
    if (!['RAW_INGREDIENT', 'PREP_ITEM'].includes(String(movement.stockItemType || ''))) return;
    const key = `${movement.stockItemType || 'UNKNOWN'}|${movement.stockItemCode || movement.inventoryItemId || 'UNKNOWN'}|${movement.unit || 'UNKNOWN'}`;
    const existing = grouped.get(key) || {
      itemName: movement.inventoryItemName || movement.inventoryItemId || 'Unknown item',
      stockItemType: (movement.stockItemType || 'RAW_INGREDIENT') as StockItemType,
      totalConsumedQuantity: 0,
      unit: movement.unit || '-',
      estimatedCogs: 0,
      ordersCount: 0,
      lastConsumedAt: '',
      orderIds: new Set<string>(),
    };
    const qty = Math.abs(money(movement.quantityDelta ?? movement.quantity));
    existing.totalConsumedQuantity += qty;
    existing.estimatedCogs += money(movement.cogsAmount);
    if (movement.orderId) existing.orderIds.add(movement.orderId);
    const currentDate = toDate(movement.createdAt);
    const existingDate = existing.lastConsumedAt ? toDate(existing.lastConsumedAt) : null;
    if (!existingDate || (currentDate && currentDate > existingDate)) {
      existing.lastConsumedAt = movement.createdAt;
    }
    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map(({ orderIds, ...row }) => ({
      ...row,
      ordersCount: orderIds.size,
      lastConsumedAt: formatDateTime(row.lastConsumedAt),
    }))
    .sort((a, b) => b.totalConsumedQuantity - a.totalConsumedQuantity || b.estimatedCogs - a.estimatedCogs);
}

function buildOrderCogsRows(orders: Order[], movements: StockMovement[]): OrderCogsRow[] {
  const movementCogsByOrder = new Map<string, number>();
  const movementCountByOrder = new Map<string, number>();

  movements.forEach((movement) => {
    if (!movement.orderId) return;
    const cogs = money(movement.cogsAmount);
    movementCogsByOrder.set(movement.orderId, (movementCogsByOrder.get(movement.orderId) || 0) + cogs);
    movementCountByOrder.set(movement.orderId, (movementCountByOrder.get(movement.orderId) || 0) + 1);
  });

  return orders
    .filter((order) => isCompletedOrder(order))
    .map((order) => {
      const orderId = order.id || '';
      const cogsFromOrder = money(order.cogsTotal);
      const cogsFromMovements = movementCogsByOrder.get(orderId) || 0;
      const cogs = cogsFromOrder > 0 ? cogsFromOrder : (cogsFromMovements > 0 ? cogsFromMovements : null);
      const netSale = money(order.grandTotal);
      const foodCostPct = cogs !== null && netSale > 0 ? (cogs / netSale) * 100 : null;
      return {
        dateTime: formatDateTime(order.createdAt),
        orderNumber: order.orderNumber,
        source: orderSourceLabel(order),
        netSale: netSale > 0 ? netSale : null,
        cogs,
        foodCostPct,
        inventoryWarningCount: money(order.inventoryWarningCount),
        stockMovementCount: money(order.stockMovementCount) || movementCountByOrder.get(orderId) || 0,
        paymentMethod: order.paymentMethodLabel || order.paymentMethod || 'UNKNOWN',
        orderId,
      };
    })
    .sort((a, b) => {
      const aDate = new Date(a.dateTime).getTime();
      const bDate = new Date(b.dateTime).getTime();
      return bDate - aDate;
    })
    .slice(0, 50);
}

function buildMovementAuditRows(movements: StockMovement[]): MovementAuditRow[] {
  return movements.map((movement) => ({
    dateTime: formatDateTime(movement.createdAt),
    storeName: movement.storeName || '-',
    movementType: movement.movementType || '-',
    source: movement.source || movement.referenceType || '-',
    orderNumber: movement.orderNumber || '-',
    itemType: movement.stockItemType || movement.inventoryItemId || '-',
    itemName: movement.inventoryItemName || movement.inventoryItemId || '-',
    quantityDelta: money(movement.quantityDelta ?? movement.quantity),
    previousQty: money(movement.previousQty),
    newQty: money(movement.newQty),
    wentNegative: Boolean(movement.wentNegative),
    cogsAmount: money(movement.cogsAmount),
    createdBy: movement.createdByName || '-',
  }));
}

function buildMissingCostRows(movements: StockMovement[]): MissingCostRow[] {
  return movements
    .filter((movement) => (movement.movementType === 'SALE_DEDUCTION' || movement.movementType === 'ORDER_BOM_BACKFILL') && money(movement.cogsAmount) <= 0)
    .map((movement) => ({
      dateTime: formatDateTime(movement.createdAt),
      orderNumber: movement.orderNumber || '-',
      finishedGoodName: movement.finishedGoodName || movement.inventoryItemName || '-',
      rawPrepItemName: movement.inventoryItemName || '-',
      quantityConsumed: Math.abs(money(movement.quantityDelta ?? movement.quantity)),
      unit: movement.unit || '-',
      warning: 'Missing cost warning',
      cogsImpact: money(movement.cogsAmount),
    }));
}

function buildMissingStockCreatedRows(movements: StockMovement[]): MissingStockCreatedRow[] {
  return movements
    .filter((movement) => (movement.movementType === 'SALE_DEDUCTION' || movement.movementType === 'ORDER_BOM_BACKFILL') && money(movement.previousQty) === 0 && money(movement.newQty) < 0)
    .map((movement) => ({
      itemName: movement.inventoryItemName || '-',
      stockItemType: (movement.stockItemType || 'RAW_INGREDIENT') as StockItemType,
      storeName: movement.storeName || '-',
      orderNumber: movement.orderNumber || '-',
      quantityDeducted: Math.abs(money(movement.quantityDelta ?? movement.quantity)),
      newStock: money(movement.newQty),
      dateTime: formatDateTime(movement.createdAt),
      warning: 'Created from sale with zero/missing stock',
    }));
}

function buildNegativeStockRows(
  store: Store,
  storeStock: StoreStock[],
  movements: StockMovement[],
): NegativeStockRow[] {
  const latestMovementByKey = new Map<string, StockMovement>();
  movements.forEach((movement) => {
    if (!movement.stockItemType || !movement.stockItemCode) return;
    const key = movementDocKey({
      stockItemType: movement.stockItemType,
      stockItemCode: movement.stockItemCode,
    } as StockMovement);
    const existing = latestMovementByKey.get(key);
    const currentDate = toDate(movement.createdAt)?.getTime() || 0;
    const existingDate = existing ? (toDate(existing.createdAt)?.getTime() || 0) : 0;
    if (!existing || currentDate > existingDate) {
      latestMovementByKey.set(key, movement);
    }
  });

  return storeStock
    .filter((row) => row.storeId === store.id && ['RAW_INGREDIENT', 'PREP_ITEM'].includes(row.stockItemType) && money(row.currentStock) < 0)
    .map((row) => {
      const latestMovement = latestMovementByKey.get(`${row.stockItemType}|${row.stockItemCode}`);
      const createdBySale = Boolean(latestMovement && (latestMovement.movementType === 'SALE_DEDUCTION' || latestMovement.movementType === 'ORDER_BOM_BACKFILL') && (money(latestMovement.previousQty) === 0 || latestMovement.wentNegative));
      return {
        itemName: row.stockItemName,
        stockItemType: row.stockItemType,
        storeName: row.storeName,
        currentStock: money(row.currentStock),
        unit: row.uom,
        lastMovementDate: latestMovement ? formatDateTime(latestMovement.createdAt) : '-',
        lastMovementSource: latestMovement ? `${latestMovement.source || latestMovement.referenceType || '-'}${latestMovement.orderNumber ? ` • ${latestMovement.orderNumber}` : ''}` : '-',
        createdBySale,
      };
    })
    .sort((a, b) => a.currentStock - b.currentStock);
}

function buildPendingBomRows(pendingRows: PendingInventoryConsumption[]): PendingBomRow[] {
  return pendingRows
    .map((row) => ({
      soldAt: formatDateTime(row.soldAt || row.createdAt),
      orderNumber: row.orderNumber || '-',
      finishedGoodName: row.finishedGoodName || row.finishedGoodCode || '-',
      finishedGoodCode: row.finishedGoodCode || '-',
      quantitySold: money(row.quantitySold),
      source: row.source || '-',
      status: row.status || 'PENDING_BOM',
      reason: row.reason || '-',
      movementCount: Array.isArray(row.inventoryMovementIds) ? row.inventoryMovementIds.length : 0,
    }))
    .sort((a, b) => {
      const aDate = new Date(a.soldAt).getTime();
      const bDate = new Date(b.soldAt).getTime();
      return bDate - aDate;
    });
}

function buildAuditCards(params: {
  dayClosing: DayClosing | null;
  completedOrders: Order[];
  voidedOrders: Order[];
  paymentDifference: number;
  missingVoidReasonCount: number;
  missingReversalCount: number;
  gstConfigActive: boolean;
  gstZeroCount: number;
  pendingOnlineCount: number;
  rejectedOnlineCount: number;
  pendingOnlineOldCount: number;
  unsettledPayAtCounterCount: number;
  reversalCount: number;
  kotPendingCount: number;
  kotOldPendingCount: number;
  closingHasVariance: boolean;
  closingMissingNotes: boolean;
  dayClosingExists: boolean;
}): AuditCardData[] {
  const {
    dayClosing,
    paymentDifference,
    missingVoidReasonCount,
    missingReversalCount,
    gstConfigActive,
    gstZeroCount,
    pendingOnlineCount,
    rejectedOnlineCount,
    pendingOnlineOldCount,
    unsettledPayAtCounterCount,
    reversalCount,
    kotPendingCount,
    kotOldPendingCount,
    closingHasVariance,
    closingMissingNotes,
    dayClosingExists,
  } = params;

  const cashCheck: AuditStatus = !dayClosingExists ? 'FAIL' : Math.abs(paymentDifference) <= 0.01 ? 'PASS' : 'WARNING';
  const paymentCheck: AuditStatus = unsettledPayAtCounterCount > 0 ? (Math.abs(paymentDifference) <= 0.01 ? 'WARNING' : 'FAIL') : Math.abs(paymentDifference) <= 0.01 ? 'PASS' : 'FAIL';
  const voidCheck: AuditStatus = missingVoidReasonCount > 0 ? 'WARNING' : 'PASS';
  const stockCheck: AuditStatus = missingReversalCount > 0 ? 'FAIL' : (reversalCount > 0 ? 'PASS' : 'PASS');
  const gstCheck: AuditStatus = gstConfigActive && gstZeroCount > 0 ? 'WARNING' : 'PASS';
  const onlineCheck: AuditStatus = pendingOnlineOldCount > 0 ? 'WARNING' : (pendingOnlineCount > 0 ? 'PASS' : 'PASS');
  const kotCheck: AuditStatus = kotOldPendingCount > 0 ? 'WARNING' : (kotPendingCount > 0 ? 'PASS' : 'PASS');
  const dayCloseCheck: AuditStatus = !dayClosingExists ? 'FAIL' : closingHasVariance && closingMissingNotes ? 'WARNING' : 'PASS';

  return [
    {
      title: 'Cash Check',
      status: cashCheck,
      detail: !dayClosingExists
        ? 'No day close exists for the selected store/date.'
        : Math.abs(paymentDifference) <= 0.01
          ? 'Expected cash matches the recorded closing.'
          : `Cash variance is ${formatMoney(Math.abs(paymentDifference))}.`,
    },
    {
      title: 'Payment Check',
      status: paymentCheck,
      detail: unsettledPayAtCounterCount > 0
        ? `${unsettledPayAtCounterCount} PAY_AT_COUNTER order(s) still need settlement.`
        : Math.abs(paymentDifference) <= 0.01
          ? 'Payment totals match net sales.'
          : 'Payment totals do not match net sales.',
    },
    {
      title: 'Void Check',
      status: voidCheck,
      detail: missingVoidReasonCount > 0
        ? `${missingVoidReasonCount} voided order(s) are missing a reason or audit fields.`
        : 'Voided orders have audit details recorded.',
    },
    {
      title: 'Stock Check',
      status: stockCheck,
      detail: missingReversalCount > 0
        ? `${missingReversalCount} voided order(s) are missing stock reversal movements.`
        : `Reverse movements found: ${reversalCount}.`,
    },
    {
      title: 'GST Check',
      status: gstCheck,
      detail: gstConfigActive
        ? gstZeroCount > 0
          ? `${gstZeroCount} completed order(s) still show zero GST.`
          : 'GST is configured and billing looks consistent.'
        : 'GST config not detected, so zero GST is expected.',
    },
    {
      title: 'Online Order Check',
      status: onlineCheck,
      detail: pendingOnlineOldCount > 0
        ? `${pendingOnlineOldCount} pending online order(s) are older than 15 minutes.`
        : pendingOnlineCount > 0
          ? `${pendingOnlineCount} pending online order(s) are in the selected range.`
          : `Rejected orders: ${rejectedOnlineCount}.`,
    },
    {
      title: 'KOT Check',
      status: kotCheck,
      detail: kotOldPendingCount > 0
        ? `${kotOldPendingCount} KOT item(s) are pending for more than 15 minutes.`
        : kotPendingCount > 0
          ? `${kotPendingCount} KOT item(s) still active in the selected range.`
          : 'No pending KOT items in the selected range.',
    },
    {
      title: 'Day Close Check',
      status: dayCloseCheck,
      detail: !dayClosingExists
        ? 'No closing saved for the selected date.'
        : closingHasVariance && closingMissingNotes
          ? 'Cash variance exists and notes are missing.'
          : 'Day close details are recorded.',
    },
  ];
}

function SummaryCard({ label, value, tone = 'neutral' }: SummaryCardData) {
  const toneClass = {
    neutral: 'border-neutral-200 bg-white text-neutral-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-900',
  }[tone];

  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${toneClass}`}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-60">{label}</p>
      <div className="mt-2 font-mono text-2xl font-black leading-none">{value}</div>
    </div>
  );
}

function AuditCheckCard({ title, status, detail }: AuditCardData) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${STATUS_TONE[status]}`}>
      <div className="flex items-center gap-2 text-sm font-black uppercase tracking-wider">
        {STATUS_ICON[status]}
        {status}
      </div>
      <h3 className="mt-3 text-base font-black text-neutral-900">{title}</h3>
      <p className="mt-1 text-sm font-semibold opacity-80">{detail}</p>
    </div>
  );
}

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 p-5 md:p-6">
        <div>
          <h2 className="text-base font-black text-neutral-900">{title}</h2>
          <p className="mt-1 text-sm font-medium text-neutral-500">{description}</p>
        </div>
        {action}
      </div>
      <div className="p-4 md:p-5">
        {children}
      </div>
    </section>
  );
}

function DataTable({
  headers,
  rows,
  emptyText = 'No records found.',
}: {
  headers: ReactNode[];
  rows: ReactNode[][];
  emptyText?: string;
}) {
  return rows.length === 0 ? (
    <div className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 p-6 text-sm font-bold text-neutral-400">
      {emptyText}
    </div>
  ) : (
    <div className="overflow-x-auto rounded-2xl border border-neutral-200">
      <table className="min-w-full whitespace-nowrap text-left text-sm">
        <thead className="bg-neutral-50 text-[10px] uppercase tracking-widest text-neutral-500">
          <tr>
            {headers.map((header, index) => (
              <th key={index} className="px-4 py-3 font-black">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 bg-white">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top hover:bg-neutral-50">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 font-medium text-neutral-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function resolveDateRange(preset: DatePreset, customStart: string, customEnd: string) {
  const today = new Date();
  let start = new Date(today);
  let end = new Date(today);

  if (preset === 'LAST_7_DAYS') {
    start = shiftDays(today, 6);
  } else if (preset === 'LAST_30_DAYS') {
    start = shiftDays(today, 29);
  } else if (preset === 'CUSTOM') {
    const customStartDate = customStart ? new Date(`${customStart}T00:00:00`) : null;
    const customEndDate = customEnd ? new Date(`${customEnd}T23:59:59.999`) : null;
    if (customStartDate) start = customStartDate;
    if (customEndDate) end = customEndDate;
    if (start > end) {
      const swap = start;
      start = end;
      end = swap;
    }
  }

  const startKey = dateKey(start);
  const endKey = dateKey(end);
  return {
    startKey,
    endKey,
    startTs: Timestamp.fromDate(startOfDay(startKey)),
    endTs: Timestamp.fromDate(endOfDay(endKey)),
    label: startKey === endKey ? startKey : `${startKey} → ${endKey}`,
  };
}

export default function InventoryControl() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('LAST_7_DAYS');
  const [customStart, setCustomStart] = useState(todayIso());
  const [customEnd, setCustomEnd] = useState(todayIso());
  const [movementTypeFilter, setMovementTypeFilter] = useState<MovementTypeFilter>('ALL');
  const [itemTypeFilter, setItemTypeFilter] = useState<ItemTypeFilter>('ALL');
  const [storesLoading, setStoresLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [error, setError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [data, setData] = useState<InventoryControlData>({
    rawIngredients: [],
    prepItems: [],
    finishedGoods: [],
    storeStock: [],
    orders: [],
    onlineOrders: [],
    kotItems: [],
    stockMovements: [],
    pendingInventoryConsumption: [],
    dayClosing: null,
    gstConfig: { exists: false, defaultRate: 0, defaultSource: `appSettings/${GST_CONFIG_DOC_ID}`, storeOverrides: {} },
  });

  const hasAccess = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';
  const accessibleStores = useMemo(() => {
    if (!staffProfile) return [];
    if (staffProfile.role === 'ADMIN') return stores;
    const ids = allowedStoreIds(staffProfile);
    return stores.filter((store) => ids.includes(store.id));
  }, [staffProfile, stores]);

  const selectedStore = useMemo(
    () => accessibleStores.find((store) => store.id === selectedStoreId) || null,
    [accessibleStores, selectedStoreId],
  );

  const dateRange = useMemo(() => resolveDateRange(datePreset, customStart, customEnd), [datePreset, customStart, customEnd]);

  useEffect(() => {
    let active = true;
    const loadStores = async () => {
      if (!staffProfile) return;
      setStoresLoading(true);
      setError('');
      try {
        const snap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        let loaded = snap.docs.map((storeDoc) => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
        loaded.sort((a, b) => a.name.localeCompare(b.name));
        if (staffProfile.role !== 'ADMIN') {
          const ids = allowedStoreIds(staffProfile);
          loaded = loaded.filter((store) => ids.includes(store.id));
        }
        if (!active) return;
        setStores(loaded);
        setSelectedStoreId((prev) => {
          if (prev && loaded.some((store) => store.id === prev)) return prev;
          return loaded[0]?.id || '';
        });
      } catch (err: any) {
        if (active) {
          setError(err?.message || 'Failed to load stores.');
        }
      } finally {
        if (active) setStoresLoading(false);
      }
    };

    loadStores();
    return () => {
      active = false;
    };
  }, [staffProfile]);

  useEffect(() => {
    let active = true;
    const loadData = async () => {
      if (!hasAccess || !selectedStore) {
        if (active) setDataLoading(false);
        return;
      }

      setDataLoading(true);
      setError('');
      try {
        const [rawSnap, prepSnap, fgSnap, stockSnap, orderSnap, onlineOrderSnap, kotSnap, movementSnap, pendingConsumptionSnap, gstConfig, closingSnap] = await Promise.all([
          getDocs(collection(db, 'rawIngredients')),
          getDocs(collection(db, 'prepItems')),
          getDocs(collection(db, 'finishedGoods')),
          getDocs(collection(db, 'storeStock')),
          getDocs(query(collection(db, 'orders'), where('storeId', '==', selectedStore.id))),
          getDocs(query(collection(db, 'onlineOrders'), where('storeId', '==', selectedStore.id))),
          getDocs(query(collection(db, 'kotItems'), where('storeId', '==', selectedStore.id))),
          getDocs(query(collection(db, 'stockMovements'), where('storeId', '==', selectedStore.id))),
          getDocs(query(collection(db, 'pendingInventoryConsumption'), where('storeId', '==', selectedStore.id))),
          getDoc(doc(db, 'appSettings', GST_CONFIG_DOC_ID)),
          getDoc(doc(db, 'dayClosings', `${selectedStore.id}_${dateRange.endKey}`)),
        ]);

        const startDate = startOfDay(dateRange.startKey);
        const endDate = endOfDay(dateRange.endKey);
        const inRange = (value: unknown) => {
          const date = toDate(value);
          return !!date && date >= startDate && date <= endDate;
        };

        const allOrders = orderSnap.docs.map((item) => ({ id: item.id, ...item.data() } as Order));
        const allOnlineOrders = onlineOrderSnap.docs.map((item) => ({ id: item.id, ...item.data() } as OnlineOrder));
        const allKotItems = kotSnap.docs.map((item) => ({ id: item.id, ...item.data() } as KotItem));
        const allMovements = movementSnap.docs.map((item) => ({ id: item.id, ...item.data() } as StockMovement));
        const allPendingConsumption = pendingConsumptionSnap.docs.map((item) => ({ id: item.id, ...item.data() } as PendingInventoryConsumption));

        const loaded: InventoryControlData = {
          rawIngredients: rawSnap.docs.map((item) => ({ id: item.id, ...item.data() } as RawIngredient)),
          prepItems: prepSnap.docs.map((item) => ({ id: item.id, ...item.data() } as PrepItem)),
          finishedGoods: fgSnap.docs.map((item) => ({ id: item.id, ...item.data() } as FinishedGood)),
          storeStock: stockSnap.docs.map((item) => ({ id: item.id, ...item.data() } as StoreStock)),
          orders: allOrders
            .filter((order) => inRange(order.createdAt))
            .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)),
          onlineOrders: allOnlineOrders
            .filter((order) => inRange(order.createdAt))
            .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)),
          kotItems: allKotItems
            .filter((item) => inRange(item.createdAt))
            .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)),
          stockMovements: allMovements
            .filter((movement) => inRange(movement.createdAt))
            .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)),
          pendingInventoryConsumption: allPendingConsumption
            .filter((item) => inRange(item.soldAt || item.createdAt || item.resolvedAt))
            .sort((a, b) => (toDate(b.soldAt || b.createdAt)?.getTime() || 0) - (toDate(a.soldAt || a.createdAt)?.getTime() || 0)),
          dayClosing: closingSnap.exists() ? ({ id: closingSnap.id, ...closingSnap.data() } as DayClosing) : null,
          gstConfig: gstConfig.exists()
            ? {
                exists: true,
                defaultRate: pickRate(gstConfig.data() as Record<string, unknown>, APP_TAX_RATE_KEYS),
                defaultSource: `appSettings/${GST_CONFIG_DOC_ID}`,
                storeOverrides: normalizeStoreOverrides((gstConfig.data() as Record<string, unknown>).storeOverrides),
              }
            : { exists: false, defaultRate: 0, defaultSource: `appSettings/${GST_CONFIG_DOC_ID}`, storeOverrides: {} },
        };

        if (!active) return;
        setData(loaded);
        setLastRefreshedAt(new Date().toLocaleString());
      } catch (err: any) {
        if (!active) return;
        const message = String(err?.message || err || 'Failed to load inventory control data.');
        if (message.toLowerCase().includes('requires an index') || message.toLowerCase().includes('failed-precondition')) {
          setError('Firestore index required for this inventory dashboard query. Deploy Firestore indexes and refresh.');
        } else {
          setError(message);
        }
      } finally {
        if (active) setDataLoading(false);
      }
    };

    loadData();
    return () => {
      active = false;
    };
  }, [hasAccess, selectedStore, dateRange.startKey, dateRange.endKey, dateRange.startTs, dateRange.endTs, refreshNonce]);

  const rawByCode = useMemo(() => new Map(data.rawIngredients.map((item) => [item.code, item])), [data.rawIngredients]);
  const prepByCode = useMemo(() => new Map(data.prepItems.map((item) => [item.code, item])), [data.prepItems]);
  const finishedByCode = useMemo(() => new Map(data.finishedGoods.map((item) => [item.code, item])), [data.finishedGoods]);

  const periodOrders = useMemo(() => data.orders, [data.orders]);
  const periodMovements = useMemo(() => data.stockMovements, [data.stockMovements]);
  const periodKotItems = useMemo(() => data.kotItems, [data.kotItems]);
  const currentOnlineOrders = useMemo(
    () => data.onlineOrders.filter((order) => {
      const orderDate = toDate(order.createdAt);
      const start = startOfDay(dateRange.startKey);
      const end = endOfDay(dateRange.endKey);
      return !!orderDate && orderDate >= start && orderDate <= end;
    }),
    [data.onlineOrders, dateRange.endKey, dateRange.startKey],
  );
  const pendingConsumptionRows = useMemo(() => data.pendingInventoryConsumption, [data.pendingInventoryConsumption]);

  const completedOrders = useMemo(() => periodOrders.filter((order) => isCompletedOrder(order)), [periodOrders]);
  const voidedOrders = useMemo(() => periodOrders.filter((order) => effectiveOrderStatus(order) !== 'COMPLETED'), [periodOrders]);
  const paymentTotals = useMemo(() => {
    const totals = buildPaymentTotals(completedOrders);
    completedOrders.forEach((order) => {
      orderPaymentBreakdown(order).forEach((payment) => {
        if (payment.method in totals) {
          totals[payment.method as PaymentMethod] += money(payment.amount);
        }
      });
    });
    return totals;
  }, [completedOrders]);
  const expectedCash = paymentTotals.CASH || 0;
  const totalCogs = useMemo(() => completedOrders.reduce((sum, order) => {
    const cogsFromOrder = money(order.cogsTotal);
    if (cogsFromOrder > 0) return sum + cogsFromOrder;
    const orderMovementCogs = periodMovements
      .filter((movement) => movement.orderId === order.id && movement.movementType === 'SALE_DEDUCTION')
      .reduce((movementSum, movement) => movementSum + money(movement.cogsAmount), 0);
    return sum + orderMovementCogs;
  }, 0), [completedOrders, periodMovements]);
  const netSales = useMemo(() => completedOrders.reduce((sum, order) => sum + money(order.grandTotal), 0), [completedOrders]);
  const foodCostPct = netSales > 0 ? (totalCogs / netSales) * 100 : 0;
  const stockReversalCount = useMemo(() => periodMovements.filter((movement) => movement.movementType === 'ORDER_VOID_REVERSAL').length, [periodMovements]);
  const pendingOnlineOrders = useMemo(() => currentOnlineOrders.filter((order) => order.status === 'PENDING'), [currentOnlineOrders]);
  const rejectedOnlineOrders = useMemo(() => currentOnlineOrders.filter((order) => order.status === 'REJECTED'), [currentOnlineOrders]);
  const acceptedOnlineOrders = useMemo(() => currentOnlineOrders.filter((order) => order.status === 'ACCEPTED' || order.status === 'CONVERTED'), [currentOnlineOrders]);
  const unsettledPayAtCounterOrders = useMemo(() => periodOrders.filter((order) => (order.paymentMethod === 'PAY_AT_COUNTER' || (order.paymentBreakdown || []).some((payment) => payment.method === 'PAY_AT_COUNTER')) && order.paymentStatus !== 'PAID' && effectiveOrderStatus(order) === 'COMPLETED'), [periodOrders]);
  const kotPendingItems = useMemo(() => periodKotItems.filter((item) => item.status === 'PENDING' || item.status === 'PREPARING'), [periodKotItems]);
  const kotOldPendingItems = useMemo(() => kotPendingItems.filter((item) => ageMinutes(item.createdAt) > 15), [kotPendingItems]);
  const gstConfigActive = useMemo(() => data.gstConfig.exists || data.finishedGoods.some((item) => parseRate(item.taxRate) > 0) || Object.values(data.gstConfig.storeOverrides).some((rate) => rate > 0), [data.finishedGoods, data.gstConfig]);
  const gstZeroCount = useMemo(() => completedOrders.filter((order) => orderTaxTotal(order) <= 0).length, [completedOrders]);
  const voidedOrdersMissingReason = useMemo(() => voidedOrders.filter((order) => !String(order.voidReason || '').trim() || !order.voidedAt || !String(order.voidedByName || '').trim()).length, [voidedOrders]);
  const voidedOrderIds = useMemo(() => new Set(voidedOrders.map((order) => order.id).filter(Boolean) as string[]), [voidedOrders]);
  const voidReversalMovements = useMemo(
    () => periodMovements.filter((movement) => movement.movementType === 'ORDER_VOID_REVERSAL' && movement.referenceId && voidedOrderIds.has(movement.referenceId)),
    [periodMovements, voidedOrderIds],
  );
  const missingVoidReversalCount = useMemo(() => voidedOrders.filter((order) => !periodMovements.some((movement) => movement.movementType === 'ORDER_VOID_REVERSAL' && movement.referenceId === order.id)).length, [periodMovements, voidedOrders]);
  const negativeStockRows = useMemo(() => buildNegativeStockRows(selectedStore || ({ id: '', name: '', code: '', address: '', isActive: true, createdAt: null, updatedAt: null } as Store), data.storeStock, periodMovements), [selectedStore, data.storeStock, periodMovements]);
  const missingStockCreatedRows = useMemo(() => buildMissingStockCreatedRows(periodMovements), [periodMovements]);
  const missingCostRows = useMemo(() => buildMissingCostRows(periodMovements), [periodMovements]);
  const rawConsumptionRows = useMemo(() => buildRawConsumptionRows(periodMovements), [periodMovements]);
  const orderCogsRows = useMemo(() => buildOrderCogsRows(periodOrders, periodMovements), [periodMovements, periodOrders]);
  const movementAuditRows = useMemo(() => buildMovementAuditRows(
    periodMovements.filter((movement) => {
      const movementTypeFilterMatch = movementTypeFilter === 'ALL'
        || movement.movementType === movementTypeFilter;
      const itemTypeFilterMatch = itemTypeFilter === 'ALL' || movement.stockItemType === itemTypeFilter;
      return movementTypeFilterMatch && itemTypeFilterMatch;
    }),
  ), [itemTypeFilter, movementTypeFilter, periodMovements]);
  const pendingBomRows = useMemo(() => buildPendingBomRows(pendingConsumptionRows), [pendingConsumptionRows]);
  const setupBlockers = useMemo(() => selectedStore ? buildSetupBlockers(selectedStore, data.rawIngredients, data.prepItems, data.finishedGoods) : [], [data.finishedGoods, data.prepItems, data.rawIngredients, selectedStore]);
  const negativeStockCount = negativeStockRows.length;
  const missingCostWarningCount = missingCostRows.length;
  const missingStockCreatedCount = missingStockCreatedRows.length;
  const activePendingBomRows = pendingConsumptionRows.filter((row) => row.status === 'PENDING_BOM' || row.status === 'READY_FOR_BACKFILL');
  const appliedPendingBomRows = pendingConsumptionRows.filter((row) => row.status === 'APPLIED');
  const failedPendingBomRows = pendingConsumptionRows.filter((row) => row.status === 'FAILED_REVIEW');
  const pendingBomFinishedGoodCount = new Set(activePendingBomRows.map((row) => row.finishedGoodCode).filter(Boolean)).size;
  const oldestPendingBomSale = activePendingBomRows
    .map((row) => toDate(row.soldAt || row.createdAt))
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime())[0] || null;
  const pendingBomOrderIds = new Set(activePendingBomRows.map((row) => row.orderId).filter(Boolean));
  const pendingBomOrderValue = periodOrders
    .filter((order) => order.id && pendingBomOrderIds.has(order.id))
    .reduce((sum, order) => sum + money(order.grandTotal), 0);
  const setupBlockerCount = new Set(setupBlockers.map((blocker) => blocker.finishedGoodCode)).size;
  const pendingKotCount = kotPendingItems.length;
  const pendingKotOldCount = kotOldPendingItems.length;
  const pendingOnlineOldCount = pendingOnlineOrders.filter((order) => ageMinutes(order.createdAt) > 15).length;
  const orderCount = completedOrders.length;
  const dayClosing = data.dayClosing;
  const dayClosingDateLabel = dateRange.endKey;
  const dayCloseVariance = dayClosing ? money(dayClosing.cashVariance) : 0;
  const dayCloseMissingNotes = Boolean(dayClosing && Math.abs(dayCloseVariance) > 0.01 && !String(dayClosing.notes || '').trim());
  const dayCloseClosed = Boolean(dayClosing);
  const paymentDifference = dayClosing ? money(dayClosing.actualCash) - expectedCash : 0;
  const dayCloseStatus: AuditStatus = !dayCloseClosed ? 'FAIL' : Math.abs(dayCloseVariance) <= 0.01 ? 'PASS' : 'WARNING';
  const summaryCards: SummaryCardData[] = [
    { label: 'Day close status', value: dayCloseClosed ? 'Closed' : 'Not Closed', tone: dayCloseClosed ? (Math.abs(dayCloseVariance) <= 0.01 ? 'green' : 'amber') : 'red' },
    { label: 'Completed bills', value: orderCount, tone: 'neutral' },
    { label: 'Voided bills', value: voidedOrders.length, tone: voidedOrders.length > 0 ? 'amber' : 'neutral' },
    { label: 'Net sales', value: formatMoney(netSales), tone: 'neutral' },
    { label: 'GST total', value: formatMoney(completedOrders.reduce((sum, order) => sum + orderTaxTotal(order), 0)), tone: gstZeroCount > 0 && gstConfigActive ? 'amber' : 'neutral' },
    { label: 'Discount total', value: formatMoney(completedOrders.reduce((sum, order) => sum + orderDiscountTotal(order), 0)), tone: 'neutral' },
    { label: 'Expected cash', value: formatMoney(expectedCash), tone: 'neutral' },
    { label: 'Actual cash', value: dayClosing ? formatMoney(dayClosing.actualCash) : '—', tone: dayClosing ? 'neutral' : 'amber' },
    { label: 'Cash variance', value: dayClosing ? formatMoney(dayCloseVariance) : '—', tone: !dayClosing ? 'amber' : Math.abs(dayCloseVariance) <= 0.01 ? 'green' : 'amber' },
    { label: 'Pending online orders', value: pendingOnlineOrders.length, tone: pendingOnlineOldCount > 0 ? 'amber' : 'neutral' },
    { label: 'Rejected online orders', value: rejectedOnlineOrders.length, tone: rejectedOnlineOrders.length > 0 ? 'neutral' : 'neutral' },
    { label: 'PAY_AT_COUNTER unsettled', value: unsettledPayAtCounterOrders.length, tone: unsettledPayAtCounterOrders.length > 0 ? 'amber' : 'neutral' },
    { label: 'Stock reversal count', value: stockReversalCount, tone: stockReversalCount > 0 ? 'green' : 'neutral' },
    { label: 'KOT pending count', value: pendingKotCount, tone: pendingKotCount > 0 ? 'amber' : 'neutral' },
    { label: 'Negative stock items', value: negativeStockCount, tone: negativeStockCount > 0 ? 'red' : 'neutral' },
    { label: 'Missing cost warnings', value: missingCostWarningCount, tone: missingCostWarningCount > 0 ? 'amber' : 'neutral' },
    { label: 'Missing sale rows', value: missingStockCreatedCount, tone: missingStockCreatedCount > 0 ? 'amber' : 'neutral' },
    { label: 'Pending BOM lines', value: activePendingBomRows.length, tone: activePendingBomRows.length > 0 ? 'amber' : 'green' },
    { label: 'Pending BOM products', value: pendingBomFinishedGoodCount, tone: pendingBomFinishedGoodCount > 0 ? 'amber' : 'green' },
    { label: 'Oldest pending sale', value: oldestPendingBomSale ? formatDateTime(oldestPendingBomSale) : '—', tone: oldestPendingBomSale ? 'amber' : 'green' },
    { label: 'Pending order value', value: formatMoney(pendingBomOrderValue), tone: pendingBomOrderValue > 0 ? 'amber' : 'neutral' },
    { label: 'Backfilled BOM lines', value: appliedPendingBomRows.length, tone: appliedPendingBomRows.length > 0 ? 'green' : 'neutral' },
    { label: 'Failed backfills', value: failedPendingBomRows.length, tone: failedPendingBomRows.length > 0 ? 'red' : 'neutral' },
    { label: 'Total COGS', value: formatMoney(totalCogs), tone: 'neutral' },
    { label: 'Food cost %', value: netSales > 0 ? `${foodCostPct.toFixed(1)}%` : '—', tone: netSales > 0 && foodCostPct > 40 ? 'amber' : 'neutral' },
    { label: 'Stock movement rows', value: periodMovements.length, tone: periodMovements.length > 0 ? 'neutral' : 'amber' },
    { label: 'Setup blockers', value: setupBlockerCount, tone: setupBlockerCount > 0 ? 'red' : 'green' },
  ];
  const auditCards = buildAuditCards({
    dayClosing,
    completedOrders,
    voidedOrders,
    paymentDifference,
    missingVoidReasonCount: voidedOrdersMissingReason,
    missingReversalCount: missingVoidReversalCount,
    gstConfigActive,
    gstZeroCount,
    pendingOnlineCount: pendingOnlineOrders.length,
    rejectedOnlineCount: rejectedOnlineOrders.length,
    pendingOnlineOldCount,
    unsettledPayAtCounterCount: unsettledPayAtCounterOrders.length,
    reversalCount: voidReversalMovements.length,
    kotPendingCount: pendingKotCount,
    kotOldPendingCount: pendingKotOldCount,
    closingHasVariance: Math.abs(dayCloseVariance) > 0.01,
    closingMissingNotes: dayCloseMissingNotes,
    dayClosingExists: dayCloseClosed,
  });

  const reload = () => setRefreshNonce((value) => value + 1);

  if (!staffProfile) return null;

  if (!hasAccess) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">No access</p>
          <h1 className="mt-2 text-2xl font-black text-[#3e2723]">Inventory Control</h1>
          <p className="mt-3 text-sm font-medium text-neutral-600">
            This dashboard is available to Admin and Store Manager roles only.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/pos" className="rounded-full bg-[#3e2723] px-4 py-2 text-sm font-black text-white hover:bg-[#2d1c19]">
              Back to POS
            </Link>
            <Link to="/reports" className="rounded-full border border-[#5c4033]/30 bg-white px-4 py-2 text-sm font-black text-[#5c4033] hover:bg-[#5c4033]/5">
              Open Reports
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const loading = storesLoading || dataLoading;

  return (
    <div className="min-h-screen w-full min-w-0 bg-[#fcf9f5] pb-24 font-sans text-neutral-800">
      <div className="mx-auto w-full max-w-7xl min-w-0 px-4 py-4 md:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/admin" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-600 shadow-sm ring-1 ring-neutral-200 hover:bg-neutral-50">
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">Inventory</p>
              <h1 className="text-2xl font-black tracking-tight text-[#3e2723] md:text-3xl">Inventory Control</h1>
              <p className="mt-1 text-sm font-medium text-neutral-500">
                Sales-first stock impact, COGS, negative stock, setup blockers, and movement audit.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link to="/reports" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm hover:bg-[#5c4033]/5">
              Open Reports
            </Link>
            <Link to="/inventory/stock-correction" className="rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-black text-emerald-800 shadow-sm hover:bg-emerald-50">
              Stock Correction
            </Link>
            <Link to="/inventory/purchase-entry" className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-black text-emerald-800 shadow-sm hover:bg-emerald-50">
              <PackagePlus size={14} />
              Purchase Entry
            </Link>
            <Link to="/pos/running-orders" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm hover:bg-[#5c4033]/5">
              Running Orders
            </Link>
            <button
              onClick={reload}
              className="inline-flex items-center gap-2 rounded-full bg-[#3e2723] px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-sm hover:bg-[#2d1c19]"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Store
              <div className="relative">
                <StoreIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                <select
                  value={selectedStoreId}
                  onChange={(event) => setSelectedStoreId(event.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-2.5 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                >
                  {accessibleStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
              </div>
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Date range
              <select
                value={datePreset}
                onChange={(event) => setDatePreset(event.target.value as DatePreset)}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              >
                {RANGE_PRESETS.map((preset) => <option key={preset} value={preset}>{preset.replace('_', ' ')}</option>)}
              </select>
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Movement type
              <select
                value={movementTypeFilter}
                onChange={(event) => setMovementTypeFilter(event.target.value as MovementTypeFilter)}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              >
                {MOVEMENT_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
              </select>
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Item type
              <select
                value={itemTypeFilter}
                onChange={(event) => setItemTypeFilter(event.target.value as ItemTypeFilter)}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              >
                {ITEM_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
              </select>
            </label>
          </div>

          {datePreset === 'CUSTOM' && (
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
                Start date
                <input
                  type="date"
                  value={customStart}
                  onChange={(event) => setCustomStart(event.target.value)}
                  className="rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </label>
              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
                End date
                <input
                  type="date"
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                  className="rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </label>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-neutral-500">
            <span>Range: {dateRange.label}</span>
            <span>{selectedStore ? selectedStore.name : 'Select a store'}</span>
            <span>Last refresh: {lastRefreshedAt || '—'}</span>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 space-y-5">
          <section>
            <div className="mb-3 flex items-center gap-2">
              <TrendingUp size={18} className="text-[#5c4033]" />
              <h2 className="text-base font-black text-[#3e2723]">Sales, Closing & Cash</h2>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
              {summaryCards.slice(0, 9).map((card) => <SummaryCard key={card.label} {...card} />)}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <Package size={18} className="text-[#5c4033]" />
              <h2 className="text-base font-black text-[#3e2723]">Inventory Warnings & Controls</h2>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
              {summaryCards.slice(9, 18).map((card) => <SummaryCard key={card.label} {...card} />)}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <Clock size={18} className="text-[#5c4033]" />
              <h2 className="text-base font-black text-[#3e2723]">Operational Flags</h2>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
              {summaryCards.slice(18).map((card) => <SummaryCard key={card.label} {...card} />)}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <ShieldAlert size={18} className="text-[#5c4033]" />
              <h2 className="text-base font-black text-[#3e2723]">Audit Checks</h2>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {auditCards.map((card) => <AuditCheckCard key={card.title} {...card} />)}
            </div>
          </section>

          <SectionCard
            title="Negative Stock"
            description="Current raw/prep stock below zero. Low or missing stock rows are not blockers anymore."
          >
            <DataTable
              headers={['Item name', 'Type', 'Store', 'Current', 'Unit', 'Last movement', 'Source/order', 'Sale badge']}
              rows={negativeStockRows.map((row) => [
                row.itemName,
                row.stockItemType,
                row.storeName,
                <span key="current" className="font-mono text-red-700">{row.currentStock.toFixed(2)}</span>,
                row.unit,
                row.lastMovementDate,
                row.lastMovementSource,
                row.createdBySale ? <span key="badge" className="rounded-full bg-red-100 px-2 py-1 text-[10px] font-black text-red-700">Created by sale</span> : '—',
              ])}
            />
          </SectionCard>

          <SectionCard
            title="Missing Stock Rows Created by Sale"
            description="Rows created from zero or missing stock are shown here for backfilling later."
          >
            <DataTable
              headers={['Item', 'Type', 'Store', 'Order', 'Qty deducted', 'New stock', 'Time', 'Warning']}
              rows={missingStockCreatedRows.map((row) => [
                row.itemName,
                row.stockItemType,
                row.storeName,
                row.orderNumber,
                <span key="qty" className="font-mono">{row.quantityDeducted.toFixed(2)}</span>,
                <span key="new" className="font-mono">{row.newStock.toFixed(2)}</span>,
                row.dateTime,
                <span key="warn" className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-700">{row.warning}</span>,
              ])}
            />
          </SectionCard>

          <SectionCard
            title="Pending BOM Consumption"
            description="Golden I deferred-inventory order lines waiting for BOM completion or backfill. This table is read-only."
          >
            <DataTable
              headers={['Sold at', 'Order', 'Finished good', 'Code', 'Qty sold', 'Source', 'Status', 'Reason', 'Movements']}
              rows={pendingBomRows.map((row) => [
                row.soldAt,
                row.orderNumber,
                row.finishedGoodName,
                row.finishedGoodCode,
                <span key="qty" className="font-mono">{row.quantitySold.toFixed(2)}</span>,
                row.source,
                <span
                  key="status"
                  className={`rounded-full px-2 py-1 text-[10px] font-black ${
                    row.status === 'APPLIED'
                      ? 'bg-emerald-100 text-emerald-700'
                      : row.status === 'FAILED_REVIEW'
                        ? 'bg-red-100 text-red-700'
                        : row.status === 'CANCELLED'
                          ? 'bg-neutral-100 text-neutral-600'
                          : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {row.status}
                </span>,
                row.reason,
                row.movementCount,
              ])}
            />
          </SectionCard>

          <SectionCard
            title="Missing Cost Warnings"
            description="Sale deductions where COGS was recorded as zero or missing."
          >
            <DataTable
              headers={['Time', 'Order', 'Finished good', 'Raw/prep item', 'Qty consumed', 'Unit', 'Warning', 'COGS impact']}
              rows={missingCostRows.map((row) => [
                row.dateTime,
                row.orderNumber,
                row.finishedGoodName,
                row.rawPrepItemName,
                <span key="qty" className="font-mono">{row.quantityConsumed.toFixed(2)}</span>,
                row.unit,
                <span key="warn" className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-700">{row.warning}</span>,
                <span key="cogs" className="font-mono">{formatMoney(row.cogsImpact)}</span>,
              ])}
            />
          </SectionCard>

          <SectionCard
            title="Raw Material Consumption"
            description="Grouped sale deduction consumption for the selected store and date range."
            action={<Link to="/reports" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/5">Open Reports</Link>}
          >
            <DataTable
              headers={['Item', 'Type', 'Total consumed', 'Unit', 'Estimated COGS', 'Orders', 'Last consumed']}
              rows={rawConsumptionRows.map((row) => [
                row.itemName,
                row.stockItemType,
                <span key="total" className="font-mono">{row.totalConsumedQuantity.toFixed(2)}</span>,
                row.unit,
                <span key="cogs" className="font-mono">{formatMoney(row.estimatedCogs)}</span>,
                row.ordersCount,
                row.lastConsumedAt,
              ])}
            />
          </SectionCard>

          <SectionCard
            title="COGS by Order"
            description="Recent completed orders with cost snapshots from stock movements."
            action={<Link to="/reports" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/5">Open order reports</Link>}
          >
            <DataTable
              headers={['Date/time', 'Order', 'Source', 'Net sale', 'COGS', 'Food cost %', 'Warnings', 'Movements', 'Payment', 'Open']}
              rows={orderCogsRows.map((row) => [
                row.dateTime,
                row.orderNumber,
                row.source,
                row.netSale !== null ? <span key="sale" className="font-mono">{formatMoney(row.netSale)}</span> : '—',
                row.cogs !== null ? <span key="cogs" className="font-mono">{formatMoney(row.cogs)}</span> : '—',
                row.foodCostPct !== null ? <span key="pct" className="font-mono">{row.foodCostPct.toFixed(1)}%</span> : '—',
                row.inventoryWarningCount || 0,
                row.stockMovementCount || 0,
                row.paymentMethod,
                <Link key="open" to="/reports" className="text-sm font-black text-[#5c4033] hover:underline">Open reports</Link>,
              ])}
            />
          </SectionCard>

          <SectionCard
            title="Setup Blockers"
            description="Items that still have broken setup or availability issues. Low and zero stock are not blockers here."
          >
            <DataTable
              headers={['Finished good', 'Category', 'Blocker type', 'Internal note', 'Suggested action']}
              rows={setupBlockers.map((row) => [
                row.finishedGoodName,
                row.categoryName,
                <span key="type" className="rounded-full bg-red-100 px-2 py-1 text-[10px] font-black text-red-700">{row.blockerType}</span>,
                row.internalNote,
                row.suggestedAction,
              ])}
            />
          </SectionCard>

          <SectionCard
            title="Stock Movement Audit"
            description="Filtered movements for the selected store and date range. Use the filters above to narrow the log."
          >
            <DataTable
              headers={['Date/time', 'Store', 'Movement type', 'Source', 'Order', 'Item type', 'Item name', 'Qty delta', 'Prev', 'New', 'Neg', 'COGS', 'Created by']}
              rows={movementAuditRows.map((row) => [
                row.dateTime,
                row.storeName,
                row.movementType,
                row.source,
                row.orderNumber,
                row.itemType,
                row.itemName,
                <span key="delta" className={`font-mono ${row.quantityDelta < 0 ? 'text-red-700' : row.quantityDelta > 0 ? 'text-emerald-700' : 'text-neutral-700'}`}>{`${row.quantityDelta > 0 ? '+' : ''}${row.quantityDelta.toFixed(2)}`}</span>,
                <span key="prev" className="font-mono">{row.previousQty.toFixed(2)}</span>,
                <span key="new" className="font-mono">{row.newQty.toFixed(2)}</span>,
                row.wentNegative ? <span key="neg" className="rounded-full bg-red-100 px-2 py-1 text-[10px] font-black text-red-700">Yes</span> : 'No',
                <span key="cogs" className="font-mono">{formatMoney(row.cogsAmount)}</span>,
                row.createdBy,
              ])}
            />
          </SectionCard>

          <section className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-black text-neutral-900">Day Close Snapshot</h2>
                <p className="mt-1 text-sm font-medium text-neutral-500">
                  Day close is checked for the range end date: <span className="font-black text-neutral-700">{dayClosingDateLabel}</span>.
                </p>
              </div>
              <div className={`rounded-full border px-3 py-1 text-xs font-black uppercase tracking-[0.16em] ${STATUS_TONE[dayCloseStatus]}`}>
                {dayClosing ? 'Closed' : 'Not Closed'}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
              <SummaryCard label="Closed by" value={dayClosing?.closedByName || '—'} />
              <SummaryCard label="Closed at" value={dayClosing?.closedAt ? formatDateTime(dayClosing.closedAt) : '—'} />
              <SummaryCard label="Cash variance" value={dayClosing ? formatMoney(dayClosing.cashVariance) : '—'} tone={!dayClosing ? 'amber' : Math.abs(dayCloseVariance) <= 0.01 ? 'green' : 'amber'} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Notes</p>
                <p className="mt-2 text-sm font-medium text-neutral-700">{dayClosing?.notes || '—'}</p>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Payments</p>
                <div className="mt-2 space-y-1 text-sm font-bold text-neutral-700">
                  {PAYMENT_METHODS.map((method) => (
                    <div key={method} className="flex justify-between gap-3">
                      <span>{method}</span>
                      <span className="font-mono">{formatMoney(dayClosing?.paymentBreakdown?.[method] ?? paymentTotals[method] ?? 0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
