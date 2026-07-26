import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const policy = require(resolve(root, 'functions/razorpayCheckoutPolicy.js'));
const razorpayCheckout = require(resolve(root, 'functions/razorpayCheckout.js'));
const reporting = await import(resolve(root, 'functions/reportingCore.mjs'));

const source = (path) => readFileSync(resolve(root, path), 'utf8');
const checkoutBackend = source('functions/razorpayCheckout.js');
const checkoutPolicy = source('functions/razorpayCheckoutPolicy.js');
const checkoutFrontend = source('frontend/lib/razorpayCheckout.ts');
const trackingFrontend = source('frontend/pages/customer/CustomerOrderStatus.tsx');
const conversionFrontend = source('frontend/lib/onlineOrderConversion.ts');
const incomingFrontend = source('frontend/pages/pos/IncomingOnlineOrders.tsx');
const submissionBackend = source('functions/index.js');
const reportsSource = source('functions/reportingCore.mjs');
const reversalSource = source('frontend/lib/paymentReversal.ts');
const rules = source('firestore.rules');

const acceptedOrder = (overrides = {}) => ({
  id: 'online-order-a',
  source: 'CUSTOMER_WEB',
  storeId: 'GOLDEN_I',
  paymentProvider: 'RAZORPAY',
  paymentMethod: 'ONLINE',
  status: 'ACCEPTED_AWAITING_PAYMENT',
  paymentStatus: 'AWAITING_PAYMENT',
  grandTotal: 236.25,
  trackingToken: 'tracking-token-with-more-than-thirty-two-characters',
  publicOrderReference: 'CB-WEB-MOCK',
  items: [{ finishedGoodCode: 'CAPPUCCINO', quantity: 1, lineTotal: 236.25, addOns: [] }],
  ...overrides,
});

const validPayment = (overrides = {}) => ({
  id: 'pay_mock',
  order_id: 'order_mock',
  amount: 23625,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...overrides,
});

