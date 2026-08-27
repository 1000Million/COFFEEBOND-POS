import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const PROJECT_ID = 'demo-coffee-bond-redemption-races';
const KEY_ID = 'rzp_test_local_only';
const KEY_SECRET = 'local_payment_race_secret';
const WEBHOOK_SECRET = 'local_webhook_race_secret';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-redemption-races-firebase-config',
  };
  for (const prefix of [
    '/opt/homebrew/opt/openjdk@21',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk@21',
    '/usr/local/opt/openjdk',
  ]) {
    if (commandResult(`${prefix}/bin/java`, ['-version']).status === 0) {
      return { ...env, JAVA_HOME: prefix, PATH: `${prefix}/bin:${env.PATH || ''}` };
    }
  }
  return env;
}

if (!process.argv.includes('--inside-emulator')) {
  const env = emulatorEnv();
  if (commandResult('java', ['-version'], env).status !== 0
    || commandResult('firebase', ['--version'], env).status !== 0) {
    console.error('BLOCKED: Firebase CLI and Java are required for payment-race emulator QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-bond-redemption-payment-races-emulator-e2e.mjs --inside-emulator',
  ], { stdio: 'inherit', env });
  process.exit(result.status ?? 1);
}

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator host is required.');
assert.ok(PROJECT_ID.startsWith('demo-'), 'Only a throwaway demo project may be used.');
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const {
  createBondRedemptionService,
  redemptionLedgerId,
  redemptionReservationId,
  redemptionRestoreLedgerId,
} = require('../functions/bondRedemption');
const { finalizePaidOnlineOrder } = require('../functions/razorpayCheckout');
const {
  createPaidOnlineOrder,
  createRazorpayPaymentFirstFunctions,
  customerOnlineOrderId,
  releaseCustomerCheckoutSessionHandler,
  updateRefundFromWebhook,
  verifySessionPayment,
} = require('../functions/razorpayPaymentFirst');
const redemptionService = createBondRedemptionService({ admin, db });
const Timestamp = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

const passed = [];
const failed = [];
function check(name, condition) {
  if (!condition) {
    failed.push(name);
    console.error(`FAIL ${passed.length + failed.length}. ${name}`);
    return;
  }
  passed.push(name);
  console.log(`PASS ${passed.length + failed.length}. ${name}`);
}

async function rejects(action, expectedCode) {
  try {
    await action();
    return null;
  } catch (error) {
    if (expectedCode) assert.equal(error?.code, expectedCode);
    return error;
  }
}

function authRequest(customerUid, data) {
  return {
    auth: {
      uid: customerUid,
      token: {
        phone_number: '+919999999999',
        firebase: { sign_in_provider: 'phone' },
      },
    },
    data,
  };
}

function canonicalBasket() {
  return {
    source: 'CUSTOMER_WEB',
    store: { id: 'STORE_A', code: 'NOIDA_29', name: 'Noida 29' },
    storeId: 'STORE_A',
    storeCode: 'NOIDA_29',
    customerName: 'Synthetic Customer',
    orderType: 'TAKEAWAY',
    tableNumber: null,
    notes: '',
    items: [{
      lineId: 'line_flat_white',
      finishedGoodId: 'FG_FLAT_WHITE',
      finishedGoodCode: 'FLAT_WHITE',
      itemName: 'Flat White',
      name: 'Flat White',
      quantity: 1,
      baseUnitPrice: 250,
      unitPrice: 250,
      unitPriceWithAddOns: 250,
      taxRate: 5,
      addOns: [],
      lineSubtotal: 250,
      lineDiscount: 0,
      lineTaxable: 250,
      lineTax: 12.5,
      lineTotal: 262.5,
    }],
    subtotal: 250,
    discount: 0,
    discountAmount: 0,
    discountTotal: 0,
    taxableAmount: 250,
    gstTotal: 12.5,
    grandTotal: 262.5,
  };
}

