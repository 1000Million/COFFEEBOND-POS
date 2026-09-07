import { collection, doc, getDoc, runTransaction, serverTimestamp, Timestamp, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { OnlineOrder, Order, OrderItem, OrderPayment, PrepStation, StaffProfile, Store } from '../types';
import { CanonicalCompositeComponent, FinishedGood } from '../types/menu-management';
import { InventoryDeductionBlocker, planInventoryDeductionForSale } from './inventoryDeduction';
import { addOnTaxForLine, addOnTotal } from './addOns';
import { authorizePosAddOns, selectedAddOnIds } from './posAddOnAuthorization';
import { publicStatusMessage, publicTrackingDocRef, updatePublicOrderTracking } from './publicOrderTracking';
import { buildKotTasks, CompositeKotTask, expandCompositeInventoryLines, summarizeParentInventory } from './compositeFulfillment';
import { immutableCompositeComponentSnapshotsEqual } from './immutableCompositeSnapshot';
import {
  calculateOnlineOrderLineMoney,
  calculateOnlineOrderTotals,
} from './onlineOrderMoney.mjs';

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
  components: CanonicalCompositeComponent[];
};

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

function normalizePrepStation(value: unknown): PrepStation {
  const normalized = String(value || 'NONE').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'BARISTA' || normalized === 'BAR') return 'BARISTA';
  if (normalized === 'KITCHEN' || normalized === 'KITCHEN_KOT') return 'KITCHEN';
  if (normalized === 'BOTH' || normalized === 'BARISTA_KITCHEN' || normalized === 'BAR_AND_KITCHEN') return 'BOTH';
  return 'NONE';
}

function buildOrderType(onlineOrder: OnlineOrder): Order['orderType'] {
  return onlineOrder.orderType === 'DINE_IN' ? 'DINE_IN' : 'TAKEAWAY';
}

function buildOnlineOrderTableNumber(onlineOrder: OnlineOrder): string | null {
  if (onlineOrder.orderType !== 'DINE_IN') return null;
  return onlineOrder.tableNumber?.trim() || 'ONLINE';
}

