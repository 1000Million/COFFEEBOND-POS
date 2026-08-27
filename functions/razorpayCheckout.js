'use strict';

const Razorpay = require('razorpay');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { canonicalizeRequestedCart } = require('./posAddOnAuthorization');
const { planOnlineOrderInventory } = require('./onlineOrderInventory');
const {
  BOND_REDEMPTION_POLICY,
  applyBondRedemptionToCheckout,
} = require('./bondRedemptionPolicy');
const {
  ACCEPTED_RAZORPAY_STATUS,
  CURRENCY,
  INTENT_TTL_MS,
  MAX_PAYMENT_ATTEMPTS,
  PAID_STATUS,
  PROVIDER,
  REVIEW_STATUS,
  cleanText,
  deterministicIntentId,
  deterministicLineId,
  deterministicPosOrderId,
  deterministicReceipt,
  intentCanBeReused,
  intentCanRetry,
  isFinalProviderState,
  isRazorpayOrderEligible,
  providerMethod,
  requestChecksum,
  rupeesToPaise,
  safeProviderError,
  sha256,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} = require('./razorpayCheckoutPolicy');

const RAZORPAY_KEY_ID = defineString('RAZORPAY_KEY_ID', { default: '' });
const RAZORPAY_KEY_SECRET = defineSecret('RAZORPAY_KEY_SECRET');
const RAZORPAY_WEBHOOK_SECRET = defineSecret('RAZORPAY_WEBHOOK_SECRET');
const PAYMENT_INTENT_COLLECTION = 'razorpayPaymentIntents';
const WEBHOOK_AUDIT_COLLECTION = 'razorpayWebhookEvents';
const PAYMENT_EXPIRY_MINUTES = 30;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function normalizePrepStation(value) {
  const normalized = String(value || 'NONE').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'BARISTA' || normalized === 'BAR') return 'BARISTA';
  if (normalized === 'KITCHEN' || normalized === 'KITCHEN_KOT') return 'KITCHEN';
  if (normalized === 'BOTH' || normalized === 'BARISTA_KITCHEN' || normalized === 'BAR_AND_KITCHEN') return 'BOTH';
  return 'NONE';
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toOrderType(order) {
  return order.orderType === 'DINE_IN' ? 'DINE_IN' : 'TAKEAWAY';
}

function publicStatusMessage(status) {
  if (status === ACCEPTED_RAZORPAY_STATUS) return 'Your order is accepted. Complete payment to begin preparation.';
  if (status === 'PAYMENT_PROCESSING') return 'We are confirming your payment.';
  if (status === 'PAYMENT_FAILED') return 'Payment was not completed. You can try again.';
  if (status === REVIEW_STATUS) return 'Payment was received, but the store must review fulfilment before preparation.';
  if (status === 'CONVERTED') return 'Payment confirmed. Your order is being prepared.';
  return 'We are checking your order status.';
}

async function resolveOnlineOrderByTracking({ db, trackingToken, publicOrderReference }) {
  const token = cleanText(trackingToken, 200);
  const reference = cleanText(publicOrderReference, 120);
  if (!token || !reference) fail('invalid-argument', 'Order tracking details are required.');

  const trackingSnapshot = await db.collection('publicOrderTracking').doc(token).get();
  if (!trackingSnapshot.exists || trackingSnapshot.data()?.publicOrderReference !== reference) {
    fail('not-found', 'Order tracking details do not match.');
  }
  const orderQuery = await db.collection('onlineOrders').where('trackingToken', '==', token).limit(2).get();
  if (orderQuery.size !== 1) fail('not-found', 'Order tracking details do not match.');
  const snapshot = orderQuery.docs[0];
  const order = { id: snapshot.id, ...snapshot.data() };
  if (order.publicOrderReference !== reference || order.trackingToken !== token) {
    fail('not-found', 'Order tracking details do not match.');
  }
  return { ref: snapshot.ref, order };
}

function razorpayClient(keyId, keySecret, RazorpayClass = Razorpay, options = {}) {
  if (!keyId || !keySecret) fail('failed-precondition', 'Online payment is not configured.');
  return new RazorpayClass({ key_id: keyId, key_secret: keySecret, ...options });
}

function paymentIntentResponse(intent, order, keyId) {
  return {
    razorpayOrderId: intent.providerOrderId,
    amount: intent.expectedAmountPaise,
    currency: intent.expectedCurrency,
    keyId,
    receipt: intent.receipt,
    status: intent.status,
    expiresAt: intent.expiresAt?.toDate?.().toISOString?.() || intent.expiresAt || null,
    prefill: {
      name: cleanText(order.customerName, 80),
      contact: normalizePhone(order.customerPhone),
    },
  };
}

