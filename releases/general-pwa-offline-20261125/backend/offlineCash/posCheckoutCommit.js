'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isDeepStrictEqual } = require('node:util');
const { isAuthorizedStaffProfile, isAuthorizedStaffForStorePair } = require('./complimentaryAuthorizationPolicy');
const { normalizeIndianPhone } = require('./complimentaryAuthorization');
const { canonicalizeRequestedCart, isDraftSetupTestAuthorizationAllowed } = require('./posAddOnAuthorization');
const { collectRequiredComponentFinishedGoodIds } = require('./compositeProductPolicy');
const { resolveInventoryStore } = require('./inventoryStoreResolver');
const { expandCompositeInventoryLines, summarizeParentInventory, buildKotTasks } = require('./compositeFulfillment');
const { planOnlineOrderInventory } = require('./onlineOrderInventory');
const { FINANCIAL_VERSION, authorizeFinancials, contentDigest, documentId, sanitizeId, shortHash } = require('./posCheckoutFinancials');

function fail(code, message) { throw new HttpsError(code, message); }
function text(value, maximum = 120) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maximum) fail('invalid-argument', 'Invalid checkout text.');
  return value.trim();
}
function id(value, label) { try { return documentId(value, label); } catch (error) { fail('invalid-argument', error.message); } }
function expiry(value) { return value && typeof value.toMillis === 'function' ? value.toMillis() : 0; }
function normalizeRequest(value) {
  const keys = ['authorizationId', 'orderId', 'idempotencyKey', 'payloadHash', 'orderType', 'tableNumber', 'customerName', 'customerPhone', 'complimentaryReason', 'complimentaryAuthorizationId', 'expectedFinancials'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-argument', 'Unsupported checkout request fields.');
  const request = {
    authorizationId: id(value.authorizationId, 'authorization reference'), orderId: id(value.orderId, 'order reference'),
    idempotencyKey: text(value.idempotencyKey, 200), payloadHash: text(value.payloadHash, 200), orderType: text(value.orderType, 24),
    tableNumber: text(value.tableNumber, 120), customerName: text(value.customerName, 120), customerPhone: normalizeIndianPhone(text(value.customerPhone, 30)),
    complimentaryReason: text(value.complimentaryReason, 500), complimentaryAuthorizationId: text(value.complimentaryAuthorizationId, 120),
    expectedFinancials: value.expectedFinancials,
  };
  if (!request.idempotencyKey || !request.payloadHash || !['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(request.orderType)) fail('invalid-argument', 'Checkout identity and order type are required.');
  if (request.customerPhone && !/^[6-9][0-9]{9}$/.test(request.customerPhone)) fail('invalid-argument', 'Enter a valid Indian mobile number.');
  if (request.complimentaryAuthorizationId) id(request.complimentaryAuthorizationId, 'complimentary authorization');
  return request;
}
function receiptLegalDetails(store) { return require('./storeGstTreatment').legalDetails(store); }

function prepStation(value) {
  const station = String(value || 'NONE').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['BARISTA', 'BAR'].includes(station)) return 'BARISTA';
  if (['KITCHEN', 'KITCHEN_KOT'].includes(station)) return 'KITCHEN';
  if (['BOTH', 'BARISTA_KITCHEN', 'BAR_AND_KITCHEN'].includes(station)) return 'BOTH';
  return 'NONE';
}
function plain(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

async function canonicalCartInTransaction({ transaction, db, authorization, store }) {
  const requestedItems = authorization.requestedItems;
  if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 30) fail('failed-precondition', 'Financial authorization has no canonical request.');
  const productIds = [...new Set(requestedItems.map(item => id(item.parentProductId, 'product reference')))];
  const products = await Promise.all(productIds.map(productId => transaction.get(db.collection('finishedGoods').doc(productId))));
  const productsById = Object.fromEntries(products.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { ...snapshot.data(), id: snapshot.id }]));
  const groupIds = [...new Set(Object.values(productsById).flatMap(product => Array.isArray(product.addOnGroupIds) ? product.addOnGroupIds : []))];
  const groups = await Promise.all(groupIds.map(groupId => transaction.get(db.collection('addOnGroups').doc(id(groupId, 'add-on group reference')))));
  const groupsById = Object.fromEntries(groups.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { ...snapshot.data(), id: snapshot.id }]));
  const componentIds = collectRequiredComponentFinishedGoodIds({ products: productsById, groupsById }).filter(componentId => !productsById[componentId]);
  const components = await Promise.all(componentIds.map(componentId => transaction.get(db.collection('finishedGoods').doc(id(componentId, 'component reference')))));
  const componentProductsById = { ...productsById, ...Object.fromEntries(components.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { ...snapshot.data(), id: snapshot.id }])) };
  const gst = await transaction.get(db.collection('appSettings').doc('gstConfig'));
  const canonical = canonicalizeRequestedCart({ storeId: store.id, store, requestedItems, productsById, groupsById, componentProductsById, gstConfig: gst.exists ? gst.data() : null });
  if (!isDeepStrictEqual(canonical.canonicalItems, authorization.canonicalItems) || canonical.canonicalAddOnTotal !== authorization.canonicalAddOnTotal) fail('failed-precondition', 'Canonical prices, eligibility or selections changed. Refresh this checkout safely before retrying.');
  return { ...canonical, productsById };
}

