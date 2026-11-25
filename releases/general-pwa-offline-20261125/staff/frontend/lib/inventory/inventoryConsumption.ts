/** Pure inventory decisions. No Firestore access, writes, or generated timestamps.
 * Persistence, record reads, and transactional guards remain in their existing callers.
 * Owner-approved all-store policy: defer BOM failures; never block solely for stock shortage.
 */
import type { Store } from '../../types';
import type { FinishedGood } from '../../types/menu-management';
import type { InventoryDeductionSource, InventoryPolicy, InventoryDeductionBlocker, PendingInventoryConsumptionPayload } from '../inventoryDeduction';

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

export function roundValue(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function roundMoney(value: number): number {
  return roundValue(value, 2);
}

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeUom(value: unknown): string {
  const raw = String(value || '').trim().toUpperCase();
  return UOM_ALIASES[raw] || raw;
}

export function convertQuantity(quantity: number, fromUom: string, toUom: string): { quantity: number; normalized: boolean } | null {
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

export function usesBom(item: Partial<FinishedGood>): boolean {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

export function isDirectStockSale(item: Partial<FinishedGood>): boolean {
  return item.itemType === 'DIRECT_STOCK' || item.productionMode === 'BOUGHT_AND_SOLD';
}

export function isNoStockItem(item: Partial<FinishedGood>): boolean {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

export function isStoreAssigned(item: Partial<FinishedGood>, storeId: string): boolean {
  const availableStoreIds = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return availableStoreIds.length === 0 || availableStoreIds.includes(storeId);
}

export function getStockDocId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

export function buildSaleNote(source: InventoryDeductionSource, orderNumber: string): string {
  if (source === 'CUSTOMER_WEB_ACCEPT') return `Online order ${orderNumber}`;
  if (source === 'REMAKE') return `Remake for order ${orderNumber}`;
  return `Order ${orderNumber}`;
}

export function effectiveInventoryPolicy(_store: Store): InventoryPolicy {
  // Bundle 7: owner explicitly approved matching the verified Bundle 7A all-store policy.
  return 'ALLOW_NEGATIVE_DEFER_BOM';
}

export function pendingConsumptionDocId(storeId: string, orderId: string, orderLineId: string): string {
  return `${storeId}_${orderId}_${orderLineId}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function isFinishedGoodAvailable(item: Partial<FinishedGood>, storeId: string): boolean {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isStoreAssigned(item, storeId);
}

export function allowsExpandedBomFailureDeferral(store: Store): boolean {
  return effectiveInventoryPolicy(store) === 'ALLOW_NEGATIVE_DEFER_BOM';
}

type PendingIntentInput = Omit<PendingInventoryConsumptionPayload,
  'status' | 'reason' | 'resolvedAt' | 'resolvedBy' | 'appliedBomVersion' | 'inventoryMovementIds' | 'idempotencyKey'> & {
  salesStoreId: string;
  blockers: Array<Pick<InventoryDeductionBlocker, 'blockerType' | 'componentType' | 'componentCode'>>;
};

/** Stable one-order/one-line identity; timestamp values are supplied by the persistence caller. */
export function buildPendingConsumptionIntent(input: PendingIntentInput): PendingInventoryConsumptionPayload {
  const { salesStoreId, blockers, ...fields } = input;
  const reason = blockers
    .map((blocker) => `${blocker.blockerType}${blocker.componentCode ? ` ${blocker.componentType || ''}/${blocker.componentCode}` : ''}`)
    .join('; ');
  return {
    ...fields,
    status: 'PENDING_BOM',
    reason: reason || 'Finished good BOM is incomplete or not approved for immediate inventory consumption.',
    resolvedAt: null,
    resolvedBy: null,
    appliedBomVersion: null,
    inventoryMovementIds: [],
    idempotencyKey: pendingConsumptionDocId(salesStoreId, fields.orderId, fields.orderLineId),
  };
}

/** Combine matching consumption contributions without mutating the input entries. */
export function aggregateConsumptionEntries<T extends {
  stockDocId: string; lineKey: string; stockItemType: string; stockItemCode: string;
  unit: string; finishedGoodCode: string; finishedGoodName: string; itemName: string;
  quantity: number; costPerUnit: number; warnings: unknown[];
}>(entries: T[]): T[] {
  return Array.from(entries.reduce((groups, entry) => {
      const key = [
        entry.stockDocId,
        entry.lineKey,
        entry.stockItemType,
        entry.stockItemCode,
        entry.unit,
        entry.finishedGoodCode,
      ].join('|');
      const current = groups.get(key);
      if (current) {
        current.quantity = roundValue(current.quantity + entry.quantity);
        current.costPerUnit = entry.costPerUnit;
        current.finishedGoodName = entry.finishedGoodName;
        current.itemName = entry.itemName;
        current.warnings.push(...entry.warnings);
        return groups;
      }
      groups.set(key, { ...entry, warnings: [...entry.warnings] });
      return groups;
    }, new Map<string, T>()).values()).sort((left, right) => (
      [
        left.lineKey,
        left.stockItemType,
        left.stockItemCode,
        left.unit,
        left.finishedGoodCode,
      ].join('|').localeCompare([
        right.lineKey,
        right.stockItemType,
        right.stockItemCode,
        right.unit,
        right.finishedGoodCode,
      ].join('|'))
    ));
}
