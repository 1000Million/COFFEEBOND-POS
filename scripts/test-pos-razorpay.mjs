import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const posRazorpay = require(resolve(root, 'functions/posRazorpay.js'));
const reporting = await import(resolve(root, 'functions/reportingCore.mjs'));

const source = path => readFileSync(resolve(root, path), 'utf8');
const backend = source('functions/posRazorpay.js');
const webhook = source('functions/razorpayPaymentFirst.js');
const indexSource = source('functions/index.js');
const posHome = source('frontend/pages/pos/POSHome.tsx');
const runningOrders = source('frontend/pages/pos/RunningOrders.tsx');
const helper = source('frontend/lib/posRazorpay.ts');
const inventory = source('functions/onlineOrderInventory.js');
const dayClose = source('frontend/pages/reports/DayClose.tsx');
const auditControl = source('frontend/pages/reports/AuditControl.tsx');
const inventoryControl = source('frontend/pages/inventory/InventoryControl.tsx');
const rules = source('firestore.rules');
const packageJson = JSON.parse(source('package.json'));

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('Razorpay appears as a full-payment POS tender', () => {
  assert.match(posHome, /'RAZORPAY'/);
  assert.match(posHome, /Generate Razorpay Payment/);
  assert.match(posHome, /SPLIT_PAYMENT_METHODS = PAYMENT_METHODS\.filter\(method => !\['COMPLIMENTARY', 'RAZORPAY'\]/);
});

test('server ignores browser-supplied amount and calculates canonical totals', () => {
  const canonicalSection = backend.slice(backend.indexOf('async function canonicalizePosRequest'), backend.indexOf('async function findExistingProviderRequest'));
  assert.doesNotMatch(canonicalSection, /request\.data\?\.amount|request\.data\.amount/);
  assert.match(canonicalSection, /canonicalizeRequestedCart/);
  assert.match(canonicalSection, /amountPaise = rupeesToPaise\(totals\.grandTotal\)/);
});

test('stable idempotency key produces one deterministic session and order', () => {
  assert.equal(posRazorpay.sessionIdFor('checkout-123'), posRazorpay.sessionIdFor('checkout-123'));
  assert.notEqual(posRazorpay.sessionIdFor('checkout-123'), posRazorpay.sessionIdFor('checkout-124'));
  assert.match(backend, /requestChecksum !== canonical\.requestChecksum/);
  assert.match(backend, /different store, cart, total, discount, tax, or tender/);
  assert.match(backend, /existing\?\.providerRequestType \|\| configuredProviderRequestType/);
  assert.match(backend, /reservation\.providerRequestType === 'DYNAMIC_QR'/);
});

test('provider request retry recovers by deterministic reference', async () => {
  let createCount = 0;
  let stored = null;
  const client = {
    paymentLink: {
      all: async () => ({ items: stored ? [stored] : [] }),
      create: async payload => {
        createCount += 1;
        stored = { id: 'plink_1', short_url: 'https://rzp.io/i/example', amount: payload.amount, reference_id: payload.reference_id };
        return stored;
      },
    },
  };
  const input = {
    client,
    session: {
      orderId: 'POS_TEST', storeId: 'GOLDEN_I', storeCode: 'GOLDEN_I', amountPaise: 22500, providerReferenceId: 'CBPOSREF',
    },
    dynamicQrEnabled: false,
    now: Date.now(),
  };
  const first = await posRazorpay.createProviderRequest(input);
  const second = await posRazorpay.createProviderRequest(input);
  assert.equal(first.entity.id, second.entity.id);
  assert.equal(createCount, 1);
  assert.equal(second.recovered, true);
});

test('Payment Link is the safe default and Dynamic QR is explicitly gated', () => {
  assert.equal(posRazorpay.booleanParameter({ value: () => 'false' }), false);
  assert.equal(posRazorpay.booleanParameter({ value: () => 'true' }), true);
  assert.match(backend, /POS_RAZORPAY_DYNAMIC_QR_ENABLED/);
  assert.match(backend, /dynamicQrEnabled \? 'DYNAMIC_QR' : 'PAYMENT_LINK'/);
  assert.match(posHome, /<QRCode/);
  assert.doesNotThrow(() => posRazorpay.validateProviderRequest({
    providerRequestType: 'PAYMENT_LINK',
    entity: {
      id: 'plink_1',
      amount: 22500,
      short_url: 'https://rzp.io/i/example',
      reference_id: 'CBPOSREF',
    },
  }, 22500, 'CBPOSREF'));
  assert.throws(() => posRazorpay.validateProviderRequest({
    providerRequestType: 'PAYMENT_LINK',
    entity: { id: 'plink_1', short_url: 'https://rzp.io/i/example', reference_id: 'CBPOSREF' },
  }, 22500, 'CBPOSREF'), /amount failed validation/);
});

test('Dynamic QR verifies its captured payment without inventing a provider order', () => {
  const qrResult = posRazorpay.verifyCapturedProviderPayment({
    session: { providerRequestType: 'DYNAMIC_QR', amountPaise: 22500 },
    providerPayment: { id: 'pay_qr_1', status: 'captured', amount: 22500, currency: 'INR', order_id: null },
    providerOrder: null,
  });
  assert.equal(qrResult.valid, true);
  const linkResult = posRazorpay.verifyCapturedProviderPayment({
    session: { providerRequestType: 'PAYMENT_LINK', amountPaise: 22500 },
    providerPayment: { id: 'pay_link_1', status: 'captured', amount: 22500, currency: 'INR', order_id: null },
    providerOrder: null,
  });
  assert.equal(linkResult.valid, false);
  assert.equal(linkResult.code, 'PROVIDER_ORDER_MISSING');
});

test('no order KOT stock or payment is created before capture', () => {
  const createSection = backend.slice(backend.indexOf('async function createPosSession'), backend.indexOf('async function providerStateForSession'));
  assert.doesNotMatch(createSection, /collection\('orders'\)|collection\('kotItems'\)|collection\('stockMovements'\)/);
  assert.match(createSection, /POS_SESSION_COLLECTION/);
});

test('captured payment finalises deterministic order payment KOT and inventory once', () => {
  const finalizeSection = backend.slice(backend.indexOf('async function finalizeCapturedPosPayment'), backend.indexOf('async function verifyAndFinalizeSession'));
  assert.match(finalizeSection, /existingOrderSnapshot\.exists/);
  assert.match(finalizeSection, /transaction\.create\(orderRef/);
  assert.match(finalizeSection, /deterministicKotId/);
  assert.match(finalizeSection, /deterministicMovementId/);
  assert.match(finalizeSection, /status: 'CAPTURED'/);
  assert.match(finalizeSection, /verifiedServerSide: true/);
  assert.match(backend, /authoritativeRequestState\.paymentId !== paymentId/);
  assert.match(backend, /captured payment does not belong to this Razorpay request/);
});

test('lost browser callback recovers through status fetch and signed webhook', () => {
  assert.match(helper, /getPosRazorpayStatus/);
  assert.match(posHome, /setInterval\(\(\) => void refreshRazorpayStatus\(false\), 5000\)/);
  assert.match(webhook, /posPaymentWebhookHandler/);
  assert.match(webhook, /payment_link\.paid/);
  assert.match(webhook, /verifyWebhookSignature/);
  assert.match(webhook, /response\.status\(posOutcome\.retry \? 500 : 200\)/);
});

test('duplicate webhook and finalisation remain idempotent', () => {
  assert.match(webhook, /auditSnapshot\.exists && auditSnapshot\.data\(\)\?\.status === 'PROCESSED'/);
  assert.match(backend, /alreadyFinalized: true/);
});

test('expired cancelled and failed requests create no sale', () => {
  assert.match(backend, /if \(linkStatus === 'cancelled'\)/);
  assert.match(backend, /if \(linkStatus === 'expired'\)/);
  assert.match(backend, /status: 'FAILED'/);
  assert.match(backend, /client\.paymentLink\.cancel/);
});

test('a failed payment attempt cannot unlock a still-live provider request', () => {
  const webhookSection = backend.slice(backend.indexOf('async function processPosPaymentWebhook'), backend.indexOf('async function processPosRefundWebhook'));
  assert.match(webhookSection, /eventName === 'payment\.failed'/);
  assert.match(webhookSection, /'WAITING_FOR_PAYMENT'/);
  assert.match(webhookSection, /PROVIDER_PAYMENT_ATTEMPT_FAILED/);
  assert.doesNotMatch(webhookSection, /status: 'FAILED'/);
});

test('dynamic QR expiry includes provider minimum-time safety margin', () => {
  assert.match(backend, /POS_SESSION_TTL_MS = 16 \* 60 \* 1000/);
  assert.match(backend, /closeAtSeconds = Math\.floor\(\(now \+ POS_SESSION_TTL_MS\) \/ 1000\)/);
  assert.match(backend, /entity\.expire_by \|\| entity\.close_by/);
});

test('cart is locked until provider request is cancelled or completed', () => {
  assert.match(helper, /PAYMENT_REVIEW_REQUIRED/);
  assert.match(posHome, /Cancel the active Razorpay payment request before changing stores/);
  assert.match(posHome, /razorpayPaymentLocked && skipConfirm !== true/);
});

test('hold creates no Razorpay request', () => {
  const holdSection = posHome.slice(posHome.indexOf('const holdCurrentBill'), posHome.indexOf('const recallHeldBill'));
  assert.doesNotMatch(holdSection, /createPosRazorpaySession/);
  assert.match(holdSection, /razorpayPaymentLocked/);
});

test('Cashier cannot refund while Admin and Manager can', () => {
  const refundSection = backend.slice(backend.indexOf('async function requestPosRefund'), backend.indexOf('async function processPosPaymentWebhook'));
  assert.match(refundSection, /\['ADMIN', 'STORE_MANAGER'\]/);
  assert.doesNotMatch(refundSection.match(/staffIdentity[\s\S]{0,100}/)?.[0] || '', /CASHIER/);
  assert.match(refundSection, /assertStoreAccess\(staff, order\.storeId\)/);
  assert.match(runningOrders, /requestPosRazorpayRefund/);
});

test('refund is reasoned idempotent and provider-confirmed', async () => {
  const refundId = posRazorpay.deterministicRefundId('POS_TEST_ORDER');
  assert.equal(refundId, posRazorpay.deterministicRefundId('POS_TEST_ORDER'));
  assert.match(refundId, /^[A-Z0-9_-]{10,40}$/);
  let request = null;
  const providerRefund = await posRazorpay.createIdempotentProviderRefund({
    keyId: 'rzp_test_public_identifier',
    keySecret: 'server_only_test_secret',
    paymentId: 'pay_test_123',
    refundId,
    payload: { amount: 22500, receipt: refundId },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'rfnd_test_123', status: 'pending' }),
      };
    },
  });
  assert.equal(providerRefund.id, 'rfnd_test_123');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Refund-Idempotency'], refundId);
  assert.match(request.options.headers.Authorization, /^Basic /);
  assert.deepEqual(JSON.parse(request.options.body), { amount: 22500, receipt: refundId });
  assert.match(backend, /deterministicRefundId\(orderId\)/);
  assert.match(backend, /'X-Refund-Idempotency': refundId/);
  assert.match(backend, /providerPaymentId/);
  assert.match(backend, /capturedAmount !== orderAmount/);
  assert.match(backend, /String\(payment\.currency \|\| ''\)\.toUpperCase\(\) !== CURRENCY/);
  assert.match(backend, /\['REFUND_PENDING', 'REFUNDED'\]\.includes\(existing\.status\)/);
  assert.match(webhook, /posRefundWebhookHandler/);
  assert.match(runningOrders, /Razorpay: \{order\.refundStatus\}/);
  assert.match(runningOrders, /Razorpay refund/);
});

