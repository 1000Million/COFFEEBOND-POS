'use strict';

const { createHash } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isAuthorizedStaffProfile } = require('./complimentaryAuthorizationPolicy');

const TENDERS = new Set(['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO']);
const PLACEHOLDERS = new Set(['CREDIT', 'PAY_AT_COUNTER']);
const EPSILON = 0.010000001;
const fail = (code, message) => { throw new HttpsError(code, message); };
const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPSILON;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail('invalid-argument', `A valid ${field} is required.`);
  return value;
}

function finiteMoney(value, field, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value <= 0)) {
    fail('invalid-argument', `${field} must be a finite ${positive ? 'positive' : 'nonnegative'} amount.`);
  }
  return value;
}

function normalizeSettlement(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).some(key => !['orderId', 'operationId', 'payments'].includes(key))) fail('invalid-argument', 'Invalid settlement request.');
  const orderId = identifier(data.orderId, 'order identity');
  const operationId = identifier(data.operationId, 'settlement identity');
  if (!Array.isArray(data.payments) || data.payments.length < 1 || data.payments.length > 30) fail('invalid-argument', 'Settlement requires valid tender rows.');
  const payments = data.payments.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['method', 'amount', 'reference', 'amountReceived', 'changeDue'].includes(key))
      || !TENDERS.has(row.method)) fail('invalid-argument', 'Unsupported settlement tender.');
    const result = { method: row.method, amount: finiteMoney(row.amount, 'Tender', true), reference: null };
    if (row.reference != null) {
      if (typeof row.reference !== 'string' || row.reference.length > 200) fail('invalid-argument', 'Invalid tender reference.');
      result.reference = row.reference.trim() || null;
    }
    if (row.amountReceived !== undefined || row.changeDue !== undefined) {
      if (row.method !== 'CASH') fail('invalid-argument', 'Cash received metadata requires CASH tender.');
      result.amountReceived = finiteMoney(row.amountReceived, 'Cash received');
      result.changeDue = finiteMoney(row.changeDue, 'Cash change');
      if (result.amountReceived + EPSILON < result.amount || !same(result.changeDue, Math.max(0, result.amountReceived - result.amount))) {
        fail('invalid-argument', 'Cash received and change must match the allocated tender.');
      }
    }
    return result;
  });
  return { orderId, operationId, payments };
}

// Legacy orders are not repriced or migrated. Refuse internally corrupt saved
// financial records before using their saved payable as a settlement authority.
function assertSavedFinancials(order, items) {
  const required = ['subtotal', 'taxableAmount', 'grandTotal'];
  if (required.some(key => typeof order[key] !== 'number' || !Number.isFinite(order[key]) || order[key] < 0)
    || !Array.isArray(items) || items.length === 0) fail('failed-precondition', 'Saved order financials require review before settlement.');
  const discount = order.discountAmount ?? order.discountTotal ?? order.discount ?? 0;
  const tax = order.gstTotal ?? order.taxTotal;
  if (typeof discount !== 'number' || !Number.isFinite(discount) || discount < 0
    || typeof tax !== 'number' || !Number.isFinite(tax) || tax < 0
    || !same(order.taxableAmount, order.subtotal - discount)
    || !same(order.grandTotal, order.taxableAmount + tax)) fail('failed-precondition', 'Saved order totals are inconsistent.');
  for (const key of ['discountAmount', 'discountTotal', 'discount']) {
    if (order[key] !== undefined && !same(order[key], discount)) fail('failed-precondition', 'Saved order discount aliases are inconsistent.');
  }
  for (const key of ['gstTotal', 'taxTotal']) {
    if (order[key] !== undefined && !same(order[key], tax)) fail('failed-precondition', 'Saved order GST aliases are inconsistent.');
  }
  const sums = { lineSubtotal: 0, lineDiscount: 0, lineTaxable: 0, lineTax: 0, lineTotal: 0 };
  for (const item of items) {
    for (const key of Object.keys(sums)) {
      if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) fail('failed-precondition', 'Saved item financials require review.');
      sums[key] += item[key];
    }
    if (!same(item.lineTaxable, item.lineSubtotal - item.lineDiscount)
      || !same(item.lineTotal, item.lineTaxable + item.lineTax)) fail('failed-precondition', 'Saved item totals are inconsistent.');
  }
  if (!same(sums.lineSubtotal, order.subtotal) || !same(sums.lineDiscount, discount)
    || !same(sums.lineTaxable, order.taxableAmount) || !same(sums.lineTax, tax)
    || !same(sums.lineTotal, order.grandTotal)) fail('failed-precondition', 'Saved order and item totals do not reconcile.');
  return order.grandTotal;
}

