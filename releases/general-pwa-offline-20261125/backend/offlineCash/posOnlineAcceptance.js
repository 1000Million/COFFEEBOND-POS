'use strict';

const { createHash } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isAuthorizedStaffProfile, isAuthorizedStaffForStorePair } = require('./complimentaryAuthorizationPolicy');
const { canonicalizeFrozenOrderCart, sanitizeCartItems, assertImmutableSourceOnlineOrder } = require('./posAddOnAuthorization');
const { collectFrozenComponentFinishedGoodIds } = require('./compositeProductPolicy');
const { resolveInventoryStore } = require('./inventoryStoreResolver');
const { expandCompositeInventoryLines } = require('./compositeFulfillment');
const { planOnlineOrderInventory } = require('./onlineOrderInventory');
const { writeCanonicalSale, receiptLegalDetails } = require('./posCheckoutCommit');
const { assertSavedFinancials } = require('./posCheckoutSettlement');

const fail = (code, message) => { throw new HttpsError(code, message); };
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const close = (a, b) => typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
const text = (value, maximum = 120) => String(value || '').trim().slice(0, maximum);

function onlineIdentity(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).some(key => key !== 'onlineOrderId')
    || typeof data.onlineOrderId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(data.onlineOrderId)) fail('invalid-argument', 'A valid online order identity is required.');
  return data.onlineOrderId;
}

function assertSubmissionOrigin(onlineOrderId, source, submission) {
  const response = submission?.response;
  if (!submission || submission.onlineOrderId !== onlineOrderId || submission.storeId !== source.storeId
    || (submission.customerUid || null) !== (source.customerUid || null)
    || submission.trackingToken !== source.trackingToken || submission.publicOrderReference !== source.publicOrderReference
    || !response || response.paymentProvider !== 'PAY_AT_COUNTER'
    || !close(response.subtotal, source.subtotal) || !close(response.gstTotal, source.gstTotal) || !close(response.total, source.grandTotal)
    || !Array.isArray(response.items) || response.items.length !== source.items.length
    || response.items.some((item, index) => item.quantity !== source.items[index].quantity || !close(item.lineTotal, source.items[index].lineTotal))) {
    fail('failed-precondition', 'The private server submission does not match this online order.');
  }
}

// Exact pure coupon allocation/rounding code from the last-verified submitCustomerOrder
// archive (customerCoupon.js). Only the existing pricing function is used; no
// coupon usage or provider handler is invoked here.
const couponPricing = (() => {
const VERSION = 'COUPON_V1';
const fail = message => { throw new HttpsError('failed-precondition', message); };
const sha = value => createHash('sha256').update(value).digest('hex');

function normalizeCouponCode(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('Enter a valid coupon code.');
  const code = value.trim().toUpperCase();
  if (!code) return null;
  if (!/^[A-Z0-9_-]{1,40}$/.test(code)) fail('Enter a valid coupon code.');
  return code;
}

// Decimal input is converted to an exact rational before half-up rounding.
function scaled(value, scale = 100) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('Invalid coupon pricing amount.');
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const power = Number(exponent) - fraction.length;
  let numerator = BigInt(whole + fraction) * BigInt(scale);
  let denominator = 1n;
  if (power >= 0) numerator *= 10n ** BigInt(power);
  else denominator = 10n ** BigInt(-power);
  const rounded = (numerator * 2n + denominator) / (2n * denominator);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) fail('Coupon amount is too large.');
  return result;
}
const halfUp = (numerator, denominator) => Number((2n * numerator + denominator) / (2n * denominator));
const money = paise => paise / 100;
const sum = values => values.reduce((a, b) => a + b, 0);

function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some(w => !Number.isSafeInteger(w) || w < 0)) fail('Invalid coupon allocation.');
  const denominator = BigInt(sum(weights));
  if (!denominator) return weights.map(() => 0);
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, value: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let remaining = total - sum(parts.map(p => p.value));
  for (const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (!remaining) break;
    part.value++; remaining--;
  }
  return parts.map(p => p.value);
}

