import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RAZORPAY_PROGRESS_MESSAGES,
  compareIncomingOrders,
  paidOrderEscalation,
} from '../frontend/lib/razorpayLatency';
import type { OnlineOrder } from '../frontend/types';

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
const customerOrder = source('frontend/pages/customer/CustomerOrder.tsx');
const checkoutLoader = source('frontend/lib/razorpayCheckout.ts');
const backend = source('functions/razorpayPaymentFirst.js');
const incoming = source('frontend/pages/pos/IncomingOnlineOrders.tsx');

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void) => tests.push([name, run]);

test('checkout script preloads after OTP verification', () => {
  assert.match(customerOrder, /if \(!verifiedCustomer\) return;[\s\S]*preloadRazorpayCheckout\(\)/);
});

test('checkout script uses one cached loading promise', () => {
  assert.match(checkoutLoader, /let checkoutScriptPromise: Promise<void> \| null = null/);
  assert.match(checkoutLoader, /if \(checkoutScriptPromise\)/);
  assert.match(checkoutLoader, /document\.head\.appendChild\(script\)/);
});

test('Pay click starts script loading and session creation together', () => {
  assert.match(customerOrder, /const scriptPromise = loadRazorpayCheckout\(\)/);
  assert.match(customerOrder, /Promise\.all\(\[sessionPromise, scriptPromise\]\)/);
});

test('duplicate Pay clicks remain blocked', () => {
  assert.match(customerOrder, /if \(saving \|\| submittingRef\.current\) return/);
  assert.match(customerOrder, /submittingRef\.current = true/);
});

test('normal provider creation avoids list calls while recovery retains them', () => {
  assert.match(backend, /recoverExisting && typeof client\.orders\?\.all/);
  assert.match(backend, /recoverExisting && typeof client\.customers\?\.all/);
  assert.match(backend, /\{ recoverExisting: claim\.recoverExisting \}/);
});

test('provider payment and order fetches remain concurrent', () => {
  const providerFetch = backend.slice(
    backend.indexOf('function fetchProviderPaymentAndOrder'),
    backend.indexOf('function createProviderRefund'),
  );
  assert.match(providerFetch, /Promise\.all\(/);
  assert.match(providerFetch, /client\.payments\.fetch\(paymentId\)/);
  assert.match(providerFetch, /client\.orders\.fetch\(providerOrderId\)/);
});

test('normal verification does not wait for webhook delivery', () => {
  const verification = backend.slice(
    backend.indexOf('async function verifySessionPayment'),
    backend.indexOf('function allowedStoreIds'),
  );
  assert.doesNotMatch(verification, /webhook|WEBHOOK/);
  assert.match(verification, /createPaidOnlineOrder/);
});

test('paid order finalization remains one atomic transaction', () => {
  const finalization = backend.slice(
    backend.indexOf('async function createPaidOnlineOrder'),
    backend.indexOf('async function verifySessionPayment'),
  );
  assert.match(finalization, /db\.runTransaction/);
  assert.match(finalization, /transaction\.create\(onlineOrderRef, onlineOrder\)/);
  assert.match(finalization, /status: 'PAID_PENDING_ACCEPTANCE'/);
});

test('progress messages remain in the approved sequence', () => {
  assert.deepEqual(Object.values(RAZORPAY_PROGRESS_MESSAGES), [
    'Preparing secure payment...',
    'Secure payment is still being prepared. Please keep this page open...',
    'Complete payment in the Razorpay window.',
    'Payment received. Verifying securely...',
    'Payment is still being confirmed. Please do not pay again or close this page.',
    'Payment confirmed. Sending your order to the store...',
    'Order sent. Waiting for store confirmation...',
  ]);
});

test('slow verification retries without asking for payment again', () => {
  assert.match(customerOrder, /PAYMENT_RECOVERY_DELAYS_MS = \[0, 1500, 3000, 5000\]/);
  assert.match(customerOrder, /Do not pay again/);
  assert.doesNotMatch(
    customerOrder.slice(
      customerOrder.indexOf('async function verifyPaidOrderWithRecovery'),
      customerOrder.indexOf('type StoreCoordinate'),
    ),
    /createCustomerCheckoutSession/,
  );
});

test('Incoming Online Orders uses live listeners', () => {
  assert.match(incoming, /onSnapshot\(query\(/);
  assert.match(incoming, /paid_order_listener_received/);
});

test('paid incoming orders sort before unpaid orders', () => {
  const paid = {
    paymentProvider: 'RAZORPAY',
    paymentStatus: 'PAID',
    createdAt: new Date('2026-07-27T10:00:00Z'),
  } as unknown as OnlineOrder;
  const unpaid = {
    paymentProvider: 'PAY_AT_COUNTER',
    paymentStatus: 'UNPAID',
    createdAt: new Date('2026-07-27T10:01:00Z'),
  } as unknown as OnlineOrder;
  assert.ok(compareIncomingOrders(paid, unpaid) < 0);
});

test('paid waiting escalation thresholds are exact', () => {
  assert.equal(paidOrderEscalation(59_999), 'NORMAL');
  assert.equal(paidOrderEscalation(60_000), 'ATTENTION');
  assert.equal(paidOrderEscalation(120_000), 'ATTENTION');
  assert.equal(paidOrderEscalation(120_001), 'URGENT');
});

test('new paid order notification is recorded once', () => {
  assert.match(incoming, /!notifiedPaidOrderIdsRef\.current\.has\(order\.id\)/);
  assert.match(incoming, /notifiedPaidOrderIdsRef\.current\.add\(order\.id\)/);
  assert.match(incoming, /newPaidOrders\.length > 0/);
});

test('only the two customer payment callables keep warm instances', () => {
  const createOptions = backend.slice(
    backend.indexOf('const createCustomerCheckoutSession = onCall'),
    backend.indexOf('const verifyCustomerRazorpayPayment = onCall'),
  );
  const verifyOptions = backend.slice(
    backend.indexOf('const verifyCustomerRazorpayPayment = onCall'),
    backend.indexOf('const acceptPaidRazorpayOrder = onCall'),
  );
  assert.match(createOptions, /minInstances: 1/);
  assert.match(verifyOptions, /minInstances: 1/);
  assert.equal((backend.match(/minInstances: 1/g) || []).length, 2);
});

let passed = 0;
for (const [name, run] of tests) {
  run();
  passed += 1;
  console.log(`PASS latency ${name}`);
}
console.log(`Razorpay latency tests passed: ${passed}/${tests.length}. No provider calls or Firebase writes were performed.`);