const validProviderOrder = (overrides = {}) => ({
  id: 'order_mock',
  amount: 23625,
  currency: 'INR',
  status: 'paid',
  ...overrides,
});

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function createProviderOrderHarness() {
  const records = new Map([
    ['onlineOrders/online-order-a', acceptedOrder()],
    ['stores/GOLDEN_I', { id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I', isActive: true }],
    ['publicOrderTracking/tracking-token-with-more-than-thirty-two-characters', {
      trackingToken: 'tracking-token-with-more-than-thirty-two-characters',
    }],
  ]);
  const makeSnapshot = (ref) => ({
    id: ref.id,
    ref,
    exists: records.has(ref.path),
    data: () => records.get(ref.path),
  });
  const makeRef = (path) => ({
    path,
    id: path.split('/').at(-1),
    async get() {
      return makeSnapshot(this);
    },
    async set(value, options = {}) {
      records.set(path, options.merge ? { ...(records.get(path) || {}), ...value } : value);
    },
  });
  const db = {
    collection(name) {
      return {
        doc(id) {
          return makeRef(`${name}/${id}`);
        },
      };
    },
    async runTransaction(run) {
      const transaction = {
        get: async ref => makeSnapshot(ref),
        set: (ref, value, options = {}) => {
          records.set(ref.path, options.merge ? { ...(records.get(ref.path) || {}), ...value } : value);
        },
        update: (ref, value) => {
          assert.equal(records.has(ref.path), true, `Expected ${ref.path} before update.`);
          records.set(ref.path, { ...records.get(ref.path), ...value });
        },
      };
      return run(transaction);
    },
  };
  const admin = {
    firestore: {
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
      Timestamp: {
        fromMillis: milliseconds => ({
          toMillis: () => milliseconds,
          toDate: () => new Date(milliseconds),
        }),
      },
    },
  };
  const providerCalls = [];
  class MockRazorpay {
    constructor() {
      this.orders = {
        create: async payload => {
          providerCalls.push(payload);
          return {
            id: 'order_provider_mock',
            amount: payload.amount,
            currency: payload.currency,
          };
        },
      };
    }
  }
  return {
    admin,
    db,
    onlineOrderRef: db.collection('onlineOrders').doc('online-order-a'),
    order: acceptedOrder(),
    providerCalls,
    records,
    RazorpayClass: MockRazorpay,
  };
}

test('1. Server computes amount from Coffee Bond data', () => {
  assert.equal(policy.rupeesToPaise(acceptedOrder().grandTotal), 23625);
  assert.match(checkoutBackend, /amountPaise = rupeesToPaise\(Number\(order\.grandTotal\)\)/);
});
test('2. Browser amount is ignored', () => {
  assert.doesNotMatch(checkoutBackend, /request\.data\?\.amount|request\.data\.amount/);
});
test('3. Amount below 100 paise is rejected', () => {
  assert.throws(() => policy.rupeesToPaise(0.99), /PAYABLE_BELOW_PROVIDER_MINIMUM/);
});
test('4. Integer paise conversion is correct', () => {
  assert.equal(policy.rupeesToPaise(350), 35000);
});
test('5. Unsafe or fractional totals are rejected', () => {
  assert.throws(() => policy.rupeesToPaise(1.001), /INVALID_PAYABLE_PRECISION/);
  assert.throws(() => policy.rupeesToPaise(Number.MAX_SAFE_INTEGER), /INVALID_PAYABLE/);
});
test('6. Pending order cannot create a Razorpay order', () => {
  assert.equal(policy.isRazorpayOrderEligible(acceptedOrder({ status: 'PENDING' })), false);
});
test('7. Rejected order cannot create a Razorpay order', () => {
  assert.equal(policy.isRazorpayOrderEligible(acceptedOrder({ status: 'REJECTED' })), false);
});
test('8. Complimentary order cannot use Razorpay', () => {
  assert.equal(policy.isRazorpayOrderEligible(acceptedOrder({ commercialStatus: 'COMPLIMENTARY' })), false);
});
test('9. Accepted unpaid Razorpay order can create one provider order', async () => {
  assert.equal(policy.isRazorpayOrderEligible(acceptedOrder()), true);
  const harness = createProviderOrderHarness();
  const result = await razorpayCheckout.createProviderOrder({
    ...harness,
    keyId: 'rzp_test_mock',
    keySecret: 'mock-secret',
    now: Date.now(),
  });
  assert.equal(harness.providerCalls.length, 1);
  assert.equal(result.razorpayOrderId, 'order_provider_mock');
  assert.equal(result.amount, 23625);
});
test('10. Repeated create calls are idempotent', async () => {
  assert.equal(policy.deterministicIntentId('same-order'), policy.deterministicIntentId('same-order'));
  const harness = createProviderOrderHarness();
  const input = {
    ...harness,
    keyId: 'rzp_test_mock',
    keySecret: 'mock-secret',
    now: Date.now(),
  };
  const first = await razorpayCheckout.createProviderOrder(input);
  const second = await razorpayCheckout.createProviderOrder(input);
  assert.equal(harness.providerCalls.length, 1);
  assert.equal(second.razorpayOrderId, first.razorpayOrderId);
  assert.match(checkoutBackend, /existing\.requestChecksum !== requestChecksum\(freshOrder\)/);
});
test('11. Already-paid order cannot create another attempt', () => {
  assert.equal(policy.isRazorpayOrderEligible(acceptedOrder({ paymentStatus: 'PAID' })), false);
  assert.match(checkoutBackend, /existing\?\.status === PAID_STATUS/);
});
test('12. Tracking token cannot access another order', () => {
  assert.match(checkoutBackend, /trackingSnapshot\.data\(\)\?\.publicOrderReference !== reference/);
  assert.match(checkoutBackend, /order\.publicOrderReference !== reference \|\| order\.trackingToken !== token/);
});
test('13. Missing checkout identity fields are rejected', () => {
  assert.match(checkoutBackend, /Order tracking details are required/);
  assert.match(checkoutBackend, /Payment confirmation details are incomplete/);
});
test('14. Provider authentication failures are sanitised', () => {
  assert.deepEqual(policy.safeProviderError({ statusCode: 401 }), {
    code: 'PROVIDER_AUTHENTICATION_FAILED',
    message: 'Online payment is temporarily unavailable.',
  });
});
test('15. Provider service failures are sanitised', () => {
  assert.deepEqual(policy.safeProviderError({ statusCode: 503, message: 'private body' }), {
    code: 'PROVIDER_UNAVAILABLE',
    message: 'Online payment is temporarily unavailable.',
  });
});
test('16. Correct HMAC signature passes', () => {
  const signature = createHmac('sha256', 'mock-secret').update('order_mock|pay_mock').digest('hex');
  assert.equal(policy.verifyCheckoutSignature({
    storedOrderId: 'order_mock',
    paymentId: 'pay_mock',
    signature,
    keySecret: 'mock-secret',
  }), true);
});
test('17. Incorrect HMAC signature fails', () => {
  assert.equal(policy.verifyCheckoutSignature({
    storedOrderId: 'order_mock',
    paymentId: 'pay_mock',
    signature: '0'.repeat(64),
    keySecret: 'mock-secret',
  }), false);
});
test('18. timingSafeEqual handles unequal lengths safely', () => {
  assert.match(checkoutPolicy, /expectedBuffer\.length === suppliedBuffer\.length/);
  assert.equal(policy.verifyCheckoutSignature({
    storedOrderId: 'order_mock',
    paymentId: 'pay_mock',
    signature: 'short',
    keySecret: 'mock-secret',
  }), false);
});
test('19. Server-stored order ID is authoritative', () => {
  assert.match(checkoutBackend, /storedOrderId: intent\.providerOrderId/);
  assert.match(checkoutPolicy, /\.update\(`\$\{safeStoredOrderId\}\|\$\{safePaymentId\}`\)/);
});
test('20. Browser or provider order mismatch fails', () => {
  const state = policy.isFinalProviderState({
    payment: validPayment({ order_id: 'wrong' }),
    providerOrder: validProviderOrder(),
    expectedOrderId: 'order_mock',
    expectedAmountPaise: 23625,
  });
  assert.equal(state.code, 'PROVIDER_ORDER_MISMATCH');
});
test('21. Provider amount mismatch fails', () => {
  const state = policy.isFinalProviderState({
    payment: validPayment({ amount: 1 }),
    providerOrder: validProviderOrder(),
    expectedOrderId: 'order_mock',
    expectedAmountPaise: 23625,
  });
  assert.equal(state.code, 'PROVIDER_AMOUNT_MISMATCH');
});
test('22. Provider currency mismatch fails', () => {
  const state = policy.isFinalProviderState({
    payment: validPayment({ currency: 'USD' }),
    providerOrder: validProviderOrder(),
    expectedOrderId: 'order_mock',
    expectedAmountPaise: 23625,
  });
  assert.equal(state.code, 'PROVIDER_CURRENCY_MISMATCH');
});
test('23. Uncaptured payment does not fulfil', () => {
  const state = policy.isFinalProviderState({
    payment: validPayment({ status: 'authorized' }),
    providerOrder: validProviderOrder(),
    expectedOrderId: 'order_mock',
    expectedAmountPaise: 23625,
  });
  assert.equal(state.code, 'PAYMENT_NOT_CAPTURED');
});
test('24. Unpaid provider order does not fulfil', () => {
  const state = policy.isFinalProviderState({
    payment: validPayment(),
    providerOrder: validProviderOrder({ status: 'attempted' }),
    expectedOrderId: 'order_mock',
    expectedAmountPaise: 23625,
  });
  assert.equal(state.code, 'PROVIDER_ORDER_NOT_PAID');
});
test('25. Captured payment and paid provider order can finalise', () => {
  assert.deepEqual(policy.isFinalProviderState({
    payment: validPayment(),
    providerOrder: validProviderOrder(),
    expectedOrderId: 'order_mock',
    expectedAmountPaise: 23625,
  }), { valid: true, code: null });
});
test('26. Verification creates exactly one Coffee Bond payment', () => {
  assert.equal((checkoutBackend.match(/posOrderRef\.collection\('payments'\)\.doc\('razorpay'\)/g) || []).length, 1);
  assert.match(checkoutBackend, /transaction\.create\(posOrderRef\.collection\('payments'\)\.doc\('razorpay'\)/);
});
test('27. Verification creates deterministic KOT rows exactly once', () => {
  assert.match(checkoutBackend, /doc\(`\$\{posOrderId\}_\$\{line\.lineId\}_\$\{kotStation\}`\)/);
  assert.match(checkoutBackend, /transaction\.create\(db\.collection\('kotItems'\)/);
});
test('28. Verification deducts stock exactly once', () => {
  assert.match(checkoutBackend, /doc\(`\$\{posOrderId\}_SALE_\$\{String\(index \+ 1\)/);
  assert.match(checkoutBackend, /transaction\.create\(\s*db\.collection\('stockMovements'\)/);
});
test('29. Repeated verification is idempotent', () => {
  assert.match(checkoutBackend, /intent\.status === PAID_STATUS && existingPosOrderSnapshot\.exists/);
  assert.match(checkoutBackend, /alreadyFinalized: true/);
});
test('30. Failed checkout leaves the order unpaid', () => {
  assert.match(checkoutBackend, /payment\?\.status === 'failed' \? 'FAILED' : 'VERIFYING'/);
  assert.match(checkoutBackend, /paymentStatus: 'FAILED'/);
});
test('31. Modal dismissal leaves the order unpaid', () => {
  assert.match(trackingFrontend, /modal:\s*\{\s*ondismiss:/);
  assert.doesNotMatch(trackingFrontend, /ondismiss:[\s\S]{0,240}verifyRazorpayPayment/);
});
test('32. payment.failed leaves the order unpaid', () => {
  assert.match(checkoutBackend, /eventName === 'payment\.failed'/);
  assert.match(checkoutBackend, /outcome: 'PAYMENT_FAILED_RECORDED'/);
});
test('33. Checkout script is loaded only once', () => {
  assert.match(checkoutFrontend, /let checkoutScriptPromise: Promise<void> \| null = null/);
  assert.match(checkoutFrontend, /if \(checkoutScriptPromise\) return checkoutScriptPromise/);
  assert.match(checkoutFrontend, /querySelector<HTMLScriptElement>/);
});
test('34. Key Secret is absent from frontend code', () => {
  assert.doesNotMatch(checkoutFrontend + trackingFrontend, /RAZORPAY_KEY_SECRET|key_secret/);
});
test('35. Key Secret is absent from built frontend output', () => {
  const dist = resolve(root, 'dist');
  if (!existsSync(dist)) return;
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dist);
  const output = files.filter(path => /\.(js|html|css|json)$/.test(path))
    .map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(output, /RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|key_secret/);
});
test('36. Payment signatures are absent from reports', () => {
  assert.doesNotMatch(reportsSource, /razorpay_signature|paymentSignature/);
});
test('37. Webhook missing signature fails', () => {
  assert.equal(policy.verifyWebhookSignature({
    rawBody: Buffer.from('{}'),
    signature: '',
    webhookSecret: 'mock-webhook',
  }), false);
});
test('38. Webhook invalid signature fails', () => {
  assert.equal(policy.verifyWebhookSignature({
    rawBody: Buffer.from('{}'),
    signature: '0'.repeat(64),
    webhookSecret: 'mock-webhook',
  }), false);
});
test('39. Valid webhook signature succeeds', () => {
  const rawBody = Buffer.from('{"event":"payment.captured"}');
  const signature = createHmac('sha256', 'mock-webhook').update(rawBody).digest('hex');
  assert.equal(policy.verifyWebhookSignature({ rawBody, signature, webhookSecret: 'mock-webhook' }), true);
});
test('40. Duplicate webhook processing is idempotent', () => {
  assert.match(checkoutBackend, /auditSnapshot\.exists && auditSnapshot\.data\(\)\.status === 'PROCESSED'/);
  assert.match(checkoutBackend, /duplicate: true/);
});
test('41. payment.captured webhook recovery is supported', () => {
  assert.match(checkoutBackend, /\['payment\.captured', 'payment\.failed', 'order\.paid'\]/);
  assert.match(checkoutBackend, /verifyAndFinalize\(\{ db, admin, onlineOrder, intent, paymentId, client \}\)/);
});
test('42. payment.failed webhook cannot mark paid', () => {
  const failureBranch = checkoutBackend.slice(
    checkoutBackend.indexOf("if (eventName === 'payment.failed')"),
    checkoutBackend.indexOf('let paymentId;'),
  );
  assert.doesNotMatch(failureBranch, /status:\s*PAID_STATUS|paymentStatus:\s*PAID_STATUS/);
});
test('43. order.paid recovery fetches captured provider payments', async () => {
  const calls = [];
  const paymentId = await razorpayCheckout.resolveWebhookPaymentId({
    client: {
      orders: {
        fetchPayments: async orderId => {
          calls.push(orderId);
          return {
            items: [
              { id: 'failed_payment', order_id: orderId, status: 'failed' },
              { id: 'captured_payment', order_id: orderId, status: 'captured' },
            ],
          };
        },
      },
    },
    eventPaymentId: '',
    providerOrderId: 'order_mock',
  });
  assert.deepEqual(calls, ['order_mock']);
  assert.equal(paymentId, 'captured_payment');
});
test('44. Cash reporting remains unchanged', () => {
  const rows = reporting.normalizedPaymentRows(
    { paymentStatus: 'PAID', paymentMethod: 'CASH', grandTotal: 100 },
    [{ method: 'CASH', amount: 100 }],
  );
  assert.equal(rows[0].method, 'CASH');
});
test('45. UPI reporting remains unchanged', () => {
  const rows = reporting.normalizedPaymentRows(
    { paymentStatus: 'PAID', paymentMethod: 'UPI', grandTotal: 100 },
    [{ method: 'UPI', amount: 100 }],
  );
  assert.equal(rows[0].method, 'UPI');
});
test('46. Card reporting remains unchanged', () => {
  const rows = reporting.normalizedPaymentRows(
    { paymentStatus: 'PAID', paymentMethod: 'CARD', grandTotal: 100 },
    [{ method: 'CARD', amount: 100 }],
  );
  assert.equal(rows[0].method, 'CARD');
});
test('47. Split-payment reporting remains unchanged', () => {
  const rows = reporting.normalizedPaymentRows(
    { paymentStatus: 'PAID', paymentMethod: 'CASH', grandTotal: 100 },
    [{ method: 'CASH', amount: 40 }, { method: 'UPI', amount: 60 }],
  );
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 100);
  assert.deepEqual(rows.map(row => row.method), ['CASH', 'UPI']);
});
test('48. Complimentary reporting remains unchanged', () => {
  assert.deepEqual(reporting.normalizedPaymentRows({
    commercialStatus: 'COMPLIMENTARY',
    paymentStatus: 'NOT_REQUIRED',
    paymentMethod: 'COMPLIMENTARY',
    grandTotal: 0,
  }), []);
});
test('49. Local void cannot falsely represent a Razorpay refund', () => {
  assert.match(reversalSource, /method === 'RAZORPAY'/);
  assert.match(reversalSource, /MANUAL_REFUND_REQUIRED/);
  assert.match(reversalSource, /Gateway refund required/);
});
test('50. Reporting includes Razorpay exactly once', () => {
  const rows = reporting.normalizedPaymentRows(
    { paymentStatus: 'PAID', paymentProvider: 'RAZORPAY', providerMethod: 'UPI', grandTotal: 350 },
    [{ method: 'ONLINE', provider: 'RAZORPAY', providerMethod: 'UPI', amount: 350 }],
  );
  assert.deepEqual(rows.map(row => [row.method, row.providerMethod, row.amount]), [['RAZORPAY', 'UPI', 350]]);
});
test('51. Firestore rules deny client payment-intent writes', () => {
  assert.match(rules, /match \/razorpayPaymentIntents\/\{intentId\} \{\s*allow read, create, update, delete: if false;/);
  assert.match(rules, /match \/razorpayWebhookEvents\/\{eventId\} \{\s*allow read, create, update, delete: if false;/);
});
test('52. Franchise Viewer cannot access private provider data', () => {
  assert.doesNotMatch(rules.match(/match \/razorpayPaymentIntents[\s\S]*?\n\s*\}/)?.[0] || '', /FRANCHISE_VIEWER|isFranchise/);
  assert.doesNotMatch(reportsSource, /providerPaymentId|providerOrderId|razorpay_signature/);
});
test('53. Existing online-order acceptance and rejection remain correct', () => {
  assert.match(conversionFrontend, /if \(isRazorpay\)/);
  assert.match(conversionFrontend, /stockMovementCount: 0,\s*kotCount: 0/);
  assert.match(incomingFrontend, /status: 'REJECTED'/);
  assert.match(incomingFrontend, /publicStatus: 'REJECTED'/);
  assert.match(submissionBackend, /paymentProvider === 'RAZORPAY' \? 'ONLINE' : 'PAY_AT_COUNTER'/);
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

assert.equal(tests.length, 53);
console.log(`Razorpay checkout tests passed: ${passed}/${tests.length}. No network or Firebase writes were performed.`);