function couponPolicy(coupon, code) {
  if (!coupon || !['PERCENT', 'FIXED'].includes(coupon.discountType)) fail('This coupon is not configured correctly.');
  if (typeof coupon.discountValue !== 'number' || coupon.discountValue <= 0 || !Number.isFinite(coupon.discountValue)
    || (coupon.discountType === 'PERCENT' && coupon.discountValue > 100)) fail('This coupon has an invalid discount.');
  if (coupon.maxDiscount != null && (typeof coupon.maxDiscount !== 'number' || !Number.isFinite(coupon.maxDiscount) || coupon.maxDiscount <= 0)) fail('This coupon has an invalid discount cap.');
  return { code, discountType: coupon.discountType, discountValue: coupon.discountValue, maxDiscount: coupon.maxDiscount ?? null };
}

function priceCoupon(items, coupon, code = coupon?.code) {
  const policy = couponPolicy(coupon, normalizeCouponCode(code));
  if (!policy.code || !Array.isArray(items) || !items.length) fail('Add items before applying a coupon.');
  const components = [];
  items.forEach((item, index) => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) fail('Invalid item quantity.');
    components.push({ index, kind: 'BASE', amount: scaled(item.baseUnitPrice) * item.quantity, rate: scaled(item.taxRate) });
    for (const addOn of item.addOns || []) components.push({ index, kind: 'ADD_ON', groupId: addOn.groupId, optionId: addOn.optionId, amount: scaled(addOn.totalPrice) * item.quantity, rate: scaled(addOn.taxRate) });
  });
  const subtotalPaise = sum(components.map(c => c.amount));
  if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise <= 0 || components.some(c => c.rate > 10000)) fail('Invalid coupon basket.');
  let discountPaise = policy.discountType === 'PERCENT'
    ? halfUp(BigInt(subtotalPaise) * BigInt(scaled(policy.discountValue)), 10000n)
    : scaled(policy.discountValue);
  if (policy.maxDiscount != null) discountPaise = Math.min(discountPaise, scaled(policy.maxDiscount));
  discountPaise = Math.min(subtotalPaise, discountPaise);
  if (discountPaise <= 0) fail('This coupon does not produce a discount for this basket.');
  const discounts = allocate(discountPaise, components.map(c => c.amount));
  const pricedItems = items.map((item, index) => {
    const rows = components.map((c, i) => ({ ...c, discount: discounts[i] })).filter(c => c.index === index);
    const lineSubtotal = sum(rows.map(c => c.amount));
    const lineDiscount = sum(rows.map(c => c.discount));
    const taxWeights = rows.map(c => (c.amount - c.discount) * c.rate);
    const lineTax = halfUp(BigInt(sum(taxWeights)), 10000n);
    const taxes = allocate(lineTax, taxWeights);
    return {
      ...item,
      lineSubtotal: money(lineSubtotal),
      lineDiscount: money(lineDiscount),
      lineTaxable: money(lineSubtotal - lineDiscount),
      lineTax: money(lineTax),
      lineTotal: money(lineSubtotal - lineDiscount + lineTax),
      couponAllocations: rows.map((c, i) => ({ kind: c.kind, ...(c.kind === 'ADD_ON' ? { groupId: c.groupId, optionId: c.optionId } : {}), subtotal: money(c.amount), discount: money(c.discount), taxableAmount: money(c.amount - c.discount), taxRate: c.rate / 100, gstTotal: money(taxes[i]) })),
    };
  });
  const gstPaise = sum(pricedItems.map(item => scaled(item.lineTax)));
  return {
    items: pricedItems,
    pricingVersion: VERSION,
    couponPolicy: policy,
    couponCode: policy.code,
    discountPercent: policy.discountType === 'PERCENT' ? policy.discountValue : 0,
    subtotal: money(subtotalPaise),
    discount: money(discountPaise),
    taxableAmount: money(subtotalPaise - discountPaise),
    gstTotal: money(gstPaise),
    grandTotal: money(subtotalPaise - discountPaise + gstPaise),
  };
}

return { priceCoupon };
})();

