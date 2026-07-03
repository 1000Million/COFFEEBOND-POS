import { collection, doc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { OnlineOrder, Order, OrderItem, OrderPayment, StaffProfile, Store } from '../types';
import { FinishedGood } from '../types/menu-management';

type TaxConfig = {
  rate: number;
  source: string;
};

type AcceptResult = {
  orderId: string;
  orderNumber: string;
  stockMovementCount: number;
  kotCount: number;
};

export type OnlineOrderAcceptBlocker = {
  itemName: string;
  itemCode: string;
  blockerType: string;
  componentType?: string;
  componentCode?: string;
  componentName?: string;
  requiredQuantity?: number;
  availableQuantity?: number;
  unit?: string;
  suggestedAction: string;
};

type RequiredStockSource = {
  itemName: string;
  itemCode: string;
  componentType: string;
  componentCode: string;
  componentName: string;
  quantity: number;
  unit: string;
};

type RequiredStock = {
  id: string;
  name: string;
  unit: string;
  qty: number;
  type: string;
  code: string;
  sources: RequiredStockSource[];
};

type CalculatedLine = {
  onlineItem: OnlineOrder['items'][number];
  finishedGood: FinishedGood & { id: string };
  quantity: number;
  lineSubtotal: number;
  lineTaxable: number;
  lineTax: number;
  lineTotal: number;
  appliedTaxRate: number;
};

const GST_CONFIG_DOC_ID = 'gstConfig';
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

export class OnlineOrderAcceptError extends Error {
  blockers: OnlineOrderAcceptBlocker[];

  constructor(blockers: OnlineOrderAcceptBlocker[]) {
    super('Online order cannot be accepted because stock/BOM readiness is incomplete.');
    this.name = 'OnlineOrderAcceptError';
    this.blockers = blockers;
  }
}

export function isOnlineOrderAcceptError(error: unknown): error is OnlineOrderAcceptError {
  return error instanceof OnlineOrderAcceptError
    || (typeof error === 'object' && error !== null && Array.isArray((error as OnlineOrderAcceptError).blockers));
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTaxRate(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function pickTaxConfig(data: Record<string, unknown>, source: string, keys: string[]): TaxConfig | null {
  for (const key of keys) {
    const rate = normalizeTaxRate(data[key]);
    if (rate > 0) return { rate, source: `${source}.${key}` };
  }
  return null;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, rate]) => {
    const normalizedRate = normalizeTaxRate(rate);
    if (normalizedRate > 0) acc[key] = normalizedRate;
    return acc;
  }, {});
}

function pickItemTaxRate(item: Record<string, unknown>): number {
  return pickTaxConfig(item, 'item', ITEM_TAX_RATE_KEYS)?.rate || 0;
}

function getAppliedTaxRate(item: Record<string, unknown>, fallbackTaxRate: number): number {
  const itemTax = pickItemTaxRate(item);
  return itemTax > 0 ? itemTax : fallbackTaxRate;
}

function calculateStoreTaxRate(store: Store, gstConfig: Record<string, unknown> | null): number {
  const overrides = normalizeStoreOverrides(gstConfig?.storeOverrides);
  const overrideRate = overrides[store.id] || overrides[store.code];
  if (overrideRate > 0) return overrideRate;

  const storeTax = pickTaxConfig(store as unknown as Record<string, unknown>, `stores/${store.id}`, STORE_TAX_RATE_KEYS);
  if (storeTax) return storeTax.rate;

  const appTax = gstConfig ? pickTaxConfig(gstConfig, `appSettings/${GST_CONFIG_DOC_ID}`, APP_TAX_RATE_KEYS) : null;
  return appTax?.rate || 0;
}

function addStockRequirement(requirements: Record<string, RequiredStock>, stockId: string, source: RequiredStockSource) {
  if (!requirements[stockId]) {
    requirements[stockId] = {
      id: stockId,
      name: source.componentName,
      unit: source.unit,
      qty: 0,
      type: source.componentType,
      code: source.componentCode,
      sources: [],
    };
  }
  requirements[stockId].qty += source.quantity;
  requirements[stockId].sources.push(source);
}