async function seedFlags() {
  await db.doc('appSettings/loyalty').set({
    accountEnabled: true,
    shadowEnabled: false,
    earnEnabled: false,
    visitEnabled: false,
    expiryEnabled: false,
    redemptionEnabled: true,
    gamificationEnabled: false,
    clubEarnedEnabled: false,
    clubPaidEnabled: false,
    omakaseEnabled: false,
    customerOrderingOnly: true,
  });
}

async function seedAccount(customerId, pointsBalance = 56) {
  await db.collection('loyaltyAccounts').doc(customerId).set({
    customerId,
    pointsBalance,
    reservedRedemptionPoints: 0,
    lifetimePointsEarned: pointsBalance,
    lifetimePointsRedeemed: 0,
    lifetimePointsRestored: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function providerState(session, paymentId = `pay_${session.sessionId}`) {
  return {
    payment: {
      id: paymentId,
      order_id: session.razorpayOrderId,
      amount: session.amountPaise,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
    },
    order: {
      id: session.razorpayOrderId,
      amount: session.amountPaise,
      currency: 'INR',
      status: 'paid',
    },
  };
}

const providerPayments = new Map();
const providerOrders = new Map();
const providerRefundCalls = new Map();
class FakeRazorpay {
  constructor() {
    this.payments = {
      fetch: async id => {
        if (!providerPayments.has(id)) throw new Error(`Missing local payment ${id}`);
        return providerPayments.get(id);
      },
      refund: async (paymentId, payload) => {
        providerRefundCalls.set(paymentId, Number(providerRefundCalls.get(paymentId) || 0) + 1);
        return {
          id: `refund_${paymentId}`,
          payment_id: paymentId,
          amount: payload.amount,
          currency: 'INR',
          status: 'pending',
        };
      },
    };
    this.orders = {
      fetch: async id => {
        if (!providerOrders.has(id)) throw new Error(`Missing local order ${id}`);
        return providerOrders.get(id);
      },
    };
  }
}

async function seedCheckout({
  customerId,
  sessionId,
  status = 'PAYMENT_STARTED',
  points = 50,
}) {
  await seedAccount(customerId);
  const quote = await redemptionService.quote({
    customerId,
    canonical: canonicalBasket(),
    requestedPoints: points,
  });
  await db.runTransaction(transaction => redemptionService.reserveInTransaction({
    transaction,
    customerId,
    sessionId,
    canonical: quote.canonical,
    expiresAt: Timestamp.fromMillis(Date.now() + (15 * 60 * 1000)),
    requestChecksum: `checksum_${sessionId}`,
  }));
  const canonical = quote.canonical;
  const session = {
    sessionId,
    customerUid: customerId,
    verifiedPhone: '+919999999999',
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
    discountAmount: canonical.discountAmount,
    discountTotal: canonical.discountTotal,
    discountReason: canonical.discountReason,
    discountSource: canonical.discountSource,
    taxableAmount: canonical.taxableAmount,
    gstTotal: canonical.gstTotal,
    payable: canonical.grandTotal,
    amountPaise: Math.round(canonical.grandTotal * 100),
    currency: 'INR',
    bondRedemptionEnabled: true,
    bondRedemptionStatus: points > 0 ? 'RESERVED' : 'NOT_REQUESTED',
    bondRedemptionPoints: canonical.bondRedemptionPoints,
    bondRedemptionDiscount: canonical.bondRedemptionDiscount,
    razorpayOrderId: `order_${sessionId}`,
    status,
    requestChecksum: `checksum_${sessionId}`,
    trackingToken: `track_${sessionId}`,
    publicOrderReference: `CBWEB-${sessionId.slice(-10).toUpperCase()}`,
    receipt: `receipt_${sessionId}`,
    expiresAt: Timestamp.fromMillis(Date.now() + (15 * 60 * 1000)),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.collection('customerCheckoutSessions').doc(sessionId).set(session);
  const provider = providerState(session);
  providerPayments.set(provider.payment.id, provider.payment);
  providerOrders.set(provider.order.id, provider.order);
  return { session, provider, quote };
}

function verifiedPaymentRequest(customerId, session, paymentId) {
  const signature = createHmac('sha256', KEY_SECRET)
    .update(`${session.razorpayOrderId}|${paymentId}`)
    .digest('hex');
  return authRequest(customerId, {
    sessionId: session.sessionId,
    razorpay_payment_id: paymentId,
    razorpay_order_id: session.razorpayOrderId,
    razorpay_signature: signature,
  });
}

async function verifyCaptured(customerId, session, paymentId) {
  return verifySessionPayment({
    request: verifiedPaymentRequest(customerId, session, paymentId),
    db,
    admin,
    redemptionService,
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    RazorpayClass: FakeRazorpay,
  });
}

async function countFor(collectionName, field, value) {
  const snapshot = await db.collection(collectionName).where(field, '==', value).get();
  return snapshot.size;
}

async function refundForSession(sessionId) {
  const snapshot = await db.collection('razorpayRefunds')
    .where('checkoutSessionId', '==', sessionId)
    .limit(2)
    .get();
  assert.equal(snapshot.size, 1, `Expected one refund for ${sessionId}`);
  return { id: snapshot.docs[0].id, ref: snapshot.docs[0].ref, ...snapshot.docs[0].data() };
}

async function invokeWebhook(functions, eventId, event) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const headers = {
    'x-razorpay-signature': signature,
    'x-razorpay-event-id': eventId,
  };
  let statusCode = 200;
  let responseBody = null;
  const request = {
    body: event,
    rawBody,
    get: name => headers[String(name).toLowerCase()] || undefined,
    headers,
    method: 'POST',
    url: '/',
  };
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      responseBody = value;
      return this;
    },
    send(value) {
      responseBody = value;
      return this;
    },
  };
  await functions.razorpayWebhook(request, response);
  return { statusCode, body: responseBody };
}

await seedFlags();
const paymentFunctions = createRazorpayPaymentFirstFunctions({
  admin,
  db,
  region: 'us-central1',
  RazorpayClass: FakeRazorpay,
  keyIdParameter: { value: () => KEY_ID },
  keySecretParameter: { value: () => KEY_SECRET },
  webhookSecretParameter: { value: () => WEBHOOK_SECRET },
  magicCheckoutParameter: { value: () => 'false' },
  getLoyaltyEarnings: async () => new Map(),
});

// A customer dismiss can win the local race while the provider is completing capture.
// The captured payment must create one deterministic full refund, never an order/debit.
const dismissed = await seedCheckout({
  customerId: 'customer_dismissed',
  sessionId: 'session_dismissed',
});
const dismissal = await releaseCustomerCheckoutSessionHandler({
  request: authRequest('customer_dismissed', {
    sessionId: dismissed.session.sessionId,
    reason: 'CHECKOUT_DISMISSED',
  }),
  db,
  admin,
  redemptionService,
});
check('dismiss releases the active redemption reservation',
  dismissal.status === 'CANCELLED' && dismissal.released === true);
const lateDismissError = await rejects(
  () => verifyCaptured(
    'customer_dismissed',
    dismissed.session,
    dismissed.provider.payment.id,
  ),
  'failed-precondition',
);
let dismissedSession = (await db.collection('customerCheckoutSessions')
  .doc(dismissed.session.sessionId).get()).data();
const dismissedAccount = (await db.collection('loyaltyAccounts')
  .doc('customer_dismissed').get()).data();
let dismissedRefund = await refundForSession(dismissed.session.sessionId);
check('late captured payment after dismiss starts one full automatic refund',
  lateDismissError
  && dismissedSession.status === 'REFUND_PENDING'
  && dismissedSession.refundStatus === 'REFUND_PENDING'
  && dismissedRefund.status === 'REFUND_PENDING'
  && dismissedRefund.workflow === 'CUSTOMER_CHECKOUT_ORPHAN'
  && dismissedRefund.amountPaise === dismissed.session.amountPaise
  && dismissedRefund.providerPaymentId === dismissed.provider.payment.id
  && Number(providerRefundCalls.get(dismissed.provider.payment.id)) === 1);
check('late capture after dismiss creates no order and consumes no points',
  !(await db.collection('onlineOrders').doc(customerOnlineOrderId(dismissed.session.sessionId)).get()).exists
  && !(await db.collection('loyaltyPointLedger').doc(redemptionLedgerId(dismissed.session.sessionId)).get()).exists
  && dismissedAccount.pointsBalance === 56
  && dismissedAccount.reservedRedemptionPoints === 0);

await rejects(
  () => verifyCaptured(
    'customer_dismissed',
    dismissed.session,
    dismissed.provider.payment.id,
  ),
  'failed-precondition',
);
const duplicateDismissWebhook = await invokeWebhook(paymentFunctions, 'evt_dismissed_capture_retry', {
  event: 'payment.captured',
  payload: { payment: { entity: dismissed.provider.payment } },
});
dismissedRefund = await refundForSession(dismissed.session.sessionId);
check('duplicate callback/webhook creates zero duplicate refund or redemption debit',
  duplicateDismissWebhook.statusCode === 200
  && Number(providerRefundCalls.get(dismissed.provider.payment.id)) === 1
  && dismissedRefund.status === 'REFUND_PENDING'
  && await countFor('razorpayRefunds', 'checkoutSessionId', dismissed.session.sessionId) === 1
  && await countFor('loyaltyPointLedger', 'sourceCheckoutSessionId', dismissed.session.sessionId) === 0);

const dismissedProcessed = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  eventName: 'refund.processed',
  refundEntity: {
    id: dismissedRefund.providerRefundId,
    payment_id: dismissed.provider.payment.id,
    amount: dismissed.session.amountPaise,
    currency: 'INR',
    status: 'processed',
  },
});
const dismissedProcessedRetry = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  eventName: 'refund.processed',
  refundEntity: {
    id: dismissedRefund.providerRefundId,
    payment_id: dismissed.provider.payment.id,
    amount: dismissed.session.amountPaise,
    currency: 'INR',
    status: 'processed',
  },
});
dismissedSession = (await db.collection('customerCheckoutSessions')
  .doc(dismissed.session.sessionId).get()).data();