test('Golden I missing BOM remains an explicit PENDING_BOM audit', () => {
  assert.match(inventory, /ALLOW_NEGATIVE_DEFER_BOM/);
  assert.match(inventory, /status: 'PENDING_BOM'/);
  assert.match(inventory, /source = 'CUSTOMER_WEB_ACCEPT'/);
  assert.match(backend, /source: 'POS_RAZORPAY'/);
});

test('Razorpay is reported separately from manual UPI', () => {
  const rows = reporting.normalizedPaymentRows({
    paymentStatus: 'PAID',
    paymentMethod: 'RAZORPAY',
    paymentProvider: 'RAZORPAY',
    grandTotal: 350,
  }, [{ method: 'RAZORPAY', provider: 'RAZORPAY', providerMethod: 'UPI', amount: 350 }]);
  assert.deepEqual(rows.map(row => row.method), ['RAZORPAY']);
  assert.match(dayClose, /'CARD', 'RAZORPAY', 'ONLINE'/);
  assert.match(dayClose, /method === 'RAZORPAY'/);
  assert.match(auditControl, /'CARD', 'RAZORPAY', 'ONLINE'/);
  assert.match(inventoryControl, /'CARD', 'RAZORPAY', 'ONLINE'/);
  assert.match(runningOrders, /const PAYMENT_METHODS[^\n]+\['CASH', 'UPI', 'CARD', 'SWIGGY'/);
  assert.match(source('functions/reportingCore.mjs'), /razorpay: metrics\.paymentBreakdown\.RAZORPAY \|\| 0/);
});

test('existing manual tenders and customer payment-first exports remain present', () => {
  for (const tender of ['CASH', 'UPI', 'CARD', 'COMPLIMENTARY']) assert.match(posHome, new RegExp(`'${tender}'`));
  assert.match(indexSource, /createCustomerCheckoutSession/);
  assert.match(indexSource, /verifyCustomerRazorpayPayment/);
});

test('provider secrets remain backend-only', () => {
  assert.doesNotMatch(posHome, /RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET/);
  assert.doesNotMatch(helper, /RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET/);
  assert.match(backend, /secrets: \[keySecretParameter\]/);
});

test('POS Razorpay sessions are denied to all Firestore clients', () => {
  assert.match(rules, /match \/posRazorpaySessions\/\{sessionId\} \{\s*allow read, create, update, delete: if false;/);
});

test('dedicated test command is registered', () => {
  assert.equal(packageJson.scripts['test:pos-razorpay'], 'node scripts/test-pos-razorpay.mjs');
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
console.log(`\n${passed}/${tests.length} POS Razorpay tests passed.`);
