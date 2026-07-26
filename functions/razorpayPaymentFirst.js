'use strict';

const { randomBytes } = require('node:crypto');
const Razorpay = require('razorpay');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const { isAuthorizedStaffProfile } = require('./complimentaryAuthorizationPolicy');
const { canonicalizeCustomerCheckout, cleanText } = require('./customerCheckoutCanonicalization');
const {
  CURRENCY,
  PROVIDER,
  REVIEW_STATUS,
  deterministicPosOrderId,
  deterministicReceipt,
  isFinalProviderState,
  providerMethod,
  requestChecksum,
  rupeesToPaise,
  safeProviderError,
  sha256,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} = require('./razorpayCheckoutPolicy');
const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  WEBHOOK_AUDIT_COLLECTION,
  finalizePaidOnlineOrder,
  razorpayClient,
  resolveWebhookPaymentId,
} = require('./razorpayCheckout');

const CUSTOMER_PROFILE_COLLECTION = 'customerProfiles';
const CHECKOUT_SESSION_COLLECTION = 'customerCheckoutSessions';
const PAYMENT_INTENT_COLLECTION = 'razorpayPaymentIntents';
const RESERVATION_COLLECTION = 'inventoryReservations';
const REFUND_COLLECTION = 'razorpayRefunds';
const CHECKOUT_SESSION_TTL_MS = 30 * 60 * 1000;
const RESERVATION_TTL_MS = 20 * 60 * 1000;
const PROVIDER_CREATION_LEASE_MS = 60 * 1000;
const REFUND_REQUEST_LEASE_MS = 2 * 60 * 1000;
const MAGIC_CHECKOUT_ENABLED = defineString('RAZORPAY_MAGIC_CHECKOUT_ENABLED', { default: 'false' });
const PHONE_PATTERN = /^\+91[6-9][0-9]{9}$/;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function booleanParameter(parameter) {
  return String(parameter?.value?.() || 'false').trim().toLowerCase() === 'true';
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function verifiedCustomerIdentity(request) {
  const uid = cleanText(request.auth?.uid, 128);
  const phoneNumber = cleanText(request.auth?.token?.phone_number, 32);
  const signInProvider = cleanText(request.auth?.token?.firebase?.sign_in_provider, 40);
  if (!uid || !PHONE_PATTERN.test(phoneNumber) || signInProvider !== 'phone') {
    fail('unauthenticated', 'Verify your mobile number before paying online.');
  }
  return { uid, phoneNumber };
}

function customerSessionId(customerUid, idempotencyKey) {
  return `checkout_${sha256(`${customerUid}:${cleanText(idempotencyKey, 200)}`).slice(0, 48)}`;
}

function customerOnlineOrderId(sessionId) {
  return `WEB_RZP_${sha256(sessionId).slice(0, 48)}`;
}

function deterministicRefundRequestId(onlineOrderId) {
  return `CBREF_${sha256(onlineOrderId).slice(0, 32).toUpperCase()}`;
}

function generateTrackingToken() {
  return randomBytes(24).toString('base64url');
}

function publicOrderReference(trackingToken) {
  return `CBWEB-${trackingToken.slice(0, 10).toUpperCase()}`;
}

function paidPendingMessage() {
  return 'Payment received. Your order has been sent to the store for confirmation. If the store cannot fulfil it, a full refund will be initiated.';
}

function publicStatusMessage(status) {
  if (status === 'PAYMENT_PROCESSING') return 'We are confirming your payment securely.';
  if (status === 'PAID_PENDING_ACCEPTANCE') return paidPendingMessage();
  if (status === 'ACCEPTED' || status === 'CONVERTED' || status === 'PREPARING') {
    return 'Your order has been accepted and is being prepared.';
  }
  if (status === 'READY') return 'Your order is ready.';
  if (status === 'COMPLETED' || status === 'SERVED') return 'Your order is complete.';
  if (status === 'REFUND_PENDING') return 'Your full refund has been initiated and is awaiting provider confirmation.';
  if (status === 'REFUNDED') return 'Your full refund has been processed.';
  if (status === 'REFUND_FAILED') return 'Your refund needs store attention. Please contact the store.';
  if (status === REVIEW_STATUS) return 'Payment was received, but the store must review this order.';
  return 'We are checking your order status.';
}

async function findOrCreateProviderCustomer(client, { customerUid, verifiedPhone, customerName }) {
  let providerCustomer = null;
  if (typeof client.customers?.all === 'function') {
    const existing = await client.customers.all({ contact: verifiedPhone, count: 10 });
    providerCustomer = (existing?.items || []).find(customer => (
      cleanText(customer?.contact, 32) === verifiedPhone
    )) || null;
  }
  return providerCustomer || client.customers.create({
    name: customerName,
    contact: verifiedPhone,
    notes: { coffee_bond_customer: sha256(customerUid).slice(0, 24) },
  });
}

async function findOrCreateProviderOrder(client, payload) {
  const existingOrders = typeof client.orders?.all === 'function'
    ? await client.orders.all({ receipt: payload.receipt, count: 10 })
    : null;
  const recovered = (existingOrders?.items || []).find(order => (
    order?.receipt === payload.receipt
    && Number(order?.amount) === payload.amount
    && String(order?.currency).toUpperCase() === CURRENCY
  ));
  return recovered || client.orders.create(payload);
}

function fetchProviderPaymentAndOrder(client, paymentId, providerOrderId) {
  return Promise.all([
    client.payments.fetch(paymentId),
    client.orders.fetch(providerOrderId),
  ]);
}

function createProviderRefund(client, paymentId, payload) {
  return client.payments.refund(paymentId, payload);
}

function sanitizedPublicItems(items) {
  return (items || []).map(item => ({
    itemName: item.itemName,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
    addOns: (item.addOns || []).map(addOn => ({
      groupName: addOn.groupName,
      optionName: addOn.optionName,
      quantity: addOn.quantity,
      unitPrice: addOn.unitPrice,
      totalPrice: addOn.totalPrice,
    })),
  }));
}

function publicTrackingPayload(order, admin) {
  return {
    trackingToken: order.trackingToken,
    publicOrderReference: order.publicOrderReference,
    storeName: order.storeName,
    orderType: order.orderType,
    ...(order.orderType === 'DINE_IN' ? { tableNumber: order.tableNumber } : {}),
    items: sanitizedPublicItems(order.items),
    subtotal: order.subtotal,
    gstTotal: order.gstTotal,
    total: order.grandTotal,
    publicStatus: order.status,
    paymentProvider: PROVIDER,
    paymentStatus: order.paymentStatus,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    customerStatusMessage: publicStatusMessage(order.status),
  };
}

function sessionResponse(session, keyId, magicEnabled) {
  return {
    sessionId: session.sessionId,
    razorpayOrderId: session.razorpayOrderId,
    amount: session.amountPaise,
    currency: CURRENCY,
    keyId,
    receipt: session.receipt,
    customerId: session.razorpayCustomerId,
    rememberCustomer: true,
    prefill: {
      name: session.customerName,
      contact: session.verifiedPhone,
    },
    readonly: { contact: true },
    magicCheckoutEnabled: magicEnabled,
    ...(magicEnabled ? {
      oneClickCheckout: true,
      lineItems: session.items.map(item => ({
        sku: item.finishedGoodCode,
        name: item.itemName,
        quantity: item.quantity,
        price: rupeesToPaise(item.unitPrice),
      })),
    } : {}),
    expiresAt: session.expiresAt?.toDate?.().toISOString?.() || session.expiresAt || null,
  };
}

async function waitForCheckoutSession(sessionRef, keyId, magicEnabled) {
  for (const delay of [250, 500, 1000, 2000]) {
    await sleep(delay);
    const snapshot = await sessionRef.get();
    const session = snapshot.exists ? { sessionId: snapshot.id, ...snapshot.data() } : null;
    if (session?.razorpayOrderId && session.status === 'PAYMENT_STARTED') {
      return sessionResponse(session, keyId, magicEnabled);
    }
    if (session?.status === 'ORDER_CREATED' && session.trackingToken) {
      return {
        alreadyPaid: true,
        trackingToken: session.trackingToken,
        trackingPath: `/order/status/${session.trackingToken}`,
      };
    }
    if (session?.status === 'PAYMENT_FAILED') break;
  }
  fail('aborted', 'Secure checkout is already being prepared. Please retry.');
}

async function resolveRazorpayCustomer({
  db,
  admin,
  customerUid,
  verifiedPhone,
  customerName,
  client,
  now = Date.now(),
}) {
  const profileRef = db.collection(CUSTOMER_PROFILE_COLLECTION).doc(customerUid);
  const leaseId = `customer_${randomBytes(12).toString('hex')}`;
  const lease = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(profileRef);
    const profile = snapshot.exists ? snapshot.data() : {};
    if (cleanText(profile.razorpayCustomerId, 120)) {
      return { customerId: profile.razorpayCustomerId, acquired: false };
    }
    const currentLeaseUntil = timestampMillis(profile.razorpayCustomerLeaseUntil);
    if (
      cleanText(profile.razorpayCustomerLeaseId, 120)
      && currentLeaseUntil
      && currentLeaseUntil > now
    ) {
      return { customerId: null, acquired: false };
    }
    transaction.set(profileRef, {
      customerUid,
      normalisedPhone: verifiedPhone,
      displayName: customerName,
      defaultOrderType: profile.defaultOrderType || 'PICKUP',
      razorpayCustomerLeaseId: leaseId,
      razorpayCustomerLeaseUntil: admin.firestore.Timestamp.fromMillis(now + PROVIDER_CREATION_LEASE_MS),
      createdAt: profile.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { customerId: null, acquired: true };
  });
  if (lease.customerId) return lease.customerId;

  if (!lease.acquired) {
    for (const delay of [250, 500, 1000, 2000]) {
      await sleep(delay);
      const snapshot = await profileRef.get();
      const customerId = cleanText(snapshot.data()?.razorpayCustomerId, 120);
      if (customerId) return customerId;
    }
    fail('aborted', 'Customer payment setup is already in progress. Please retry.');
  }

  try {
    const providerCustomer = await findOrCreateProviderCustomer(client, {
      customerUid,
      verifiedPhone,
      customerName,
    });
    const providerCustomerId = cleanText(providerCustomer?.id, 120);
    if (!providerCustomerId) {
      fail('unavailable', 'Online payment customer setup is temporarily unavailable.');
    }
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(profileRef);
      const profile = snapshot.exists ? snapshot.data() : {};
      if (
        profile.razorpayCustomerId
        && profile.razorpayCustomerId !== providerCustomerId
      ) {
        return;
      }
      if (profile.razorpayCustomerLeaseId !== leaseId && !profile.razorpayCustomerId) {
        fail('aborted', 'Customer payment setup changed. Please retry.');
      }
      transaction.set(profileRef, {
        customerUid,
        normalisedPhone: verifiedPhone,
        displayName: customerName,
        defaultOrderType: profile.defaultOrderType || 'PICKUP',
        razorpayCustomerId: profile.razorpayCustomerId || providerCustomerId,
        razorpayCustomerLeaseId: admin.firestore.FieldValue.delete(),
        razorpayCustomerLeaseUntil: admin.firestore.FieldValue.delete(),
        createdAt: profile.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    const saved = await profileRef.get();
    return cleanText(saved.data()?.razorpayCustomerId, 120) || providerCustomerId;
  } catch (error) {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(profileRef);
      if (snapshot.data()?.razorpayCustomerLeaseId === leaseId) {
        transaction.set(profileRef, {
          razorpayCustomerLeaseId: admin.firestore.FieldValue.delete(),
          razorpayCustomerLeaseUntil: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
    throw error;
  }
}

async function resolveCustomerProfileHandler({ request, db, admin }) {
  const identity = verifiedCustomerIdentity(request);
  const profileRef = db.collection(CUSTOMER_PROFILE_COLLECTION).doc(identity.uid);
  const profileSnapshot = await profileRef.get();
  const current = profileSnapshot.exists ? profileSnapshot.data() : {};
  const requestedName = cleanText(request.data?.displayName, 80);
  const requestedOrderType = request.data?.defaultOrderType === 'DINE_IN' ? 'DINE_IN' : 'PICKUP';
  const displayName = requestedName || cleanText(current.displayName, 80);
  const defaultOrderType = current.defaultOrderType === 'DINE_IN'
    ? 'DINE_IN'
    : requestedOrderType;
  await profileRef.set({
    customerUid: identity.uid,
    normalisedPhone: identity.phoneNumber,
    displayName,
    defaultOrderType,
    createdAt: current.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return {
    customerUid: identity.uid,
    normalisedPhone: identity.phoneNumber,
    displayName,
    defaultOrderType,
  };
}

async function createCheckoutSession({
  request,
  db,
  admin,
  keyId,
  keySecret,
  RazorpayClass,
  magicEnabled,
  now = Date.now(),
}) {
  const identity = verifiedCustomerIdentity(request);
  const idempotencyKey = cleanText(request.data?.clientIdempotencyKey, 200);
  if (idempotencyKey.length < 12) fail('invalid-argument', 'Please retry secure checkout.');
  const sessionId = customerSessionId(identity.uid, idempotencyKey);
  const sessionRef = db.collection(CHECKOUT_SESSION_COLLECTION).doc(sessionId);
  const canonical = await canonicalizeCustomerCheckout({
    db,
    data: request.data,
    sessionId,
  });
  const amountPaise = rupeesToPaise(canonical.grandTotal);
  const checksum = requestChecksum({
    storeId: canonical.store.id,
    grandTotal: canonical.grandTotal,
    items: canonical.items,
  });
  const providerCreationLeaseId = `order_${randomBytes(12).toString('hex')}`;
  const receipt = deterministicReceipt(sessionId);
  const expiresAt = admin.firestore.Timestamp.fromMillis(now + CHECKOUT_SESSION_TTL_MS);
  const claim = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(sessionRef);
    const existing = snapshot.exists ? { sessionId: snapshot.id, ...snapshot.data() } : null;
    if (existing?.customerUid && existing.customerUid !== identity.uid) {
      fail('permission-denied', 'This checkout belongs to another customer.');
    }
    if (existing?.requestChecksum && existing.requestChecksum !== checksum) {
      fail('already-exists', 'This checkout key was already used for a different basket.');
    }
    const existingExpiry = timestampMillis(existing?.expiresAt);
    if (
      existing?.razorpayOrderId
      && existing.status === 'PAYMENT_STARTED'
      && (!existingExpiry || existingExpiry > now)
    ) {
      return { kind: 'REUSE', session: existing };
    }
    if (existing && ['PAYMENT_CAPTURED', 'ORDER_CREATED'].includes(existing.status)) {
      return { kind: 'PAID', session: existing };
    }
    const leaseUntil = timestampMillis(existing?.providerCreationLeaseUntil);
    if (
      existing?.providerCreationLeaseId
      && leaseUntil
      && leaseUntil > now
      && existing.providerCreationLeaseId !== providerCreationLeaseId
    ) {
      return { kind: 'WAIT', session: existing };
    }
    const trackingToken = existing?.trackingToken || generateTrackingToken();
    const session = {
      sessionId,
      customerUid: identity.uid,
      verifiedPhone: identity.phoneNumber,
      storeId: canonical.store.id,
      storeCode: canonical.store.code,
      storeName: canonical.store.name,
      orderType: canonical.orderType,
      tableNumber: canonical.tableNumber,
      customerName: canonical.customerName,
      notes: canonical.notes,
      items: canonical.items,
      subtotal: canonical.subtotal,
      discount: canonical.discount,
      taxableAmount: canonical.taxableAmount,
      gstTotal: canonical.gstTotal,
      payable: canonical.grandTotal,
      amountPaise,
      currency: CURRENCY,
      razorpayCustomerId: existing?.razorpayCustomerId || null,
      razorpayOrderId: null,
      status: 'CREATED',
      requestChecksum: checksum,
      trackingToken,
      publicOrderReference: publicOrderReference(trackingToken),
      receipt,
      expiresAt,
      providerCreationLeaseId,
      providerCreationLeaseUntil: admin.firestore.Timestamp.fromMillis(now + PROVIDER_CREATION_LEASE_MS),
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    transaction.set(sessionRef, session, { merge: false });
    return { kind: 'CREATE', session };
  });
  if (claim.kind === 'REUSE') return sessionResponse(claim.session, keyId, magicEnabled);
  if (claim.kind === 'PAID') {
    return {
      alreadyPaid: true,
      trackingToken: claim.session.trackingToken || null,
      trackingPath: claim.session.trackingToken ? `/order/status/${claim.session.trackingToken}` : null,
    };
  }
  if (claim.kind === 'WAIT') return waitForCheckoutSession(sessionRef, keyId, magicEnabled);

  const client = razorpayClient(keyId, keySecret, RazorpayClass);
  try {
    const razorpayCustomerId = await resolveRazorpayCustomer({
      db,
      admin,
      customerUid: identity.uid,
      verifiedPhone: identity.phoneNumber,
      customerName: canonical.customerName,
      client,
      now,
    });
    await db.collection(CUSTOMER_PROFILE_COLLECTION).doc(identity.uid).set({
      displayName: canonical.customerName,
      defaultOrderType: canonical.orderType,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const providerOrder = await findOrCreateProviderOrder(client, {
      amount: amountPaise,
      currency: CURRENCY,
      receipt,
      customer_id: razorpayCustomerId,
      notes: {
        coffee_bond_checkout: sha256(sessionId).slice(0, 24),
      },
    });
    if (
      !providerOrder?.id
      || Number(providerOrder.amount) !== amountPaise
      || String(providerOrder.currency).toUpperCase() !== CURRENCY
    ) {
      throw Object.assign(new Error('Provider order response failed validation.'), { statusCode: 502 });
    }
    const created = {
      ...claim.session,
      razorpayCustomerId,
      razorpayOrderId: providerOrder.id,
      status: 'PAYMENT_STARTED',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await sessionRef.set({
      razorpayOrderId: providerOrder.id,
      razorpayCustomerId,
      status: 'PAYMENT_STARTED',
      providerCreationLeaseId: admin.firestore.FieldValue.delete(),
      providerCreationLeaseUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return sessionResponse(created, keyId, magicEnabled);
  } catch (error) {
    const safe = safeProviderError(error);
    await sessionRef.set({
      status: 'PAYMENT_FAILED',
      failureCode: safe.code,
      providerCreationLeaseId: admin.firestore.FieldValue.delete(),
      providerCreationLeaseUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error('razorpay-payment-first-order-create-failed', {
      sessionHash: sha256(sessionId).slice(0, 16),
      storeId: canonical.store.id,
      failureCode: safe.code,
    });
    fail('unavailable', safe.message);
  }
}

async function createPaidOnlineOrder({
  db,
  admin,
  sessionId,
  providerPayment,
  providerOrder,
  now = Date.now(),
}) {
  const sessionRef = db.collection(CHECKOUT_SESSION_COLLECTION).doc(sessionId);
  const onlineOrderId = customerOnlineOrderId(sessionId);
  const onlineOrderRef = db.collection('onlineOrders').doc(onlineOrderId);
  const trackingRef = db.collection('publicOrderTracking');
  const intentRef = db.collection(PAYMENT_INTENT_COLLECTION).doc(sessionId);
  const reservationRef = db.collection(RESERVATION_COLLECTION).doc(onlineOrderId);

  return db.runTransaction(async transaction => {
    const [sessionSnapshot, existingOrderSnapshot] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(onlineOrderRef),
    ]);
    if (!sessionSnapshot.exists) fail('not-found', 'Checkout session no longer exists.');
    const session = { sessionId: sessionSnapshot.id, ...sessionSnapshot.data() };
    if (existingOrderSnapshot.exists) {
      return {
        alreadyFinalized: true,
        onlineOrderId,
        trackingToken: existingOrderSnapshot.data().trackingToken,
        trackingPath: `/order/status/${existingOrderSnapshot.data().trackingToken}`,
      };
    }
    if (session.razorpayOrderId !== providerOrder.id || providerPayment.order_id !== session.razorpayOrderId) {
      fail('failed-precondition', 'Provider order does not match this checkout.');
    }

    const tender = providerMethod(providerPayment.method);
    const onlineOrder = {
      storeId: session.storeId,
      storeCode: session.storeCode,
      storeName: session.storeName,
      customerUid: session.customerUid,
      customerName: session.customerName,
      customerPhone: session.verifiedPhone.replace('+91', ''),
      verifiedPhone: session.verifiedPhone,
      orderType: session.orderType,
      ...(session.orderType === 'DINE_IN' ? { tableNumber: session.tableNumber } : {}),
      notes: session.notes,
      items: session.items,
      subtotal: session.subtotal,
      taxableAmount: session.taxableAmount,
      gstTotal: session.gstTotal,
      grandTotal: session.payable,
      status: 'PAID_PENDING_ACCEPTANCE',
      source: 'CUSTOMER_WEB',
      paymentProvider: PROVIDER,
      paymentMethod: 'ONLINE',
      paymentStatus: 'PAID',
      paymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
      checkoutSessionId: sessionId,
      paymentIntentId: sessionId,
      providerPaymentId: providerPayment.id,
      providerOrderId: providerOrder.id,
      providerMethod: tender,
      trackingToken: session.trackingToken,
      publicOrderReference: session.publicOrderReference,
      customerStatusMessage: paidPendingMessage(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    transaction.create(onlineOrderRef, onlineOrder);
    transaction.create(trackingRef.doc(session.trackingToken), publicTrackingPayload(onlineOrder, admin));
    transaction.set(intentRef, {
      checkoutSessionId: sessionId,
      coffeeBondOnlineOrderId: onlineOrderId,
      coffeeBondPosOrderId: deterministicPosOrderId(onlineOrderId),
      customerUid: session.customerUid,
      storeId: session.storeId,
      provider: PROVIDER,
      providerOrderId: providerOrder.id,
      safeProviderPaymentId: providerPayment.id,
      providerMethod: tender,
      expectedAmountPaise: session.amountPaise,
      expectedCurrency: CURRENCY,
      status: 'PAID',
      requestChecksum: session.requestChecksum,
      receipt: session.receipt,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: session.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.create(reservationRef, {
      idempotencyKey: onlineOrderId,
      onlineOrderId,
      checkoutSessionId: sessionId,
      customerUid: session.customerUid,
      storeId: session.storeId,
      status: 'ACTIVE',
      mode: 'SOFT_REVALIDATION_REQUIRED',
      items: session.items.map(item => ({
        finishedGoodId: item.finishedGoodId,
        finishedGoodCode: item.finishedGoodCode,
        quantity: item.quantity,
      })),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + RESERVATION_TTL_MS),
      releasedAt: null,
      convertedAt: null,
    });
    transaction.update(sessionRef, {
      status: 'ORDER_CREATED',
      onlineOrderId,
      paymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      alreadyFinalized: false,
      onlineOrderId,
      trackingToken: session.trackingToken,
      trackingPath: `/order/status/${session.trackingToken}`,
      publicOrderReference: session.publicOrderReference,
      customerStatusMessage: paidPendingMessage(),
    };
  });
}

async function verifySessionPayment({ request, db, admin, keyId, keySecret, RazorpayClass }) {
  const identity = verifiedCustomerIdentity(request);
  const sessionId = cleanText(request.data?.sessionId, 120);
  const paymentId = cleanText(request.data?.razorpay_payment_id, 120);
  const suppliedOrderId = cleanText(request.data?.razorpay_order_id, 120);
  const signature = cleanText(request.data?.razorpay_signature, 256);
  if (!sessionId || !paymentId || !suppliedOrderId || !signature) {
    fail('invalid-argument', 'Payment confirmation details are incomplete.');
  }
  const sessionSnapshot = await db.collection(CHECKOUT_SESSION_COLLECTION).doc(sessionId).get();
  if (!sessionSnapshot.exists) fail('not-found', 'Checkout session was not found.');
  const session = { sessionId: sessionSnapshot.id, ...sessionSnapshot.data() };
  if (session.customerUid !== identity.uid) fail('permission-denied', 'This checkout belongs to another customer.');
  if (suppliedOrderId !== session.razorpayOrderId) fail('permission-denied', 'Payment order does not match.');
  if (!verifyCheckoutSignature({
    storedOrderId: session.razorpayOrderId,
    paymentId,
    signature,
    keySecret,
  })) {
    fail('permission-denied', 'Payment signature could not be verified.');
  }

  const client = razorpayClient(keyId, keySecret, RazorpayClass);
  let payment;
  let providerOrder;
  try {
    [payment, providerOrder] = await fetchProviderPaymentAndOrder(
      client,
      paymentId,
      session.razorpayOrderId,
    );
  } catch (error) {
    console.error('razorpay-payment-first-provider-verify-failed', {
      sessionHash: sha256(sessionId).slice(0, 16),
      storeId: session.storeId,
      failureCode: safeProviderError(error).code,
    });
    fail('unavailable', 'Payment confirmation is delayed. Please refresh shortly.');
  }
  const finalState = isFinalProviderState({
    payment,
    providerOrder,
    expectedOrderId: session.razorpayOrderId,
    expectedAmountPaise: session.amountPaise,
  });
  if (!finalState.valid) {
    await sessionSnapshot.ref.set({
      status: payment?.status === 'failed' ? 'PAYMENT_FAILED' : 'PAYMENT_STARTED',
      failureCode: finalState.code,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    fail('failed-precondition', 'Payment is not captured and paid yet.');
  }
  try {
    return await createPaidOnlineOrder({ db, admin, sessionId, providerPayment: payment, providerOrder });
  } catch (error) {
    try {
      await sessionSnapshot.ref.set({
        status: REVIEW_STATUS,
        failureCode: 'PAID_ORDER_CREATION_FAILED',
        paymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (statusError) {
      console.error('razorpay-payment-first-review-status-failed', {
        sessionHash: sha256(sessionId).slice(0, 16),
        storeId: session.storeId,
        failureCode: cleanText(statusError?.code || statusError?.message, 120) || 'UNKNOWN',
      });
    }
    console.error('razorpay-payment-first-order-finalisation-failed', {
      sessionHash: sha256(sessionId).slice(0, 16),
      storeId: session.storeId,
      failureCode: cleanText(error?.code || error?.message, 120) || 'UNKNOWN',
    });
    fail('unavailable', 'Payment was received, but order confirmation is delayed. The store has been alerted.');
  }
}

function allowedStoreIds(profile) {
  return Array.isArray(profile.assignedStoreIds) && profile.assignedStoreIds.length > 0
    ? profile.assignedStoreIds
    : Array.isArray(profile.storeIds) ? profile.storeIds : [];
}

async function staffIdentity(request, db, allowedRoles) {
  const uid = cleanText(request.auth?.uid, 128);
  if (!uid) fail('unauthenticated', 'Staff sign-in is required.');
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) fail('permission-denied', 'Active staff profile is required.');
  const profile = snapshot.data() || {};
  const active = profile.isActive === true || profile.active === true;
  if (!active || !allowedRoles.includes(profile.role)) fail('permission-denied', 'This staff role cannot perform this action.');
  return {
    uid,
    name: cleanText(profile.displayName || profile.name || request.auth.token?.name || 'Staff', 120),
    role: profile.role,
    profile,
  };
}

async function acceptPaidOrder({ request, db, admin }) {
  const staff = await staffIdentity(request, db, ['ADMIN', 'STORE_MANAGER', 'CASHIER']);
  const onlineOrderId = cleanText(request.data?.onlineOrderId, 120);
  if (!onlineOrderId) fail('invalid-argument', 'Online order is required.');
  const orderRef = db.collection('onlineOrders').doc(onlineOrderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) fail('not-found', 'Paid online order was not found.');
  const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
  if (!isAuthorizedStaffProfile(staff.profile, order.storeId)) {
    fail('permission-denied', 'This staff account cannot accept orders for this store.');
  }
  if (order.status === 'CONVERTED' && order.linkedOrderId) {
    return {
      alreadyFinalized: true,
      orderId: order.linkedOrderId,
      orderNumber: order.linkedOrderNumber,
    };
  }
  if (order.status !== 'PAID_PENDING_ACCEPTANCE' || order.paymentStatus !== 'PAID') {
    fail('failed-precondition', 'This paid order is not awaiting acceptance.');
  }
  const intentSnapshot = await db.collection(PAYMENT_INTENT_COLLECTION).doc(order.checkoutSessionId).get();
  if (!intentSnapshot.exists || intentSnapshot.data()?.status !== 'PAID') {
    fail('failed-precondition', 'Verified payment intent was not found.');
  }
  await orderRef.set({
    acceptedBy: staff.uid,
    acceptedByName: staff.name,
    acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  const result = await finalizePaidOnlineOrder({
    db,
    admin,
    onlineOrderId,
    intentId: intentSnapshot.id,
    providerPayment: {
      id: order.providerPaymentId,
      order_id: order.providerOrderId,
      method: String(order.providerMethod || 'OTHER').toLowerCase(),
    },
    providerOrder: { id: order.providerOrderId },
  });
  if (!result.reviewRequired) {
    await db.collection(RESERVATION_COLLECTION).doc(onlineOrderId).set({
      status: 'CONVERTED',
      convertedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return result;
}

async function cancelAndRefund({
  request,
  db,
  admin,
  keyId,
  keySecret,
  RazorpayClass,
}) {
  const staff = await staffIdentity(request, db, ['ADMIN', 'STORE_MANAGER']);
  const onlineOrderId = cleanText(request.data?.onlineOrderId, 120);
  const reason = cleanText(request.data?.reason, 240);
  const confirmation = cleanText(request.data?.confirmation, 120);
  if (!onlineOrderId || !reason) fail('invalid-argument', 'Order and refund reason are required.');
  const orderRef = db.collection('onlineOrders').doc(onlineOrderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) fail('not-found', 'Paid online order was not found.');
  const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
  if (staff.role !== 'ADMIN' && !allowedStoreIds(staff.profile).includes(order.storeId)) {
    fail('permission-denied', 'This manager cannot refund another store’s order.');
  }
  if (!['REFUND', order.publicOrderReference].includes(confirmation)) {
    fail('failed-precondition', 'Type REFUND or the order reference to confirm the full refund.');
  }
  if (
    order.paymentProvider !== PROVIDER
    || !['PAID', 'REFUND_FAILED'].includes(order.paymentStatus)
    || !['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS, 'REFUND_FAILED'].includes(order.status)
  ) {
    fail('failed-precondition', 'Only an unaccepted captured Razorpay order can be refunded here.');
  }
  const refundRef = db.collection(REFUND_COLLECTION).doc(onlineOrderId);
  const refundRequestId = deterministicRefundRequestId(onlineOrderId);
  const requestLeaseId = `refund_${randomBytes(12).toString('hex')}`;
  const now = Date.now();
  const claim = await db.runTransaction(async transaction => {
    const [freshOrder, existingRefund] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(refundRef),
    ]);
    if (
      !freshOrder.exists
      || !['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS, 'REFUND_FAILED'].includes(freshOrder.data().status)
    ) {
      fail('aborted', 'Order status changed before the refund could be requested.');
    }
    const existing = existingRefund.exists ? existingRefund.data() : null;
    if (existing && ['REFUND_PENDING', 'REFUNDED'].includes(existing.status)) {
      return { kind: 'EXISTING', refund: existing };
    }
    const leaseUntil = timestampMillis(existing?.requestLeaseUntil);
    if (
      existing?.status === 'REFUND_REQUESTING'
      && existing?.requestLeaseId
      && leaseUntil
      && leaseUntil > now
    ) {
      return { kind: 'IN_PROGRESS', refund: existing };
    }
    const requestReason = cleanText(existing?.reason, 240) || reason;
    transaction.set(refundRef, {
      onlineOrderId,
      storeId: order.storeId,
      provider: PROVIDER,
      providerPaymentId: order.providerPaymentId,
      refundRequestId,
      amountPaise: rupeesToPaise(Number(order.grandTotal)),
      currency: CURRENCY,
      status: 'REFUND_REQUESTING',
      reason: requestReason,
      requestedBy: staff.uid,
      requestedByName: staff.name,
      requestedAt: existing?.requestedAt || admin.firestore.FieldValue.serverTimestamp(),
      requestLeaseId,
      requestLeaseUntil: admin.firestore.Timestamp.fromMillis(now + REFUND_REQUEST_LEASE_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { kind: 'CREATE', refund: existing, reason: requestReason };
  });
  if (claim.kind === 'EXISTING') {
    return {
      alreadyRequested: true,
      status: claim.refund.status,
      refundId: claim.refund.providerRefundId || null,
    };
  }
  if (claim.kind === 'IN_PROGRESS') {
    fail('aborted', 'A full refund request is already in progress.');
  }
  const client = razorpayClient(keyId, keySecret, RazorpayClass, {
    headers: { 'X-Refund-Idempotency': refundRequestId },
  });
  let providerRefund;
  try {
    providerRefund = await createProviderRefund(client, order.providerPaymentId, {
      amount: rupeesToPaise(Number(order.grandTotal)),
      speed: 'normal',
      receipt: refundRequestId,
      notes: {
        coffee_bond_order: sha256(onlineOrderId).slice(0, 24),
        reason: claim.reason.slice(0, 120),
      },
    });
    if (!cleanText(providerRefund?.id, 120)) {
      throw Object.assign(new Error('Refund confirmation was not returned.'), { statusCode: 502 });
    }
  } catch (error) {
    const safe = safeProviderError(error);
    console.error('razorpay-refund-request-failed', {
      orderHash: sha256(onlineOrderId).slice(0, 16),
      storeId: order.storeId,
      failureCode: safe.code,
    });
    await db.runTransaction(async transaction => {
      const freshRefund = await transaction.get(refundRef);
      if (freshRefund.data()?.requestLeaseId !== requestLeaseId) return;
      transaction.set(refundRef, {
        status: 'REFUND_FAILED',
        failureCode: safe.code,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        requestLeaseId: admin.firestore.FieldValue.delete(),
        requestLeaseUntil: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.update(orderRef, {
        status: 'REFUND_FAILED',
        paymentStatus: 'REFUND_FAILED',
        refundStatus: 'REFUND_FAILED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(db.collection('publicOrderTracking').doc(order.trackingToken), {
        publicStatus: 'REFUND_FAILED',
        paymentStatus: 'REFUND_FAILED',
        customerStatusMessage: publicStatusMessage('REFUND_FAILED'),
      }, { merge: true });
    });
    fail('unavailable', 'The full refund could not be initiated. Please retry.');
  }

  await db.runTransaction(async transaction => {
    const [freshOrder, freshRefund] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(refundRef),
    ]);
    if (
      !freshOrder.exists
      || !['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS, 'REFUND_FAILED'].includes(freshOrder.data().status)
      || freshRefund.data()?.requestLeaseId !== requestLeaseId
      || freshRefund.data()?.refundRequestId !== refundRequestId
    ) {
      fail('aborted', 'Order status changed before the refund could be recorded.');
    }
    transaction.set(refundRef, {
      onlineOrderId,
      storeId: order.storeId,
      provider: PROVIDER,
      providerPaymentId: order.providerPaymentId,
      providerRefundId: providerRefund.id,
      refundRequestId,
      amountPaise: rupeesToPaise(Number(order.grandTotal)),
      currency: CURRENCY,
      status: 'REFUND_PENDING',
      reason,
      requestedBy: staff.uid,
      requestedByName: staff.name,
      requestLeaseId: admin.firestore.FieldValue.delete(),
      requestLeaseUntil: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(orderRef, {
      status: 'REFUND_PENDING',
      refundStatus: 'REFUND_PENDING',
      refundReason: claim.reason,
      refundRequestedBy: staff.uid,
      refundRequestedByName: staff.name,
      refundRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    transaction.set(db.collection(RESERVATION_COLLECTION).doc(onlineOrderId), {
      status: 'RELEASED',
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      releaseReason: 'REFUND_REQUESTED',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(db.collection('publicOrderTracking').doc(order.trackingToken), {
      publicStatus: 'REFUND_PENDING',
      paymentStatus: 'REFUND_PENDING',
      customerStatusMessage: publicStatusMessage('REFUND_PENDING'),
    }, { merge: true });
  });
  return { alreadyRequested: false, status: 'REFUND_PENDING', refundId: providerRefund.id };
}

async function listMyOrders({ request, db }) {
  const identity = verifiedCustomerIdentity(request);
  const snapshot = await db.collection('onlineOrders')
    .where('customerUid', '==', identity.uid)
    .limit(50)
    .get();
  return {
    orders: snapshot.docs.map(document => {
      const order = document.data();
      return {
        trackingToken: order.trackingToken,
        publicOrderReference: order.publicOrderReference,
        storeName: order.storeName,
        orderType: order.orderType,
        total: order.grandTotal,
        status: order.status,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt?.toDate?.().toISOString?.() || null,
      };
    }).sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
  };
}

async function updateRefundFromWebhook({ db, admin, eventName, refundEntity }) {
  const providerRefundId = cleanText(refundEntity?.id, 120);
  if (!providerRefundId) return { handled: false, outcome: 'REFUND_ID_MISSING' };
  const query = await db.collection(REFUND_COLLECTION)
    .where('providerRefundId', '==', providerRefundId)
    .limit(2)
    .get();
  if (query.size !== 1) return { handled: false, outcome: 'REFUND_RECORD_NOT_FOUND' };
  const refundSnapshot = query.docs[0];
  const refund = refundSnapshot.data();
  const orderRef = db.collection('onlineOrders').doc(refund.onlineOrderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) return { handled: false, outcome: 'REFUND_ORDER_NOT_FOUND' };
  const order = orderSnapshot.data();
  if (eventName === 'refund.created') return { handled: true, outcome: 'REFUND_PENDING' };
  const status = eventName === 'refund.processed' ? 'REFUNDED' : 'REFUND_FAILED';
  await db.runTransaction(async transaction => {
    transaction.set(refundSnapshot.ref, {
      status,
      failureCode: eventName === 'refund.failed' ? cleanText(refundEntity?.error_code, 80) || 'PROVIDER_REFUND_FAILED' : null,
      processedAt: eventName === 'refund.processed' ? admin.firestore.FieldValue.serverTimestamp() : null,
      failedAt: eventName === 'refund.failed' ? admin.firestore.FieldValue.serverTimestamp() : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(orderRef, {
      status: eventName === 'refund.processed' ? 'CANCELLED_REFUNDED' : 'REFUND_FAILED',
      paymentStatus: status,
      refundStatus: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    transaction.set(db.collection('publicOrderTracking').doc(order.trackingToken), {
      publicStatus: status,
      paymentStatus: status,
      customerStatusMessage: publicStatusMessage(status),
    }, { merge: true });
  });
  return { handled: true, outcome: status };
}

function createRazorpayPaymentFirstFunctions({
  admin,
  db,
  region,
  RazorpayClass = Razorpay,
  keyIdParameter = RAZORPAY_KEY_ID,
  keySecretParameter = RAZORPAY_KEY_SECRET,
  webhookSecretParameter = RAZORPAY_WEBHOOK_SECRET,
  magicCheckoutParameter = MAGIC_CHECKOUT_ENABLED,
}) {
  const resolveCustomerProfile = onCall({ region }, request => (
    resolveCustomerProfileHandler({ request, db, admin })
  ));

  const createCustomerCheckoutSession = onCall({
    region,
    timeoutSeconds: 120,
    memory: '1GiB',
    secrets: [keySecretParameter],
  }, request => createCheckoutSession({
    request,
    db,
    admin,
    keyId: cleanText(keyIdParameter.value(), 120),
    keySecret: keySecretParameter.value(),
    RazorpayClass,
    magicEnabled: booleanParameter(magicCheckoutParameter),
  }));

  const verifyCustomerRazorpayPayment = onCall({
    region,
    timeoutSeconds: 180,
    memory: '1GiB',
    secrets: [keySecretParameter],
  }, request => verifySessionPayment({
    request,
    db,
    admin,
    keyId: cleanText(keyIdParameter.value(), 120),
    keySecret: keySecretParameter.value(),
    RazorpayClass,
  }));

  const acceptPaidRazorpayOrder = onCall({
    region,
    timeoutSeconds: 180,
    memory: '1GiB',
  }, request => acceptPaidOrder({ request, db, admin }));

  const cancelAndRefundRazorpayOrder = onCall({
    region,
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [keySecretParameter],
  }, request => cancelAndRefund({
    request,
    db,
    admin,
    keyId: cleanText(keyIdParameter.value(), 120),
    keySecret: keySecretParameter.value(),
    RazorpayClass,
  }));

  const listMyCustomerOrders = onCall({ region }, request => listMyOrders({ request, db }));

  const razorpayWebhook = onRequest({
    region,
    timeoutSeconds: 180,
    memory: '1GiB',
    secrets: [keySecretParameter, webhookSecretParameter],
  }, async (request, response) => {
    const rawBody = request.rawBody;
    if (!verifyWebhookSignature({
      rawBody,
      signature: request.get('x-razorpay-signature'),
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
    if (auditSnapshot.exists && auditSnapshot.data()?.status === 'PROCESSED') {
      response.status(200).json({ ok: true, duplicate: true });
      return;
    }
    const paymentEntity = event.payload?.payment?.entity || null;
    const orderEntity = event.payload?.order?.entity || null;
    const refundEntity = event.payload?.refund?.entity || null;
    await auditRef.set({
      eventId,
      eventName,
      provider: PROVIDER,
      status: 'PROCESSING',
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    if (['refund.created', 'refund.processed', 'refund.failed'].includes(eventName)) {
      const outcome = await updateRefundFromWebhook({ db, admin, eventName, refundEntity });
      await auditRef.set({
        status: outcome.handled ? 'PROCESSED' : 'FAILED',
        outcome: outcome.outcome,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, reviewRequired: !outcome.handled });
      return;
    }
    if (!['payment.captured', 'payment.failed', 'order.paid'].includes(eventName)) {
      await auditRef.set({
        status: 'PROCESSED',
        outcome: 'IGNORED_UNSUPPORTED_EVENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, ignored: true });
      return;
    }
    const providerOrderId = cleanText(paymentEntity?.order_id || orderEntity?.id, 120);
    const sessionQuery = await db.collection(CHECKOUT_SESSION_COLLECTION)
      .where('razorpayOrderId', '==', providerOrderId)
      .limit(2)
      .get();
    if (sessionQuery.size !== 1) {
      await auditRef.set({
        status: 'FAILED',
        outcome: 'CHECKOUT_SESSION_NOT_FOUND',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, reviewRequired: true });
      return;
    }
    const sessionSnapshot = sessionQuery.docs[0];
    const session = { sessionId: sessionSnapshot.id, ...sessionSnapshot.data() };
    if (eventName === 'payment.failed') {
      await sessionSnapshot.ref.set({
        status: 'PAYMENT_FAILED',
        failureCode: 'PROVIDER_PAYMENT_FAILED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
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
    const paymentId = await resolveWebhookPaymentId({
      client,
      eventPaymentId: cleanText(paymentEntity?.id, 120),
      providerOrderId,
    });
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
      const [payment, providerOrder] = await fetchProviderPaymentAndOrder(
        client,
        paymentId,
        providerOrderId,
      );
      const finalState = isFinalProviderState({
        payment,
        providerOrder,
        expectedOrderId: providerOrderId,
        expectedAmountPaise: session.amountPaise,
      });
      if (!finalState.valid) throw new Error(finalState.code);
      const result = await createPaidOnlineOrder({
        db,
        admin,
        sessionId: session.sessionId,
        providerPayment: payment,
        providerOrder,
      });
      await auditRef.set({
        status: 'PROCESSED',
        outcome: 'ORDER_CREATED',
        coffeeBondOnlineOrderId: result.onlineOrderId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(200).json({ ok: true, duplicate: result.alreadyFinalized });
    } catch (error) {
      await sessionSnapshot.ref.set({
        status: REVIEW_STATUS,
        failureCode: cleanText(error?.message, 120) || 'PAYMENT_FINALISATION_FAILED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      console.error('razorpay-payment-first-webhook-failed', {
        eventId,
        eventName,
        sessionHash: sha256(session.sessionId).slice(0, 16),
        failureCode: cleanText(error?.message, 120),
      });
      await auditRef.set({
        status: 'FAILED',
        outcome: 'PAYMENT_REVIEW_REQUIRED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.status(500).json({ ok: false });
    }
  });

  return {
    acceptPaidRazorpayOrder,
    cancelAndRefundRazorpayOrder,
    createCustomerCheckoutSession,
    listMyCustomerOrders,
    razorpayWebhook,
    resolveCustomerProfile,
    verifyCustomerRazorpayPayment,
  };
}

module.exports = {
  CHECKOUT_SESSION_COLLECTION,
  CHECKOUT_SESSION_TTL_MS,
  CUSTOMER_PROFILE_COLLECTION,
  MAGIC_CHECKOUT_ENABLED,
  REFUND_COLLECTION,
  RESERVATION_COLLECTION,
  RESERVATION_TTL_MS,
  cancelAndRefund,
  createCheckoutSession,
  createPaidOnlineOrder,
  createProviderRefund,
  createRazorpayPaymentFirstFunctions,
  customerOnlineOrderId,
  customerSessionId,
  deterministicRefundRequestId,
  fetchProviderPaymentAndOrder,
  findOrCreateProviderCustomer,
  findOrCreateProviderOrder,
  listMyOrders,
  paidPendingMessage,
  publicStatusMessage,
  resolveCustomerProfileHandler,
  updateRefundFromWebhook,
  verifiedCustomerIdentity,
  verifySessionPayment,
};