function frozenFinancials({ source, canonicalItems, itemIds, orderId }) {
  const coupon = !!source.couponCode;
  if (coupon && (source.pricingVersion !== 'COUPON_V1' || source.couponUsageStatus !== 'COMMITTED'
    || !/^[A-Z0-9_-]{1,40}$/.test(source.couponCode))) fail('failed-precondition', 'The server coupon snapshot requires review.');
  const couponCalculated = coupon ? couponPricing.priceCoupon(itemIds.map(id => canonicalItems[id]), source.couponPolicy, source.couponCode) : null;
  const lines = {};
  itemIds.forEach((id, index) => {
    const canonical = canonicalItems[id], stored = source.items[index];
    if (coupon) {
      for (const key of ['lineSubtotal', 'lineDiscount', 'lineTaxable', 'lineTax', 'lineTotal']) {
        const value = stored[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) fail('failed-precondition', 'The frozen coupon line requires review.');
      }
      lines[id] = Object.fromEntries(['lineSubtotal', 'lineDiscount', 'lineTaxable', 'lineTax', 'lineTotal'].map(key => [key, stored[key]]));
      for (const key of Object.keys(lines[id])) if (!close(lines[id][key], couponCalculated.items[index][key])) fail('failed-precondition', 'The frozen coupon allocation or GST is inconsistent.');
      if (!close(lines[id].lineSubtotal, lines[id].lineDiscount + lines[id].lineTaxable)
        || !close(lines[id].lineTotal, lines[id].lineTaxable + lines[id].lineTax)) fail('failed-precondition', 'Frozen coupon line arithmetic is inconsistent.');
    } else {
      const rawSubtotal = (canonical.baseUnitPrice + canonical.addOnTotal) * canonical.quantity;
      const lineSubtotal = roundMoney(rawSubtotal);
      const addOnTax = canonical.addOns.reduce((sum, addOn) => sum + addOn.totalPrice * canonical.quantity * addOn.taxRate / 100, 0);
      const rawTax = canonical.baseUnitPrice * canonical.quantity * canonical.taxRate / 100 + addOnTax;
      const lineTax = roundMoney(rawTax);
      lines[id] = { lineSubtotal, lineDiscount: 0, lineTaxable: lineSubtotal, lineTax, lineTotal: roundMoney(lineSubtotal + lineTax) };
      const raw = { lineSubtotal: rawSubtotal, lineTaxable: rawSubtotal, lineTax: rawTax, lineTotal: rawSubtotal + rawTax };
      const rawForm = Object.keys(raw).every(key => close(stored[key], raw[key]));
      const acceptedForm = Object.keys(raw).every(key => close(stored[key], lines[id][key]));
      if (!rawForm && !acceptedForm) fail('failed-precondition', 'The frozen online line totals are inconsistent.');
      if (stored.lineDiscount !== undefined && stored.lineDiscount !== 0) fail('failed-precondition', 'Unexpected noncoupon discount.');
    }
  });
  const total = key => roundMoney(Object.values(lines).reduce((sum, line) => sum + line[key], 0));
  const subtotal = total('lineSubtotal'), discountAmount = total('lineDiscount'), taxableAmount = total('lineTaxable'), taxTotal = total('lineTax');
  const grandTotal = roundMoney(taxableAmount + taxTotal);
  // Submit stores unrounded amounts; acceptance has historically rounded each
  // line. Validate the original source on its own basis, then preserve that
  // accepted rounding policy without treating the rounded output as source.
  const sourceTotal = key => source.items.reduce((sum, item) => sum + item[key], 0);
  const sourceExpected = { subtotal: sourceTotal('lineSubtotal'), taxableAmount: sourceTotal('lineTaxable'), gstTotal: sourceTotal('lineTax') };
  sourceExpected.grandTotal = sourceExpected.taxableAmount + sourceExpected.gstTotal;
  for (const [key, expected] of Object.entries(sourceExpected)) {
    if (!close(source[key], expected) && !close(source[key], roundMoney(expected))) fail('failed-precondition', 'The frozen online order totals are inconsistent.');
  }
  if (coupon && !close(source.discount, discountAmount)) fail('failed-precondition', 'The frozen coupon total is inconsistent.');
  if (!coupon && [source.discount, source.discountAmount, source.discountTotal, source.discountPercent].some(value => value !== undefined && value !== 0)) fail('failed-precondition', 'Unexpected noncoupon order discount.');
  const discountPercent = source.discountPercent ?? 0;
  if (coupon && !close(discountPercent, couponCalculated.discountPercent)) fail('failed-precondition', 'The frozen coupon policy is inconsistent.');
  if (typeof discountPercent !== 'number' || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) fail('failed-precondition', 'The frozen discount percentage is invalid.');
  assertSavedFinancials({ subtotal, discountAmount, taxableAmount, gstTotal: taxTotal, grandTotal }, Object.values(lines));
  const paymentId = `${orderId}_PAY_01_PAY_AT_COUNTER`;
  return { version: 3, subtotal, discountPercent, discountAmount, taxableAmount, taxTotal, gstTotal: taxTotal, grandTotal,
    itemIds, lines, paymentIds: [paymentId], payments: { [paymentId]: { method: 'PAY_AT_COUNTER', amount: 0, paymentIndex: 0, reference: 'PAY_AT_COUNTER_PLACEHOLDER' } },
    paymentStatus: 'UNPAID', paymentMethod: 'PAY_AT_COUNTER', isSplitPayment: false, commercialStatus: 'SALE' };
}