function buildStockBlockers(
  requirement: RequiredStock,
  blockerType: string,
  availableQuantity: number,
  suggestedAction: string,
): OnlineOrderAcceptBlocker[] {
  return requirement.sources.map(source => ({
    itemName: source.itemName,
    itemCode: source.itemCode,
    blockerType,
    componentType: source.componentType,
    componentCode: source.componentCode,
    componentName: source.componentName,
    requiredQuantity: requirement.qty,
    availableQuantity,
    unit: source.unit,
    suggestedAction,
  }));
}

function buildOrderType(onlineOrder: OnlineOrder): Order['orderType'] {
  return onlineOrder.orderType === 'DINE_IN' ? 'DINE_IN' : 'TAKEAWAY';
}

export async function acceptOnlineOrder(onlineOrderId: string, staffProfile: StaffProfile): Promise<AcceptResult> {
  const onlineOrderRef = doc(db, 'onlineOrders', onlineOrderId);
  const newOrderRef = doc(collection(db, 'orders'));
  const newCustomerRef = doc(collection(db, 'customers'));

  try {
    return await runTransaction(db, async transaction => {
    const onlineOrderSnap = await transaction.get(onlineOrderRef);
    if (!onlineOrderSnap.exists()) throw new Error('Online order request no longer exists.');

    const onlineOrder = { id: onlineOrderSnap.id, ...onlineOrderSnap.data() } as OnlineOrder;
    if (onlineOrder.status !== 'PENDING' && onlineOrder.status !== 'NEEDS_ATTENTION') {
      throw new Error(`Online order is ${onlineOrder.status} and cannot be accepted again.`);
    }

    const storeRef = doc(db, 'stores', onlineOrder.storeId);
    const gstRef = doc(db, 'appSettings', GST_CONFIG_DOC_ID);
    const [storeSnap, gstSnap] = await Promise.all([
      transaction.get(storeRef),
      transaction.get(gstRef),
    ]);

    if (!storeSnap.exists()) throw new Error('Selected store no longer exists.');
    const store = { id: storeSnap.id, ...storeSnap.data() } as Store;
    const gstConfig = gstSnap.exists() ? gstSnap.data() as Record<string, unknown> : null;
    const storeTaxRate = calculateStoreTaxRate(store, gstConfig);

    const finishedGoodRefs = onlineOrder.items.map(item => doc(db, 'finishedGoods', item.finishedGoodCode));
    const finishedGoodSnaps = await Promise.all(finishedGoodRefs.map(ref => transaction.get(ref)));
    const finishedGoods = finishedGoodSnaps.map((snap, index) => {
      if (!snap.exists()) {
        throw new OnlineOrderAcceptError([{
          itemName: onlineOrder.items[index].itemName,
          itemCode: onlineOrder.items[index].finishedGoodCode,
          blockerType: 'Missing finished good',
          suggestedAction: 'Check Menu Management and make sure the finished good still exists.',
        }]);
      }
      return { id: snap.id, ...snap.data() } as FinishedGood & { id: string };
    });

    const blockers: OnlineOrderAcceptBlocker[] = [];
    const calculatedLines: CalculatedLine[] = [];

    onlineOrder.items.forEach((onlineItem, index) => {
      const finishedGood = finishedGoods[index];
      const quantity = Number(onlineItem.quantity) || 0;
      const itemName = finishedGood.displayName || finishedGood.name || onlineItem.itemName;

      if (!finishedGood.isActive || !finishedGood.isSellable || finishedGood.isAvailable === false || !finishedGood.availableStoreIds?.includes(store.id)) {
        blockers.push({
          itemName,
          itemCode: finishedGood.code,
          blockerType: 'Finished good unavailable',
          suggestedAction: 'Make the item active, sellable, available, and assigned to this store before accepting.',
        });
      }

      if (quantity <= 0) {
        blockers.push({
          itemName,
          itemCode: finishedGood.code,
          blockerType: 'Invalid quantity',
          suggestedAction: 'Reject this request and ask the customer to place it again.',
        });
      }

      const price = Number(finishedGood.salePrice) || Number(onlineItem.unitPrice) || 0;
      const lineSubtotal = price * quantity;
      const appliedTaxRate = getAppliedTaxRate(finishedGood as unknown as Record<string, unknown>, storeTaxRate);
      const lineTaxable = lineSubtotal;
      const lineTax = lineTaxable * (appliedTaxRate / 100);

      calculatedLines.push({
        onlineItem,
        finishedGood,
        quantity,
        lineSubtotal,
        lineTaxable,
        lineTax,
        lineTotal: lineTaxable + lineTax,
        appliedTaxRate,
      });
    });

    const stockRequirements: Record<string, RequiredStock> = {};

    calculatedLines.forEach(({ finishedGood, quantity }) => {
      const itemType = finishedGood.itemType;
      const bom = Array.isArray(finishedGood.bom) ? finishedGood.bom : [];
      const itemName = finishedGood.displayName || finishedGood.name || finishedGood.code;

      if (itemType === 'NO_STOCK') return;

      if (itemType === 'MADE_TO_ORDER' || (itemType === 'DIRECT_STOCK' && bom.length > 0)) {
        if (bom.length === 0) {
          blockers.push({
            itemName,
            itemCode: finishedGood.code,
            blockerType: 'Missing BOM',
            suggestedAction: 'Add a BOM/recipe for this finished good in Menu Management before accepting.',
          });
          return;
        }

        bom.forEach(line => {
          const componentCode = String(line.componentCode || '').trim();
          const componentType = String(line.componentType || '').trim();
          const componentQuantity = Number(line.quantity) || 0;
          const unit = String(line.uom || '').trim();

          if (!componentCode || !componentType || componentQuantity <= 0) {
            blockers.push({
              itemName,
              itemCode: finishedGood.code,
              blockerType: 'Missing prep/raw ingredient reference',
              componentType: componentType || 'UNKNOWN',
              componentCode: componentCode || 'UNKNOWN',
              componentName: line.componentName || 'Missing component',
              requiredQuantity: componentQuantity,
              unit,
              suggestedAction: 'Fix the BOM row so it has component type, code, quantity, and UOM.',
            });
            return;
          }

          addStockRequirement(stockRequirements, `${store.id}_${componentType}_${componentCode}`, {
            itemName,
            itemCode: finishedGood.code,
            componentType,
            componentCode,
            componentName: line.componentName || componentCode,
            quantity: componentQuantity * quantity,
            unit,
          });
        });
      } else if (itemType === 'DIRECT_STOCK') {
        addStockRequirement(stockRequirements, `${store.id}_FINISHED_GOOD_${finishedGood.code}`, {
          itemName,
          itemCode: finishedGood.code,
          componentType: 'FINISHED_GOOD',
          componentCode: finishedGood.code,
          componentName: itemName,
          quantity,
          unit: 'pcs',
        });
      }
    });

    if (blockers.length > 0) {
      throw new OnlineOrderAcceptError(blockers);
    }

    const stockTargets = Object.keys(stockRequirements).map(stockKey => {
      const requirement = stockRequirements[stockKey];
      let stockRef = doc(db, 'storeStock', stockKey);
      if (requirement.type === 'PACKAGING') {
        stockRef = doc(db, 'storeStock', `${store.id}_PACKAGING_${requirement.code}`);
      }
      return { stockKey, requirement, stockRef };
    });

    const stockSnaps = await Promise.all(stockTargets.map(target => transaction.get(target.stockRef)));
    const resolvedStockTargets = [];

    for (let index = 0; index < stockTargets.length; index += 1) {
      let stockSnap = stockSnaps[index];
      let target = stockTargets[index];

      if (!stockSnap.exists() && target.requirement.type === 'PACKAGING') {
        const fallbackRef = doc(db, 'storeStock', `${store.id}_RAW_INGREDIENT_${target.requirement.code}`);
        stockSnap = await transaction.get(fallbackRef);
        target = { ...target, stockRef: fallbackRef };
      }

      if (!stockSnap.exists()) {
        blockers.push(...buildStockBlockers(
          target.requirement,
          'Missing stock record',
          0,
          `Create a storeStock row for ${target.requirement.type} / ${target.requirement.code} at ${store.name}.`,
        ));
        continue;
      }

      const stockData = stockSnap.data() as Record<string, unknown>;
      const currentStock = Number(stockData.currentStock) || 0;
      const confirmedZero = stockData.confirmedZero === true;
      if (currentStock < target.requirement.qty) {
        const blockerType = currentStock <= 0
          ? (confirmedZero ? 'Zero stock' : 'confirmedZero false')
          : 'Insufficient stock';
        blockers.push(...buildStockBlockers(
          target.requirement,
          blockerType,
          currentStock,
          `Load current stock or reduce the requested quantity. Required ${target.requirement.qty.toFixed(2)} ${target.requirement.unit}; available ${currentStock.toFixed(2)} ${target.requirement.unit}.`,
        ));
        continue;
      }

      resolvedStockTargets.push({ ...target, currentStock });
    }

    if (blockers.length > 0) {
      throw new OnlineOrderAcceptError(blockers);
    }

    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterRef = doc(db, 'counters', `${store.code}_${dateKey}`);
    const counterSnap = await transaction.get(counterRef);
    const sequence = counterSnap.exists() ? (Number(counterSnap.data().lastSequence) || 0) + 1 : 1;
    const orderNumber = `CB-${store.code}-${dateKey}-${sequence.toString().padStart(4, '0')}`;

    const subtotal = calculatedLines.reduce((sum, line) => sum + line.lineSubtotal, 0);
    const taxableAmount = calculatedLines.reduce((sum, line) => sum + line.lineTaxable, 0);
    const gstTotal = calculatedLines.reduce((sum, line) => sum + line.lineTax, 0);
    const grandTotal = taxableAmount + gstTotal;
    const orderType = buildOrderType(onlineOrder);
    const customerPhone = onlineOrder.customerPhone.trim();
    const customerName = onlineOrder.customerName.trim() || 'Online Guest';
    const customerId = customerPhone ? newCustomerRef.id : null;

    resolvedStockTargets.forEach(target => {
      const deduction = target.requirement.qty;
      transaction.update(target.stockRef, {
        currentStock: target.currentStock - deduction,
        updatedAt: serverTimestamp(),
      });

      const movementRef = doc(collection(db, 'stockMovements'));
      transaction.set(movementRef, {
        storeId: store.id,
        storeName: store.name,
        inventoryItemId: target.requirement.code,
        inventoryItemName: target.requirement.name,
        movementType: 'SALE_DEDUCTION',
        quantity: -deduction,
        unit: target.requirement.unit,
        referenceType: 'ORDER',
        referenceId: newOrderRef.id,
        notes: `Online order ${orderNumber}`,
        createdByUserId: staffProfile.uid,
        createdByName: staffProfile.name,
        createdAt: serverTimestamp(),
        stockSystem: 'MENU_MANAGEMENT',
        stockItemType: target.requirement.type === 'PACKAGING' && target.stockRef.id.includes('RAW_INGREDIENT') ? 'RAW_INGREDIENT' : target.requirement.type,
        stockItemCode: target.requirement.code,
      });
    });

    if (counterSnap.exists()) {
      transaction.update(counterRef, { lastSequence: sequence, updatedAt: serverTimestamp() });
    } else {
      transaction.set(counterRef, { storeCode: store.code, dateKey, lastSequence: sequence, updatedAt: serverTimestamp() });
    }

    if (customerPhone) {
      transaction.set(newCustomerRef, {
        name: customerName,
        phone: customerPhone,
        visitCount: 1,
        totalSpend: grandTotal,
        lastVisitAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const orderData: Order = {
      orderNumber,
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      customerId,
      customerName,
      customerPhone: customerPhone || null,
      createdByUserId: staffProfile.uid,
      createdByName: staffProfile.name,
      orderType,
      status: 'COMPLETED',
      paymentStatus: 'UNPAID',
      tableNumber: orderType === 'DINE_IN' ? 'ONLINE' : null,
      subtotal,
      taxTotal: gstTotal,
      gstTotal,
      taxableAmount,
      discountPercent: 0,
      discountAmount: 0,
      discountTotal: 0,
      discount: 0,
      grandTotal,
      paymentMethod: 'PAY_AT_COUNTER',
      paymentMethodLabel: 'PAY_AT_COUNTER',
      isSplitPayment: false,
      paymentBreakdown: [{ method: 'PAY_AT_COUNTER', amount: grandTotal }],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    transaction.set(newOrderRef, {
      ...orderData,
      source: 'CUSTOMER_WEB',
      onlineOrderId,
      notes: onlineOrder.notes || '',
    });

    let kotCount = 0;
    calculatedLines.forEach(line => {
      const lineRef = doc(collection(newOrderRef, 'items'));
      const itemData: OrderItem = {
        menuItemId: line.finishedGood.code,
        itemName: line.finishedGood.displayName || line.finishedGood.name,
        itemCode: line.finishedGood.code,
        categoryId: line.finishedGood.posCategoryCode || 'MISC',
        categoryName: line.finishedGood.posCategoryName || 'Misc',
        quantity: line.quantity,
        unitPrice: Number(line.finishedGood.salePrice) || line.onlineItem.unitPrice,
        taxRate: line.appliedTaxRate,
        lineSubtotal: line.lineSubtotal,
        lineDiscount: 0,
        lineTaxable: line.lineTaxable,
        lineTax: line.lineTax,
        lineTotal: line.lineTotal,
        prepStation: line.finishedGood.prepStation,
        status: 'PENDING',
        createdAt: serverTimestamp(),
        sourceSystem: 'FINISHED_GOODS',
        finishedGoodCode: line.finishedGood.code,
        itemType: line.finishedGood.itemType,
      };
      transaction.set(lineRef, itemData);

      const createKot = (station: 'BARISTA' | 'KITCHEN') => {
        const kotRef = doc(collection(db, 'kotItems'));
        kotCount += 1;
        transaction.set(kotRef, {
          orderId: newOrderRef.id,
          orderNumber,
          orderItemId: lineRef.id,
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
          station,
          itemName: line.finishedGood.displayName || line.finishedGood.name,
          itemCode: line.finishedGood.code,
          quantity: line.quantity,
          orderType,
          tableNumber: orderType === 'DINE_IN' ? 'ONLINE' : null,
          customerName,
          status: 'PENDING',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdByUserId: staffProfile.uid,
          createdByName: staffProfile.name,
        });
      };

      if (line.finishedGood.prepStation === 'BARISTA' || line.finishedGood.prepStation === 'BOTH') createKot('BARISTA');
      if (line.finishedGood.prepStation === 'KITCHEN' || line.finishedGood.prepStation === 'BOTH') createKot('KITCHEN');
    });

    const paymentRef = doc(collection(newOrderRef, 'payments'));
    const paymentData: OrderPayment = {
      method: 'PAY_AT_COUNTER',
      amount: grandTotal,
      reference: 'ONLINE_ORDER_REQUEST',
      paymentIndex: 0,
      createdAt: serverTimestamp(),
    };
    transaction.set(paymentRef, paymentData);

    transaction.update(onlineOrderRef, {
      status: 'CONVERTED',
      linkedOrderId: newOrderRef.id,
      linkedOrderNumber: orderNumber,
      convertedBy: staffProfile.uid,
      convertedByName: staffProfile.name,
      convertedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return {
      orderId: newOrderRef.id,
      orderNumber,
      stockMovementCount: resolvedStockTargets.length,
      kotCount,
    };
    });
  } catch (error) {
    if (isOnlineOrderAcceptError(error)) {
      await updateDoc(onlineOrderRef, {
        status: 'NEEDS_ATTENTION',
        attentionReason: error.blockers.map(blocker => `${blocker.itemName}: ${blocker.blockerType}`).join('; '),
        updatedAt: serverTimestamp(),
      });
    }
    throw error;
  }
}