// Internal backend writer. Callers must derive and validate these values from
// trusted server state inside their transaction. No callable accepts this context.
function writeCanonicalSale(transaction, { db, admin, orderRef, orderData, canonicalItems, financials, productsById, expandedInventoryLines, inventoryPlan, staff, selectedStore }) {
  const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
  const movementId = movement => {
    const stockKey = movement.stockDocId || [movement.stockItemType, movement.stockItemCode].filter(Boolean).join('_') || 'STOCK';
    return sanitizeId(`${orderRef.id}_${stockKey}_${movement.orderLineKey || 'ORDER'}_${movement.movementType || 'SALE_DEDUCTION'}_${movement.unit || 'UOM'}`, 360);
  };
  const kotTasks = financials.itemIds.flatMap(lineId => {
    const line = canonicalItems[lineId]; const product = productsById[line.parentProductId];
    return buildKotTasks({ quantity: line.quantity, finishedGood: { ...product, prepStation: prepStation(product.prepStation) }, components: line.components || [] }).map(task => ({ lineId, task, id: sanitizeId(`${orderRef.id}_KOT_${task.taskKey}_${shortHash(lineId)}`, 220) }));
  });
  const paths = [orderRef.path, ...inventoryPlan.stockUpdates.map(update => update.ref.path), ...inventoryPlan.movementPayloads.map(movement => db.collection('stockMovements').doc(movementId(movement)).path), ...inventoryPlan.pendingConsumptionPayloads.map(pending => db.collection('pendingInventoryConsumption').doc(pending.idempotencyKey).path), ...financials.itemIds.map(id => orderRef.collection('items').doc(id).path), ...financials.paymentIds.map(id => orderRef.collection('payments').doc(id).path), ...kotTasks.map(task => db.collection('kotItems').doc(task.id).path)];
  if (new Set(paths).size !== paths.length) fail('failed-precondition', 'Derived checkout effect identities collide. No sale was committed.');
  inventoryPlan.stockUpdates.forEach(update => {
    if (update.existed) transaction.update(update.ref, { currentStock: update.newQty, updatedAt: timestamp() });
    else transaction.set(update.ref, { ...update.seedData, currentStock: update.newQty, createdAt: timestamp(), updatedAt: timestamp() });
  });
  inventoryPlan.movementPayloads.forEach(movement => {
    transaction.create(db.collection('stockMovements').doc(movementId(movement)), movement);
  });
  inventoryPlan.pendingConsumptionPayloads.forEach(pending => transaction.create(db.collection('pendingInventoryConsumption').doc(pending.idempotencyKey), pending));
  transaction.create(orderRef, orderData);
  for (const lineId of financials.itemIds) {
    const line = canonicalItems[lineId];
    const product = productsById[line.parentProductId];
    const station = prepStation(product.prepStation);
    const inventory = summarizeParentInventory({ parentLineKey: lineId, expandedLines: expandedInventoryLines, perLineCogs: inventoryPlan.perLineCogs, perLineConsumptionStatus: inventoryPlan.perLineConsumptionStatus });
    transaction.create(orderRef.collection('items').doc(lineId), {
      menuItemId: line.parentProductId, itemName: product.displayName || product.name || line.parentProductCode, itemCode: line.parentProductCode,
      categoryId: product.categoryId || '', categoryName: product.categoryName || '', quantity: line.quantity,
      unitPrice: line.baseUnitPrice, baseUnitPrice: line.baseUnitPrice, addOns: line.addOns, addOnAuthorizationId: orderData.addOnAuthorizationId,
      addOnTotal: line.addOnTotal, unitPriceWithAddOns: line.baseUnitPrice + line.addOnTotal, taxRate: line.taxRate,
      ...financials.lines[lineId], cogsAmount: inventory.cogsAmount, inventoryConsumptionStatus: inventory.inventoryConsumptionStatus,
      prepStation: station, status: 'PENDING', createdAt: timestamp(), sourceSystem: 'FINISHED_GOODS', itemType: product.itemType || 'NO_STOCK',
      finishedGoodCode: line.parentProductCode, ...(line.components?.length ? { components: line.components } : {}),
    });
    kotTasks.filter(entry => entry.lineId === lineId).forEach(({ task, id: kotId }) => {
      transaction.create(db.collection('kotItems').doc(kotId), {
        orderId: orderRef.id, orderNumber: orderData.orderNumber, orderItemId: lineId,
        storeId: selectedStore.id, storeCode: selectedStore.code, storeName: selectedStore.name,
        station: task.station, itemName: task.itemName, itemCode: task.itemCode, quantity: task.quantity, addOns: line.addOns,
        ...(task.component ? { component: task.component } : {}), orderType: orderData.orderType, tableNumber: orderData.orderType === 'DINE_IN' ? orderData.tableNumber : null,
        ...(orderData.onlineOrderId ? { onlineOrderId: orderData.onlineOrderId, onlineOrderTrackingToken: orderData.onlineOrderTrackingToken || null, onlineOrderReference: orderData.onlineOrderReference || null } : {}),
        customerName: orderData.customerName || null, status: 'PENDING', createdAt: timestamp(), updatedAt: timestamp(), createdByUserId: staff.uid, createdByName: staff.name,
      });
    });
  }
  for (const paymentId of financials.paymentIds) transaction.create(orderRef.collection('payments').doc(paymentId), { ...financials.payments[paymentId], reference: financials.payments[paymentId].reference || null, createdAt: timestamp() });
}