dismissedRefund = await refundForSession(dismissed.session.sessionId);
check('orphan refund progresses REFUND_PENDING to terminal REFUNDED exactly once',
  dismissedProcessed.outcome === 'REFUNDED'
  && dismissedProcessedRetry.outcome === 'REFUNDED'
  && dismissedSession.status === 'REFUNDED'
  && dismissedSession.refundStatus === 'REFUNDED'
  && dismissedRefund.status === 'REFUNDED'
  && Number(providerRefundCalls.get(dismissed.provider.payment.id)) === 1
  && await countFor('loyaltyPointLedger', 'sourceCheckoutSessionId', dismissed.session.sessionId) === 0);

// Expiry has the same monotonic safety boundary as explicit dismissal.
const expired = await seedCheckout({
  customerId: 'customer_expired',
  sessionId: 'session_expired',
});
await redemptionService.releaseReservation({
  customerId: 'customer_expired',
  sessionId: expired.session.sessionId,
  reason: 'CHECKOUT_EXPIRED',
});
await db.collection('customerCheckoutSessions').doc(expired.session.sessionId).set({
  status: 'EXPIRED',
  expiresAt: Timestamp.fromMillis(Date.now() - 1000),
}, { merge: true });
const lateExpiryError = await rejects(
  () => verifyCaptured('customer_expired', expired.session, expired.provider.payment.id),
  'failed-precondition',
);
const expiredSession = (await db.collection('customerCheckoutSessions')
  .doc(expired.session.sessionId).get()).data();
