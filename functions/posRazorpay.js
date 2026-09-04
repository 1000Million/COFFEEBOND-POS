'use strict';

const { randomBytes } = require('node:crypto');
const Razorpay = require('razorpay');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const {
  isAuthorizedStaffForStorePair,
  isAuthorizedStaffProfile,
} = require('./complimentaryAuthorizationPolicy');
const { resolveInventoryStore } = require('./inventoryStoreResolver');
const { planOnlineOrderInventory } = require('./onlineOrderInventory');
const {
  canonicalizeRequestedCart,
  sanitizeCartItems,
} = require('./posAddOnAuthorization');
const {
  CompositeProductPolicyError,
  collectRequiredComponentFinishedGoodIds,
} = require('./compositeProductPolicy');
const {
  buildKotTasks,
  expandCompositeInventoryLines,
  summarizeParentInventory,
} = require('./compositeFulfillment');
const {
  CURRENCY,
  PROVIDER,
  cleanText,
  isFinalProviderState,
  providerMethod,
  rupeesToPaise,
  safeProviderError,
  sha256,
  verifyWebhookSignature,
} = require('./razorpayCheckoutPolicy');
const {
  razorpayClient,
} = require('./razorpayCheckout');

const POS_SESSION_COLLECTION = 'posRazorpaySessions';
const POS_WEBHOOK_AUDIT_COLLECTION = 'posRazorpayWebhookEvents';
const REFUND_COLLECTION = 'razorpayRefunds';
// Razorpay Dynamic QR requires close_by to be at least 15 minutes ahead.
// A one-minute margin prevents request latency from falling below that limit.
const POS_SESSION_TTL_MS = 16 * 60 * 1000;
const PROVIDER_CREATION_LEASE_MS = 60 * 1000;
const REFUND_REQUEST_LEASE_MS = 2 * 60 * 1000;
const POS_WEBHOOK_LEASE_MS = 2 * 60 * 1000;
const POS_RAZORPAY_KEY_ID = defineString('POS_RAZORPAY_KEY_ID', { default: '' });
const POS_RAZORPAY_KEY_SECRET = defineSecret('POS_RAZORPAY_KEY_SECRET');
const POS_RAZORPAY_WEBHOOK_SECRET = defineSecret('POS_RAZORPAY_WEBHOOK_SECRET');
const POS_RAZORPAY_DYNAMIC_QR_ENABLED = defineString('POS_RAZORPAY_DYNAMIC_QR_ENABLED', { default: 'false' });
const POS_RAZORPAY_EXPECTED_MODE = 'TEST';
const POS_RAZORPAY_MODE_MISMATCH_MESSAGE = 'POS Razorpay mode mismatch: Test Mode required';
const POS_PAYMENT_WEBHOOK_EVENTS = new Set(['payment_link.paid', 'qr_code.credited', 'payment.failed']);
const POS_REFUND_WEBHOOK_EVENTS = new Set(['refund.created', 'refund.processed', 'refund.failed']);
const ACTIVE_SESSION_STATUSES = new Set(['CREATING', 'WAITING_FOR_PAYMENT', 'RECOVERING']);
const FINAL_SESSION_STATUSES = new Set(['PAYMENT_CAPTURED', 'EXPIRED', 'CANCELLED', 'FAILED']);

function fail(code, message) {
  throw new HttpsError(code, message);
}

function booleanParameter(parameter) {
  return String(parameter?.value?.() || 'false').trim().toLowerCase() === 'true';
}

function assertPosRazorpayTestMode(value) {
  const keyId = cleanText(value, 120);
  if (POS_RAZORPAY_EXPECTED_MODE !== 'TEST' || !/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) {
    fail('failed-precondition', POS_RAZORPAY_MODE_MISMATCH_MESSAGE);
  }
  return keyId;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function safeDocId(value, maxLength = 480) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || 'ID').slice(0, maxLength);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function checksum(value) {
  return sha256(stableJson(value));
}

function sessionIdFor(idempotencyKey) {
  return `POSRZP_${sha256(cleanText(idempotencyKey, 160)).slice(0, 48).toUpperCase()}`;
}

function posOrderIdFor(idempotencyKey) {
  return safeDocId(`POS_${cleanText(idempotencyKey, 160)}`, 180);
}

function providerReferenceFor(sessionId) {
  return `CBPOS${sha256(sessionId).slice(0, 28).toUpperCase()}`;
}

function deterministicRefundId(orderId) {
  return `POSREF_${sha256(orderId).slice(0, 32).toUpperCase()}`;
}

async function createIdempotentProviderRefund({
  keyId,
  keySecret,
  paymentId,
  refundId,
  payload,
  fetchImpl = globalThis.fetch,
}) {
  if (!keyId || !keySecret) fail('failed-precondition', 'Online payment is not configured.');
  if (typeof fetchImpl !== 'function') throw new Error('Provider refund transport is unavailable.');
  const response = await fetchImpl(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/json',
        'X-Refund-Idempotency': refundId,
      },
      body: JSON.stringify(payload),
    },
  );
  const responseText = await response.text();
  let result = null;
  try {
    result = responseText ? JSON.parse(responseText) : null;
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw {
      statusCode: response.status,
      error: result?.error || { code: `HTTP_${response.status}` },
    };
  }
  if (!result || typeof result !== 'object') {
    throw Object.assign(new Error('Provider refund response was invalid.'), { statusCode: 502 });
  }
  return result;
}

function deterministicKotId(orderId, lineId, taskKey) {
  return safeDocId(`${orderId}_KOT_${taskKey}_${sha256(lineId).slice(0, 16).toUpperCase()}`, 220);
}

function deterministicMovementId(orderId, movement) {
  const stockKey = movement.stockDocId
    || [movement.stockItemType, movement.stockItemCode].filter(Boolean).join('_')
    || 'STOCK';
  return safeDocId(`${orderId}_${stockKey}_${movement.orderLineKey || 'ORDER'}_${movement.movementType || 'SALE_DEDUCTION'}_${movement.unit || 'UOM'}`, 360);
}

function normalizePrepStation(value) {
  const normalized = String(value || 'NONE').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'BARISTA' || normalized === 'BAR') return 'BARISTA';
  if (normalized === 'KITCHEN' || normalized === 'KITCHEN_KOT') return 'KITCHEN';
  if (normalized === 'BOTH' || normalized === 'BARISTA_KITCHEN' || normalized === 'BAR_AND_KITCHEN') return 'BOTH';
  return 'NONE';
}

function maxDiscountPercent(role) {
  if (role === 'ADMIN') return 100;
  if (role === 'STORE_MANAGER') return 20;
  return 10;
}

async function staffIdentity(request, db, allowedRoles) {
  const uid = cleanText(request.auth?.uid, 128);
  if (!uid) fail('unauthenticated', 'Staff sign-in is required.');
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) fail('permission-denied', 'Active staff profile is required.');
  const profile = snapshot.data() || {};
  const active = profile.isActive === true || profile.active === true;
  if (!active || !allowedRoles.includes(profile.role)) {
    fail('permission-denied', 'This staff role cannot perform this action.');
  }
  return {
    uid,
    name: cleanText(profile.displayName || profile.name || request.auth?.token?.name || 'Staff', 120),
    role: profile.role,
    profile,
  };
}

function assertStoreAccess(staff, storeId) {
  if (!isAuthorizedStaffProfile(staff.profile, storeId)) {
    fail('permission-denied', 'This staff account cannot take payments for this store.');
  }
}