async function createProviderOrder({
  db,
  admin,
  onlineOrderRef,
  order,
  keyId,
  keySecret,
  RazorpayClass,
  now = Date.now(),
}) {
  if (!isRazorpayOrderEligible(order, now)) {
    fail('failed-precondition', 'This order is not ready for online payment.');
  }
  let amountPaise;
  try {
    amountPaise = rupeesToPaise(Number(order.grandTotal));
  } catch {
    fail('failed-precondition', 'This order total cannot be paid online.');
  }

  const intentRef = db.collection(PAYMENT_INTENT_COLLECTION).doc(deterministicIntentId(order.id));
  const reservation = await db.runTransaction(async transaction => {
    const storeRef = db.collection('stores').doc(order.storeId);
    const [freshOrderSnapshot, intentSnapshot, storeSnapshot] = await Promise.all([
      transaction.get(onlineOrderRef),
      transaction.get(intentRef),
      transaction.get(storeRef),
    ]);
    if (!freshOrderSnapshot.exists) fail('not-found', 'Order no longer exists.');
    const freshOrder = { id: freshOrderSnapshot.id, ...freshOrderSnapshot.data() };
    if (!storeSnapshot.exists || storeSnapshot.data()?.isActive !== true) {
      fail('failed-precondition', 'The selected store is not active.');
    }
    if (!isRazorpayOrderEligible(freshOrder, now)) {
      if (freshOrder.paymentStatus === PAID_STATUS && freshOrder.linkedOrderId) {
        return { alreadyPaid: true, linkedOrderId: freshOrder.linkedOrderId };
      }
      fail('failed-precondition', 'This order is not ready for online payment.');
    }
    if (rupeesToPaise(Number(freshOrder.grandTotal)) !== amountPaise) {
      fail('aborted', 'The order total changed. Refresh and try again.');
    }

    const existing = intentSnapshot.exists ? { id: intentSnapshot.id, ...intentSnapshot.data() } : null;
    if (existing?.status === PAID_STATUS) {
      return { alreadyPaid: true, linkedOrderId: existing.coffeeBondPosOrderId || freshOrder.linkedOrderId };
    }
    if (intentCanBeReused(existing, amountPaise, now)) {
      if (existing.requestChecksum !== requestChecksum(freshOrder)) {
        fail('aborted', 'The order details changed. Ask the store to review it again.');
      }
      return { reuse: true, intent: existing, freshOrder };
    }
    if (existing?.status === 'CREATING') {
      fail('aborted', 'Payment setup is already in progress. Please wait and try again.');
    }
    if (existing && !intentCanRetry(existing)) {
      fail('resource-exhausted', 'Online payment attempts are exhausted. Please contact the store.');
    }
    const attemptNumber = Number(existing?.attemptNumber || 0) + 1;
    if (attemptNumber > MAX_PAYMENT_ATTEMPTS) {
      fail('resource-exhausted', 'Online payment attempts are exhausted. Please contact the store.');
    }
    const receipt = deterministicReceipt(freshOrder.id);
    transaction.set(intentRef, {
      coffeeBondOnlineOrderId: freshOrder.id,
      coffeeBondPosOrderId: freshOrder.plannedOrderId || deterministicPosOrderId(freshOrder.id),
      storeId: freshOrder.storeId,
      provider: PROVIDER,
      expectedAmountPaise: amountPaise,
      expectedCurrency: CURRENCY,
      status: 'CREATING',
      attemptNumber,
      requestChecksum: requestChecksum(freshOrder),
      receipt,
      providerOrderId: null,
      safeProviderPaymentId: null,
      failureCode: null,
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + INTENT_TTL_MS),
      verifiedAt: null,
    }, { merge: true });
    return { create: true, attemptNumber, receipt, freshOrder };
  });

  if (reservation.alreadyPaid) {
    return { alreadyPaid: true, linkedOrderId: reservation.linkedOrderId || null };
  }
  if (reservation.reuse) {
    return paymentIntentResponse(reservation.intent, reservation.freshOrder, keyId);
  }

  const client = razorpayClient(keyId, keySecret, RazorpayClass);
  try {
    const providerOrder = await client.orders.create({
      amount: amountPaise,
      currency: CURRENCY,
      receipt: reservation.receipt,
      notes: {
        coffee_bond_order: sha256(order.id).slice(0, 24),
      },
    });
    if (
      !providerOrder?.id
      || Number(providerOrder.amount) !== amountPaise
      || String(providerOrder.currency).toUpperCase() !== CURRENCY
    ) {
      throw Object.assign(new Error('Provider order response failed validation.'), { statusCode: 502 });
    }

    const expiresAt = admin.firestore.Timestamp.fromMillis(now + INTENT_TTL_MS);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(intentRef);
      if (!snapshot.exists || snapshot.data().status !== 'CREATING') {
        fail('aborted', 'Payment setup state changed. Please refresh.');
      }
      transaction.update(intentRef, {
        providerOrderId: providerOrder.id,
        status: 'CREATED',
        expiresAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(onlineOrderRef, {
        paymentStatus: 'AWAITING_PAYMENT',
        paymentIntentId: intentRef.id,
        paymentExpiresAt: expiresAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(order.trackingToken), {
        paymentStatus: 'AWAITING_PAYMENT',
        paymentAvailableUntil: expiresAt,
        customerStatusMessage: publicStatusMessage(ACCEPTED_RAZORPAY_STATUS),
      }, { merge: true });
    });
    return paymentIntentResponse({
      providerOrderId: providerOrder.id,
      expectedAmountPaise: amountPaise,
      expectedCurrency: CURRENCY,
      receipt: reservation.receipt,
      status: 'CREATED',
      expiresAt,
    }, order, keyId);
  } catch (error) {
    const safe = safeProviderError(error);
    await intentRef.set({
      status: 'FAILED',
      failureCode: safe.code,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error('razorpay-order-create-failed', {
      onlineOrderHash: sha256(order.id).slice(0, 16),
      storeId: order.storeId,
      failureCode: safe.code,
    });
    fail('unavailable', safe.message);
  }
}

function selectedAddOns(addOns) {
  return (addOns || []).map(addOn => ({
    groupId: cleanText(addOn.groupId, 80),
    optionId: cleanText(addOn.optionId, 80),
    quantity: Number(addOn.quantity),
  }));
}

async function finalizePaidOnlineOrder({
  db,
  admin,
  onlineOrderId,
  intentId,
  providerPayment,
  providerOrder,
}) {
  const onlineOrderRef = db.collection('onlineOrders').doc(onlineOrderId);
  const intentRef = db.collection(PAYMENT_INTENT_COLLECTION).doc(intentId);
  const posOrderId = deterministicPosOrderId(onlineOrderId);
  const posOrderRef = db.collection('orders').doc(posOrderId);

  return db.runTransaction(async transaction => {
    const [onlineOrderSnapshot, intentSnapshot, existingPosOrderSnapshot] = await Promise.all([
      transaction.get(onlineOrderRef),
      transaction.get(intentRef),
      transaction.get(posOrderRef),
    ]);
    if (!onlineOrderSnapshot.exists || !intentSnapshot.exists) fail('not-found', 'Payment order no longer exists.');
    const onlineOrder = { id: onlineOrderSnapshot.id, ...onlineOrderSnapshot.data() };
    const intent = { id: intentSnapshot.id, ...intentSnapshot.data() };

    if (intent.status === PAID_STATUS && existingPosOrderSnapshot.exists) {
      return {
        alreadyFinalized: true,
        orderId: posOrderRef.id,
        orderNumber: existingPosOrderSnapshot.data().orderNumber,
      };
    }
    if (intent.providerOrderId !== providerOrder.id || providerPayment.order_id !== intent.providerOrderId) {
      fail('failed-precondition', 'Provider order does not match this payment intent.');
    }
    const isPaymentFirstAcceptance = ['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS].includes(onlineOrder.status)
      && onlineOrder.paymentStatus === PAID_STATUS;
    if (
      !isPaymentFirstAcceptance
      && !isRazorpayOrderEligible(onlineOrder)
      && onlineOrder.paymentStatus !== 'PAYMENT_PROCESSING'
    ) {
      fail('failed-precondition', 'This Coffee Bond order cannot be finalised.');
    }
    if (existingPosOrderSnapshot.exists) {
      fail('already-exists', 'A POS order already exists for this payment.');
    }

    const storeRef = db.collection('stores').doc(onlineOrder.storeId);
    const gstRef = db.collection('appSettings').doc('gstConfig');
    const [storeSnapshot, gstSnapshot] = await Promise.all([
      transaction.get(storeRef),
      transaction.get(gstRef),
    ]);
    if (!storeSnapshot.exists || storeSnapshot.data().isActive !== true) {
      fail('failed-precondition', 'The selected store is not active.');
    }
    const store = { id: storeSnapshot.id, ...storeSnapshot.data() };
    const finishedGoodRefs = onlineOrder.items.map(item => (
      db.collection('finishedGoods').doc(item.finishedGoodId || item.finishedGoodCode)
    ));
    const finishedGoodSnapshots = await Promise.all(finishedGoodRefs.map(ref => transaction.get(ref)));
    if (finishedGoodSnapshots.some(snapshot => !snapshot.exists)) {
      transaction.update(intentRef, {
        status: REVIEW_STATUS,
        failureCode: 'FINISHED_GOOD_MISSING_AFTER_PAYMENT',
        safeProviderPaymentId: providerPayment.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(onlineOrderRef, {
        status: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        paymentReviewCode: 'FINISHED_GOOD_MISSING_AFTER_PAYMENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(onlineOrder.trackingToken), {
        publicStatus: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        customerStatusMessage: publicStatusMessage(REVIEW_STATUS),
      }, { merge: true });
      return { reviewRequired: true, code: 'FINISHED_GOOD_MISSING_AFTER_PAYMENT' };
    }
    const finishedGoods = finishedGoodSnapshots.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    const groupIds = [...new Set(finishedGoods.flatMap(item => Array.isArray(item.addOnGroupIds) ? item.addOnGroupIds : []))];
    const groupSnapshots = await Promise.all(
      groupIds.map(groupId => transaction.get(db.collection('addOnGroups').doc(groupId))),
    );
    const groupsById = Object.fromEntries(
      groupSnapshots.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { id: snapshot.id, ...snapshot.data() }]),
    );
    const productsById = Object.fromEntries(finishedGoods.map(item => [item.id, item]));
    const lineIds = onlineOrder.items.map((_, index) => deterministicLineId(onlineOrder.id, index));
    const requestedItems = onlineOrder.items.map((item, index) => ({
      orderItemId: lineIds[index],
      parentProductId: finishedGoods[index].id,
      parentProductCode: finishedGoods[index].code,
      quantity: Number(item.quantity),
      selectedAddOns: selectedAddOns(item.addOns),
    }));
    let canonical;
    try {
      canonical = canonicalizeRequestedCart({
        storeId: store.id,
        store,
        gstConfig: gstSnapshot.exists ? gstSnapshot.data() : null,
        requestedItems,
        productsById,
        groupsById,
      });
    } catch {
      transaction.update(intentRef, {
        status: REVIEW_STATUS,
        failureCode: 'MENU_REVALIDATION_FAILED_AFTER_PAYMENT',
        safeProviderPaymentId: providerPayment.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(onlineOrderRef, {
        status: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        paymentReviewCode: 'MENU_REVALIDATION_FAILED_AFTER_PAYMENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(onlineOrder.trackingToken), {
        publicStatus: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        customerStatusMessage: publicStatusMessage(REVIEW_STATUS),
      }, { merge: true });
      return { reviewRequired: true, code: 'MENU_REVALIDATION_FAILED_AFTER_PAYMENT' };
    }

    let calculatedLines = onlineOrder.items.map((storedItem, index) => {
      const item = finishedGoods[index];
      const canonicalItem = canonical.canonicalItems[lineIds[index]];
      const quantity = Number(storedItem.quantity);
      const baseSubtotal = canonicalItem.baseUnitPrice * quantity;
      const addOnSubtotal = canonicalItem.addOnTotal * quantity;
      const lineSubtotal = baseSubtotal + addOnSubtotal;
      const lineTax = canonicalItem.baseUnitPrice * quantity * canonicalItem.taxRate / 100
        + canonicalItem.addOns.reduce((sum, addOn) => (
          sum + addOn.totalPrice * quantity * addOn.taxRate / 100
        ), 0);
      return {
        lineId: lineIds[index],
        finishedGood: item,
        quantity,
        addOns: canonicalItem.addOns,
        addOnTotal: canonicalItem.addOnTotal,
        baseUnitPrice: canonicalItem.baseUnitPrice,
        taxRate: canonicalItem.taxRate,
        lineSubtotal: roundMoney(lineSubtotal),
        lineTaxable: roundMoney(lineSubtotal),
        lineTax: roundMoney(lineTax),
        lineTotal: roundMoney(lineSubtotal + lineTax),
      };
    });
    let pricedCheckout;
    try {
      const requestedRedemptionPoints = Number(onlineOrder.bondRedemptionPoints || 0);
      pricedCheckout = applyBondRedemptionToCheckout({
        checkout: { items: calculatedLines, discount: 0 },
        requestedPoints: requestedRedemptionPoints,
        pointsBalance: requestedRedemptionPoints,
        availablePoints: requestedRedemptionPoints,
        redemptionEnabled: requestedRedemptionPoints > 0,
        channel: 'CUSTOMER_WEB',
      });
      calculatedLines = pricedCheckout.items;
    } catch {
      transaction.update(intentRef, {
        status: REVIEW_STATUS,
        failureCode: 'BOND_REDEMPTION_REVALIDATION_FAILED_AFTER_PAYMENT',
        safeProviderPaymentId: providerPayment.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(onlineOrderRef, {
        status: REVIEW_STATUS,
        paymentStatus: PAID_STATUS,
        paymentReviewCode: 'BOND_REDEMPTION_REVALIDATION_FAILED_AFTER_PAYMENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(onlineOrder.trackingToken), {
        publicStatus: REVIEW_STATUS,
        paymentStatus: PAID_STATUS,
        customerStatusMessage: publicStatusMessage(REVIEW_STATUS),
      }, { merge: true });
      return { reviewRequired: true, code: 'BOND_REDEMPTION_REVALIDATION_FAILED_AFTER_PAYMENT' };
    }
    const totals = {
      subtotal: pricedCheckout.subtotal,
      discount: pricedCheckout.discount,
      taxableAmount: pricedCheckout.taxableAmount,
      gstTotal: pricedCheckout.gstTotal,
      grandTotal: pricedCheckout.grandTotal,
    };
    const canonicalTotalsMatch = [
      ['subtotal', totals.subtotal],
      ['discountAmount', totals.discount],
      ['taxableAmount', totals.taxableAmount],
      ['gstTotal', totals.gstTotal],
      ['grandTotal', totals.grandTotal],
    ].every(([field, expected]) => (
      Math.round(Number(onlineOrder[field] || 0) * 100)
        === Math.round(Number(expected || 0) * 100)
    ));
    if (!canonicalTotalsMatch || rupeesToPaise(totals.grandTotal) !== intent.expectedAmountPaise) {
      transaction.update(intentRef, {
        status: REVIEW_STATUS,
        failureCode: 'CANONICAL_TOTAL_CHANGED_AFTER_PAYMENT',
        safeProviderPaymentId: providerPayment.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(onlineOrderRef, {
        status: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        paymentReviewCode: 'CANONICAL_TOTAL_CHANGED_AFTER_PAYMENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(onlineOrder.trackingToken), {
        publicStatus: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        customerStatusMessage: publicStatusMessage(REVIEW_STATUS),
      }, { merge: true });
      return { reviewRequired: true, code: 'CANONICAL_TOTAL_CHANGED_AFTER_PAYMENT' };
    }

    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterRef = db.collection('counters').doc(`${store.code}_${dateKey}`);
    const counterSnapshot = await transaction.get(counterRef);
    const sequence = counterSnapshot.exists ? Number(counterSnapshot.data().lastSequence || 0) + 1 : 1;
    const orderNumber = `CB-${store.code}-${dateKey}-${String(sequence).padStart(4, '0')}`;
    const acceptedBy = cleanText(onlineOrder.acceptedBy, 128);
    const acceptedByName = cleanText(onlineOrder.acceptedByName, 120);
    if (!acceptedBy || !acceptedByName) {
      fail('failed-precondition', 'Staff acceptance is required before operational fulfilment.');
    }
    const inventoryPlan = await planOnlineOrderInventory({
      transaction,
      db,
      admin,
      store,
      orderId: posOrderId,
      orderNumber,
      orderType: toOrderType(onlineOrder),
      businessDate: dateKey,
      staff: { uid: acceptedBy, name: acceptedByName },
      lines: calculatedLines.map(line => ({
        lineKey: line.lineId,
        quantity: line.quantity,
        finishedGood: line.finishedGood,
        addOns: line.addOns,
      })),
      requireAvailableStock: true,
    });
    if (inventoryPlan.blockers.length > 0) {
      const blockerCode = inventoryPlan.blockers.map(blocker => blocker.blockerType).join('|').slice(0, 240);
      transaction.update(intentRef, {
        status: PAID_STATUS,
        failureCode: `INVENTORY_${blockerCode}`,
        safeProviderPaymentId: providerPayment.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(onlineOrderRef, {
        status: REVIEW_STATUS,
        paymentStatus: PAID_STATUS,
        paymentReviewCode: `INVENTORY_${blockerCode}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(onlineOrder.trackingToken), {
        publicStatus: REVIEW_STATUS,
        paymentStatus: PAID_STATUS,
        customerStatusMessage: publicStatusMessage(REVIEW_STATUS),
      }, { merge: true });
      return { reviewRequired: true, code: 'INVENTORY_REVALIDATION_FAILED_AFTER_PAYMENT' };
    }

    inventoryPlan.stockUpdates.forEach(update => {
      if (update.existed) {
        transaction.update(update.ref, {
          currentStock: update.newQty,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        transaction.set(update.ref, {
          ...update.seedData,
          currentStock: update.newQty,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
    inventoryPlan.movementPayloads.forEach((movement, index) => {
      transaction.create(
        db.collection('stockMovements').doc(`${posOrderId}_SALE_${String(index + 1).padStart(3, '0')}`),
        movement,
      );
    });
    inventoryPlan.pendingConsumptionPayloads.forEach(payload => {
      transaction.set(db.collection('pendingInventoryConsumption').doc(payload.idempotencyKey), payload, { merge: true });
    });
    if (counterSnapshot.exists) {
      transaction.update(counterRef, { lastSequence: sequence, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      transaction.set(counterRef, {
        storeCode: store.code,
        dateKey,
        lastSequence: sequence,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const customerId = `WEB_${sha256(`${onlineOrder.id}:${normalizePhone(onlineOrder.customerPhone)}`).slice(0, 32)}`;
    transaction.set(db.collection('customers').doc(customerId), {
      name: cleanText(onlineOrder.customerName, 80) || 'Online Guest',
      phone: normalizePhone(onlineOrder.customerPhone),
      visitCount: 1,
      totalSpend: totals.grandTotal,
      lastVisitAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const tender = providerMethod(providerPayment.method);
    transaction.create(posOrderRef, {
      orderNumber,
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      customerId,
      customerName: cleanText(onlineOrder.customerName, 80) || 'Online Guest',
      customerPhone: normalizePhone(onlineOrder.customerPhone) || null,
      createdByUserId: acceptedBy,
      createdByName: acceptedByName,
      orderType: toOrderType(onlineOrder),
      status: 'COMPLETED',
      paymentStatus: PAID_STATUS,
      tableNumber: onlineOrder.orderType === 'DINE_IN' ? cleanText(onlineOrder.tableNumber, 20) || 'ONLINE' : null,
      subtotal: totals.subtotal,
      taxTotal: totals.gstTotal,
      gstTotal: totals.gstTotal,
      taxableAmount: totals.taxableAmount,
      discountPercent: totals.subtotal > 0
        ? roundMoney((totals.discount / totals.subtotal) * 100)
        : 0,
      discountAmount: totals.discount,
      discountTotal: totals.discount,
      discount: totals.discount,
      discountReason: totals.discount > 0 ? BOND_REDEMPTION_POLICY.label : null,
      discountLabel: totals.discount > 0 ? BOND_REDEMPTION_POLICY.label : null,
      discountSource: totals.discount > 0 ? 'BOND_REDEMPTION' : null,
      bondRedemptionPoints: Number(onlineOrder.bondRedemptionPoints || 0),
      bondRedemptionDiscount: totals.discount,
      pointFundedAmount: totals.discount,
      bondRedemptionPolicyVersion: onlineOrder.bondRedemptionPolicyVersion || null,
      grandTotal: totals.grandTotal,
      cogsTotal: inventoryPlan.totalCogs,
      inventoryWarningCount: inventoryPlan.warnings.length,
      inventoryWarnings: inventoryPlan.warnings.map(warning => warning.message),
      inventoryConsumptionStatus: inventoryPlan.pendingConsumptionPayloads.length > 0 ? 'PENDING_BOM' : 'APPLIED',
      stockMovementCount: inventoryPlan.movementPayloads.length,
      paymentMethod: 'ONLINE',
      paymentMethodLabel: `RAZORPAY ${tender}`,
      paymentProvider: PROVIDER,
      providerMethod: tender,
      isSplitPayment: false,
      paymentBreakdown: [{
        method: 'ONLINE',
        provider: PROVIDER,
        providerMethod: tender,
        amount: totals.grandTotal,
      }],
      addOnTotal: canonical.canonicalAddOnTotal,
      source: 'CUSTOMER_WEB',
      onlineOrderId: onlineOrder.id,
      onlineOrderTrackingToken: onlineOrder.trackingToken,
      onlineOrderReference: onlineOrder.publicOrderReference,
      notes: cleanText(onlineOrder.notes, 200),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    let kotCount = 0;
    calculatedLines.forEach(line => {
      const station = normalizePrepStation(line.finishedGood.prepStation);
      const itemRef = posOrderRef.collection('items').doc(line.lineId);
      transaction.create(itemRef, {
        menuItemId: line.finishedGood.code,
        itemName: line.finishedGood.displayName || line.finishedGood.name,
        itemCode: line.finishedGood.code,
        categoryId: line.finishedGood.posCategoryCode || 'MISC',
        categoryName: line.finishedGood.posCategoryName || 'Misc',
        quantity: line.quantity,
        unitPrice: line.baseUnitPrice,
        baseUnitPrice: line.baseUnitPrice,
        addOns: line.addOns,
        addOnTotal: line.addOnTotal,
        unitPriceWithAddOns: line.baseUnitPrice + line.addOnTotal,
        taxRate: line.taxRate,
        lineSubtotal: line.lineSubtotal,
        lineDiscount: line.lineDiscount,
        lineTaxable: line.lineTaxable,
        lineTax: line.lineTax,
        lineTotal: line.lineTotal,
        cogsAmount: inventoryPlan.perLineCogs[line.lineId] || 0,
        inventoryConsumptionStatus: inventoryPlan.perLineConsumptionStatus[line.lineId] || 'APPLIED',
        prepStation: station,
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sourceSystem: 'FINISHED_GOODS',
        finishedGoodCode: line.finishedGood.code,
        itemType: line.finishedGood.itemType,
      });
      const createKot = kotStation => {
        kotCount += 1;
        transaction.create(db.collection('kotItems').doc(`${posOrderId}_${line.lineId}_${kotStation}`), {
          orderId: posOrderId,
          orderNumber,
          orderItemId: line.lineId,
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
          station: kotStation,
          itemName: line.finishedGood.displayName || line.finishedGood.name,
          itemCode: line.finishedGood.code,
          quantity: line.quantity,
          addOns: line.addOns,
          orderType: toOrderType(onlineOrder),
          tableNumber: onlineOrder.orderType === 'DINE_IN' ? cleanText(onlineOrder.tableNumber, 20) || 'ONLINE' : null,
          customerName: cleanText(onlineOrder.customerName, 80) || 'Online Guest',
          onlineOrderId: onlineOrder.id,
          onlineOrderTrackingToken: onlineOrder.trackingToken,
          onlineOrderReference: onlineOrder.publicOrderReference,
          status: 'PENDING',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUserId: acceptedBy,
          createdByName: acceptedByName,
        });
      };
      if (station === 'BARISTA' || station === 'BOTH') createKot('BARISTA');
      if (station === 'KITCHEN' || station === 'BOTH') createKot('KITCHEN');
    });

    transaction.create(posOrderRef.collection('payments').doc('razorpay'), {
      method: 'ONLINE',
      provider: PROVIDER,
      providerMethod: tender,
      providerPaymentId: providerPayment.id,
      providerOrderId: providerOrder.id,
      amount: totals.grandTotal,
      status: 'CAPTURED',
      currency: CURRENCY,
      verifiedServerSide: true,
      source: 'CUSTOMER_WEB',
      onlineOrderId: onlineOrder.id,
      storeId: store.id,
      orderId: posOrderId,
      reference: providerPayment.id,
      paymentIndex: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
      settledBy: 'RAZORPAY_GATEWAY',
      settledByName: 'Razorpay',
    });
    transaction.update(intentRef, {
      status: PAID_STATUS,
      coffeeBondPosOrderId: posOrderId,
      safeProviderPaymentId: providerPayment.id,
      providerMethod: tender,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      failureCode: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    transaction.update(onlineOrderRef, {
      status: 'CONVERTED',
      paymentStatus: PAID_STATUS,
      linkedOrderId: posOrderId,
      linkedOrderNumber: orderNumber,
      providerPaymentId: providerPayment.id,
      providerOrderId: providerOrder.id,
      providerMethod: tender,
      customerStatusMessage: publicStatusMessage('CONVERTED'),
      convertedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    transaction.set(db.collection('publicOrderTracking').doc(onlineOrder.trackingToken), {
      publicStatus: 'CONVERTED',
      paymentStatus: PAID_STATUS,
      publicOrderNumber: orderNumber,
      customerStatusMessage: publicStatusMessage('CONVERTED'),
      acceptedAt: onlineOrder.acceptedAt || admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (onlineOrder.addOnAuthorizationId) {
      transaction.set(db.collection('posAddOnAuthorizations').doc(onlineOrder.addOnAuthorizationId), {
        used: true,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
        orderNumber,
      }, { merge: true });
    }
    return {
      alreadyFinalized: false,
      reviewRequired: false,
      orderId: posOrderId,
      orderNumber,
      kotCount,
      stockMovementCount: inventoryPlan.movementPayloads.length,
    };
  });
}

async function verifyAndFinalize({
  db,
  admin,
  onlineOrder,
  intent,
  paymentId,
  client,
}) {
  let payment;
  let providerOrder;
  try {
    [payment, providerOrder] = await Promise.all([
      client.payments.fetch(paymentId),
      client.orders.fetch(intent.providerOrderId),
    ]);
  } catch (error) {
    const safe = safeProviderError(error);
    console.error('razorpay-provider-verify-failed', {
      intentId: intent.id,
      storeId: intent.storeId,
      failureCode: safe.code,
    });
    fail('unavailable', 'Payment confirmation is delayed. Please refresh shortly.');
  }
  const finalState = isFinalProviderState({
    payment,
    providerOrder,
    expectedOrderId: intent.providerOrderId,
    expectedAmountPaise: intent.expectedAmountPaise,
  });
  if (!finalState.valid) {
    await db.collection(PAYMENT_INTENT_COLLECTION).doc(intent.id).set({
      status: payment?.status === 'failed' ? 'FAILED' : 'VERIFYING',
      failureCode: finalState.code,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (payment?.status === 'failed') {
      await Promise.all([
        db.collection('onlineOrders').doc(onlineOrder.id).set({
          paymentStatus: 'FAILED',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }),
        db.collection('publicOrderTracking').doc(onlineOrder.trackingToken).set({
          paymentStatus: 'FAILED',
          customerStatusMessage: publicStatusMessage('PAYMENT_FAILED'),
        }, { merge: true }),
      ]);
    }
    fail('failed-precondition', 'Payment is not captured and paid yet.');
  }
  try {
    return await finalizePaidOnlineOrder({
      db,
      admin,
      onlineOrderId: onlineOrder.id,
      intentId: intent.id,
      providerPayment: payment,
      providerOrder,
    });
  } catch (error) {
    const reviewCode = 'OPERATIONAL_FINALISATION_FAILED_AFTER_PAYMENT';
    await Promise.all([
      db.collection(PAYMENT_INTENT_COLLECTION).doc(intent.id).set({
        status: REVIEW_STATUS,
        failureCode: reviewCode,
        safeProviderPaymentId: payment.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }),
      db.collection('onlineOrders').doc(onlineOrder.id).set({
        status: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        paymentReviewCode: reviewCode,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }),
      db.collection('publicOrderTracking').doc(onlineOrder.trackingToken).set({
        publicStatus: REVIEW_STATUS,
        paymentStatus: REVIEW_STATUS,
        customerStatusMessage: publicStatusMessage(REVIEW_STATUS),
      }, { merge: true }),
    ]);
    console.error('razorpay-operational-finalisation-failed', {
      intentId: intent.id,
      storeId: intent.storeId,
      failureCode: reviewCode,
    });
    return { reviewRequired: true, code: reviewCode };
  }
}

async function resolveWebhookPaymentId({ client, eventPaymentId, providerOrderId }) {
  const directPaymentId = cleanText(eventPaymentId, 120);
  if (directPaymentId) return directPaymentId;
  const response = await client.orders.fetchPayments(providerOrderId);
  const payments = Array.isArray(response?.items) ? response.items : [];
  const captured = payments.find(payment => (
    payment?.order_id === providerOrderId
    && payment?.status === 'captured'
    && cleanText(payment?.id, 120)
  ));
  return cleanText(captured?.id, 120) || null;
}

function createRazorpayCheckoutFunctions({
  admin,
  db,
  region,
  RazorpayClass = Razorpay,
  keyIdParameter = RAZORPAY_KEY_ID,
  keySecretParameter = RAZORPAY_KEY_SECRET,
  webhookSecretParameter = RAZORPAY_WEBHOOK_SECRET,
}) {
  const createRazorpayOrder = onCall({
    region,
    timeoutSeconds: 60,
    memory: '512MiB',
    secrets: [keySecretParameter],
  }, async request => {
    const { ref, order } = await resolveOnlineOrderByTracking({
      db,
      trackingToken: request.data?.trackingToken,
      publicOrderReference: request.data?.publicOrderReference,
    });
    return createProviderOrder({
      db,
      admin,
      onlineOrderRef: ref,
      order,
      keyId: cleanText(keyIdParameter.value(), 120),
      keySecret: keySecretParameter.value(),
      RazorpayClass,
    });
  });

  const verifyRazorpayPayment = onCall({
    region,
    timeoutSeconds: 180,
    memory: '1GiB',
    secrets: [keySecretParameter],
  }, async request => {
    const paymentId = cleanText(request.data?.razorpay_payment_id, 120);
    const suppliedOrderId = cleanText(request.data?.razorpay_order_id, 120);
    const signature = cleanText(request.data?.razorpay_signature, 256);
    if (!paymentId || !suppliedOrderId || !signature) {
      fail('invalid-argument', 'Payment confirmation details are incomplete.');
    }
    const { order } = await resolveOnlineOrderByTracking({
      db,
      trackingToken: request.data?.trackingToken,
      publicOrderReference: request.data?.publicOrderReference,
    });
    const intentRef = db.collection(PAYMENT_INTENT_COLLECTION).doc(deterministicIntentId(order.id));
    const intentSnapshot = await intentRef.get();
    if (!intentSnapshot.exists) fail('failed-precondition', 'Payment intent was not found.');
    const intent = { id: intentSnapshot.id, ...intentSnapshot.data() };
    if (intent.status === PAID_STATUS && intent.coffeeBondPosOrderId) {
      return {
        alreadyFinalized: true,
        orderId: intent.coffeeBondPosOrderId,
        orderNumber: order.linkedOrderNumber || null,
      };
    }
    if (suppliedOrderId !== intent.providerOrderId) {
      fail('permission-denied', 'Payment order does not match.');
    }
    if (!verifyCheckoutSignature({
      storedOrderId: intent.providerOrderId,
      paymentId,
      signature,
      keySecret: keySecretParameter.value(),
    })) {
      await intentRef.set({
        failureCode: 'SIGNATURE_MISMATCH',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      fail('permission-denied', 'Payment signature could not be verified.');
    }
    await Promise.all([
      intentRef.set({
        status: 'VERIFYING',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }),
      db.collection('onlineOrders').doc(order.id).set({
        paymentStatus: 'PAYMENT_PROCESSING',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }),
      db.collection('publicOrderTracking').doc(order.trackingToken).set({
        paymentStatus: 'PAYMENT_PROCESSING',
        customerStatusMessage: publicStatusMessage('PAYMENT_PROCESSING'),
      }, { merge: true }),
    ]);
    const client = razorpayClient(
      cleanText(keyIdParameter.value(), 120),
      keySecretParameter.value(),
      RazorpayClass,
    );
    return verifyAndFinalize({ db, admin, onlineOrder: order, intent, paymentId, client });
  });

  const razorpayWebhook = onRequest({
    region,
    timeoutSeconds: 180,
    memory: '1GiB',
    secrets: [keySecretParameter, webhookSecretParameter],
  }, async (request, response) => {
    const rawBody = request.rawBody;
    const signature = request.get('x-razorpay-signature');
    if (!verifyWebhookSignature({
      rawBody,
      signature,
      webhookSecret: webhookSecretParameter.value(),
    })) {
      response.status(400).send('Invalid webhook signature.');
      return;
    }

    const event = request.body || {};
    const eventName = cleanText(event.event, 80);
    const eventId = cleanText(request.get('x-razorpay-event-id'), 160)
      || `evt_${sha256(rawBody).slice(0, 48)}`;
    const auditRef = db.collection(WEBHOOK_AUDIT_COLLECTION).doc(eventId.replace(/[^A-Za-z0-9_-]/g, '_'));
    const auditSnapshot = await auditRef.get();
    if (auditSnapshot.exists && auditSnapshot.data().status === 'PROCESSED') {
      response.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const paymentEntity = event.payload?.payment?.entity || null;
    const orderEntity = event.payload?.order?.entity || null;
    const providerOrderId = cleanText(paymentEntity?.order_id || orderEntity?.id, 120);
    const providerPaymentId = cleanText(paymentEntity?.id, 120);
    await auditRef.set({
      eventId,
      eventName,
      provider: PROVIDER,
      providerOrderId: providerOrderId || null,
      safeProviderPaymentId: providerPaymentId || null,
      status: 'PROCESSING',
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    if (!['payment.captured', 'payment.failed', 'order.paid'].includes(eventName)) {
      await auditRef.set({
        status: 'PROCESSED',
        outcome: 'IGNORED_UNSUPPORTED_EVENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, ignored: true });
      return;
    }
    if (!providerOrderId) {
      await auditRef.set({
        status: 'FAILED',
        outcome: 'MISSING_PROVIDER_ORDER_ID',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, reviewRequired: true });
      return;
    }

    const intentQuery = await db.collection(PAYMENT_INTENT_COLLECTION)
      .where('providerOrderId', '==', providerOrderId)
      .limit(2)
      .get();
    if (intentQuery.size !== 1) {
      await auditRef.set({
        status: 'FAILED',
        outcome: 'PAYMENT_INTENT_NOT_FOUND',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, reviewRequired: true });
      return;
    }
    const intentSnapshot = intentQuery.docs[0];
    const intent = { id: intentSnapshot.id, ...intentSnapshot.data() };
    const onlineOrderSnapshot = await db.collection('onlineOrders').doc(intent.coffeeBondOnlineOrderId).get();
    if (!onlineOrderSnapshot.exists) {
      await auditRef.set({
        status: 'FAILED',
        outcome: 'ONLINE_ORDER_NOT_FOUND',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, reviewRequired: true });
      return;
    }
    const onlineOrder = { id: onlineOrderSnapshot.id, ...onlineOrderSnapshot.data() };

    if (eventName === 'payment.failed') {
      if (intent.status !== PAID_STATUS) {
        await Promise.all([
          intentSnapshot.ref.set({
            status: 'FAILED',
            failureCode: 'PROVIDER_PAYMENT_FAILED',
            safeProviderPaymentId: providerPaymentId || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true }),
          onlineOrderSnapshot.ref.set({
            paymentStatus: 'FAILED',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true }),
          db.collection('publicOrderTracking').doc(onlineOrder.trackingToken).set({
            paymentStatus: 'FAILED',
            customerStatusMessage: publicStatusMessage('PAYMENT_FAILED'),
          }, { merge: true }),
        ]);
      }
      await auditRef.set({
        status: 'PROCESSED',
        outcome: 'PAYMENT_FAILED_RECORDED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true });
      return;
    }

    const client = razorpayClient(
      cleanText(keyIdParameter.value(), 120),
      keySecretParameter.value(),
      RazorpayClass,
    );
    let paymentId;
    try {
      paymentId = await resolveWebhookPaymentId({
        client,
        eventPaymentId: providerPaymentId,
        providerOrderId,
      });
    } catch (error) {
      console.error('razorpay-webhook-payment-lookup-failed', {
        eventId,
        eventName,
        intentId: intent.id,
        errorCode: safeProviderError(error).code,
      });
    }
    if (!paymentId) {
      await auditRef.set({
        status: 'FAILED',
        outcome: 'PAYMENT_ID_NOT_AVAILABLE',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, retry: true });
      return;
    }
    try {
      const result = await verifyAndFinalize({ db, admin, onlineOrder, intent, paymentId, client });
      await auditRef.set({
        status: 'PROCESSED',
        outcome: result.reviewRequired ? REVIEW_STATUS : PAID_STATUS,
        coffeeBondPosOrderId: result.orderId || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, reviewRequired: Boolean(result.reviewRequired) });
    } catch (error) {
      console.error('razorpay-webhook-processing-failed', {
        eventId,
        eventName,
        intentId: intent.id,
        errorCode: cleanText(error?.code || error?.message, 120),
      });
      await auditRef.set({
        status: 'FAILED',
        outcome: 'PROVIDER_VERIFICATION_OR_FINALISATION_FAILED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(500).json({ ok: false });
    }
  });

  return {
    createRazorpayOrder,
    razorpayWebhook,
    verifyRazorpayPayment,
  };
}

module.exports = {
  PAYMENT_EXPIRY_MINUTES,
  PAYMENT_INTENT_COLLECTION,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  WEBHOOK_AUDIT_COLLECTION,
  createProviderOrder,
  createRazorpayCheckoutFunctions,
  finalizePaidOnlineOrder,
  publicStatusMessage,
  resolveOnlineOrderByTracking,
  resolveWebhookPaymentId,
  razorpayClient,
  verifyAndFinalize,
};