const expiredRefund = await refundForSession(expired.session.sessionId);
const expiredAccount = (await db.collection('loyaltyAccounts').doc('customer_expired').get()).data();
check('late captured payment after expiry starts one full automatic refund',
  lateExpiryError
  && expiredSession.status === 'REFUND_PENDING'
  && expiredRefund.status === 'REFUND_PENDING'
  && Number(providerRefundCalls.get(expired.provider.payment.id)) === 1
  && !(await db.collection('onlineOrders').doc(customerOnlineOrderId(expired.session.sessionId)).get()).exists
  && !(await db.collection('loyaltyPointLedger').doc(redemptionLedgerId(expired.session.sessionId)).get()).exists
  && expiredAccount.pointsBalance === 56
  && expiredAccount.reservedRedemptionPoints === 0);

// The browser verifier and webhook both terminate at createPaidOnlineOrder. Run that
// finalizer concurrently to prove the transaction has one business outcome.
const duplicate = await seedCheckout({
  customerId: 'customer_duplicate',
  sessionId: 'session_duplicate',
});
const duplicateResults = await Promise.all([
  createPaidOnlineOrder({
    db,
    admin,
    redemptionService,
    sessionId: duplicate.session.sessionId,
    providerPayment: duplicate.provider.payment,
    providerOrder: duplicate.provider.order,
  }),
  createPaidOnlineOrder({
    db,
    admin,
    redemptionService,
    sessionId: duplicate.session.sessionId,
    providerPayment: duplicate.provider.payment,
    providerOrder: duplicate.provider.order,
  }),
]);
const duplicateOnlineOrderId = customerOnlineOrderId(duplicate.session.sessionId);
const duplicateRetry = await verifyCaptured(
  'customer_duplicate',
  duplicate.session,
  duplicate.provider.payment.id,
);
const duplicateAccount = (await db.collection('loyaltyAccounts')
  .doc('customer_duplicate').get()).data();
