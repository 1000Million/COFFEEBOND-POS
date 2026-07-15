import { Order, StockMovement } from '../types';
import { StockItemType } from '../types/menu-management';

export type InventoryMovementFilter = {
  movementType: string;
  itemType: string;
  search: string;
};

export type InventoryRawConsumptionRow = {
  itemName: string;
  itemCode: string;
  stockItemType: StockItemType | string;
  grossConsumedQuantity: number;
  reversedQuantity: number;
  netConsumedQuantity: number;
  unit: string;
  grossCogs: number;
  reversedCogs: number;
  netCogs: number;
  ordersCount: number;
  lastConsumedAt: unknown;
};

export type InventoryMovementAuditRow = {
  dateTimeSource: unknown;
  storeName: string;
  movementType: string;
  source: string;
  orderNumber: string;
  itemType: string;
  itemCode: string;
  itemName: string;
  quantityDelta: number;
  unit: string;
  previousQty: number | null;
  newQty: number | null;
  wentNegative: boolean;
  cogsAmount: number;
  reason: string;
  createdBy: string;
};

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 10000) / 10000 : 0;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function recordValue(source: unknown, key: string): unknown {
  return source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
}

function optionalNumberFromFields(source: unknown, keys: string[]): number | null {
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed * 10000) / 10000;
  }
  return null;
}

function toTime(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function movementItemType(movement: StockMovement): string {
  return clean(
    movement.stockItemType
      || recordValue(movement, 'itemType')
      || recordValue(movement, 'inventoryItemType')
      || recordValue(movement, 'componentType')
      || 'UNKNOWN',
  ) || 'UNKNOWN';
}

export function movementItemCode(movement: StockMovement): string {
  return clean(
    movement.stockItemCode
      || recordValue(movement, 'itemCode')
      || recordValue(movement, 'componentCode')
      || movement.inventoryItemId
      || 'UNKNOWN',
  ) || 'UNKNOWN';
}

export function movementItemName(movement: StockMovement): string {
  return clean(
    movement.inventoryItemName
      || recordValue(movement, 'stockItemName')
      || recordValue(movement, 'itemName')
      || recordValue(movement, 'componentName')
      || movementItemCode(movement),
  ) || '-';
}

function orderLookupKeys(order: Order): string[] {
  return [order.id, order.orderNumber].filter(Boolean).map(String);
}

function movementOrderKeys(movement: StockMovement): string[] {
  return [
    movement.orderId,
    movement.orderNumber,
    movement.referenceId,
    recordValue(movement, 'sourceOrderId'),
    recordValue(movement, 'voidedOrderId'),
  ].filter(Boolean).map(String);
}

export function buildOrderReferenceLookup(orders: Order[]): Map<string, string> {
  const lookup = new Map<string, string>();
  orders.forEach((order) => {
    orderLookupKeys(order).forEach((key) => {
      if (order.orderNumber) lookup.set(key, order.orderNumber);
    });
  });
  return lookup;
}

export function movementOrderReference(movement: StockMovement, orderLookup: Map<string, string>): string {
  if (movement.orderNumber) return movement.orderNumber;
  for (const key of movementOrderKeys(movement)) {
    const orderNumber = orderLookup.get(key);
    if (orderNumber) return orderNumber;
    if (key.startsWith('CB-')) return key;
  }
  return movement.referenceId || movement.orderId || '-';
}

export function buildInventoryMovementAuditRows(
  movements: StockMovement[],
  orders: Order[],
): InventoryMovementAuditRow[] {
  const orderLookup = buildOrderReferenceLookup(orders);
  return movements
    .map((movement) => ({
      dateTimeSource: movement.createdAt,
      storeName: movement.storeName || '-',
      movementType: movement.movementType || '-',
      source: movement.source || movement.referenceType || '-',
      orderNumber: movementOrderReference(movement, orderLookup),
      itemType: movementItemType(movement),
      itemCode: movementItemCode(movement),
      itemName: movementItemName(movement),
      quantityDelta: money(movement.quantityDelta ?? movement.quantity),
      unit: movement.unit || '-',
      previousQty: optionalNumberFromFields(movement, ['previousQty', 'stockBefore', 'previousStock', 'balanceBefore']),
      newQty: optionalNumberFromFields(movement, ['newQty', 'stockAfter', 'resultingStock', 'balanceAfter']),
      wentNegative: Boolean(movement.wentNegative),
      cogsAmount: money(movement.cogsAmount),
      reason: clean(movement.notes || recordValue(movement, 'reason') || recordValue(movement, 'warning') || '-'),
      createdBy: movement.createdByName || '-',
    }))
    .sort((a, b) => toTime(b.dateTimeSource) - toTime(a.dateTimeSource));
}

export function filterInventoryMovementAuditRows(
  rows: InventoryMovementAuditRow[],
  filters: InventoryMovementFilter,
): InventoryMovementAuditRow[] {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.movementType !== 'ALL' && row.movementType !== filters.movementType) return false;
    if (filters.itemType !== 'ALL' && row.itemType !== filters.itemType) return false;
    if (!search) return true;
    return [row.orderNumber, row.itemName, row.itemCode]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });
}

export function buildInventoryRawConsumptionRows(movements: StockMovement[]): InventoryRawConsumptionRow[] {
  const grouped = new Map<string, InventoryRawConsumptionRow & { orderIds: Set<string> }>();

  movements.forEach((movement) => {
    const movementType = movement.movementType;
    const isConsumption = movementType === 'SALE_DEDUCTION' || movementType === 'ORDER_BOM_BACKFILL';
    const isReversal = movementType === 'ORDER_VOID_REVERSAL';
    if (!isConsumption && !isReversal) return;

    const itemType = movementItemType(movement);
    if (!['RAW_INGREDIENT', 'PREP_ITEM', 'PACKAGING', 'BOUGHT_COMPONENT'].includes(itemType)) return;

    const itemCode = movementItemCode(movement);
    const unit = movement.unit || '-';
    const key = `${itemType}|${itemCode}|${unit}`;
    const existing = grouped.get(key) || {
      itemName: movementItemName(movement),
      itemCode,
      stockItemType: itemType,
      grossConsumedQuantity: 0,
      reversedQuantity: 0,
      netConsumedQuantity: 0,
      unit,
      grossCogs: 0,
      reversedCogs: 0,
      netCogs: 0,
      ordersCount: 0,
      lastConsumedAt: null,
      orderIds: new Set<string>(),
    };

    const quantity = Math.abs(money(movement.quantityDelta ?? movement.quantity));
    const cogs = Math.abs(money(movement.cogsAmount));
    if (isReversal) {
      existing.reversedQuantity += quantity;
      existing.reversedCogs += cogs;
    } else {
      existing.grossConsumedQuantity += quantity;
      existing.grossCogs += cogs;
      if (movement.orderId) existing.orderIds.add(movement.orderId);
      if (!existing.lastConsumedAt || toTime(movement.createdAt) > toTime(existing.lastConsumedAt)) {
        existing.lastConsumedAt = movement.createdAt;
      }
    }
    existing.netConsumedQuantity = Math.max(0, existing.grossConsumedQuantity - existing.reversedQuantity);
    existing.netCogs = Math.max(0, existing.grossCogs - existing.reversedCogs);
    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map(({ orderIds, ...row }) => ({
      ...row,
      ordersCount: orderIds.size,
    }))
    .sort((a, b) => b.netConsumedQuantity - a.netConsumedQuantity || b.grossConsumedQuantity - a.grossConsumedQuantity);
}