function assertLegacySplitAllocation(payments, order) {
  if (order.isSplitPayment !== true) return null;
  if (!Array.isArray(payments) || payments.length === 0 || !Number.isFinite(order.grandTotal) || order.grandTotal < 0
    || payments.some(payment => !TENDERS.has(payment.method) && payment.method !== 'CREDIT' && payment.method !== 'PAY_AT_COUNTER'
      || payment.method === 'PAY_AT_COUNTER' && payment.amount !== 0
      || typeof payment.amount !== 'number' || !Number.isFinite(payment.amount) || payment.amount < 0)) {
    fail('failed-precondition', 'Saved split allocation requires review.');
  }
  const allocated = payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (!Number.isFinite(allocated) || Math.abs(allocated - order.grandTotal) > 0.01) fail('failed-precondition', 'Saved split allocation does not match the payable.');
  const credit = payments.filter(payment => payment.method === 'CREDIT').reduce((sum, payment) => sum + payment.amount, 0);
  const status = credit <= 0.01 ? 'PAID' : credit >= order.grandTotal - 0.01 ? 'UNPAID' : 'PARTIAL';
  if (order.paymentStatus !== status) fail('failed-precondition', 'Saved split status does not match the original allocation contract.');
  return { status, allocated, credit, collected: payments.filter(payment => payment.method !== 'CREDIT').reduce((sum, payment) => sum + payment.amount, 0) };
}

function assertExistingPayments(payments, order, trustedInitialPlan = null) {
  // This context is supplied only after the handler has verified the exact
  // server authorization, order, item and payment snapshot. The issued plan's
  // status preserves the existing 0.01 split-allocation contract; do not
  // independently reclassify its collected/debt rows using legacy thresholds.
  if (trustedInitialPlan) {
    if (trustedInitialPlan.version !== 3 || order.financialAuthorizationVersion !== 3
      || order.paymentStatus !== trustedInitialPlan.paymentStatus || order.grandTotal !== trustedInitialPlan.grandTotal
      || !Array.isArray(trustedInitialPlan.paymentIds)
      || JSON.stringify(payments.map(payment => payment.id).sort()) !== JSON.stringify([...trustedInitialPlan.paymentIds].sort())
      || payments.some(payment => {
        const expected = trustedInitialPlan.payments?.[payment.id];
        return !expected || expected.method !== payment.method || expected.amount !== payment.amount || expected.paymentIndex !== payment.paymentIndex;
      })) fail('failed-precondition', 'Saved collections do not match the verified financial plan.');
  }
  let paid = 0;
  for (const payment of payments) {
    if (!TENDERS.has(payment.method) && !PLACEHOLDERS.has(payment.method)) fail('failed-precondition', 'This payment lifecycle cannot use manual settlement.');
    if (typeof payment.amount !== 'number' || !Number.isFinite(payment.amount) || payment.amount < 0
      || payment.provider || payment.verifiedServerSide === true) fail('failed-precondition', 'Saved payment records require review.');
    if (PLACEHOLDERS.has(payment.method)) {
      if (payment.method === 'PAY_AT_COUNTER' && payment.amount !== 0) fail('failed-precondition', 'Counter placeholders must not contain collections.');
    } else paid += payment.amount;
  }
  if (paid > order.grandTotal + EPSILON) fail('failed-precondition', 'Saved collections exceed the order payable.');
  const legacySplit = !trustedInitialPlan ? assertLegacySplitAllocation(payments, order) : null;
  if (!trustedInitialPlan && !legacySplit && order.paymentStatus === 'UNPAID' && paid > EPSILON) fail('failed-precondition', 'Saved unpaid status does not match collections.');
  if (!trustedInitialPlan && !legacySplit && order.paymentStatus === 'PARTIAL' && (paid <= 0 || paid >= order.grandTotal - EPSILON)) fail('failed-precondition', 'Saved partial status does not match collections.');
  return paid;
}