check('concurrent browser/webhook finalizers converge on one online order',
  duplicateResults.filter(result => result.alreadyFinalized === false).length === 1
  && duplicateResults.filter(result => result.alreadyFinalized === true).length === 1
  && duplicateRetry.alreadyFinalized === true
  && await countFor('onlineOrders', 'checkoutSessionId', duplicate.session.sessionId) === 1);
check('duplicate finalization creates one public row, intent, hold, and redemption debit',
  (await db.collection('publicOrderTracking').doc(duplicate.session.trackingToken).get()).exists
  && (await db.collection('razorpayPaymentIntents').doc(duplicate.session.sessionId).get()).exists
  && (await db.collection('inventoryReservations').doc(duplicateOnlineOrderId).get()).exists
  && (await db.collection('loyaltyPointLedger').doc(redemptionLedgerId(duplicate.session.sessionId)).get()).exists
  && await countFor('loyaltyPointLedger', 'sourceCheckoutSessionId', duplicate.session.sessionId) === 1
  && duplicateAccount.pointsBalance === 6
  && duplicateAccount.reservedRedemptionPoints === 0);

// Acceptance must preserve the server-canonical redeemed amounts all the way
// through the POS order, payment, item, KOT, and inventory transaction.
const accepted = await seedCheckout({
  customerId: 'customer_accepted',
  sessionId: 'session_accepted',
});
const acceptedPayment = await createPaidOnlineOrder({
  db,
  admin,
  redemptionService,
  sessionId: accepted.session.sessionId,
  providerPayment: accepted.provider.payment,
  providerOrder: accepted.provider.order,
});
await Promise.all([
  db.collection('stores').doc('STORE_A').set({
    code: 'NOIDA_29',
    name: 'Noida 29',
    isActive: true,
  }),
  db.collection('appSettings').doc('gstConfig').set({ defaultGstRate: 5 }),
  db.collection('finishedGoods').doc('FG_FLAT_WHITE').set({
    code: 'FLAT_WHITE',
    name: 'Flat White',
    displayName: 'Flat White',
    salePrice: 250,
    taxRate: 5,
    isActive: true,
    isSellable: true,
    isAvailable: true,
    availableStoreIds: ['STORE_A'],
    addOnGroupIds: [],
    addOnOptionIdsByGroup: {},
    prepStation: 'KITCHEN',
    itemType: 'DIRECT_STOCK',
    productionMode: 'BOUGHT_AND_SOLD',
    recipeCost: 20,
  }),
  db.collection('storeStock').doc('STORE_A_FINISHED_GOOD_FLAT_WHITE').set({
    storeId: 'STORE_A',
    stockItemType: 'FINISHED_GOOD',
    stockItemCode: 'FLAT_WHITE',
    stockItemName: 'Flat White',
    currentStock: 10,
    uom: 'PCS',
    costPerUnit: 20,
  }),
]);
await db.collection('onlineOrders').doc(acceptedPayment.onlineOrderId).set({
  acceptedBy: 'manager_store_a',
  acceptedByName: 'Store Manager',
  acceptedAt: FieldValue.serverTimestamp(),
}, { merge: true });
const acceptedResult = await finalizePaidOnlineOrder({
  db,
  admin,
  onlineOrderId: acceptedPayment.onlineOrderId,
  intentId: accepted.session.sessionId,
  providerPayment: accepted.provider.payment,
  providerOrder: accepted.provider.order,
});
const acceptedRetry = await finalizePaidOnlineOrder({
  db,
  admin,
  onlineOrderId: acceptedPayment.onlineOrderId,
  intentId: accepted.session.sessionId,
  providerPayment: accepted.provider.payment,
  providerOrder: accepted.provider.order,
});
const acceptedOrder = (await db.collection('orders').doc(acceptedResult.orderId).get()).data();
const acceptedItems = await db.collection('orders').doc(acceptedResult.orderId).collection('items').get();
const acceptedPayments = await db.collection('orders').doc(acceptedResult.orderId).collection('payments').get();
const acceptedKots = await db.collection('kotItems').where('orderId', '==', acceptedResult.orderId).get();
const acceptedMovements = await db.collection('stockMovements').where('orderId', '==', acceptedResult.orderId).get();
const acceptedStock = (await db.collection('storeStock')
  .doc('STORE_A_FINISHED_GOOD_FLAT_WHITE').get()).data();