export async function acceptOnlineOrder(onlineOrderId: string, staffProfile: StaffProfile): Promise<AcceptResult> {
  const onlineOrderRef = doc(db, 'onlineOrders', onlineOrderId);

  try {
    const preflightOnlineOrderSnap = await getDoc(onlineOrderRef);
    if (!preflightOnlineOrderSnap.exists()) throw new Error('Online order request no longer exists.');
    const preflightOnlineOrder = {
      id: preflightOnlineOrderSnap.id,
      ...preflightOnlineOrderSnap.data(),
    } as OnlineOrder;
    if (preflightOnlineOrder.status !== 'PENDING' && preflightOnlineOrder.status !== 'NEEDS_ATTENTION') {
      throw new Error(`Online order is ${preflightOnlineOrder.status} and cannot be accepted again.`);
    }
    if (preflightOnlineOrder.paymentProvider === 'RAZORPAY') {
      throw new Error('Paid Razorpay orders must use the secured staff acceptance service.');
    }
    const newOrderRef = doc(collection(db, 'orders'));
    const newCustomerRef = doc(collection(db, 'customers'));
    const lineRefs = preflightOnlineOrder.items.map(() => doc(collection(newOrderRef, 'items')));
    const posAddOnAuthorization = await authorizePosAddOns({
      storeId: preflightOnlineOrder.storeId,
      orderId: newOrderRef.id,
      orderNumber: null,
      sourceOnlineOrderId: preflightOnlineOrder.id,
      items: preflightOnlineOrder.items.map((item, index) => ({
        orderItemId: lineRefs[index].id,
        parentProductId: item.finishedGoodCode,
        parentProductCode: item.finishedGoodCode,
        quantity: item.quantity,
        selectedAddOns: selectedAddOnIds(item.addOns),
      })),
    });
    const posAddOnAuthorizationRef = doc(
      db,
      'posAddOnAuthorizations',
      posAddOnAuthorization.authorizationId,
    );

    return await runTransaction(db, async transaction => {
    const onlineOrderSnap = await transaction.get(onlineOrderRef);
    if (!onlineOrderSnap.exists()) throw new Error('Online order request no longer exists.');

    const onlineOrder = { id: onlineOrderSnap.id, ...onlineOrderSnap.data() } as OnlineOrder;
    if (onlineOrder.status !== 'PENDING' && onlineOrder.status !== 'NEEDS_ATTENTION') {
      throw new Error(`Online order is ${onlineOrder.status} and cannot be accepted again.`);
    }

    const storeRef = doc(db, 'stores', onlineOrder.storeId);
    const storeSnap = await transaction.get(storeRef);

    if (!storeSnap.exists()) throw new Error('Selected store no longer exists.');
    const store = { id: storeSnap.id, ...storeSnap.data() } as Store;
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

    if (onlineOrder.items.length !== lineRefs.length) {
      throw new Error('Online order items changed during acceptance. Please retry.');
    }
    onlineOrder.items.forEach((storedOnlineItem, index) => {
      const finishedGood = finishedGoods[index];
      const canonicalItem = posAddOnAuthorization.canonicalItems[lineRefs[index].id];
      const effectiveProduct = canonicalItem?.productSnapshot || finishedGood;
      const quantity = Number(storedOnlineItem.quantity) || 0;
      if (
        !canonicalItem
        || canonicalItem.parentProductId !== effectiveProduct.id
        || canonicalItem.parentProductCode !== effectiveProduct.code
        || effectiveProduct.id !== finishedGood.id
        || effectiveProduct.code !== finishedGood.code
        || canonicalItem.quantity !== quantity
      ) {
        throw new Error('Online order add-on authorization no longer matches the live menu. Please retry.');
      }
      if (!immutableCompositeComponentSnapshotsEqual(
        storedOnlineItem.components,
        canonicalItem.components,
      )) {
        throw new Error('Online order component snapshot no longer matches the submitted order. Please retry.');
      }
      const onlineItem = {
        ...storedOnlineItem,
        baseUnitPrice: canonicalItem.baseUnitPrice,
        unitPrice: canonicalItem.baseUnitPrice,
        addOns: canonicalItem.addOns,
      };
      const baseUnitPrice = canonicalItem.baseUnitPrice;
      const selectedAddOnTotal = addOnTotal(onlineItem.addOns);
      const appliedTaxRate = canonicalItem.taxRate;
      const money = calculateOnlineOrderLineMoney({
        baseUnitPrice,
        selectedAddOnTotal,
        quantity,
        appliedTaxRate,
        addOnLineTax: addOnTaxForLine(onlineItem.addOns, quantity, 0),
      });

      calculatedLines.push({
        onlineItem,
        finishedGood: effectiveProduct,
        quantity,
        lineSubtotal: money.lineSubtotal,
        lineTaxable: money.lineTaxable,
        lineTax: money.lineTax,
        lineTotal: money.lineTotal,
        appliedTaxRate,
        components: canonicalItem.components || [],
      });
    });

    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterRef = doc(db, 'counters', `${store.code}_${dateKey}`);
    const counterSnap = await transaction.get(counterRef);
    const posAddOnAuthorizationSnap = await transaction.get(posAddOnAuthorizationRef);
    if (!posAddOnAuthorizationSnap.exists()) {
      throw new Error('The POS add-on authorization was not found. Please retry.');
    }
    const authorizationData = posAddOnAuthorizationSnap.data();
    const expiresAt = authorizationData.expiresAt;
    if (
      authorizationData.provider !== 'SERVER_CANONICAL_ADD_ONS'
      || authorizationData.used !== false
      || authorizationData.staffUid !== staffProfile.uid
      || authorizationData.storeId !== store.id
      || authorizationData.orderId !== newOrderRef.id
      || !(expiresAt instanceof Timestamp)
      || expiresAt.toMillis() <= Date.now()
    ) {
      throw new Error('The POS add-on authorization is expired, used, or does not match this online order.');
    }
    const sequence = counterSnap.exists() ? (Number(counterSnap.data().lastSequence) || 0) + 1 : 1;
    const orderNumber = `CB-${store.code}-${dateKey}-${sequence.toString().padStart(4, '0')}`;
    const orderType = buildOrderType(onlineOrder);
    const expandedInventoryLines = expandCompositeInventoryLines(calculatedLines.map((line, index) => ({
      lineKey: lineRefs[index].id,
      quantity: line.quantity,
      finishedGood: line.finishedGood,
      addOns: line.onlineItem.addOns,
      components: line.components,
    })), store.id);
    const deductionPlan = await planInventoryDeductionForSale({
      transaction,
      store,
      orderId: newOrderRef.id,
      orderNumber,
      orderType,
      businessDate: dateKey,
      source: 'CUSTOMER_WEB_ACCEPT',
      staffProfile: {
        uid: staffProfile.uid,
        name: staffProfile.name,
      },
      lines: expandedInventoryLines,
    });

    if (deductionPlan.blockers.length > 0) {
      throw new OnlineOrderAcceptError(deductionPlan.blockers);
    }

    const { subtotal, taxableAmount, gstTotal, grandTotal } = calculateOnlineOrderTotals(calculatedLines);
    const tableNumber = buildOnlineOrderTableNumber(onlineOrder);
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
    deductionPlan.pendingConsumptionPayloads.forEach((pending) => {
      transaction.set(doc(db, 'pendingInventoryConsumption', pending.idempotencyKey), pending, { merge: true });
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
      tableNumber,
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
      inventoryConsumptionStatus: deductionPlan.pendingConsumptionPayloads.length > 0 ? 'PENDING_BOM' : 'APPLIED',
      stockMovementCount: deductionPlan.movementPayloads.length,
      paymentMethod: 'PAY_AT_COUNTER',
      paymentMethodLabel: 'PAY_AT_COUNTER',
      isSplitPayment: false,
      paymentBreakdown: [{ method: 'PAY_AT_COUNTER', amount: 0 }],
      addOnAuthorizationId: posAddOnAuthorization.authorizationId,
      addOnTotal: posAddOnAuthorization.canonicalAddOnTotal,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    transaction.set(newOrderRef, {
      ...orderData,
      source: 'CUSTOMER_WEB',
      onlineOrderId,
      onlineOrderTrackingToken: onlineOrder.trackingToken || null,
      onlineOrderReference: onlineOrder.publicOrderReference || null,
      notes: onlineOrder.notes || '',
    });

    let kotCount = 0;
    calculatedLines.forEach((line, index) => {
      const lineRef = lineRefs[index];
      const linePrepStation = normalizePrepStation(line.finishedGood.prepStation);
      const parentInventory = summarizeParentInventory({
        parentLineKey: lineRef.id,
        expandedLines: expandedInventoryLines,
        perLineCogs: deductionPlan.perLineCogs,
        perLineConsumptionStatus: deductionPlan.perLineConsumptionStatus,
      });
      const itemData: OrderItem = {
        menuItemId: line.finishedGood.code,
        itemName: line.finishedGood.displayName || line.finishedGood.name,
        itemCode: line.finishedGood.code,
        categoryId: line.finishedGood.posCategoryCode || 'MISC',
        categoryName: line.finishedGood.posCategoryName || 'Misc',
        quantity: line.quantity,
        unitPrice: Number(line.finishedGood.salePrice) || line.onlineItem.baseUnitPrice || line.onlineItem.unitPrice,
        baseUnitPrice: Number(line.finishedGood.salePrice) || line.onlineItem.baseUnitPrice || line.onlineItem.unitPrice,
        addOns: line.onlineItem.addOns || [],
        addOnAuthorizationId: posAddOnAuthorization.authorizationId,
        addOnTotal: addOnTotal(line.onlineItem.addOns),
        unitPriceWithAddOns: (Number(line.finishedGood.salePrice) || line.onlineItem.baseUnitPrice || line.onlineItem.unitPrice)
          + addOnTotal(line.onlineItem.addOns),
        taxRate: line.appliedTaxRate,
        lineSubtotal: line.lineSubtotal,
        lineDiscount: 0,
        lineTaxable: line.lineTaxable,
        lineTax: line.lineTax,
        lineTotal: line.lineTotal,
        cogsAmount: parentInventory.cogsAmount,
        inventoryConsumptionStatus: parentInventory.inventoryConsumptionStatus,
        prepStation: linePrepStation,
        status: 'PENDING',
        createdAt: serverTimestamp(),
        sourceSystem: 'FINISHED_GOODS',
        finishedGoodCode: line.finishedGood.code,
        itemType: line.finishedGood.itemType,
        productSnapshot: line.finishedGood,
        ...(line.components.length > 0 ? { components: line.components } : {}),
      };
      transaction.set(lineRef, itemData);

      const createKot = (task: CompositeKotTask) => {
        const kotRef = doc(collection(db, 'kotItems'));
        kotCount += 1;
        transaction.set(kotRef, {
          orderId: newOrderRef.id,
          orderNumber,
          orderItemId: lineRef.id,
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
          station: task.station,
          itemName: task.itemName,
          itemCode: task.itemCode,
          quantity: task.quantity,
          addOns: line.onlineItem.addOns || [],
          ...(task.component ? { component: task.component } : {}),
          orderType,
          tableNumber,
          customerName,
          onlineOrderId,
          onlineOrderTrackingToken: onlineOrder.trackingToken || null,
          onlineOrderReference: onlineOrder.publicOrderReference || null,
          status: 'PENDING',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdByUserId: staffProfile.uid,
          createdByName: staffProfile.name,
        });
      };

      buildKotTasks({
        quantity: line.quantity,
        finishedGood: line.finishedGood,
        prepStation: linePrepStation,
        components: line.components,
      }).forEach(createKot);
    });

    const paymentRef = doc(collection(newOrderRef, 'payments'));
    const paymentData: OrderPayment = {
      method: 'PAY_AT_COUNTER',
      amount: 0,
      reference: 'PAY_AT_COUNTER_PLACEHOLDER',
      paymentIndex: 0,
      createdAt: serverTimestamp(),
    };
    transaction.set(paymentRef, paymentData);
    transaction.update(posAddOnAuthorizationRef, {
      used: true,
      usedAt: serverTimestamp(),
      orderNumber,
    });

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

    if (onlineOrder.trackingToken) {
      transaction.update(publicTrackingDocRef(onlineOrder.trackingToken), {
        publicStatus: 'CONVERTED',
        publicOrderNumber: orderNumber,
        customerStatusMessage: publicStatusMessage('CONVERTED'),
        acceptedAt: serverTimestamp(),
      });
    }

    return {
      orderId: newOrderRef.id,
      orderNumber,
      stockMovementCount: deductionPlan.movementPayloads.length,
      kotCount,
    };
    });
  } catch (error) {
    if (isOnlineOrderAcceptError(error)) {
      const onlineOrderSnap = await getDoc(onlineOrderRef);
      const trackingToken = onlineOrderSnap.exists() ? (onlineOrderSnap.data() as Partial<OnlineOrder>).trackingToken : null;
      await updateDoc(onlineOrderRef, {
        status: 'NEEDS_ATTENTION',
        attentionReason: error.blockers.map(blocker => `${blocker.itemName}: ${blocker.blockerType}`).join('; '),
        customerStatusMessage: 'The store is reviewing this order.',
        updatedAt: serverTimestamp(),
      });
      await updatePublicOrderTracking(trackingToken, {
        publicStatus: 'NEEDS_ATTENTION',
        customerStatusMessage: publicStatusMessage('NEEDS_ATTENTION'),
      });
    }
    throw error;
  }
}