function createPosCheckoutSettlementFunction({ admin, db, region }) {
  return onCall({ region }, async request => {
    const staffUid = request.auth?.uid;
    if (!staffUid) fail('unauthenticated', 'Staff sign-in is required.');
    const input = normalizeSettlement(request.data);
    const requestHash = hash({ staffUid, ...input });
    const operationRef = db.collection('posSettlementOperations').doc(hash([input.orderId, input.operationId]));
    const orderRef = db.collection('orders').doc(input.orderId);
    return db.runTransaction(async transaction => {
      const [profileSnapshot, orderSnapshot, operationSnapshot] = await Promise.all([
        transaction.get(db.collection('users').doc(staffUid)), transaction.get(orderRef), transaction.get(operationRef),
      ]);
      if (!orderSnapshot.exists) fail('not-found', 'Order no longer exists.');
      const order = orderSnapshot.data();
      const staff = profileSnapshot.exists ? profileSnapshot.data() : null;
      if (!isAuthorizedStaffProfile(staff, order.storeId)) fail('permission-denied', 'This staff account cannot settle this store.');
      const storeSnapshot = await transaction.get(db.collection('stores').doc(order.storeId));
      if (!storeSnapshot.exists || storeSnapshot.data().isActive !== true) fail('failed-precondition', 'The selected store is not active.');
      if (operationSnapshot.exists) {
        const operation = operationSnapshot.data();
        if (operation.requestHash !== requestHash || operation.staffUid !== staffUid || operation.orderId !== input.orderId) fail('already-exists', 'Settlement identity is already bound to another request.');
        return { ...operation.result, replayed: true };
      }
      if (order.status !== 'COMPLETED' || !['UNPAID', 'PARTIAL'].includes(order.paymentStatus)
        || order.tableSessionId || order.commercialStatus === 'COMPLIMENTARY' || order.paymentMethod === 'COMPLIMENTARY'
        || order.paymentProvider === 'RAZORPAY' || order.paymentMethod === 'RAZORPAY'
        || (order.paymentProvider && order.paymentProvider !== 'PAY_AT_COUNTER')) fail('failed-precondition', 'This order is not eligible for manual settlement.');
      const [itemSnapshot, paymentSnapshot, authorizationSnapshot] = await Promise.all([
        transaction.get(orderRef.collection('items')), transaction.get(orderRef.collection('payments')),
        order.addOnAuthorizationId ? transaction.get(db.collection('posAddOnAuthorizations').doc(order.addOnAuthorizationId)) : Promise.resolve(null),
      ]);
      const items = itemSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const existing = paymentSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const payable = assertSavedFinancials(order, items);
      const authorization = authorizationSnapshot?.exists ? authorizationSnapshot.data() : null;
      const plan = authorization?.financials;
      if (order.financialAuthorizationVersion !== undefined || plan) {
        if (order.financialAuthorizationVersion !== 3 || plan?.version !== 3
          || authorization.orderId !== input.orderId || authorization.storeId !== order.storeId
          || authorization.provider !== 'SERVER_CANONICAL_ADD_ONS' || authorization.used !== true
          || !Array.isArray(plan.itemIds) || !Array.isArray(plan.paymentIds)
          || JSON.stringify(items.map(item => item.id).sort()) !== JSON.stringify([...plan.itemIds].sort())
          || JSON.stringify(existing.map(payment => payment.id).sort()) !== JSON.stringify([...plan.paymentIds].sort())) {
          fail('failed-precondition', 'Saved financial plan membership is inconsistent.');
        }
        for (const key of ['subtotal', 'discountPercent', 'discountAmount', 'taxableAmount', 'taxTotal', 'gstTotal', 'grandTotal']) {
          if (order[key] !== plan[key]) fail('failed-precondition', 'Saved order differs from its trusted financial plan.');
        }
        if (order.discountTotal !== plan.discountAmount || order.discount !== plan.discountAmount
          || order.paymentStatus !== plan.paymentStatus || order.paymentMethod !== plan.paymentMethod
          || (order.isSplitPayment === true) !== plan.isSplitPayment || order.commercialStatus !== plan.commercialStatus) {
          fail('failed-precondition', 'Saved order aliases or tender status differ from the trusted financial plan.');
        }
        for (const item of items) for (const key of ['lineSubtotal', 'lineDiscount', 'lineTaxable', 'lineTax', 'lineTotal']) {
          if (!plan.lines?.[item.id] || item[key] !== plan.lines[item.id][key]) fail('failed-precondition', 'Saved item differs from its trusted financial plan.');
        }
        for (const payment of existing) {
          const expected = plan.payments?.[payment.id];
          if (!expected || expected.method !== payment.method || expected.amount !== payment.amount
            || expected.paymentIndex !== payment.paymentIndex) fail('failed-precondition', 'Saved payment differs from its trusted financial plan.');
        }
      }
      const paid = assertExistingPayments(existing, order, plan || null);
      const outstanding = Math.max(0, Number((payable - paid).toFixed(2)));
      const allocated = input.payments.reduce((sum, row) => sum + row.amount, 0);
      if (outstanding <= 0 || !same(allocated, outstanding)) fail('failed-precondition', 'Settlement allocation must match the saved outstanding payable.');
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const staffName = String(staff.displayName || staff.name || request.auth.token?.name || 'Staff').slice(0, 120);
      const existingTenders = existing.filter(row => TENDERS.has(row.method) && row.amount > 0);
      const saved = input.payments.map((row, index) => ({
        id: `${input.orderId}_SETTLE_${hash(input.operationId).slice(0, 24)}_${String(index + 1).padStart(2, '0')}`,
        ...row, paymentIndex: existingTenders.length + index, createdAt: timestamp,
        settledBy: staffUid, settledByName: staffName,
      }));
      for (const row of saved) {
        const { id, ...payment } = row;
        transaction.create(orderRef.collection('payments').doc(id), payment);
      }
      const breakdown = [...existingTenders, ...saved].map(row => ({ method: row.method, amount: row.amount }));
      transaction.update(orderRef, {
        paymentStatus: 'PAID', paymentMethod: breakdown[0].method, isSplitPayment: breakdown.length > 1,
        paymentMethodLabel: breakdown.length > 1 ? breakdown.map(row => `${row.method} ₹${row.amount.toFixed(2)}`).join(' + ') : breakdown[0].method,
        paymentBreakdown: breakdown, settledAt: timestamp, settledBy: staffUid, settledByName: staffName, updatedAt: timestamp,
      });
      const result = { orderId: input.orderId, paymentStatus: 'PAID', payments: saved.map(({ id, method, amount }) => ({ id, method, amount })), replayed: false };
      transaction.create(operationRef, { orderId: input.orderId, staffUid, operationId: input.operationId, requestHash, result, createdAt: timestamp });
      return result;
    });
  });
}

module.exports = { createPosCheckoutSettlementFunction, normalizeSettlement, assertSavedFinancials, assertExistingPayments, assertLegacySplitAllocation };