const acceptedItem = acceptedItems.docs[0]?.data();
const acceptedPosPayment = acceptedPayments.docs[0]?.data();
check('acceptance records the canonical 50-point discount before GST and exact provider payable',
  acceptedResult.alreadyFinalized === false
  && acceptedRetry.alreadyFinalized === true
  && acceptedOrder.subtotal === 250
  && acceptedOrder.discountAmount === 50
  && acceptedOrder.discountReason === 'BOND Points Redemption'
  && acceptedOrder.taxableAmount === 200
  && acceptedOrder.gstTotal === 10
  && acceptedOrder.grandTotal === 210
  && acceptedOrder.bondRedemptionPoints === 50
  && acceptedPosPayment.amount === 210
  && accepted.session.amountPaise === 21000);
check('acceptance creates POS, payment, item, KOT, and stock effects exactly once',
  await countFor('orders', 'onlineOrderId', acceptedPayment.onlineOrderId) === 1
  && acceptedPayments.size === 1
  && acceptedItems.size === 1
  && acceptedItem.lineSubtotal === 250
  && acceptedItem.lineDiscount === 50
  && acceptedItem.lineTaxable === 200
  && acceptedItem.lineTax === 10
  && acceptedItem.lineTotal === 210
  && acceptedKots.size === 1
  && acceptedMovements.size === 1
  && acceptedStock.currentStock === 9
  && acceptedOrder.stockMovementCount === 1);

// Neither a late client failure callback nor a provider payment.failed webhook may
// regress a checkout that already has its exactly-once online order.
const failedPaymentId = 'pay_failed_after_capture';
providerPayments.set(failedPaymentId, {
  id: failedPaymentId,
  order_id: duplicate.session.razorpayOrderId,
  amount: duplicate.session.amountPaise,
  currency: 'INR',
  status: 'failed',
  method: 'upi',
});
await rejects(
  () => verifySessionPayment({
    request: verifiedPaymentRequest('customer_duplicate', duplicate.session, failedPaymentId),
    db,
    admin,
    redemptionService,
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    RazorpayClass: FakeRazorpay,
  }),
  'failed-precondition',
);
let monotonicSession = (await db.collection('customerCheckoutSessions')
  .doc(duplicate.session.sessionId).get()).data();
check('late failed browser callback cannot regress ORDER_CREATED',
  monotonicSession.status === 'ORDER_CREATED'
  && (await db.collection('onlineOrders').doc(duplicateOnlineOrderId).get()).data().paymentStatus === 'PAID');