function createPosOnlineAcceptanceFunction({ admin, db, region }) {
  return onCall({ region }, async request => {
    const uid = request.auth?.uid;
    if (!uid) fail('unauthenticated', 'Staff sign-in is required.');
    const onlineOrderId = onlineIdentity(request.data);
    const orderId = `WEB_PAC_${sha(onlineOrderId).slice(0, 48)}`;
    const onlineRef = db.collection('onlineOrders').doc(onlineOrderId);
    const orderRef = db.collection('orders').doc(orderId);
    return db.runTransaction(async transaction => {
      const [onlineSnapshot, staffSnapshot, existingSnapshot] = await Promise.all([
        transaction.get(onlineRef), transaction.get(db.collection('users').doc(uid)), transaction.get(orderRef),
      ]);
      if (!onlineSnapshot.exists) fail('not-found', 'Online order request no longer exists.');
      const online = onlineSnapshot.data();
      const staffProfile = staffSnapshot.exists ? staffSnapshot.data() : null;
      if (!isAuthorizedStaffProfile(staffProfile, online.storeId)) fail('permission-denied', 'This staff account cannot accept this store.');
      if (online.source !== 'CUSTOMER_WEB' || online.paymentProvider !== 'PAY_AT_COUNTER'
        || online.tableSessionId || online.paymentStatus === 'PAID' || online.commercialStatus === 'COMPLIMENTARY') fail('failed-precondition', 'This online order requires its existing payment lifecycle.');
      if (online.status === 'CONVERTED') {
        if (!existingSnapshot.exists || online.linkedOrderId !== orderId
          || existingSnapshot.data().onlineOrderId !== onlineOrderId || existingSnapshot.data().storeId !== online.storeId) fail('failed-precondition', 'The saved online conversion requires review.');
        const saved = existingSnapshot.data();
        return { orderId, orderNumber: saved.orderNumber, stockMovementCount: saved.stockMovementCount || 0, kotCount: saved.kotCount || 0, replayed: true };
      }
      if (!['PENDING', 'NEEDS_ATTENTION'].includes(online.status) || existingSnapshot.exists || online.linkedOrderId) fail('failed-precondition', 'This online order cannot be accepted again.');
      if (!Array.isArray(online.items) || online.items.length < 1 || online.items.length > 30) fail('failed-precondition', 'The frozen online basket requires review.');
      if (typeof online.customerOrderSubmissionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(online.customerOrderSubmissionId)) fail('failed-precondition', 'The private server submission reference is required.');
      const submissionSnapshot = await transaction.get(db.collection('customerOrderSubmissions').doc(online.customerOrderSubmissionId));
      assertSubmissionOrigin(onlineOrderId, online, submissionSnapshot.exists ? submissionSnapshot.data() : null);
      const storeSnapshot = await transaction.get(db.collection('stores').doc(online.storeId));
      if (!storeSnapshot.exists || storeSnapshot.data().isActive !== true || storeSnapshot.data().posEnabled === false) fail('failed-precondition', 'The selected store is not active.');
      const store = { ...storeSnapshot.data(), id: storeSnapshot.id };
      const inventoryStore = await resolveInventoryStore(store, async id => {
        const snapshot = await transaction.get(db.collection('stores').doc(id));
        return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
      });
      if (!isAuthorizedStaffForStorePair(staffProfile, store.id, inventoryStore.id)) fail('permission-denied', 'This staff account cannot consume inventory at the configured store.');
      const itemIds = online.items.map((_, index) => `${orderId}_ITEM_${String(index + 1).padStart(3, '0')}`);
      const requestedItems = sanitizeCartItems(online.items.map((item, index) => ({
        orderItemId: itemIds[index], parentProductId: item.finishedGoodId || item.finishedGoodCode, parentProductCode: item.finishedGoodCode,
        quantity: item.quantity, selectedAddOns: (item.addOns || []).map(addOn => ({ groupId: addOn.groupId, optionId: addOn.optionId, quantity: addOn.quantity })),
      })));
      const productIds = [...new Set(requestedItems.map(item => item.parentProductId))];
      const products = await Promise.all(productIds.map(id => transaction.get(db.collection('finishedGoods').doc(id))));
      const productsById = Object.fromEntries(products.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { ...snapshot.data(), id: snapshot.id }]));
      const componentIds = collectFrozenComponentFinishedGoodIds(online.items).filter(id => !productsById[id]);
      const components = await Promise.all(componentIds.map(id => transaction.get(db.collection('finishedGoods').doc(id))));
      const componentProductsById = { ...productsById, ...Object.fromEntries(components.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { ...snapshot.data(), id: snapshot.id }])) };
      const canonical = canonicalizeFrozenOrderCart({ storeId: store.id, store, requestedItems, sourceItems: online.items, productsById, componentProductsById });
      assertImmutableSourceOnlineOrder({ sourceOnlineOrderSnapshot: onlineSnapshot, storeId: store.id, requestedItems, canonicalItems: canonical.canonicalItems });
      for (const line of Object.values(canonical.canonicalItems)) if (Number(productsById[line.parentProductId].salePrice) !== line.baseUnitPrice) fail('failed-precondition', 'The online price snapshot no longer matches the live menu.');
      if (online.couponCode) {
        const redemptionSnapshot = await transaction.get(db.collection('customerCouponRedemptions').doc(onlineOrderId));
        const redemption = redemptionSnapshot.exists ? redemptionSnapshot.data() : null;
        if (!redemption || redemption.status !== 'COMMITTED' || redemption.reviewRequired === true
          || redemption.onlineOrderId !== onlineOrderId || redemption.code !== online.couponCode
          || !close(redemption.discount, online.discount) || !online.customerUid || redemption.customerKey !== sha(online.customerUid)) {
          fail('failed-precondition', 'The private committed coupon redemption does not match this order.');
        }
      }
      const financials = frozenFinancials({ source: online, canonicalItems: canonical.canonicalItems, itemIds, orderId });
      const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const counterRef = db.collection('counters').doc(`${store.code}_${dateKey}`), counterSnapshot = await transaction.get(counterRef);
      const sequence = counterSnapshot.exists ? Number(counterSnapshot.data().lastSequence || 0) + 1 : 1;
      if (!Number.isSafeInteger(sequence) || sequence < 1) fail('failed-precondition', 'The order sequence requires review.');
      const orderNumber = `CB-${store.code}-${dateKey}-${String(sequence).padStart(4, '0')}`;
      const orderType = online.orderType === 'DINE_IN' ? 'DINE_IN' : 'TAKEAWAY';
      const staff = { uid, name: text(staffProfile.displayName || staffProfile.name || request.auth.token?.name || 'Staff') };
      const expandedInventoryLines = expandCompositeInventoryLines(itemIds.map(id => ({ lineKey: id, quantity: canonical.canonicalItems[id].quantity,
        finishedGood: productsById[canonical.canonicalItems[id].parentProductId], addOns: canonical.canonicalItems[id].addOns, components: canonical.canonicalItems[id].components || [] })), store.id);
      const inventoryPlan = await planOnlineOrderInventory({ transaction, db, admin, store: { ...store, inventoryPolicy: 'ALLOW_NEGATIVE_DEFER_BOM' },
        orderId, orderNumber, orderType, businessDate: dateKey, staff, lines: expandedInventoryLines, requireAvailableStock: false, deferIncompleteBom: true, aggregateLineConsumption: true, source: 'CUSTOMER_WEB_ACCEPT' });
      if (inventoryPlan.blockers.length) fail('failed-precondition', 'The inventory configuration requires review before acceptance.');
      const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
      const authorizationId = `${orderId}_AUTH`, authorizationRef = db.collection('posAddOnAuthorizations').doc(authorizationId);
      const customerPhone = text(online.customerPhone, 30), customerName = text(online.customerName) || 'Online Guest';
      const customerId = customerPhone ? `WEB_${sha(`${onlineOrderId}:${customerPhone}`).slice(0, 32)}` : null;
      const orderData = { orderNumber, storeId: store.id, storeCode: store.code, storeName: store.name, customerId, customerName, customerPhone: customerPhone || null,
        createdByUserId: uid, createdByName: staff.name, orderType, status: 'COMPLETED', commercialStatus: 'SALE', paymentStatus: 'UNPAID',
        tableNumber: orderType === 'DINE_IN' ? text(online.tableNumber, 120) || 'ONLINE' : null,
        subtotal: financials.subtotal, discountPercent: financials.discountPercent, discountAmount: financials.discountAmount, discountTotal: financials.discountAmount, discount: financials.discountAmount,
        taxableAmount: financials.taxableAmount, taxTotal: financials.taxTotal, gstTotal: financials.taxTotal, grandTotal: financials.grandTotal,
        cogsTotal: inventoryPlan.totalCogs, inventoryWarningCount: inventoryPlan.warnings.length, inventoryWarnings: inventoryPlan.warnings.map(warning => warning.message),
        inventoryConsumptionStatus: inventoryPlan.pendingConsumptionPayloads.length ? 'PENDING_BOM' : 'APPLIED', stockMovementCount: inventoryPlan.movementPayloads.length,
        paymentMethod: 'PAY_AT_COUNTER', paymentMethodLabel: 'PAY_AT_COUNTER', isSplitPayment: false, paymentBreakdown: [{ method: 'PAY_AT_COUNTER', amount: 0 }],
        addOnAuthorizationId: authorizationId, addOnTotal: canonical.canonicalAddOnTotal, financialAuthorizationVersion: 3, financialItemIds: itemIds, financialPaymentIds: financials.paymentIds,
        ...(online.gstTreatmentSnapshot ? { gstTreatmentSnapshot: online.gstTreatmentSnapshot } : {}),
        receiptLegalDetails: online.receiptLegalDetails || receiptLegalDetails(store), source: 'CUSTOMER_WEB', onlineOrderId, onlineOrderTrackingToken: online.trackingToken || null,
        onlineOrderReference: online.publicOrderReference || null, notes: text(online.notes, 500), ...(online.couponCode ? { couponCode: online.couponCode, discountReason: `Coupon ${online.couponCode}` } : {}),
        createdAt: timestamp(), updatedAt: timestamp() };
      // Count deterministic tasks without creating any effect before the writer.
      const { buildKotTasks } = require('./compositeFulfillment');
      orderData.kotCount = itemIds.reduce((count, id) => count + buildKotTasks({ quantity: canonical.canonicalItems[id].quantity,
        finishedGood: productsById[canonical.canonicalItems[id].parentProductId], components: canonical.canonicalItems[id].components || [] }).length, 0);
      writeCanonicalSale(transaction, { db, admin, orderRef, orderData, canonicalItems: canonical.canonicalItems, financials, productsById, expandedInventoryLines, inventoryPlan, staff, selectedStore: store });
      transaction.set(counterRef, { storeCode: store.code, dateKey, lastSequence: sequence, updatedAt: timestamp() }, { merge: true });
      transaction.create(authorizationRef, { staffUid: uid, staffName: staff.name, storeId: store.id, orderId, orderNumber, sourceOnlineOrderId: onlineOrderId,
        canonicalItems: canonical.canonicalItems, canonicalAddOnTotal: canonical.canonicalAddOnTotal, provider: 'SERVER_CANONICAL_ADD_ONS', financials, used: true, usedAt: timestamp(), createdAt: timestamp() });
      if (customerId) transaction.set(db.collection('customers').doc(customerId), { name: customerName, phone: customerPhone, visitCount: 1,
        totalSpend: financials.grandTotal, lastVisitAt: timestamp(), createdAt: timestamp(), updatedAt: timestamp() });
      transaction.update(onlineRef, { status: 'CONVERTED', linkedOrderId: orderId, linkedOrderNumber: orderNumber, customerStatusMessage: 'Your order has been accepted and is being prepared.',
        convertedBy: uid, convertedByName: staff.name, convertedAt: timestamp(), updatedAt: timestamp() });
      if (online.trackingToken) transaction.set(db.collection('publicOrderTracking').doc(online.trackingToken), {
        publicStatus: 'CONVERTED', publicOrderNumber: orderNumber, customerStatusMessage: 'Your order has been accepted and is being prepared.', acceptedAt: timestamp() }, { merge: true });
      return { orderId, orderNumber, stockMovementCount: inventoryPlan.movementPayloads.length, kotCount: orderData.kotCount, replayed: false };
    });
  });
}

module.exports = { createPosOnlineAcceptanceFunction, frozenFinancials, onlineIdentity, assertSubmissionOrigin };
