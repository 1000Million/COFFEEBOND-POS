'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isAuthorizedStaffProfile, isAuthorizedStaffForStorePair } = require('./complimentaryAuthorizationPolicy');
const { assertSavedFinancials, assertLegacySplitAllocation } = require('./posCheckoutSettlement');
const { contentDigest, documentId } = require('./posCheckoutFinancials');
const { deterministicRefundId } = require('./posRazorpay');
const { plain } = require('./posCheckoutCommit');
const { buildPaymentReversalAudit, buildRazorpayRefundAudit, buildVoidStockReversal, deterministicVoidReversalMovementId, planVoidStockBalances } = require('./posVoidPolicies.cjs');

const fail = (code, message) => { throw new HttpsError(code, message); };
const same = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.010000001;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const keysEqual = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const MANUAL = new Set(['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO']);
function normalizeVoid(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['orderId', 'reason', 'confirmation', 'operationId'].includes(key))) fail('invalid-argument', 'Unsupported void request fields.');
  try { documentId(data.orderId, 'order identity'); documentId(data.operationId, 'void identity'); }
  catch (error) { fail('invalid-argument', error.message); }
  if (typeof data.reason !== 'string' || !data.reason.trim() || data.reason.length > 500 || data.confirmation !== 'VOID ORDER') fail('invalid-argument', 'A void reason and VOID ORDER confirmation are required.');
  return { orderId: data.orderId, operationId: data.operationId, reason: data.reason.trim(), confirmation: data.confirmation };
}

function assertVoidMoney({ order, items, payments, authorization, settlementOperations }) {
  assertSavedFinancials(order, items);
  const complimentary = order.commercialStatus === 'COMPLIMENTARY' || order.paymentMethod === 'COMPLIMENTARY';
  if (complimentary && (order.paymentStatus !== 'NOT_REQUIRED' || order.grandTotal !== 0 || order.gstTotal !== 0 || order.taxableAmount !== 0 || payments.length)) fail('failed-precondition', 'Saved complimentary records require review before voiding.');
  const plan = authorization?.financials;
  let validatedInitialAllocation = false;
  if (settlementOperations.length > 1) fail('failed-precondition', 'Saved settlement history requires review.');
  if (settlementOperations.length) {
    const operation = settlementOperations[0];
    if (operation.orderId !== order.id || operation.result?.orderId !== order.id || operation.result?.paymentStatus !== 'PAID' || !Array.isArray(operation.result?.payments) || order.paymentStatus !== 'PAID') fail('failed-precondition', 'Saved settlement result is inconsistent.');
    for (const expected of operation.result.payments) {
      const matches = payments.filter(payment => payment.id === expected.id);
      if (matches.length !== 1 || matches[0].method !== expected.method || matches[0].amount !== expected.amount) fail('failed-precondition', 'Saved settled collections require review.');
    }
  }
  if (order.financialAuthorizationVersion !== undefined || plan) {
    if (order.financialAuthorizationVersion !== 3 || plan?.version !== 3 || authorization.orderId !== order.id || authorization.storeId !== order.storeId || authorization.provider !== 'SERVER_CANONICAL_ADD_ONS' || authorization.used !== true || !Array.isArray(plan.itemIds) || !Array.isArray(plan.paymentIds) || !keysEqual(items.map(item => item.id), plan.itemIds)) fail('failed-precondition', 'Saved void financial plan membership is inconsistent.');
    for (const key of ['subtotal', 'discountPercent', 'discountAmount', 'taxableAmount', 'taxTotal', 'grandTotal']) {
      if (order[key] !== plan[key]) fail('failed-precondition', 'Saved sale differs from its trusted financial plan.');
    }
    for (const key of ['discountTotal', 'discount']) if (order[key] !== plan.discountAmount) fail('failed-precondition', 'Saved discount aliases differ from the trusted financial plan.');
    if (order.gstTotal !== (plan.gstTotal ?? plan.taxTotal)) fail('failed-precondition', 'Saved GST differs from the trusted financial plan.');
    if (order.commercialStatus !== plan.commercialStatus) fail('failed-precondition', 'Saved commercial status differs from the trusted financial plan.');
    if (!settlementOperations.length) {
      if (order.paymentStatus !== plan.paymentStatus || order.paymentMethod !== plan.paymentMethod || (order.isSplitPayment === true) !== plan.isSplitPayment) fail('failed-precondition', 'Saved tender status differs from the trusted financial plan.');
      validatedInitialAllocation = true;
    }
    for (const item of items) for (const key of ['lineSubtotal', 'lineDiscount', 'lineTaxable', 'lineTax', 'lineTotal']) {
      if (!plan.lines?.[item.id] || item[key] !== plan.lines[item.id][key]) fail('failed-precondition', 'Saved item differs from its trusted financial plan.');
    }
    const expected = new Map(plan.paymentIds.map(paymentId => [paymentId, { ...plan.payments[paymentId] }]));
    if (settlementOperations.length) {
      const operation = settlementOperations[0];
      if (operation.orderId !== order.id || operation.result?.orderId !== order.id || operation.result?.paymentStatus !== 'PAID' || !Array.isArray(operation.result?.payments) || order.paymentStatus !== 'PAID') fail('failed-precondition', 'Saved settlement result is inconsistent.');
      for (const payment of operation.result.payments) {
        if (expected.has(payment.id) || !MANUAL.has(payment.method) || !finite(payment.amount) || payment.amount <= 0) fail('failed-precondition', 'Saved settlement tender identity is inconsistent.');
        expected.set(payment.id, payment);
      }
    }
    if (!keysEqual(payments.map(payment => payment.id), expected.keys())) fail('failed-precondition', 'Saved payment membership differs from its trusted lifecycle.');
    for (const payment of payments) {
      const match = expected.get(payment.id);
      if (!match || match.method !== payment.method || match.amount !== payment.amount) fail('failed-precondition', 'Saved payment differs from its trusted lifecycle.');
    }
  } else if (!settlementOperations.length && order.isSplitPayment === true) {
    // Historical split records have no server plan. Preserve their established
    // complete-allocation/credit-status contract after saved-money reconciliation.
    assertLegacySplitAllocation(payments, order);
    validatedInitialAllocation = true;
  }
  let collected = 0; let credit = 0;
  for (const payment of payments) {
    if (!finite(payment.amount) || (!MANUAL.has(payment.method) && !['CREDIT', 'PAY_AT_COUNTER', 'RAZORPAY', 'ONLINE'].includes(payment.method))) fail('failed-precondition', 'Saved payment records require review before voiding.');
    if (payment.method === 'PAY_AT_COUNTER') { if (payment.amount !== 0) fail('failed-precondition', 'Saved counter placeholder has a collection amount.'); }
    else if (payment.method === 'CREDIT') credit += payment.amount;
    else collected += payment.amount;
  }
  if (!complimentary && !validatedInitialAllocation) {
    if (order.paymentStatus === 'PAID' && (!same(collected, order.grandTotal) || (credit > 0.010000001 && settlementOperations.length !== 1))) fail('failed-precondition', 'Saved paid collections do not match the payable.');
    if (order.paymentStatus === 'UNPAID' && collected > 0.010000001) fail('failed-precondition', 'Saved unpaid collections require review.');
    if (order.paymentStatus === 'PARTIAL' && (collected <= 0 || collected >= order.grandTotal - 0.010000001 || !same(collected + credit, order.grandTotal))) fail('failed-precondition', 'Saved partial allocation requires review.');
    if (!['PAID', 'UNPAID', 'PARTIAL'].includes(order.paymentStatus)) fail('failed-precondition', 'Saved payment status cannot be voided here.');
  }
  const auditPayments = order.paymentStatus === 'PAID' && settlementOperations.length === 1
    ? payments.filter(payment => !['CREDIT', 'PAY_AT_COUNTER'].includes(payment.method))
    : payments;
  return { complimentary, auditPayments };
}