const failedWebhook = await invokeWebhook(paymentFunctions, 'evt_failed_after_capture', {
  event: 'payment.failed',
  payload: {
    payment: {
      entity: {
        id: failedPaymentId,
        order_id: duplicate.session.razorpayOrderId,
        status: 'failed',
      },
    },
  },
});
monotonicSession = (await db.collection('customerCheckoutSessions')
  .doc(duplicate.session.sessionId).get()).data();
check('late payment.failed webhook is acknowledged without regressing capture',
  failedWebhook.statusCode === 200
  && monotonicSession.status === 'ORDER_CREATED'
  && (await db.collection('onlineOrders').doc(duplicateOnlineOrderId).get()).data().paymentStatus === 'PAID');

// Model the accepted-order void transaction before the asynchronous refund webhook:
// operational stock and KOT reversal is already complete, while payment is pending.
const linkedOrderId = 'POS_ACCEPTED_REFUND';
const stockRef = db.collection('stockMovements').doc('stock_void_reversal');
const kotRef = db.collection('kotItems').doc('kot_cancelled');
await db.collection('onlineOrders').doc(duplicateOnlineOrderId).set({
  status: 'REFUND_PENDING',
  paymentStatus: 'PAID',
  refundStatus: 'REFUND_PENDING',
  linkedOrderId,
}, { merge: true });
await db.collection('orders').doc(linkedOrderId).set({
  status: 'VOIDED',
  source: 'CUSTOMER_WEB',
  onlineOrderId: duplicateOnlineOrderId,
  paymentMethod: 'ONLINE',
  paymentProvider: 'RAZORPAY',
  paymentStatus: 'PAID',
  grandTotal: duplicate.quote.grandTotal,
  refundStatus: 'REFUND_PENDING',
  paymentReversalStatus: 'REFUND_PENDING',
  refundPendingAmount: duplicate.quote.grandTotal,
  netCollectionAmount: duplicate.quote.grandTotal,
});
await db.collection('orders').doc(linkedOrderId).collection('payments').doc('razorpay').set({
  status: 'CAPTURED',
  provider: 'RAZORPAY',
  amount: duplicate.quote.grandTotal,
  refundStatus: 'REFUND_PENDING',
});
await stockRef.set({
  orderId: linkedOrderId,
  movementType: 'ORDER_VOID_REVERSAL',
  quantity: 1,
  immutableSentinel: 'unchanged',
});
await kotRef.set({
  orderId: linkedOrderId,
  status: 'CANCELLED',
  immutableSentinel: 'unchanged',
});
await db.collection('razorpayRefunds').doc(duplicateOnlineOrderId).set({
  onlineOrderId: duplicateOnlineOrderId,
  workflow: 'CUSTOMER_WEB_ACCEPTED',
  sourceOrderId: linkedOrderId,
  provider: 'RAZORPAY',
  providerRefundId: 'refund_race',
  providerPaymentId: duplicate.provider.payment.id,
  amountPaise: duplicate.session.amountPaise,
  currency: 'INR',
  status: 'REFUND_PENDING',
});
const stockBefore = (await stockRef.get()).data();
const kotBefore = (await kotRef.get()).data();
const firstProcessed = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  eventName: 'refund.processed',
  refundEntity: {
    id: 'refund_race',
    payment_id: duplicate.provider.payment.id,
    amount: duplicate.session.amountPaise,
    currency: 'INR',
    status: 'processed',
  },
});
const duplicateProcessed = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  eventName: 'refund.processed',
  refundEntity: {
    id: 'refund_race',
    payment_id: duplicate.provider.payment.id,
    amount: duplicate.session.amountPaise,
    currency: 'INR',
    status: 'processed',
  },
});
let refundDoc = (await db.collection('razorpayRefunds').doc(duplicateOnlineOrderId).get()).data();
let refundedOnlineOrder = (await db.collection('onlineOrders').doc(duplicateOnlineOrderId).get()).data();
let refundedPosOrder = (await db.collection('orders').doc(linkedOrderId).get()).data();
let refundedPayment = (await db.collection('orders').doc(linkedOrderId)
  .collection('payments').doc('razorpay').get()).data();
