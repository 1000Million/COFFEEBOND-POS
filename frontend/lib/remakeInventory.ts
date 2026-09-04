import type { KotItem, OrderItem } from '../types';
import type { FinishedGood } from '../types/menu-management';
import type { InventoryDeductionLineInput, InventoryMovementPayload } from './inventoryDeduction';
import { expandCompositeInventoryLines } from './compositeFulfillment';

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sanitizeRemakeDocumentId(value: string, maxLength = 360): string {
  return text(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLength);
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0');
}

export function nextRemakeCount(kot: Pick<KotItem, 'remakeCount'>): number {
  return Math.max(0, Math.trunc(number(kot.remakeCount))) + 1;
}

export function deterministicRemakeKotId(kot: Pick<KotItem, 'id' | 'remakeCount'>): string {
  const sourceKotId = text(kot.id);
  if (!sourceKotId) throw new Error('The source KOT id is required for a remake.');
  const suffix = `REMAKE_${String(nextRemakeCount(kot)).padStart(2, '0')}`;
  const rawId = sanitizeRemakeDocumentId(`${sourceKotId}_${suffix}`, 1500);
  if (rawId.length <= 360) return rawId;
  return `${rawId.slice(0, 330)}_${shortHash(sourceKotId)}_${suffix}`;
}

export function deterministicRemakeMovementId(
  remakeKotId: string,
  movement: Pick<InventoryMovementPayload, 'stockDocId' | 'orderLineKey' | 'unit'>,
): string {
  const identity = [
    remakeKotId,
    movement.stockDocId || 'STOCK',
    movement.orderLineKey || 'LINE',
    'WASTAGE',
    movement.unit || 'UOM',
  ].join('_');
  return `${sanitizeRemakeDocumentId(identity, 340)}_${shortHash(identity)}`;
}

export function canonicalComponentForRemake(orderItem: OrderItem, kot: KotItem) {
  const components = Array.isArray(orderItem.components) ? orderItem.components : [];
  if (components.length === 0) return null;
  if (!kot.component) {
    throw new Error('This composite KOT is missing its canonical component snapshot.');
  }

  const component = components.find(candidate => (
    candidate.sequence === kot.component!.sequence
    && candidate.componentFinishedGoodId === kot.component!.componentFinishedGoodId
    && candidate.componentFinishedGoodCode === kot.component!.componentFinishedGoodCode
  ));
  if (!component) {
    throw new Error('The remake component no longer matches the canonical order item snapshot.');
  }

  const expectedQuantity = number(orderItem.quantity) * number(component.quantity);
  if (expectedQuantity <= 0 || number(kot.quantity) !== expectedQuantity) {
    throw new Error('The remake component quantity does not match the canonical order item snapshot.');
  }
  return component;
}

export function buildFinishedGoodsRemakeLine(input: {
  orderItem: OrderItem;
  kot: KotItem;
  remakeKotId: string;
  liveFinishedGood?: FinishedGood | null;
  logicalStoreId: string;
}): InventoryDeductionLineInput {
  const { orderItem, kot, remakeKotId, liveFinishedGood, logicalStoreId } = input;
  if (orderItem.sourceSystem !== 'FINISHED_GOODS') {
    throw new Error('Canonical remake inventory is only available for FINISHED_GOODS order items.');
  }

  const component = canonicalComponentForRemake(orderItem, kot);
  if (component) {
    const [expanded] = expandCompositeInventoryLines([{
      lineKey: remakeKotId,
      quantity: number(orderItem.quantity),
      finishedGood: {
        code: text(orderItem.finishedGoodCode || orderItem.itemCode),
        name: text(orderItem.itemName),
      } as FinishedGood,
      addOns: [],
      components: [component],
    }], logicalStoreId);
    if (!expanded) throw new Error('The canonical remake component could not be expanded.');
    return {
      lineKey: expanded.lineKey,
      quantity: expanded.quantity,
      finishedGood: expanded.finishedGood,
      addOns: [],
    };
  }

  if (kot.component) {
    throw new Error('The KOT component is not present on the canonical order item.');
  }
  if (!liveFinishedGood) {
    throw new Error(`Finished good ${orderItem.finishedGoodCode || orderItem.itemCode} was not found for remake.`);
  }
  const expectedCode = text(orderItem.finishedGoodCode || orderItem.itemCode);
  if (!expectedCode || text(liveFinishedGood.code) !== expectedCode) {
    throw new Error('The remake finished good does not match the canonical order item.');
  }
  if (number(kot.quantity) <= 0 || number(kot.quantity) !== number(orderItem.quantity)) {
    throw new Error('The remake quantity does not match the canonical order item.');
  }

  return {
    lineKey: remakeKotId,
    quantity: number(kot.quantity),
    finishedGood: liveFinishedGood,
    addOns: Array.isArray(orderItem.addOns) ? orderItem.addOns : [],
  };
}