async function loadSavedResult(db, orderRef, replayed) {
  const [order, items, payments] = await Promise.all([orderRef.get(), orderRef.collection('items').get(), orderRef.collection('payments').get()]);
  if (!order.exists) fail('internal', 'The completed checkout could not be read. Keep its original identity for recovery.');
  const savedOrder = { id: order.id, ...order.data() };
  const ordered = (documents, ids) => {
    const rows = documents.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    if (!Array.isArray(ids)) return rows;
    const byId = new Map(rows.map(row => [row.id, row]));
    return [...ids.map(id => byId.get(id)).filter(Boolean), ...rows.filter(row => !ids.includes(row.id))];
  };
  return plain({ savedOrder, savedItems: ordered(items.docs, savedOrder.financialItemIds), savedPayments: ordered(payments.docs, savedOrder.financialPaymentIds), ...(replayed ? { existingOrderId: orderRef.id } : {}) });
}

async function commitPosOrder({ admin, db, request }) {
  const uid = request.auth?.uid;
  if (!uid) fail('unauthenticated', 'Staff sign-in is required.');
  const input = normalizeRequest(request.data);
  const authorizationRef = db.collection('posAddOnAuthorizations').doc(input.authorizationId);
  const orderRef = db.collection('orders').doc(input.orderId);
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const replayed = await db.runTransaction(async transaction => {
    const [authorizationSnapshot, existingOrderSnapshot, staffSnapshot] = await Promise.all([transaction.get(authorizationRef), transaction.get(orderRef), transaction.get(db.collection('users').doc(uid))]);
    if (!authorizationSnapshot.exists) fail('failed-precondition', 'The POS financial authorization was not found.');
    const authorization = authorizationSnapshot.data();
    if (authorization.provider !== 'SERVER_CANONICAL_ADD_ONS' || authorization.staffUid !== uid || authorization.orderId !== input.orderId || authorization.sourceOnlineOrderId || authorization.financials?.version !== FINANCIAL_VERSION) fail('permission-denied', 'The POS financial authorization does not match this checkout.');
    const storeId = id(authorization.storeId, 'store reference');
    const storeSnapshot = await transaction.get(db.collection('stores').doc(storeId));
    const staffProfile = staffSnapshot.exists ? staffSnapshot.data() : null;
    if (!isAuthorizedStaffProfile(staffProfile, storeId) || !storeSnapshot.exists) fail('permission-denied', 'Active assigned staff and store are required.');
    const store = await require('./storeGstTreatment').resolveGstStore({ ...storeSnapshot.data(), id: storeSnapshot.id }, async id => { const snapshot = await transaction.get(db.collection('stores').doc(id)); return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null; });
    const staff = { uid, name: String(staffProfile.displayName || staffProfile.name || request.auth.token?.name || 'Staff').trim().slice(0, 120) };
    let financials;
    try { financials = authorizeFinancials({ canonicalItems: authorization.canonicalItems, itemIds: authorization.financials.itemIds, orderId: input.orderId, role: staffProfile.role, ...authorization.financialRequest }); }
    catch (error) { fail(error.code || 'failed-precondition', error.message); }
    if (!isDeepStrictEqual(financials, authorization.financials) || !isDeepStrictEqual(input.expectedFinancials, financials)) fail('failed-precondition', 'The checkout financial snapshot does not match the server-authorized sale.');
    const complimentary = financials.commercialStatus === 'COMPLIMENTARY';
    if (complimentary && financials.subtotal <= 0) fail('failed-precondition', 'Complimentary checkout requires a positive menu value.');
    if (complimentary && (!input.customerName || !input.complimentaryReason || !/^[6-9][0-9]{9}$/.test(input.customerPhone) || !input.complimentaryAuthorizationId)) fail('failed-precondition', 'Complimentary checkout requires its verified customer and reason.');
    if (!complimentary && (input.complimentaryAuthorizationId || input.complimentaryReason)) fail('invalid-argument', 'Unexpected complimentary fields.');
    const digest = contentDigest({ staffUid: uid, storeId, orderId: input.orderId, canonicalItems: authorization.canonicalItems, financials, idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash, orderType: input.orderType, tableNumber: input.tableNumber, customerName: input.customerName, customerPhone: input.customerPhone, complimentaryReason: input.complimentaryReason, complimentaryAuthorizationId: input.complimentaryAuthorizationId });
    if (existingOrderSnapshot.exists) {
      const existing = existingOrderSnapshot.data();
      if (existing.createdByUserId !== uid || existing.storeId !== storeId || existing.clientCheckoutIdempotencyKey !== input.idempotencyKey || existing.checkoutPayloadHash !== input.payloadHash || existing.checkoutContentDigest !== digest || existing.financialAuthorizationVersion !== FINANCIAL_VERSION) fail('already-exists', 'Checkout retry conflict: the saved sale has a different checkout identity or content.');
      return true;
    }
    if (authorization.used !== false || expiry(authorization.expiresAt) <= Date.now()) fail('failed-precondition', 'The POS financial authorization is expired or already used.');
    const setupTest = isDraftSetupTestAuthorizationAllowed({ storeId, store, staff: staffProfile, checkoutMode: authorization.checkoutMode, checkoutSource: authorization.checkoutSource, paymentMethod: authorization.financialRequest.paymentMethod });
    if ((store.isActive !== true && !setupTest) || store.posEnabled === false) fail('failed-precondition', 'The selected store is not active for POS checkout.');
    const inventoryStore = await resolveInventoryStore(store, async inventoryStoreId => {
      const snapshot = await transaction.get(db.collection('stores').doc(inventoryStoreId));
      return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
    });
    if (!isAuthorizedStaffForStorePair(staffProfile, storeId, inventoryStore.id)) fail('permission-denied', 'This staff account cannot consume inventory at the configured store.');
    const { canonicalItems, productsById } = await canonicalCartInTransaction({ transaction, db, authorization, store });
    const counterRef = db.collection('counters').doc(`${store.code}_${dateKey}`);
    const counterSnapshot = await transaction.get(counterRef);
    const sequence = counterSnapshot.exists ? Number(counterSnapshot.data().lastSequence || 0) + 1 : 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail('failed-precondition', 'The order sequence requires review.');
    const orderNumber = `CB-${store.code}-${dateKey}-${String(sequence).padStart(4, '0')}`;
    const expandedInventoryLines = expandCompositeInventoryLines(financials.itemIds.map(lineId => ({ lineKey: lineId, quantity: canonicalItems[lineId].quantity, finishedGood: productsById[canonicalItems[lineId].parentProductId], addOns: canonicalItems[lineId].addOns, components: canonicalItems[lineId].components || [] })), storeId);
    const inventoryPlan = await planOnlineOrderInventory({ transaction, db, admin, store: { ...store, inventoryPolicy: 'ALLOW_NEGATIVE_DEFER_BOM' }, orderId: input.orderId, orderNumber, orderType: input.orderType, businessDate: dateKey, staff, lines: expandedInventoryLines, requireAvailableStock: false, deferIncompleteBom: true, aggregateLineConsumption: true, source: 'POS' });
    if (inventoryPlan.blockers.length) fail('failed-precondition', 'The inventory configuration requires review before this sale can be committed.');
    let complimentaryRef = null; let complimentaryAuthorization = null; let customerRef = null; let customerSnapshot = null;
    if (complimentary) {
      complimentaryRef = db.collection('complimentaryAuthorizations').doc(input.complimentaryAuthorizationId);
      const snapshot = await transaction.get(complimentaryRef);
      complimentaryAuthorization = snapshot.exists ? snapshot.data() : null;
      if (!complimentaryAuthorization || complimentaryAuthorization.status !== 'VERIFIED' || complimentaryAuthorization.used !== false || complimentaryAuthorization.staffUid !== uid || complimentaryAuthorization.storeId !== storeId || complimentaryAuthorization.customerPhoneE164 !== `+91${input.customerPhone}` || complimentaryAuthorization.provider !== 'FIREBASE_PHONE_AUTH' || expiry(complimentaryAuthorization.expiresAt) <= Date.now()) fail('failed-precondition', 'Complimentary phone verification is expired, used, or does not match this sale.');
      const customers = await transaction.get(db.collection('customers').where('phone', '==', input.customerPhone).limit(1));
      customerSnapshot = customers.docs[0] || null;
      customerRef = customerSnapshot ? customerSnapshot.ref : db.collection('customers').doc();
    }
    const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
    const orderData = {
      orderNumber, storeId, storeCode: store.code, storeName: store.name, customerId: customerRef?.id || null,
      customerName: input.customerName || null, customerPhone: input.customerPhone || null, source: 'POS',
      ...(!complimentary && input.customerPhone ? { customerPhoneVerification: 'UNVERIFIED', customerContactSource: 'STAFF_ENTERED', customerMarketingConsent: false } : {}),
      createdByUserId: uid, createdByName: staff.name, orderType: input.orderType, tableNumber: input.tableNumber || null, status: 'COMPLETED',
      paymentStatus: financials.paymentStatus, commercialStatus: financials.commercialStatus,
      isSetupTest: setupTest, setupTestMode: setupTest, setupTestLabel: setupTest ? 'SETUP TEST' : null, setupTestStoreStatus: setupTest ? String(store.status || 'DRAFT') : null,
      addOnAuthorizationId: input.authorizationId, addOnTotal: authorization.canonicalAddOnTotal,
      subtotal: financials.subtotal, taxTotal: financials.taxTotal, gstTotal: financials.gstTotal, taxableAmount: financials.taxableAmount,
      discountPercent: financials.discountPercent, discountAmount: financials.discountAmount, discountTotal: financials.discountAmount, discount: financials.discountAmount, grandTotal: financials.grandTotal,
      cogsTotal: inventoryPlan.totalCogs, inventoryWarningCount: inventoryPlan.warnings.length, inventoryWarnings: inventoryPlan.warnings.map(warning => warning.message), inventoryConsumptionStatus: inventoryPlan.pendingConsumptionPayloads.length ? 'PENDING_BOM' : 'APPLIED', stockMovementCount: inventoryPlan.movementPayloads.length,
      clientCheckoutIdempotencyKey: input.idempotencyKey, checkoutPayloadHash: input.payloadHash, checkoutIdempotencyVersion: 1,
      checkoutContentDigest: digest, financialAuthorizationVersion: FINANCIAL_VERSION, financialItemIds: financials.itemIds, financialPaymentIds: financials.paymentIds,
      paymentMethod: financials.paymentMethod, ...(financials.isSplitPayment ? { isSplitPayment: true, paymentMethodLabel: financials.paymentIds.map(paymentId => financials.payments[paymentId]).map(row => `${row.method} ₹${row.amount.toFixed(2)}`).join(' + '), paymentBreakdown: financials.paymentIds.map(paymentId => { const { method, amount } = financials.payments[paymentId]; return { method, amount }; }) } : {}),
      gstTreatmentSnapshot: require('./storeGstTreatment').treatment(store), receiptLegalDetails: receiptLegalDetails(store), createdAt: timestamp(), updatedAt: timestamp(),
      ...(complimentary ? { menuValue: financials.subtotal, complimentaryDiscount: financials.subtotal, complimentaryReason: input.complimentaryReason, complimentaryAuthorizationId: input.complimentaryAuthorizationId, complimentaryOtpVerified: true, complimentaryVerifiedPhone: input.customerPhone, complimentaryOtpProvider: complimentaryAuthorization.provider, complimentaryAuthorisedByUid: uid, complimentaryAuthorisedByName: staff.name, complimentaryAuthorisedAt: timestamp() } : {}),
    };
    // No writes precede the completed identity/financial/availability/OTP reads.
    writeCanonicalSale(transaction, { db, admin, orderRef, orderData, canonicalItems, financials, productsById, expandedInventoryLines, inventoryPlan, staff, selectedStore: store });
    if (counterSnapshot.exists) transaction.update(counterRef, { lastSequence: sequence, updatedAt: timestamp() });
    else transaction.create(counterRef, { storeCode: store.code, dateKey, lastSequence: sequence, updatedAt: timestamp() });
    transaction.update(authorizationRef, { used: true, usedAt: timestamp(), orderNumber });
    if (complimentaryRef) transaction.update(complimentaryRef, { used: true, usedAt: timestamp(), usedByOrderId: input.orderId, usedByOrderNumber: orderNumber });
    if (customerRef) {
      if (customerSnapshot) transaction.update(customerRef, { visitCount: (Number(customerSnapshot.data().visitCount) || 0) + 1, totalSpend: (Number(customerSnapshot.data().totalSpend) || 0) + financials.grandTotal, lastVisitAt: timestamp(), updatedAt: timestamp(), name: input.customerName });
      else transaction.create(customerRef, { name: input.customerName, phone: input.customerPhone, visitCount: 1, totalSpend: financials.grandTotal, lastVisitAt: timestamp(), createdAt: timestamp(), updatedAt: timestamp() });
    }
    return false;
  });
  return loadSavedResult(db, orderRef, replayed);
}

function createPosCheckoutCommitFunction({ admin, db, region }) { return onCall({ region }, request => commitPosOrder({ admin, db, request })); }
module.exports = { createPosCheckoutCommitFunction, createCommitPosOrderFunction: createPosCheckoutCommitFunction, commitPosOrder, loadSavedResult, normalizeRequest, plain, prepStation, receiptLegalDetails, writeCanonicalSale };