const restoredAccount = (await db.collection('loyaltyAccounts').doc('customer_duplicate').get()).data();
check('duplicate refund.processed deliveries restore redemption exactly once',
  firstProcessed.outcome === 'REFUNDED'
  && duplicateProcessed.outcome === 'REFUNDED'
  && refundDoc.status === 'REFUNDED'
  && restoredAccount.pointsBalance === 56
  && await countFor('loyaltyPointLedger', 'sourceCheckoutSessionId', duplicate.session.sessionId) === 2
  && (await db.collection('loyaltyPointLedger')
    .doc(redemptionRestoreLedgerId(duplicate.session.sessionId)).get()).exists);
check('processed accepted refund preserves void/KOT/stock and finalizes financial reversal',
  refundedOnlineOrder.status === 'CANCELLED_REFUNDED'
  && refundedOnlineOrder.paymentStatus === 'REFUNDED'
  && refundedPosOrder.status === 'VOIDED'
  && refundedPosOrder.refundStatus === 'REFUNDED'
  && refundedPosOrder.paymentReversalStatus === 'REFUNDED'
  && refundedPosOrder.refundedAmount === duplicate.quote.grandTotal
  && refundedPosOrder.netCollectionAmount === 0
  && refundedPayment.status === 'CAPTURED'
  && refundedPayment.refundStatus === 'REFUNDED'
  && isDeepStrictEqual((await stockRef.get()).data(), stockBefore)
  && isDeepStrictEqual((await kotRef.get()).data(), kotBefore));

// Terminal REFUNDED is monotonic. Late/reordered created or failed events cannot undo
// the provider-confirmed refund or consume the restored BOND points again.
const lateCreated = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  eventName: 'refund.created',
  refundEntity: {
    id: 'refund_race',
    payment_id: duplicate.provider.payment.id,
    amount: duplicate.session.amountPaise,
    currency: 'INR',
    status: 'created',
  },
});
const lateFailed = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  eventName: 'refund.failed',
  refundEntity: {
    id: 'refund_race',
    payment_id: duplicate.provider.payment.id,
    amount: duplicate.session.amountPaise,
    currency: 'INR',
    status: 'failed',
    error_code: 'LATE_EVENT',
  },
});
refundDoc = (await db.collection('razorpayRefunds').doc(duplicateOnlineOrderId).get()).data();
refundedOnlineOrder = (await db.collection('onlineOrders').doc(duplicateOnlineOrderId).get()).data();
refundedPosOrder = (await db.collection('orders').doc(linkedOrderId).get()).data();
refundedPayment = (await db.collection('orders').doc(linkedOrderId)
  .collection('payments').doc('razorpay').get()).data();
const finalSession = (await db.collection('customerCheckoutSessions')
  .doc(duplicate.session.sessionId).get()).data();
check('refund.processed is terminal across reordered created/failed webhooks',
  lateCreated.handled === true
  && lateFailed.handled === true
  && refundDoc.status === 'REFUNDED'
  && refundedOnlineOrder.status === 'CANCELLED_REFUNDED'
  && refundedOnlineOrder.paymentStatus === 'REFUNDED'
  && refundedPosOrder.paymentReversalStatus === 'REFUNDED'
  && refundedPayment.refundStatus === 'REFUNDED'
  && finalSession.bondRedemptionStatus === 'RESTORED');
check('terminal refund has one debit, one restore, and no duplicate operational effects',
  await countFor('loyaltyPointLedger', 'sourceCheckoutSessionId', duplicate.session.sessionId) === 2
  && (await db.collection('loyaltyPointLedger').doc(redemptionLedgerId(duplicate.session.sessionId)).get()).data().pointsDelta === -50
  && (await db.collection('loyaltyPointLedger').doc(redemptionRestoreLedgerId(duplicate.session.sessionId)).get()).data().pointsDelta === 50
  && isDeepStrictEqual((await stockRef.get()).data(), stockBefore)
  && isDeepStrictEqual((await kotRef.get()).data(), kotBefore));

await admin.app().delete();
if (failed.length > 0) {
  assert.fail(`Payment/redemption lifecycle race failures: ${failed.join('; ')}`);
}
console.log(`\nPayment/redemption lifecycle race emulator tests passed: ${passed.length}/${passed.length}.`);
