import { collection, doc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { OnlineOrder, Order, OrderItem, OrderPayment, StaffProfile, Store } from '../types';
import { FinishedGood } from '../types/menu-management';
import { InventoryDeductionBlocker, planInventoryDeductionForSale } from './inventoryDeduction';

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

export type OnlineOrderAcceptBlocker = InventoryDeductionBlocker;

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
          storeId: store.id,
          storeName: store.name,
          suggestedAdminAction: 'Check Menu Management and make sure the finished good still exists.',
        }]);
      }
      return { id: snap.id, ...snap.data() } as FinishedGood & { id: string };
    });

    const calculatedLines: CalculatedLine[] = [];

    onlineOrder.items.forEach((onlineItem, index) => {
      const finishedGood = finishedGoods[index];
      const quantity = Number(onlineItem.quantity) || 0;
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

    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterRef = doc(db, 'counters', `${store.code}_${dateKey}`);
    const counterSnap = await transaction.get(counterRef);
    const sequence = counterSnap.exists() ? (Number(counterSnap.data().lastSequence) || 0) + 1 : 1;
    const orderNumber = `CB-${store.code}-${dateKey}-${sequence.toString().padStart(4, '0')}`;
    const lineRefs = calculatedLines.map(() => doc(collection(newOrderRef, 'items')));
    const deductionPlan = await planInventoryDeductionForSale({
      transaction,
      store,
      orderId: newOrderRef.id,
      orderNumber,
      businessDate: dateKey,
      source: 'CUSTOMER_WEB_ACCEPT',
      staffProfile: {
        uid: staffProfile.uid,
        name: staffProfile.name,
      },
      lines: calculatedLines.map((line, index) => ({
        lineKey: lineRefs[index].id,
        quantity: line.quantity,
        finishedGood: {
          ...(line.finishedGood as FinishedGood & { id: string } & Record<string, unknown>),
          code: line.finishedGood.code,
          name: line.finishedGood.name,
        },
      })),
    });

    if (deductionPlan.blockers.length > 0) {
      throw new OnlineOrderAcceptError(deductionPlan.blockers);
    }

    const subtotal = calculatedLines.reduce((sum, line) => sum + line.lineSubtotal, 0);
    const taxableAmount = calculatedLines.reduce((sum, line) => sum + line.lineTaxable, 0);
    const gstTotal = calculatedLines.reduce((sum, line) => sum + line.lineTax, 0);
    const grandTotal = taxableAmount + gstTotal;
    const orderType = buildOrderType(onlineOrder);
    const customerPhone = onlineOrder.customerPhone.trim();
    const customerName = onlineOrder.customerName.trim() || 'Online Guest';
    const customerId = customerPhone ? newCustomerRef.id : null;

    deductionPlan.stockUpdates.forEach((update) => {
      if (update.existed) {
        transaction.update(update.stockRef, {
          currentStock: update.newQty,
          updatedAt: serverTimestamp(),
        });
        return;
      }

      transaction.set(update.stockRef, {
        ...update.seedData,
        currentStock: update.newQty,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    deductionPlan.movementPayloads.forEach((movement) => {
      transaction.set(doc(collection(db, 'stockMovements')), movement);
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
      cogsTotal: deductionPlan.totalCogs,
      inventoryWarningCount: deductionPlan.warnings.length,
      inventoryWarnings: deductionPlan.warnings.map((warning) => warning.message),
      stockMovementCount: deductionPlan.movementPayloads.length,
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
    calculatedLines.forEach((line, index) => {
      const lineRef = lineRefs[index];
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
        cogsAmount: deductionPlan.perLineCogs[lineRef.id] || 0,
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
      customerStatusMessage: 'Your order has been accepted and is being prepared.',
      convertedBy: staffProfile.uid,
      convertedByName: staffProfile.name,
      convertedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return {
      orderId: newOrderRef.id,
      orderNumber,
      stockMovementCount: deductionPlan.movementPayloads.length,
      kotCount,
    };
    });
  } catch (error) {
    if (isOnlineOrderAcceptError(error)) {
      await updateDoc(onlineOrderRef, {
        status: 'NEEDS_ATTENTION',
        attentionReason: error.blockers.map(blocker => `${blocker.itemName}: ${blocker.blockerType}`).join('; '),
        customerStatusMessage: 'The store is reviewing this order.',
        updatedAt: serverTimestamp(),
      });
    }
    throw error;
  }
}
