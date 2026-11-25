import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator only.');
const PROJECT_ID = 'demo-coffee-bond-loyalty';
assert.ok(PROJECT_ID.startsWith('demo-'));
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { pointEarnLedgerId } = require('../functions/bondLoyalty');

const now = admin.firestore.Timestamp.fromDate(new Date('2026-08-13T07:00:00.000Z'));
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const percentile = (values, value) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * value))];

async function flags(enabled) {
  await db.doc('appSettings/loyalty').set({
    accountEnabled: enabled,
    shadowEnabled: false,
    earnEnabled: enabled,
    visitEnabled: false,
    expiryEnabled: false,
    redemptionEnabled: false,
    gamificationEnabled: false,
    clubEarnedEnabled: false,
    clubPaidEnabled: false,
    omakaseEnabled: false,
    customerOrderingOnly: true,
  });
}

function onlineOrder(orderId, customerId) {
  return {
    source: 'CUSTOMER_WEB', linkedOrderId: orderId, customerUid: customerId,
    checkoutSessionId: `checkout_online_${orderId}`,
    storeId: 'PERF_STORE', status: 'CONVERTED', paymentStatus: 'PAID', grandTotal: 336,
    createdAt: now, updatedAt: now,
  };
}

function checkoutSession(orderId, customerId) {
  return {
    customerUid: customerId,
    storeId: 'PERF_STORE',
    onlineOrderId: `online_${orderId}`,
    status: 'ORDER_CREATED',
    createdAt: now,
    updatedAt: now,
  };
}

function order(orderId) {
  return {
    source: 'CUSTOMER_WEB', onlineOrderId: `online_${orderId}`, storeId: 'PERF_STORE',
    orderType: 'TAKEAWAY', status: 'COMPLETED', paymentStatus: 'PAID', subtotal: 320,
    taxableAmount: 320, gstTotal: 16, grandTotal: 336, createdAt: now, updatedAt: now, settledAt: now,
  };
}

async function waitForLedger(orderId, timeoutMs = 10000) {
  const started = performance.now();
  const ref = db.collection('loyaltyPointLedger').doc(pointEarnLedgerId(orderId));
  while (performance.now() - started < timeoutMs) {
    if ((await ref.get()).exists) return performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for loyalty ledger ${orderId}`);
}

const disabledCommitMs = [];
await flags(false);
for (let index = 0; index < 8; index += 1) {
  const orderId = `perf_disabled_${Date.now()}_${index}`;
  const batch = db.batch();
  batch.set(db.collection('onlineOrders').doc(`online_${orderId}`), onlineOrder(orderId, 'perf_disabled_customer'));
  batch.set(db.collection('customerCheckoutSessions').doc(`checkout_online_${orderId}`), checkoutSession(orderId, 'perf_disabled_customer'));
  await batch.commit();
  const started = performance.now();
  await db.collection('orders').doc(orderId).set(order(orderId));
  disabledCommitMs.push(performance.now() - started);
}

const enabledCommitMs = [];
const workerMs = [];
await flags(true);
for (let index = 0; index < 8; index += 1) {
  const orderId = `perf_enabled_${Date.now()}_${index}`;
  const batch = db.batch();
  batch.set(db.collection('onlineOrders').doc(`online_${orderId}`), onlineOrder(orderId, 'perf_enabled_customer'));
  batch.set(db.collection('customerCheckoutSessions').doc(`checkout_online_${orderId}`), checkoutSession(orderId, 'perf_enabled_customer'));
  await batch.commit();
  const started = performance.now();
  await db.collection('orders').doc(orderId).set(order(orderId));
  enabledCommitMs.push(performance.now() - started);
  workerMs.push(await waitForLedger(orderId));
}

const nativeCommitMs = [];
for (let index = 0; index < 8; index += 1) {
  const orderId = `perf_native_${Date.now()}_${index}`;
  const started = performance.now();
  await db.collection('orders').doc(orderId).set({
    storeId: 'PERF_STORE', orderType: 'TAKEAWAY', status: 'COMPLETED', paymentStatus: 'PAID',
    paymentMethod: index % 2 ? 'UPI' : 'CASH', taxableAmount: 320, gstTotal: 16, grandTotal: 336,
    createdAt: now, updatedAt: now,
  });
  nativeCommitMs.push(performance.now() - started);
}

await new Promise(resolve => setTimeout(resolve, 500));
const nativeLedger = await db.collection('loyaltyPointLedger').where('customerId', '==', 'perf_native_customer').get();
assert.equal(nativeLedger.size, 0);

const result = {
  sampleSize: 8,
  baselineLikeFlagsOffOrderCommitMs: { average: average(disabledCommitMs), p50: percentile(disabledCommitMs, 0.5), max: Math.max(...disabledCommitMs) },
  loyaltyEnabledOrderCommitMs: { average: average(enabledCommitMs), p50: percentile(enabledCommitMs, 0.5), max: Math.max(...enabledCommitMs) },
  asynchronousLoyaltyWorkerObservedMs: { average: average(workerMs), p50: percentile(workerMs, 0.5), max: Math.max(...workerMs) },
  nativePosOrderCommitMs: { average: average(nativeCommitMs), p50: percentile(nativeCommitMs, 0.5), max: Math.max(...nativeCommitMs) },
  synchronousLoyaltyDependency: false,
};

console.log(JSON.stringify(result, null, 2));