function assertCapturedRefund(order, payments, refund) {
  const payment = payments.length === 1 ? payments[0] : null;
  const paymentId = payment?.razorpayPaymentId || payment?.providerPaymentId;
  if (!payment || payment.provider !== 'RAZORPAY' || payment.status !== 'CAPTURED' || payment.verifiedServerSide !== true || !paymentId || !same(payment.amount, order.grandTotal) || payment.currency !== 'INR' || !refund || refund.workflow !== 'POS_IN_STORE' || refund.orderId !== order.id || refund.storeId !== order.storeId || refund.provider !== 'RAZORPAY' || refund.paymentDocumentId !== payment.id || refund.providerPaymentId !== paymentId || refund.amountPaise !== Math.round(order.grandTotal * 100) || refund.currency !== 'INR' || !refund.providerRefundId || !['REFUND_PENDING', 'REFUNDED'].includes(refund.status)) fail('failed-precondition', 'The server-verified full Razorpay refund must be recorded before voiding.');
  return refund.status;
}

async function voidPosCheckout({ admin, db, request }) {
  const uid = request.auth?.uid;
  if (!uid) fail('unauthenticated', 'Staff sign-in is required.');
  const input = normalizeVoid(request.data);
  const requestHash = contentDigest({ staffUid: uid, ...input });
  const operationRef = db.collection('posVoidOperations').doc(contentDigest([input.orderId, input.operationId]));
  const orderRef = db.collection('orders').doc(input.orderId);
  const result = await db.runTransaction(async transaction => {
    const [staffSnapshot, orderSnapshot, operationSnapshot] = await Promise.all([transaction.get(db.collection('users').doc(uid)), transaction.get(orderRef), transaction.get(operationRef)]);
    if (!orderSnapshot.exists) fail('not-found', 'Order no longer exists.');
    const order = { ...orderSnapshot.data(), id: orderSnapshot.id };
    const profile = staffSnapshot.exists ? staffSnapshot.data() : null;
    if (!['ADMIN', 'STORE_MANAGER'].includes(profile?.role) || !isAuthorizedStaffProfile(profile, order.storeId)) fail('permission-denied', 'Only an active assigned Admin or Store Manager can void this sale.');
    if (order.tableSessionId || input.orderId.startsWith('TABLE_')) fail('failed-precondition', 'Table orders use their existing secured table lifecycle.');
    if (operationSnapshot.exists) {
      const operation = operationSnapshot.data();
      if (operation.requestHash !== requestHash || operation.staffUid !== uid || operation.orderId !== input.orderId || order.status !== 'VOIDED' || order.voidOperationId !== input.operationId || order.voidRequestHash !== requestHash) fail('already-exists', 'Void retry conflict: this operation has different content.');
      return { ...operation.result, replayed: true };
    }
    if (order.status !== 'COMPLETED') fail('failed-precondition', 'This sale is already voided or is not eligible for voiding.');
    const [storeSnapshot, itemsSnapshot, paymentsSnapshot, movementSnapshot, kotSnapshot, pendingSnapshot, authorizationSnapshot, settlementSnapshot] = await Promise.all([
      transaction.get(db.collection('stores').doc(order.storeId)), transaction.get(orderRef.collection('items')), transaction.get(orderRef.collection('payments')),
      transaction.get(db.collection('stockMovements').where('referenceId', '==', input.orderId)), transaction.get(db.collection('kotItems').where('orderId', '==', input.orderId)),
      transaction.get(db.collection('pendingInventoryConsumption').where('orderId', '==', input.orderId)),
      order.addOnAuthorizationId ? transaction.get(db.collection('posAddOnAuthorizations').doc(order.addOnAuthorizationId)) : Promise.resolve(null),
      transaction.get(db.collection('posSettlementOperations').where('orderId', '==', input.orderId)),
    ]);
    if (!storeSnapshot.exists) fail('failed-precondition', 'The saved sales store no longer exists.');
    const store = { ...storeSnapshot.data(), id: storeSnapshot.id };
    const items = itemsSnapshot.docs.map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
    const payments = paymentsSnapshot.docs.map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
    const { complimentary, auditPayments } = assertVoidMoney({ order, items, payments, authorization: authorizationSnapshot?.exists ? authorizationSnapshot.data() : null, settlementOperations: settlementSnapshot.docs.map(snapshot => snapshot.data()) });
    const movements = movementSnapshot.docs.map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
    if (movements.some(movement => movement.movementType === 'ORDER_VOID_REVERSAL')) fail('failed-precondition', 'This sale already has stock reversal records.');
    const saleMovements = movements.filter(movement => ['SALE_DEDUCTION', 'ORDER_BOM_BACKFILL'].includes(movement.movementType));
    const targets = saleMovements.map(movement => {
      if ((movement.orderId && movement.orderId !== order.id) || (movement.referenceType && movement.referenceType !== 'ORDER') || !Number.isFinite(movement.quantity) || movement.quantity >= 0 || !movement.storeId || (movement.inventoryStoreId && movement.inventoryStoreId !== movement.storeId) || (movement.logicalSalesStoreId && movement.logicalSalesStoreId !== order.storeId) || (!movement.logicalSalesStoreId && movement.storeId !== order.storeId)) fail('failed-precondition', 'An original stock movement has invalid sale attribution.');
      const type = String(movement.stockItemType || 'RAW_INGREDIENT');
      const code = String(movement.stockItemCode || movement.inventoryItemId || '');
      if (!code || !['RAW_INGREDIENT', 'PREP_ITEM', 'FINISHED_GOOD', 'PACKAGING', 'BOUGHT_COMPONENT'].includes(type)) fail('failed-precondition', 'An original stock movement is missing its stock identity.');
      if (!isAuthorizedStaffForStorePair(profile, order.storeId, movement.storeId)) fail('permission-denied', 'Voiding requires access to every original physical inventory store.');
      return { movement, stockRef: db.collection('storeStock').doc(`${movement.storeId}_${type}_${code}`), reversalRef: db.collection('stockMovements').doc(deterministicVoidReversalMovementId(movement.id)) };
    });
    if (new Set(targets.map(target => target.reversalRef.path)).size !== targets.length) fail('failed-precondition', 'Original reversal identities collide.');
    const physicalIds = [...new Set(targets.map(target => target.movement.storeId))];
    const [stockSnapshots, reversalSnapshots, physicalStores] = await Promise.all([
      Promise.all(targets.map(target => transaction.get(target.stockRef))), Promise.all(targets.map(target => transaction.get(target.reversalRef))), Promise.all(physicalIds.map(id => transaction.get(db.collection('stores').doc(id)))),
    ]);
    if (stockSnapshots.some(snapshot => !snapshot.exists) || physicalStores.some(snapshot => !snapshot.exists) || reversalSnapshots.some(snapshot => snapshot.exists)) fail('failed-precondition', 'Original stock balance or reversal state requires review.');
    const physicalById = new Map(physicalStores.map(snapshot => [snapshot.id, { ...snapshot.data(), id: snapshot.id }]));
    const balances = planVoidStockBalances(targets.map((target, index) => ({ stockKey: target.stockRef.path, currentStock: Number(stockSnapshots[index].data().currentStock), reversalQuantity: Math.abs(target.movement.quantity) })));
    for (const snapshot of kotSnapshot.docs) if (snapshot.data().storeId !== order.storeId || snapshot.data().tableSessionId) fail('failed-precondition', 'KOT sale attribution requires review.');
    for (const snapshot of pendingSnapshot.docs) if (!isAuthorizedStaffForStorePair(profile, order.storeId, snapshot.data().inventoryStoreId || snapshot.data().storeId) || snapshot.data().tableSessionId) fail('permission-denied', 'Pending inventory store access is required.');
    const capturedPos = order.paymentMethod === 'RAZORPAY' && order.paymentProvider === 'RAZORPAY';
    let audit;
    if (capturedPos) {
      const refundSnapshot = await transaction.get(db.collection('razorpayRefunds').doc(deterministicRefundId(order.id)));
      const status = assertCapturedRefund(order, payments, refundSnapshot.exists ? refundSnapshot.data() : null);
      audit = buildRazorpayRefundAudit(order, payments, status);
    } else audit = buildPaymentReversalAudit(order, auditPayments);
    const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
    const staffName = String(profile.displayName || profile.name || request.auth.token?.name || 'Staff').trim().slice(0, 120);
    const stockRefs = new Map(targets.map(target => [target.stockRef.path, target.stockRef]));
    // Every state, membership, role and financial read completes before any write.
    balances.stockBalances.forEach(balance => transaction.update(stockRefs.get(balance.stockKey), { currentStock: balance.currentStock, updatedAt: timestamp() }));
    targets.forEach((target, index) => transaction.create(target.reversalRef, buildVoidStockReversal({ movement: target.movement, order, store, inventoryStore: physicalById.get(target.movement.storeId), currentStock: balances.steps[index].stockBefore, staffUid: uid, staffName, reason: input.reason, timestamp: timestamp() })));
    const pending = pendingSnapshot.docs.filter(snapshot => snapshot.data().status === 'PENDING_BOM');
    pending.forEach(snapshot => transaction.update(snapshot.ref, { status: 'CANCELLED', reason: `Order voided before BOM backfill: ${input.reason}`, resolvedAt: timestamp(), resolvedBy: uid, updatedAt: timestamp() }));
    kotSnapshot.docs.forEach(snapshot => transaction.update(snapshot.ref, { status: 'CANCELLED', voidReason: input.reason, handledByUserId: uid, handledByName: staffName, updatedAt: timestamp() }));
    transaction.update(orderRef, { status: 'VOIDED', ...(!complimentary ? audit : {}), voidReason: input.reason, voidedBy: uid, voidedByName: staffName, voidedByEmail: profile.email || null, voidedAt: timestamp(), updatedAt: timestamp(), voidOperationId: input.operationId, voidRequestHash: requestHash });
    const result = { orderId: order.id, status: 'VOIDED', replayed: false, stockReversalCount: targets.length, kotCancelledCount: kotSnapshot.docs.length, pendingCancelledCount: pending.length, paymentReversalStatus: audit.paymentReversalStatus };
    transaction.create(operationRef, { orderId: order.id, staffUid: uid, operationId: input.operationId, requestHash, result, createdAt: timestamp() });
    return result;
  });
  const saved = await orderRef.get();
  if (!saved.exists) fail('unavailable', 'The saved void result could not be read. Reconcile its original operation identity before retrying.');
  return plain({ ...result, paymentReversalStatus: saved.data()?.paymentReversalStatus || result.paymentReversalStatus, savedOrder: { ...saved.data(), id: saved.id } });
}

function createPosCheckoutVoidFunction({ admin, db, region }) { return onCall({ region }, request => voidPosCheckout({ admin, db, request })); }
module.exports = { createPosCheckoutVoidFunction, voidPosCheckout, normalizeVoid, assertVoidMoney, assertCapturedRefund };