function toIso(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function sessionResponse(session) {
  return {
    sessionId: session.sessionId || session.id,
    status: session.status,
    amount: Number(session.grandTotal || 0),
    amountPaise: Number(session.amountPaise || 0),
    currency: CURRENCY,
    providerRequestType: session.providerRequestType || null,
    providerPaymentLinkId: session.providerPaymentLinkId || null,
    providerQrCodeId: session.providerQrCodeId || null,
    paymentUrl: session.paymentUrl || null,
    qrImageUrl: session.qrImageUrl || null,
    expiresAt: toIso(session.expiresAt),
    checkoutPayloadHash: session.checkoutPayloadHash,
    orderId: session.orderId,
    orderNumber: session.orderNumber || null,
    providerMethod: session.providerMethod || null,
    failureCode: session.failureCode || null,
    failureMessage: session.failureMessage || null,
  };
}

function receiptLegalDetails(store) {
  return {
    legalName: cleanText(store.legalName, 160) || null,
    tradeName: cleanText(store.tradeName, 160) || null,
    legalAddress: cleanText(store.legalAddress || store.address, 300) || null,
    gstin: cleanText(store.gstin, 30) || null,
    stateName: cleanText(store.stateName || store.state, 80) || null,
    stateCode: cleanText(store.stateCode, 12) || null,
    gstRegistered: store.gstRegistered === true,
  };
}

function sanitizeOrderType(value) {
  const normalized = cleanText(value, 24).toUpperCase();
  if (!['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(normalized)) {
    fail('invalid-argument', 'Select a valid order type.');
  }
  return normalized;
}

function providerPaymentIdFromRequest(providerRequest) {
  const payments = Array.isArray(providerRequest?.payments) ? providerRequest.payments : [];
  const captured = payments.find(payment => (
    ['captured', 'paid'].includes(String(payment?.status || '').toLowerCase())
  ));
  return cleanText(
    captured?.payment_id || captured?.id,
    120,
  ) || null;
}

async function canonicalizePosRequest({ request, db, admin, staff, sessionId, orderId }) {
  const storeId = cleanText(request.data?.storeId, 120);
  const orderType = sanitizeOrderType(request.data?.orderType);
  const tableNumber = cleanText(request.data?.tableNumber, 20);
  const customerName = cleanText(request.data?.customerName, 80);
  const customerPhone = cleanText(request.data?.customerPhone, 20);
  const notes = cleanText(request.data?.notes, 200);
  const discountPercent = Number(request.data?.discountPercent || 0);
  if (!storeId) fail('invalid-argument', 'Store is required.');
  assertStoreAccess(staff, storeId);
  if (orderType === 'DINE_IN' && !tableNumber) fail('invalid-argument', 'Table number is required for dine in orders.');
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > maxDiscountPercent(staff.role)) {
    fail('failed-precondition', `Discount exceeds the ${maxDiscountPercent(staff.role)}% limit for this role.`);
  }
  if (request.data?.paymentMethod && request.data.paymentMethod !== 'RAZORPAY') {
    fail('invalid-argument', 'Razorpay is a full-payment tender only.');
  }
  if (request.data?.isSplitPayment === true || Array.isArray(request.data?.paymentBreakdown)) {
    fail('invalid-argument', 'Razorpay cannot be used in Split payment during Phase 1.');
  }

  const requestedItems = sanitizeCartItems(request.data?.items);
  return db.runTransaction(async transaction => {
    const storeRef = db.collection('stores').doc(storeId);
    const gstRef = db.collection('appSettings').doc('gstConfig');
    const productRefs = requestedItems.map(item => db.collection('finishedGoods').doc(item.parentProductId));
    const [storeSnapshot, gstSnapshot, ...productSnapshots] = await Promise.all([
      transaction.get(storeRef),
      transaction.get(gstRef),
      ...productRefs.map(ref => transaction.get(ref)),
    ]);
    if (!storeSnapshot.exists) fail('not-found', 'The selected store was not found.');
    const store = { id: storeSnapshot.id, ...storeSnapshot.data() };
    if (store.isActive !== true || store.posEnabled === false) {
      fail('failed-precondition', 'The selected store is not active for staff POS.');
    }
    let inventoryStore;
    try {
      inventoryStore = await resolveInventoryStore(store, async inventoryStoreId => {
        const snapshot = await transaction.get(db.collection('stores').doc(inventoryStoreId));
        return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
      });
    } catch (_error) {
      fail('failed-precondition', 'The selected store inventory configuration is invalid.');
    }
    if (!isAuthorizedStaffForStorePair(staff.profile, store.id, inventoryStore.id)) {
      fail('permission-denied', 'This staff account must be assigned to both the sales and inventory stores.');
    }
    if (productSnapshots.some(snapshot => !snapshot.exists)) {
      fail('failed-precondition', 'One or more products are no longer available.');
    }
    const products = productSnapshots.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    const productsById = Object.fromEntries(products.map(product => [product.id, product]));
    const groupIds = [...new Set(products.flatMap(product => (
      Array.isArray(product.addOnGroupIds) ? product.addOnGroupIds : []
    )))];
    const groupSnapshots = await Promise.all(
      groupIds.map(groupId => transaction.get(db.collection('addOnGroups').doc(groupId))),
    );
    const groupsById = Object.fromEntries(
      groupSnapshots.filter(snapshot => snapshot.exists).map(snapshot => [snapshot.id, { id: snapshot.id, ...snapshot.data() }]),
    );
    let componentProductIds;
    try {
      componentProductIds = collectRequiredComponentFinishedGoodIds({
        products: productsById,
        groupsById,
      });
    } catch (error) {
      if (error instanceof CompositeProductPolicyError) {
        fail('failed-precondition', error.message);
      }
      throw error;
    }
    const componentProductSnapshots = await Promise.all(
      componentProductIds.map(productId => transaction.get(db.collection('finishedGoods').doc(productId))),
    );
    const componentProductsById = {
      ...productsById,
      ...Object.fromEntries(componentProductSnapshots
        .filter(snapshot => snapshot.exists)
        .map(snapshot => [snapshot.id, { id: snapshot.id, ...snapshot.data() }])),
    };
    const canonical = canonicalizeRequestedCart({
      storeId,
      store,
      gstConfig: gstSnapshot.exists ? gstSnapshot.data() : null,
      requestedItems,
      productsById,
      groupsById,
      componentProductsById,
    });

    const subtotal = requestedItems.reduce((sum, requestedItem) => {
      const item = canonical.canonicalItems[requestedItem.orderItemId];
      return sum + (item.baseUnitPrice + item.addOnTotal) * requestedItem.quantity;
    }, 0);
    const discountAmount = subtotal * (discountPercent / 100);
    const discountRatio = subtotal > 0 ? discountAmount / subtotal : 0;
    const taxableAmount = Math.max(0, subtotal - discountAmount);
    const lines = requestedItems.map(requestedItem => {
      const product = productsById[requestedItem.parentProductId];
      const item = canonical.canonicalItems[requestedItem.orderItemId];
      const baseSubtotal = item.baseUnitPrice * requestedItem.quantity;
      const addOnSubtotal = item.addOnTotal * requestedItem.quantity;
      const lineSubtotal = baseSubtotal + addOnSubtotal;
      const lineDiscount = lineSubtotal * discountRatio;
      const lineTaxable = Math.max(0, lineSubtotal - lineDiscount);
      const baseTaxable = Math.max(0, baseSubtotal * (1 - discountRatio));
      const lineTax = baseTaxable * item.taxRate / 100 + item.addOns.reduce((sum, addOn) => (
        sum + addOn.totalPrice * requestedItem.quantity * (1 - discountRatio) * addOn.taxRate / 100
      ), 0);
      return {
        lineId: requestedItem.orderItemId,
        parentProductId: product.id,
        parentProductCode: product.code,
        itemName: product.displayName || product.name,
        categoryId: product.posCategoryCode || product.categoryId || 'MISC',
        categoryName: product.posCategoryName || product.categoryName || 'Misc',
        quantity: requestedItem.quantity,
        baseUnitPrice: item.baseUnitPrice,
        taxRate: item.taxRate,
        addOns: item.addOns,
        addOnTotal: item.addOnTotal,
        components: item.components || [],
        lineSubtotal: roundMoney(lineSubtotal),
        lineDiscount: roundMoney(lineDiscount),
        lineTaxable: roundMoney(lineTaxable),
        lineTax: roundMoney(lineTax),
        lineTotal: roundMoney(lineTaxable + lineTax),
        prepStation: normalizePrepStation(product.prepStation),
        finishedGood: {
          id: product.id,
          code: product.code,
          name: product.name,
          displayName: product.displayName || product.name,
          itemType: product.itemType,
          productionMode: product.productionMode,
          bom: Array.isArray(product.bom) ? product.bom : [],
          availableStoreIds: Array.isArray(product.availableStoreIds) ? product.availableStoreIds : [],
          isActive: product.isActive,
          isSellable: product.isSellable,
          isAvailable: product.isAvailable,
          prepStation: normalizePrepStation(product.prepStation),
          recipeCost: finiteNumber(product.recipeCost),
          posCategoryCode: product.posCategoryCode || product.categoryId || 'MISC',
          posCategoryName: product.posCategoryName || product.categoryName || 'Misc',
        },
      };
    });
    const gstTotal = lines.reduce((sum, line) => sum + line.lineTax, 0);
    const totals = {
      subtotal: roundMoney(subtotal),
      discountPercent: roundMoney(discountPercent),
      discountAmount: roundMoney(discountAmount),
      taxableAmount: roundMoney(taxableAmount),
      gstTotal: roundMoney(gstTotal),
      grandTotal: roundMoney(taxableAmount + gstTotal),
    };
    const amountPaise = rupeesToPaise(totals.grandTotal);
    const businessDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const expandedInventoryLines = expandCompositeInventoryLines(lines.map(line => ({
      lineKey: line.lineId,
      quantity: line.quantity,
      finishedGood: line.finishedGood,
      addOns: line.addOns,
      components: line.components,
    })), store.id);
    const preflight = await planOnlineOrderInventory({
      transaction,
      db,
      admin,
      store,
      orderId,
      orderNumber: `PENDING-${sessionId}`,
      orderType,
      businessDate,
      staff: { uid: staff.uid, name: staff.name },
      lines: expandedInventoryLines,
      requireAvailableStock: true,
      source: 'POS_RAZORPAY',
    });
    if (preflight.blockers.length > 0) {
      fail('failed-precondition', preflight.blockers.map(blocker => blocker.suggestedAdminAction || blocker.blockerType).join(' '));
    }
    const requestPayload = {
      storeId,
      staffUid: staff.uid,
      orderId,
      orderType,
      tableNumber: orderType === 'DINE_IN' ? tableNumber : null,
      customerName,
      customerPhone,
      notes,
      tender: 'RAZORPAY',
      isSplitPayment: false,
      lines: lines.map(line => ({
        lineId: line.lineId,
        productId: line.parentProductId,
        productCode: line.parentProductCode,
        quantity: line.quantity,
        baseUnitPrice: line.baseUnitPrice,
        taxRate: line.taxRate,
        addOns: line.addOns,
        ...(line.components.length > 0 ? { components: line.components } : {}),
      })),
      totals,
    };
    return {
      amountPaise,
      businessDate,
      canonicalAddOnTotal: roundMoney(canonical.canonicalAddOnTotal),
      checkoutPayloadHash: checksum(requestPayload),
      customerName,
      customerPhone,
      inventoryPreflightWarnings: preflight.warnings.map(warning => warning.message),
      lines,
      notes,
      orderType,
      requestChecksum: checksum(requestPayload),
      store,
      tableNumber: orderType === 'DINE_IN' ? tableNumber : null,
      totals,
    };
  });
}

async function findExistingProviderRequest(client, providerRequestType, referenceId) {
  if (providerRequestType === 'DYNAMIC_QR' && typeof client.qrCode?.all === 'function') {
    const response = await client.qrCode.all({ count: 100 });
    return (response?.items || []).find(item => (
      cleanText(item?.notes?.coffee_bond_pos_reference, 80) === referenceId
    )) || null;
  }
  if (typeof client.paymentLink?.all !== 'function') return null;
  const response = await client.paymentLink.all({ reference_id: referenceId, count: 100 });
  return (response?.payment_links || response?.items || []).find(item => (
    cleanText(item?.reference_id, 80) === referenceId
  )) || null;
}

async function createProviderRequest({ client, session, dynamicQrEnabled, now }) {
  const closeAtSeconds = Math.floor((now + POS_SESSION_TTL_MS) / 1000);
  const referenceId = session.providerReferenceId;
  const providerRequestType = dynamicQrEnabled ? 'DYNAMIC_QR' : 'PAYMENT_LINK';
  const recovered = await findExistingProviderRequest(client, providerRequestType, referenceId);
  if (recovered) return { providerRequestType, entity: recovered, recovered: true };

  if (providerRequestType === 'DYNAMIC_QR') {
    const entity = await client.qrCode.create({
      type: 'upi_qr',
      name: `Coffee Bond ${session.storeCode}`.slice(0, 80),
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: session.amountPaise,
      description: `Coffee Bond POS ${session.orderId}`.slice(0, 255),
      close_by: closeAtSeconds,
      notes: {
        coffee_bond_pos_reference: referenceId,
        coffee_bond_store: sha256(session.storeId).slice(0, 20),
      },
    });
    return { providerRequestType, entity, recovered: false };
  }

  const entity = await client.paymentLink.create({
    amount: session.amountPaise,
    currency: CURRENCY,
    accept_partial: false,
    description: `Coffee Bond counter payment ${session.storeCode}`.slice(0, 255),
    reference_id: referenceId,
    expire_by: closeAtSeconds,
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: {
      coffee_bond_pos_reference: referenceId,
      coffee_bond_store: sha256(session.storeId).slice(0, 20),
    },
  });
  return { providerRequestType, entity, recovered: false };
}

function validateProviderRequest(providerRequest, amountPaise, referenceId) {
  const entity = providerRequest.entity;
  if (!cleanText(entity?.id, 120)) throw new Error('Provider payment request ID was not returned.');
  const providerAmount = Number(entity.amount || entity.payment_amount);
  if (!Number.isFinite(providerAmount) || providerAmount !== amountPaise) {
    throw new Error('Provider payment request amount failed validation.');
  }
  if (providerRequest.providerRequestType === 'PAYMENT_LINK') {
    if (!cleanText(entity.short_url, 500)) throw new Error('Provider payment link was not returned.');
    if (cleanText(entity.reference_id, 80) !== referenceId) {
      throw new Error('Provider payment link reference failed validation.');
    }
  }
  if (providerRequest.providerRequestType === 'DYNAMIC_QR') {
    if (!cleanText(entity.image_url, 1000)) throw new Error('Provider QR image was not returned.');
    if (
      cleanText(entity.notes?.coffee_bond_pos_reference, 80) !== referenceId
      || entity.fixed_amount !== true
      || entity.usage !== 'single_use'
    ) {
      throw new Error('Provider QR request failed validation.');
    }
  }
}

function verifyCapturedProviderPayment({ session, providerPayment, providerOrder }) {
  const providerOrderId = cleanText(providerPayment?.order_id || providerOrder?.id, 120) || null;
  if (session.providerRequestType === 'PAYMENT_LINK') {
    if (!providerOrderId || !providerOrder) return { valid: false, code: 'PROVIDER_ORDER_MISSING' };
    return {
      ...isFinalProviderState({
        payment: providerPayment,
        providerOrder,
        expectedOrderId: providerOrderId,
        expectedAmountPaise: session.amountPaise,
      }),
      providerOrderId,
    };
  }
  if (session.providerRequestType !== 'DYNAMIC_QR') {
    return { valid: false, code: 'PROVIDER_REQUEST_TYPE_INVALID', providerOrderId };
  }
  if (providerPayment?.status !== 'captured') {
    return { valid: false, code: 'PAYMENT_NOT_CAPTURED', providerOrderId };
  }
  if (Number(providerPayment.amount) !== session.amountPaise) {
    return { valid: false, code: 'PROVIDER_AMOUNT_MISMATCH', providerOrderId };
  }
  if (String(providerPayment.currency || '').toUpperCase() !== CURRENCY) {
    return { valid: false, code: 'PROVIDER_CURRENCY_MISMATCH', providerOrderId };
  }
  return { valid: true, code: null, providerOrderId };
}

async function createPosSession({ request, db, admin, keyId, keySecret, RazorpayClass, dynamicQrEnabled }) {
  const staff = await staffIdentity(request, db, ['ADMIN', 'STORE_MANAGER', 'CASHIER']);
  const idempotencyKey = cleanText(request.data?.checkoutIdempotencyKey, 160);
  if (!idempotencyKey) fail('invalid-argument', 'A stable checkout idempotency key is required.');
  const sessionId = sessionIdFor(idempotencyKey);
  const orderId = posOrderIdFor(idempotencyKey);
  const canonical = await canonicalizePosRequest({ request, db, admin, staff, sessionId, orderId });
  const sessionRef = db.collection(POS_SESSION_COLLECTION).doc(sessionId);
  const now = Date.now();
  const providerReferenceId = providerReferenceFor(sessionId);
  const configuredProviderRequestType = dynamicQrEnabled ? 'DYNAMIC_QR' : 'PAYMENT_LINK';
  const leaseId = `pos_rzp_${randomBytes(12).toString('hex')}`;
  const reservation = await db.runTransaction(async transaction => {
    const existingSnapshot = await transaction.get(sessionRef);
    const existing = existingSnapshot.exists ? { sessionId: existingSnapshot.id, ...existingSnapshot.data() } : null;
    if (existing) {
      if (
        existing.staffUid !== staff.uid
        || existing.storeId !== canonical.store.id
        || existing.requestChecksum !== canonical.requestChecksum
        || existing.amountPaise !== canonical.amountPaise
      ) {
        fail('already-exists', 'This checkout idempotency key belongs to a different store, cart, total, discount, tax, or tender.');
      }
      const retryableCreateFailure = existing.status === 'FAILED'
        && !existing.providerPaymentLinkId
        && !existing.providerQrCodeId;
      if (!retryableCreateFailure && (existing.providerPaymentLinkId || existing.providerQrCodeId || FINAL_SESSION_STATUSES.has(existing.status))) {
        return { kind: 'EXISTING', session: existing };
      }
      const leaseUntil = timestampMillis(existing.providerCreationLeaseUntil);
      if (existing.status === 'CREATING' && leaseUntil && leaseUntil > now) {
        return { kind: 'IN_PROGRESS', session: existing };
      }
    }
    const providerRequestType = existing?.providerRequestType || configuredProviderRequestType;
    transaction.set(sessionRef, {
      sessionId,
      checkoutIdempotencyKey: idempotencyKey,
      checkoutPayloadHash: canonical.checkoutPayloadHash,
      requestChecksum: canonical.requestChecksum,
      orderId,
      orderNumber: existing?.orderNumber || null,
      storeId: canonical.store.id,
      storeCode: canonical.store.code || canonical.store.storeCode || canonical.store.id,
      storeName: canonical.store.name,
      staffUid: staff.uid,
      staffName: staff.name,
      staffRole: staff.role,
      orderType: canonical.orderType,
      tableNumber: canonical.tableNumber,
      customerName: canonical.customerName || null,
      customerPhone: canonical.customerPhone || null,
      notes: canonical.notes || null,
      items: canonical.lines,
      subtotal: canonical.totals.subtotal,
      discountPercent: canonical.totals.discountPercent,
      discountAmount: canonical.totals.discountAmount,
      taxableAmount: canonical.totals.taxableAmount,
      gstTotal: canonical.totals.gstTotal,
      grandTotal: canonical.totals.grandTotal,
      canonicalAddOnTotal: canonical.canonicalAddOnTotal,
      amountPaise: canonical.amountPaise,
      currency: CURRENCY,
      tender: 'RAZORPAY',
      isSplitPayment: false,
      inventoryPreflightWarnings: canonical.inventoryPreflightWarnings,
      status: 'CREATING',
      provider: PROVIDER,
      providerReferenceId,
      providerRequestType,
      providerPaymentLinkId: null,
      providerQrCodeId: null,
      providerOrderId: null,
      providerPaymentId: null,
      paymentUrl: null,
      qrImageUrl: null,
      providerCreationLeaseId: leaseId,
      providerCreationLeaseUntil: admin.firestore.Timestamp.fromMillis(now + PROVIDER_CREATION_LEASE_MS),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + POS_SESSION_TTL_MS),
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      capturedAt: existing?.capturedAt || null,
      failureCode: null,
      failureMessage: null,
    }, { merge: true });
    return { kind: 'CREATE', providerRequestType };
  });

  if (reservation.kind === 'EXISTING') return sessionResponse(reservation.session);
  if (reservation.kind === 'IN_PROGRESS') {
    fail('aborted', 'Razorpay payment setup is already in progress. Retry status shortly.');
  }

  const client = razorpayClient(keyId, keySecret, RazorpayClass);
  let providerRequest;
  try {
    providerRequest = await createProviderRequest({
      client,
      session: {
        sessionId,
        orderId,
        storeId: canonical.store.id,
        storeCode: canonical.store.code || canonical.store.storeCode || canonical.store.id,
        amountPaise: canonical.amountPaise,
        providerReferenceId,
      },
      dynamicQrEnabled: reservation.providerRequestType === 'DYNAMIC_QR',
      now,
    });
    validateProviderRequest(providerRequest, canonical.amountPaise, providerReferenceId);
  } catch (error) {
    const safe = safeProviderError(error);
    await sessionRef.set({
      status: 'FAILED',
      failureCode: safe.code,
      failureMessage: safe.message,
      providerCreationLeaseId: admin.firestore.FieldValue.delete(),
      providerCreationLeaseUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error('pos-razorpay-request-create-failed', {
      sessionHash: sha256(sessionId).slice(0, 16),
      storeId: canonical.store.id,
      failureCode: safe.code,
    });
    fail('unavailable', 'Razorpay payment request could not be created. Retry without changing the cart.');
  }

  const entity = providerRequest.entity;
  const providerExpirySeconds = Number(entity.expire_by || entity.close_by);
  const providerExpiryMillis = Number.isFinite(providerExpirySeconds) && providerExpirySeconds * 1000 > now
    ? providerExpirySeconds * 1000
    : now + POS_SESSION_TTL_MS;
  const expiresAt = admin.firestore.Timestamp.fromMillis(providerExpiryMillis);
  await db.runTransaction(async transaction => {
    const fresh = await transaction.get(sessionRef);
    if (
      !fresh.exists
      || fresh.data().requestChecksum !== canonical.requestChecksum
      || fresh.data().providerCreationLeaseId !== leaseId
    ) {
      fail('aborted', 'Razorpay session state changed before the request could be saved.');
    }
    transaction.update(sessionRef, {
      status: 'WAITING_FOR_PAYMENT',
      providerRequestType: providerRequest.providerRequestType,
      providerPaymentLinkId: providerRequest.providerRequestType === 'PAYMENT_LINK' ? entity.id : null,
      providerQrCodeId: providerRequest.providerRequestType === 'DYNAMIC_QR' ? entity.id : null,
      paymentUrl: providerRequest.providerRequestType === 'PAYMENT_LINK' ? entity.short_url : null,
      qrImageUrl: providerRequest.providerRequestType === 'DYNAMIC_QR' ? entity.image_url : null,
      expiresAt,
      providerCreationLeaseId: admin.firestore.FieldValue.delete(),
      providerCreationLeaseUntil: admin.firestore.FieldValue.delete(),
      providerRequestRecovered: providerRequest.recovered === true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  const snapshot = await sessionRef.get();
  return sessionResponse({ sessionId, ...snapshot.data() });
}

async function providerStateForSession(client, session) {
  if (session.providerRequestType === 'DYNAMIC_QR') {
    const qr = await client.qrCode.fetch(session.providerQrCodeId);
    const paymentsResponse = await client.qrCode.fetchAllPayments(session.providerQrCodeId, { count: 100 });
    const payments = Array.isArray(paymentsResponse?.items) ? paymentsResponse.items : [];
    const paymentSummary = payments.find(payment => payment?.status === 'captured') || null;
    const paymentId = cleanText(paymentSummary?.id || paymentSummary?.payment_id, 120) || null;
    if (paymentId) return { providerRequest: qr, paymentId };
    const qrStatus = String(qr?.status || '').toLowerCase();
    if (['closed', 'expired'].includes(qrStatus)) return { status: 'EXPIRED', providerRequest: qr };
    return { status: 'WAITING_FOR_PAYMENT', providerRequest: qr };
  }

  const link = await client.paymentLink.fetch(session.providerPaymentLinkId);
  const paymentId = providerPaymentIdFromRequest(link);
  if (paymentId) return { providerRequest: link, paymentId };
  const linkStatus = String(link?.status || '').toLowerCase();
  if (linkStatus === 'cancelled') return { status: 'CANCELLED', providerRequest: link };
  if (linkStatus === 'expired') return { status: 'EXPIRED', providerRequest: link };
  return { status: 'WAITING_FOR_PAYMENT', providerRequest: link };
}

async function finalizeCapturedPosPayment({ db, admin, sessionId, providerPayment, providerOrder }) {
  const sessionRef = db.collection(POS_SESSION_COLLECTION).doc(sessionId);
  const initialSessionSnapshot = await sessionRef.get();
  if (!initialSessionSnapshot.exists) fail('not-found', 'POS Razorpay session was not found.');
  const initialSession = { sessionId: initialSessionSnapshot.id, ...initialSessionSnapshot.data() };
  const finalState = verifyCapturedProviderPayment({
    session: initialSession,
    providerPayment,
    providerOrder,
  });
  if (!finalState.valid) {
    fail('failed-precondition', 'Razorpay has not verified the full captured amount.');
  }
  const providerOrderId = finalState.providerOrderId;
  const orderRef = db.collection('orders').doc(initialSession.orderId);
  return db.runTransaction(async transaction => {
    const [sessionSnapshot, existingOrderSnapshot] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(orderRef),
    ]);
    if (!sessionSnapshot.exists) fail('not-found', 'POS Razorpay session was not found.');
    const session = { sessionId: sessionSnapshot.id, ...sessionSnapshot.data() };
    if (existingOrderSnapshot.exists) {
      const order = existingOrderSnapshot.data();
      if (
        order.clientCheckoutIdempotencyKey !== session.checkoutIdempotencyKey
        || order.checkoutPayloadHash !== session.checkoutPayloadHash
      ) {
        fail('already-exists', 'The completed POS order does not match this payment session.');
      }
      transaction.set(sessionRef, {
        status: 'PAYMENT_CAPTURED',
        providerPaymentId: providerPayment.id,
        providerOrderId,
        orderNumber: order.orderNumber,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { alreadyFinalized: true, orderId: orderRef.id, orderNumber: order.orderNumber };
    }
    if (
      session.requestChecksum !== initialSession.requestChecksum
      || session.staffUid !== initialSession.staffUid
      || session.storeId !== initialSession.storeId
      || session.amountPaise !== initialSession.amountPaise
    ) {
      fail('aborted', 'The payment session changed before finalisation.');
    }
    const storeRef = db.collection('stores').doc(session.storeId);
    const currentStaffRef = db.collection('users').doc(session.staffUid);
    const [storeSnapshot, currentStaffSnapshot] = await Promise.all([
      transaction.get(storeRef),
      transaction.get(currentStaffRef),
    ]);
    if (!storeSnapshot.exists || storeSnapshot.data().isActive !== true || storeSnapshot.data().posEnabled === false) {
      transaction.set(sessionRef, {
        status: 'PAYMENT_REVIEW_REQUIRED',
        failureCode: 'STORE_NOT_ACTIVE_AFTER_PAYMENT',
        providerPaymentId: providerPayment.id,
        providerOrderId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { reviewRequired: true, code: 'STORE_NOT_ACTIVE_AFTER_PAYMENT' };
    }
    const store = { id: storeSnapshot.id, ...storeSnapshot.data() };
    let inventoryStore;
    try {
      inventoryStore = await resolveInventoryStore(store, async inventoryStoreId => {
        const snapshot = await transaction.get(db.collection('stores').doc(inventoryStoreId));
        return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
      });
    } catch (_error) {
      transaction.set(sessionRef, {
        status: 'PAYMENT_REVIEW_REQUIRED',
        failureCode: 'INVENTORY_STORE_CONFIGURATION_CHANGED_AFTER_PAYMENT',
        providerPaymentId: providerPayment.id,
        providerOrderId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { reviewRequired: true, code: 'INVENTORY_STORE_CONFIGURATION_CHANGED_AFTER_PAYMENT' };
    }
    const currentStaffProfile = currentStaffSnapshot.exists ? currentStaffSnapshot.data() : null;
    if (!isAuthorizedStaffForStorePair(currentStaffProfile, store.id, inventoryStore.id)) {
      transaction.set(sessionRef, {
        status: 'PAYMENT_REVIEW_REQUIRED',
        failureCode: 'STAFF_FULFILMENT_AUTHORIZATION_CHANGED_AFTER_PAYMENT',
        providerPaymentId: providerPayment.id,
        providerOrderId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { reviewRequired: true, code: 'STAFF_FULFILMENT_AUTHORIZATION_CHANGED_AFTER_PAYMENT' };
    }
    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterRef = db.collection('counters').doc(`${store.code || store.storeCode || store.id}_${dateKey}`);
    const counterSnapshot = await transaction.get(counterRef);
    const sequence = counterSnapshot.exists ? Number(counterSnapshot.data().lastSequence || 0) + 1 : 1;
    const orderNumber = `CB-${store.code || store.storeCode || store.id}-${dateKey}-${String(sequence).padStart(4, '0')}`;
    const expandedInventoryLines = expandCompositeInventoryLines(session.items.map(line => ({
      lineKey: line.lineId,
      quantity: line.quantity,
      finishedGood: line.finishedGood,
      addOns: line.addOns,
      components: line.components,
    })), store.id);
    const inventoryPlan = await planOnlineOrderInventory({
      transaction,
      db,
      admin,
      store,
      orderId: session.orderId,
      orderNumber,
      orderType: session.orderType,
      businessDate: dateKey,
      staff: { uid: session.staffUid, name: session.staffName },
      lines: expandedInventoryLines,
      requireAvailableStock: true,
      source: 'POS_RAZORPAY',
    });
    if (inventoryPlan.blockers.length > 0) {
      transaction.set(sessionRef, {
        status: 'PAYMENT_REVIEW_REQUIRED',
        failureCode: 'INVENTORY_REVALIDATION_FAILED_AFTER_PAYMENT',
        failureMessage: inventoryPlan.blockers.map(blocker => blocker.blockerType).join('; ').slice(0, 240),
        providerPaymentId: providerPayment.id,
        providerOrderId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
    inventoryPlan.movementPayloads.forEach(movement => {
      transaction.create(
        db.collection('stockMovements').doc(deterministicMovementId(session.orderId, movement)),
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
        storeCode: store.code || store.storeCode || store.id,
        dateKey,
        lastSequence: sequence,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const tender = providerMethod(providerPayment.method);
    transaction.create(orderRef, {
      orderNumber,
      storeId: store.id,
      storeCode: store.code || store.storeCode || store.id,
      storeName: store.name,
      customerId: null,
      customerName: session.customerName || null,
      customerPhone: session.customerPhone || null,
      createdByUserId: session.staffUid,
      createdByName: session.staffName,
      orderType: session.orderType,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      commercialStatus: 'SALE',
      tableNumber: session.orderType === 'DINE_IN' ? session.tableNumber : null,
      subtotal: session.subtotal,
      taxTotal: session.gstTotal,
      gstTotal: session.gstTotal,
      taxableAmount: session.taxableAmount,
      discountPercent: session.discountPercent,
      discountAmount: session.discountAmount,
      discountTotal: session.discountAmount,
      discount: session.discountAmount,
      grandTotal: session.grandTotal,
      cogsTotal: inventoryPlan.totalCogs,
      inventoryWarningCount: inventoryPlan.warnings.length,
      inventoryWarnings: inventoryPlan.warnings.map(warning => warning.message),
      inventoryConsumptionStatus: inventoryPlan.pendingConsumptionPayloads.length > 0 ? 'PENDING_BOM' : 'APPLIED',
      stockMovementCount: inventoryPlan.movementPayloads.length,
      clientCheckoutIdempotencyKey: session.checkoutIdempotencyKey,
      checkoutPayloadHash: session.checkoutPayloadHash,
      checkoutIdempotencyVersion: 1,
      paymentMethod: 'RAZORPAY',
      paymentMethodLabel: `RAZORPAY / ${tender}`,
      paymentProvider: PROVIDER,
      providerMethod: tender,
      isSplitPayment: false,
      paymentBreakdown: [{
        method: 'RAZORPAY',
        provider: PROVIDER,
        providerMethod: tender,
        amount: session.grandTotal,
      }],
      razorpaySessionId: sessionId,
      providerPaymentId: providerPayment.id,
      providerOrderId,
      addOnTotal: session.canonicalAddOnTotal,
      source: 'POS',
      notes: session.notes || null,
      receiptLegalDetails: receiptLegalDetails(store),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    let kotCount = 0;
    session.items.forEach(line => {
      const parentInventory = summarizeParentInventory({
        parentLineKey: line.lineId,
        expandedLines: expandedInventoryLines,
        perLineCogs: inventoryPlan.perLineCogs,
        perLineConsumptionStatus: inventoryPlan.perLineConsumptionStatus,
      });
      transaction.create(orderRef.collection('items').doc(line.lineId), {
        menuItemId: line.parentProductId,
        itemName: line.itemName,
        itemCode: line.parentProductCode,
        categoryId: line.categoryId,
        categoryName: line.categoryName,
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
        cogsAmount: parentInventory.cogsAmount,
        inventoryConsumptionStatus: parentInventory.inventoryConsumptionStatus,
        prepStation: line.prepStation,
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sourceSystem: 'FINISHED_GOODS',
        finishedGoodCode: line.parentProductCode,
        itemType: line.finishedGood.itemType,
        ...(Array.isArray(line.components) && line.components.length > 0 ? { components: line.components } : {}),
      });
      const createKot = task => {
        kotCount += 1;
        transaction.create(db.collection('kotItems').doc(deterministicKotId(session.orderId, line.lineId, task.taskKey)), {
          orderId: session.orderId,
          orderNumber,
          orderItemId: line.lineId,
          storeId: store.id,
          storeCode: store.code || store.storeCode || store.id,
          storeName: store.name,
          station: task.station,
          itemName: task.itemName,
          itemCode: task.itemCode,
          quantity: task.quantity,
          addOns: line.addOns,
          ...(task.component ? { component: task.component } : {}),
          orderType: session.orderType,
          tableNumber: session.orderType === 'DINE_IN' ? session.tableNumber : null,
          customerName: session.customerName || null,
          status: 'PENDING',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUserId: session.staffUid,
          createdByName: session.staffName,
        });
      };
      buildKotTasks({
        quantity: line.quantity,
        finishedGood: line.finishedGood,
        prepStation: line.prepStation,
        components: line.components,
      }).forEach(createKot);
    });

    const paymentId = safeDocId(`${session.orderId}_PAY_01_RAZORPAY`, 220);
    transaction.create(orderRef.collection('payments').doc(paymentId), {
      method: 'RAZORPAY',
      status: 'CAPTURED',
      provider: PROVIDER,
      providerMethod: tender,
      razorpayPaymentId: providerPayment.id,
      razorpayOrderId: providerOrderId,
      paymentLinkId: session.providerPaymentLinkId || null,
      qrCodeId: session.providerQrCodeId || null,
      providerPaymentId: providerPayment.id,
      providerOrderId,
      amount: session.grandTotal,
      currency: CURRENCY,
      capturedAt: admin.firestore.FieldValue.serverTimestamp(),
      verifiedServerSide: true,
      storeId: store.id,
      orderId: session.orderId,
      checkoutIdempotencyKey: session.checkoutIdempotencyKey,
      reference: providerPayment.id,
      paymentIndex: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
      settledBy: 'RAZORPAY_GATEWAY',
      settledByName: 'Razorpay',
    });
    transaction.update(sessionRef, {
      status: 'PAYMENT_CAPTURED',
      providerPaymentId: providerPayment.id,
      providerOrderId,
      providerMethod: tender,
      orderNumber,
      capturedAt: admin.firestore.FieldValue.serverTimestamp(),
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      failureCode: null,
      failureMessage: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      alreadyFinalized: false,
      reviewRequired: false,
      orderId: session.orderId,
      orderNumber,
      paymentId,
      kotCount,
      stockMovementCount: inventoryPlan.movementPayloads.length,
      pendingBomCount: inventoryPlan.pendingConsumptionPayloads.length,
    };
  });
}

async function verifyAndFinalizeSession({ db, admin, session, client, paymentId, providerState = null }) {
  const authoritativeRequestState = providerState || await providerStateForSession(client, session);
  if (!authoritativeRequestState.paymentId || authoritativeRequestState.paymentId !== paymentId) {
    fail('failed-precondition', 'The captured payment does not belong to this Razorpay request.');
  }
  const providerPayment = await client.payments.fetch(paymentId);
  const providerOrderId = cleanText(providerPayment?.order_id, 120);
  const providerOrder = providerOrderId ? await client.orders.fetch(providerOrderId) : null;
  const finalState = verifyCapturedProviderPayment({ session, providerPayment, providerOrder });
  if (!finalState.valid) {
    fail('failed-precondition', 'Razorpay has not verified the full captured amount.');
  }
  return finalizeCapturedPosPayment({ db, admin, sessionId: session.sessionId, providerPayment, providerOrder });
}

async function getPosSessionStatus({ request, db, admin, keyId, keySecret, RazorpayClass }) {
  const staff = await staffIdentity(request, db, ['ADMIN', 'STORE_MANAGER', 'CASHIER']);
  const sessionId = cleanText(request.data?.sessionId, 120);
  if (!sessionId) fail('invalid-argument', 'Razorpay session is required.');
  const sessionRef = db.collection(POS_SESSION_COLLECTION).doc(sessionId);
  const snapshot = await sessionRef.get();
  if (!snapshot.exists) fail('not-found', 'Razorpay session was not found.');
  let session = { sessionId: snapshot.id, ...snapshot.data() };
  assertStoreAccess(staff, session.storeId);
  if (staff.uid !== session.staffUid && !['ADMIN', 'STORE_MANAGER'].includes(staff.role)) {
    fail('permission-denied', 'This payment session belongs to another cashier.');
  }
  if (FINAL_SESSION_STATUSES.has(session.status) || session.status === 'PAYMENT_REVIEW_REQUIRED') {
    return sessionResponse(session);
  }
  if (!ACTIVE_SESSION_STATUSES.has(session.status)) return sessionResponse(session);
  const client = razorpayClient(keyId, keySecret, RazorpayClass);
  let providerState;
  try {
    providerState = await providerStateForSession(client, session);
  } catch (error) {
    const safe = safeProviderError(error);
    await sessionRef.set({
      status: 'RECOVERING',
      failureCode: safe.code,
      failureMessage: 'Razorpay status is temporarily unavailable. Retry status shortly.',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return sessionResponse({ ...session, status: 'RECOVERING', failureCode: safe.code, failureMessage: 'Razorpay status is temporarily unavailable. Retry status shortly.' });
  }
  if (providerState.paymentId) {
    const result = await verifyAndFinalizeSession({
      db,
      admin,
      session,
      client,
      paymentId: providerState.paymentId,
      providerState,
    });
    const refreshed = await sessionRef.get();
    return { ...sessionResponse({ sessionId, ...refreshed.data() }), ...result };
  }
  const expiredByClock = timestampMillis(session.expiresAt) <= Date.now();
  if (providerState.status === 'EXPIRED' || expiredByClock) {
    await sessionRef.set({ status: 'EXPIRED', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    session = { ...session, status: 'EXPIRED' };
  } else if (providerState.status === 'CANCELLED') {
    await sessionRef.set({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    session = { ...session, status: 'CANCELLED' };
  } else if (session.status === 'RECOVERING') {
    await sessionRef.set({ status: 'WAITING_FOR_PAYMENT', failureCode: null, failureMessage: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    session = { ...session, status: 'WAITING_FOR_PAYMENT', failureCode: null, failureMessage: null };
  }
  return sessionResponse(session);
}

async function cancelPosSession({ request, db, admin, keyId, keySecret, RazorpayClass }) {
  const staff = await staffIdentity(request, db, ['ADMIN', 'STORE_MANAGER', 'CASHIER']);
  const sessionId = cleanText(request.data?.sessionId, 120);
  if (!sessionId) fail('invalid-argument', 'Razorpay session is required.');
  const sessionRef = db.collection(POS_SESSION_COLLECTION).doc(sessionId);
  const snapshot = await sessionRef.get();
  if (!snapshot.exists) fail('not-found', 'Razorpay session was not found.');
  const session = { sessionId: snapshot.id, ...snapshot.data() };
  assertStoreAccess(staff, session.storeId);
  if (staff.uid !== session.staffUid && !['ADMIN', 'STORE_MANAGER'].includes(staff.role)) {
    fail('permission-denied', 'This payment session belongs to another cashier.');
  }
  if (session.status === 'PAYMENT_CAPTURED') return sessionResponse(session);
  if (['CANCELLED', 'EXPIRED', 'FAILED'].includes(session.status)) return sessionResponse(session);
  const client = razorpayClient(keyId, keySecret, RazorpayClass);
  const providerState = await providerStateForSession(client, session);
  if (providerState.paymentId) {
    await verifyAndFinalizeSession({
      db,
      admin,
      session,
      client,
      paymentId: providerState.paymentId,
      providerState,
    });
    const refreshed = await sessionRef.get();
    return sessionResponse({ sessionId, ...refreshed.data() });
  }
  if (session.providerRequestType === 'DYNAMIC_QR') {
    await client.qrCode.close(session.providerQrCodeId);
  } else {
    await client.paymentLink.cancel(session.providerPaymentLinkId);
  }
  await sessionRef.set({
    status: 'CANCELLED',
    cancelledBy: staff.uid,
    cancelledByName: staff.name,
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return sessionResponse({ ...session, status: 'CANCELLED' });
}

async function requestPosRefund({ request, db, admin, keyId, keySecret, fetchImpl }) {
  const staff = await staffIdentity(request, db, ['ADMIN', 'STORE_MANAGER']);
  const orderId = cleanText(request.data?.orderId, 180);
  const reason = cleanText(request.data?.reason, 240);
  const confirmation = cleanText(request.data?.confirmation, 160);
  if (!orderId || !reason) fail('invalid-argument', 'Order and refund reason are required.');
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) fail('not-found', 'Razorpay POS order was not found.');
  const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
  assertStoreAccess(staff, order.storeId);
  if (confirmation !== order.orderNumber && confirmation !== 'REFUND RAZORPAY') {
    fail('failed-precondition', 'Type REFUND RAZORPAY or the order number to confirm the full refund.');
  }
  if (
    order.paymentProvider !== PROVIDER
    || order.paymentMethod !== 'RAZORPAY'
    || order.paymentStatus !== 'PAID'
    || order.status === 'VOIDED'
  ) {
    fail('failed-precondition', 'Only a captured, non-voided in-store Razorpay order can be refunded here.');
  }
  const [salesStoreSnapshot, paymentSnapshot, originalMovementSnapshot] = await Promise.all([
    db.collection('stores').doc(order.storeId).get(),
    orderRef.collection('payments').where('provider', '==', PROVIDER).limit(2).get(),
    db.collection('stockMovements').where('referenceId', '==', orderId).get(),
  ]);
  if (!salesStoreSnapshot.exists) fail('failed-precondition', 'The order store configuration no longer exists.');
  const salesStore = { id: salesStoreSnapshot.id, ...salesStoreSnapshot.data() };
  let currentInventoryStore;
  try {
    currentInventoryStore = await resolveInventoryStore(salesStore, async inventoryStoreId => {
      const snapshot = await db.collection('stores').doc(inventoryStoreId).get();
      return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
    });
  } catch (_error) {
    fail('failed-precondition', 'The order inventory store configuration is invalid.');
  }
  if (!isAuthorizedStaffForStorePair(staff.profile, salesStore.id, currentInventoryStore.id)) {
    fail('permission-denied', 'Refunding this order requires access to both its sales and inventory stores.');
  }
  const originalInventoryStoreIds = new Set();
  for (const movementSnapshot of originalMovementSnapshot.docs) {
    const movement = movementSnapshot.data() || {};
    if (!['SALE_DEDUCTION', 'ORDER_BOM_BACKFILL'].includes(movement.movementType)) continue;
    if (movement.orderId && movement.orderId !== orderId) continue;
    const physicalStoreId = cleanText(movement.inventoryStoreId || movement.storeId, 120);
    if (!physicalStoreId) {
      fail('failed-precondition', 'An original inventory movement is missing its physical store attribution.');
    }
    originalInventoryStoreIds.add(physicalStoreId);
  }
  if ([...originalInventoryStoreIds].some(inventoryStoreId => (
    !isAuthorizedStaffForStorePair(staff.profile, salesStore.id, inventoryStoreId)
  ))) {
    fail('permission-denied', 'Refunding this order requires access to every physical store recorded by its inventory movements.');
  }
  if (paymentSnapshot.size !== 1) fail('failed-precondition', 'The authoritative Razorpay payment record is missing or ambiguous.');
  const paymentDocument = paymentSnapshot.docs[0];
  const payment = paymentDocument.data();
  const providerPaymentId = cleanText(payment.razorpayPaymentId || payment.providerPaymentId, 120);
  const capturedAmount = roundMoney(payment.amount);
  const orderAmount = roundMoney(order.grandTotal);
  if (
    !providerPaymentId
    || payment.verifiedServerSide !== true
    || payment.status !== 'CAPTURED'
    || capturedAmount !== orderAmount
    || String(payment.currency || '').toUpperCase() !== CURRENCY
  ) {
    fail('failed-precondition', 'The payment has not been server-verified as captured.');
  }
  const refundId = deterministicRefundId(orderId);
  const refundRef = db.collection(REFUND_COLLECTION).doc(refundId);
  const leaseId = `pos_refund_${randomBytes(12).toString('hex')}`;
  const now = Date.now();
  const claim = await db.runTransaction(async transaction => {
    const existingSnapshot = await transaction.get(refundRef);
    const existing = existingSnapshot.exists ? existingSnapshot.data() : null;
    if (existing && ['REFUND_PENDING', 'REFUNDED'].includes(existing.status)) {
      return { kind: 'EXISTING', refund: existing };
    }
    const leaseUntil = timestampMillis(existing?.requestLeaseUntil);
    if (existing?.status === 'REFUND_REQUESTING' && leaseUntil && leaseUntil > now) {
      return { kind: 'IN_PROGRESS' };
    }
    transaction.set(refundRef, {
      workflow: 'POS_IN_STORE',
      orderId,
      orderNumber: order.orderNumber,
      paymentDocumentId: paymentDocument.id,
      storeId: order.storeId,
      provider: PROVIDER,
      providerPaymentId,
      refundRequestId: refundId,
      amountPaise: rupeesToPaise(orderAmount),
      currency: CURRENCY,
      status: 'REFUND_REQUESTING',
      reason,
      requestedBy: staff.uid,
      requestedByName: staff.name,
      requestedAt: existing?.requestedAt || admin.firestore.FieldValue.serverTimestamp(),
      requestLeaseId: leaseId,
      requestLeaseUntil: admin.firestore.Timestamp.fromMillis(now + REFUND_REQUEST_LEASE_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { kind: 'CREATE' };
  });
  if (claim.kind === 'EXISTING') {
    return {
      alreadyRequested: true,
      status: claim.refund.status,
      refundId: claim.refund.providerRefundId || null,
      refundRequestId: refundId,
    };
  }
  if (claim.kind === 'IN_PROGRESS') fail('aborted', 'A Razorpay refund request is already in progress.');

  let providerRefund;
  try {
    providerRefund = await createIdempotentProviderRefund({
      keyId,
      keySecret,
      paymentId: providerPaymentId,
      refundId,
      fetchImpl,
      payload: {
        amount: rupeesToPaise(orderAmount),
        speed: 'normal',
        receipt: refundId,
        notes: {
          coffee_bond_pos_order: sha256(orderId).slice(0, 24),
          reason: reason.slice(0, 120),
        },
      },
    });
    if (!cleanText(providerRefund?.id, 120)) throw new Error('Provider refund ID was not returned.');
  } catch (error) {
    const safe = safeProviderError(error);
    await refundRef.set({
      status: 'REFUND_FAILED',
      failureCode: safe.code,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      requestLeaseId: admin.firestore.FieldValue.delete(),
      requestLeaseUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error('pos-razorpay-refund-request-failed', {
      orderHash: sha256(orderId).slice(0, 16),
      storeId: order.storeId,
      failureCode: safe.code,
    });
    fail('unavailable', 'The Razorpay refund could not be initiated. The order has not been voided.');
  }
  const providerStatus = String(providerRefund.status || '').toLowerCase();
  const refundStatus = providerStatus === 'processed' ? 'REFUNDED' : 'REFUND_PENDING';
  await db.runTransaction(async transaction => {
    const fresh = await transaction.get(refundRef);
    if (!fresh.exists || fresh.data().requestLeaseId !== leaseId) {
      fail('aborted', 'Refund state changed before the provider result could be recorded.');
    }
    transaction.set(refundRef, {
      providerRefundId: providerRefund.id,
      status: refundStatus,
      providerStatus: providerRefund.status || null,
      processedAt: refundStatus === 'REFUNDED' ? admin.firestore.FieldValue.serverTimestamp() : null,
      requestLeaseId: admin.firestore.FieldValue.delete(),
      requestLeaseUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(orderRef, {
      refundStatus,
      refundReason: reason,
      refundRequestId: refundId,
      providerRefundId: providerRefund.id,
      refundRequestedBy: staff.uid,
      refundRequestedByName: staff.name,
      refundRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(paymentDocument.ref, {
      refundStatus,
      refundRequestId: refundId,
      providerRefundId: providerRefund.id,
      refundRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return {
    alreadyRequested: false,
    status: refundStatus,
    refundId: providerRefund.id,
    refundRequestId: refundId,
  };
}

async function processPosPaymentWebhook({ db, admin, eventName, paymentEntity, paymentLinkEntity, qrCodeEntity, client }) {
  let sessionQuery = null;
  const paymentLinkId = cleanText(paymentLinkEntity?.id, 120);
  const qrCodeId = cleanText(qrCodeEntity?.id || paymentEntity?.qr_code_id, 120);
  const providerOrderId = cleanText(paymentEntity?.order_id, 120);
  const providerReferenceId = cleanText(
    paymentEntity?.notes?.coffee_bond_pos_reference,
    80,
  );
  if (paymentLinkId) {
    sessionQuery = await db.collection(POS_SESSION_COLLECTION).where('providerPaymentLinkId', '==', paymentLinkId).limit(2).get();
  } else if (qrCodeId) {
    sessionQuery = await db.collection(POS_SESSION_COLLECTION).where('providerQrCodeId', '==', qrCodeId).limit(2).get();
  } else if (providerOrderId) {
    sessionQuery = await db.collection(POS_SESSION_COLLECTION).where('providerOrderId', '==', providerOrderId).limit(2).get();
  } else if (providerReferenceId) {
    sessionQuery = await db.collection(POS_SESSION_COLLECTION).where('providerReferenceId', '==', providerReferenceId).limit(2).get();
  }
  if ((!sessionQuery || sessionQuery.size !== 1) && providerReferenceId) {
    sessionQuery = await db.collection(POS_SESSION_COLLECTION).where('providerReferenceId', '==', providerReferenceId).limit(2).get();
  }
  if (!sessionQuery || sessionQuery.size !== 1) return { handled: false, outcome: 'POS_SESSION_NOT_FOUND' };
  const sessionSnapshot = sessionQuery.docs[0];
  const session = { sessionId: sessionSnapshot.id, ...sessionSnapshot.data() };
  if (eventName === 'payment.failed') {
    if (session.status !== 'PAYMENT_CAPTURED') {
      const expired = timestampMillis(session.expiresAt) <= Date.now();
      await sessionSnapshot.ref.set({
        status: expired ? 'EXPIRED' : session.status === 'CANCELLED' ? 'CANCELLED' : 'WAITING_FOR_PAYMENT',
        failureCode: 'PROVIDER_PAYMENT_ATTEMPT_FAILED',
        failureMessage: expired
          ? 'The Razorpay payment request expired.'
          : 'A payment attempt failed. The customer can retry before this request expires.',
        lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { handled: true, outcome: 'POS_PAYMENT_ATTEMPT_FAILED_RECORDED' };
  }
  let paymentId = cleanText(paymentEntity?.id, 120) || providerPaymentIdFromRequest(paymentLinkEntity);
  if (!paymentId && session.providerRequestType === 'DYNAMIC_QR') {
    const state = await providerStateForSession(client, session);
    paymentId = state.paymentId;
  }
  if (!paymentId) return { handled: true, retry: true, outcome: 'POS_PAYMENT_ID_NOT_AVAILABLE' };
  const result = await verifyAndFinalizeSession({ db, admin, session, client, paymentId });
  return {
    handled: true,
    outcome: result.reviewRequired ? 'POS_PAYMENT_REVIEW_REQUIRED' : 'POS_ORDER_CREATED',
    orderId: result.orderId || null,
    duplicate: result.alreadyFinalized === true,
  };
}

async function processPosRefundWebhook({ db, admin, eventName, refundEntity }) {
  const providerRefundId = cleanText(refundEntity?.id, 120);
  if (!providerRefundId) return { handled: false, outcome: 'POS_REFUND_ID_MISSING' };
  const query = await db.collection(REFUND_COLLECTION).where('providerRefundId', '==', providerRefundId).limit(2).get();
  if (query.size !== 1) return { handled: false, outcome: 'POS_REFUND_NOT_FOUND' };
  const refundSnapshot = query.docs[0];
  const refund = refundSnapshot.data();
  if (refund.workflow !== 'POS_IN_STORE') return { handled: false, outcome: 'NOT_POS_REFUND' };
  if (eventName === 'refund.created') return { handled: true, outcome: 'REFUND_PENDING' };
  const status = eventName === 'refund.processed' ? 'REFUNDED' : 'REFUND_FAILED';
  const orderRef = db.collection('orders').doc(refund.orderId);
  const paymentRef = orderRef.collection('payments').doc(refund.paymentDocumentId);
  await db.runTransaction(async transaction => {
    const orderSnapshot = await transaction.get(orderRef);
    transaction.set(refundSnapshot.ref, {
      status,
      failureCode: eventName === 'refund.failed' ? cleanText(refundEntity?.error_code, 80) || 'PROVIDER_REFUND_FAILED' : null,
      processedAt: eventName === 'refund.processed' ? admin.firestore.FieldValue.serverTimestamp() : null,
      failedAt: eventName === 'refund.failed' ? admin.firestore.FieldValue.serverTimestamp() : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(paymentRef, {
      refundStatus: status,
      refundedAt: eventName === 'refund.processed' ? admin.firestore.FieldValue.serverTimestamp() : null,
      refundFailedAt: eventName === 'refund.failed' ? admin.firestore.FieldValue.serverTimestamp() : null,
    }, { merge: true });
    if (orderSnapshot.exists) {
      const order = orderSnapshot.data();
      const update = {
        refundStatus: status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (order.status === 'VOIDED') {
        const reversalStatus = status === 'REFUNDED' ? 'REFUNDED' : 'MANUAL_REFUND_REQUIRED';
        const amount = Number(order.grandTotal || 0);
        update.paymentReversalStatus = reversalStatus;
        update.paymentReversalBreakdown = (Array.isArray(order.paymentReversalBreakdown)
          ? order.paymentReversalBreakdown
          : [{ method: 'RAZORPAY', originalAmount: amount, amount }]
        ).map(line => ({
          ...line,
          reversalStatus,
          reason: status === 'REFUNDED'
            ? 'Razorpay confirmed the full provider refund.'
            : 'Razorpay reported that the refund failed and requires Admin attention.',
        }));
        update.refundedAmount = status === 'REFUNDED' ? amount : 0;
        update.refundPendingAmount = 0;
        update.manualRefundRequiredAmount = status === 'REFUNDED' ? 0 : amount;
        update.netCollectionAmount = 0;
      }
      transaction.set(orderRef, update, { merge: true });
    }
  });
  return { handled: true, outcome: status };
}

async function claimPosWebhookEvent({ db, admin, eventId, eventName }) {
  const auditRef = db.collection(POS_WEBHOOK_AUDIT_COLLECTION).doc(safeDocId(eventId, 180));
  const leaseId = `pos_webhook_${randomBytes(12).toString('hex')}`;
  const now = Date.now();
  const claim = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(auditRef);
    const existing = snapshot.exists ? snapshot.data() : null;
    if (existing?.status === 'PROCESSED') return { kind: 'DUPLICATE', auditRef };
    const leaseUntil = timestampMillis(existing?.processingLeaseUntil);
    if (existing?.status === 'PROCESSING' && leaseUntil && leaseUntil > now) {
      return { kind: 'IN_PROGRESS', auditRef };
    }
    transaction.set(auditRef, {
      eventId,
      eventName,
      provider: PROVIDER,
      workflow: 'POS_IN_STORE',
      mode: POS_RAZORPAY_EXPECTED_MODE,
      status: 'PROCESSING',
      processingLeaseId: leaseId,
      processingLeaseUntil: admin.firestore.Timestamp.fromMillis(now + POS_WEBHOOK_LEASE_MS),
      receivedAt: existing?.receivedAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { kind: 'CLAIMED', auditRef, leaseId };
  });
  return claim;
}

async function finishPosWebhookEvent({ db, auditRef, admin, leaseId, status, outcome, orderId = null }) {
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(auditRef);
    if (!snapshot.exists || snapshot.data()?.processingLeaseId !== leaseId) {
      throw new Error('POS Razorpay webhook audit lease changed before completion.');
    }
    transaction.set(auditRef, {
      status,
      outcome,
      coffeeBondPosOrderId: orderId,
      processingLeaseId: admin.firestore.FieldValue.delete(),
      processingLeaseUntil: admin.firestore.FieldValue.delete(),
      completedLeaseId: leaseId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function handlePosRazorpayWebhook({
  request,
  response,
  db,
  admin,
  keyId,
  keySecret,
  webhookSecret,
  RazorpayClass = Razorpay,
}) {
  let testKeyId;
  try {
    testKeyId = assertPosRazorpayTestMode(keyId);
  } catch {
    console.error('pos-razorpay-mode-mismatch', { expectedMode: POS_RAZORPAY_EXPECTED_MODE });
    response.status(503).json({ ok: false, error: POS_RAZORPAY_MODE_MISMATCH_MESSAGE });
    return;
  }
  const rawBody = request.rawBody;
  if (!verifyWebhookSignature({
    rawBody,
    signature: request.get('x-razorpay-signature'),
    webhookSecret,
  })) {
    response.status(400).send('Invalid POS Razorpay webhook signature.');
    return;
  }
  const event = request.body || {};
  const eventName = cleanText(event.event, 80);
  if (!POS_PAYMENT_WEBHOOK_EVENTS.has(eventName) && !POS_REFUND_WEBHOOK_EVENTS.has(eventName)) {
    response.status(400).json({ ok: false, error: 'Unsupported POS Razorpay webhook event.' });
    return;
  }
  const eventId = cleanText(request.get('x-razorpay-event-id'), 160)
    || `pos_evt_${sha256(rawBody).slice(0, 48)}`;
  const claim = await claimPosWebhookEvent({ db, admin, eventId, eventName });
  if (claim.kind === 'DUPLICATE') {
    response.status(200).json({ ok: true, duplicate: true });
    return;
  }
  if (claim.kind === 'IN_PROGRESS') {
    response.status(500).json({ ok: false, retry: true });
    return;
  }

  try {
    const paymentEntity = event.payload?.payment?.entity || null;
    const paymentLinkEntity = event.payload?.payment_link?.entity || null;
    const qrCodeEntity = event.payload?.qr_code?.entity || null;
    const refundEntity = event.payload?.refund?.entity || null;
    let result;
    if (POS_REFUND_WEBHOOK_EVENTS.has(eventName)) {
      result = await processPosRefundWebhook({ db, admin, eventName, refundEntity });
    } else {
      const client = razorpayClient(testKeyId, keySecret, RazorpayClass);
      result = await processPosPaymentWebhook({
        db,
        admin,
        eventName,
        paymentEntity,
        paymentLinkEntity,
        qrCodeEntity,
        client,
      });
    }
    if (!result.handled) {
      await finishPosWebhookEvent({
        db,
        auditRef: claim.auditRef,
        admin,
        leaseId: claim.leaseId,
        status: 'REJECTED',
        outcome: result.outcome || 'NOT_POS_RAZORPAY_EVENT',
      });
      response.status(400).json({ ok: false, error: 'Event does not belong to a POS Razorpay session.' });
      return;
    }
    await finishPosWebhookEvent({
      db,
      auditRef: claim.auditRef,
      admin,
      leaseId: claim.leaseId,
      status: result.retry ? 'FAILED' : 'PROCESSED',
      outcome: result.outcome,
      orderId: result.orderId || null,
    });
    response.status(result.retry ? 500 : 200).json({
      ok: result.retry !== true,
      duplicate: result.duplicate === true,
      retry: result.retry === true,
    });
  } catch (error) {
    const safe = safeProviderError(error);
    await finishPosWebhookEvent({
      db,
      auditRef: claim.auditRef,
      admin,
      leaseId: claim.leaseId,
      status: 'FAILED',
      outcome: safe.code,
    });
    console.error('pos-razorpay-webhook-failed', {
      eventHash: sha256(eventId).slice(0, 16),
      eventName,
      failureCode: safe.code,
    });
    response.status(500).json({ ok: false, retry: true });
  }
}

function createPosRazorpayFunctions({
  admin,
  db,
  region,
  RazorpayClass = Razorpay,
  keyIdParameter = POS_RAZORPAY_KEY_ID,
  keySecretParameter = POS_RAZORPAY_KEY_SECRET,
  webhookSecretParameter = POS_RAZORPAY_WEBHOOK_SECRET,
  dynamicQrParameter = POS_RAZORPAY_DYNAMIC_QR_ENABLED,
  fetchImpl = globalThis.fetch,
}) {
  const createPosRazorpaySession = onCall({
    region,
    timeoutSeconds: 120,
    memory: '1GiB',
    secrets: [keySecretParameter],
  }, request => createPosSession({
    request,
    db,
    admin,
    keyId: assertPosRazorpayTestMode(keyIdParameter.value()),
    keySecret: keySecretParameter.value(),
    RazorpayClass,
    dynamicQrEnabled: booleanParameter(dynamicQrParameter),
  }));

  const getPosRazorpayStatus = onCall({
    region,
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [keySecretParameter],
  }, request => getPosSessionStatus({
    request,
    db,
    admin,
    keyId: assertPosRazorpayTestMode(keyIdParameter.value()),
    keySecret: keySecretParameter.value(),
    RazorpayClass,
  }));

  const cancelPosRazorpaySession = onCall({
    region,
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [keySecretParameter],
  }, request => cancelPosSession({
    request,
    db,
    admin,
    keyId: assertPosRazorpayTestMode(keyIdParameter.value()),
    keySecret: keySecretParameter.value(),
    RazorpayClass,
  }));

  const requestPosRazorpayRefund = onCall({
    region,
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [keySecretParameter],
  }, request => requestPosRefund({
    request,
    db,
    admin,
    keyId: assertPosRazorpayTestMode(keyIdParameter.value()),
    keySecret: keySecretParameter.value(),
    fetchImpl,
  }));

  const posRazorpayWebhook = onRequest({
    region,
    timeoutSeconds: 180,
    memory: '1GiB',
    secrets: [keySecretParameter, webhookSecretParameter],
  }, (request, response) => handlePosRazorpayWebhook({
    request,
    response,
    db,
    admin,
    keyId: keyIdParameter.value(),
    keySecret: keySecretParameter.value(),
    webhookSecret: webhookSecretParameter.value(),
    RazorpayClass,
  }));

  return {
    cancelPosRazorpaySession,
    createPosRazorpaySession,
    getPosRazorpayStatus,
    posRazorpayWebhook,
    requestPosRazorpayRefund,
  };
}

module.exports = {
  ACTIVE_SESSION_STATUSES,
  FINAL_SESSION_STATUSES,
  POS_RAZORPAY_EXPECTED_MODE,
  POS_RAZORPAY_KEY_ID,
  POS_RAZORPAY_KEY_SECRET,
  POS_RAZORPAY_MODE_MISMATCH_MESSAGE,
  POS_RAZORPAY_WEBHOOK_SECRET,
  POS_RAZORPAY_DYNAMIC_QR_ENABLED,
  POS_SESSION_COLLECTION,
  POS_SESSION_TTL_MS,
  POS_WEBHOOK_AUDIT_COLLECTION,
  assertPosRazorpayTestMode,
  booleanParameter,
  canonicalizePosRequest,
  cancelPosSession,
  checksum,
  claimPosWebhookEvent,
  createIdempotentProviderRefund,
  createPosRazorpayFunctions,
  createPosSession,
  createProviderRequest,
  deterministicRefundId,
  finalizeCapturedPosPayment,
  getPosSessionStatus,
  handlePosRazorpayWebhook,
  processPosPaymentWebhook,
  processPosRefundWebhook,
  requestPosRefund,
  sessionIdFor,
  sessionResponse,
  validateProviderRequest,
  verifyCapturedProviderPayment,
};
