import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const policy = require(resolve(root, 'functions/razorpayCheckoutPolicy.js'));
const paymentFirst = require(resolve(root, 'functions/razorpayPaymentFirst.js'));
const checkoutBackend = require(resolve(root, 'functions/razorpayCheckout.js'));
const checkoutCanonicalization = require(resolve(root, 'functions/customerCheckoutCanonicalization.js'));
const onlineOrderInventory = require(resolve(root, 'functions/onlineOrderInventory.js'));
const reporting = await import(resolve(root, 'functions/reportingCore.mjs'));

const source = path => readFileSync(resolve(root, path), 'utf8');
const backend = source('functions/razorpayPaymentFirst.js');
const legacyBackend = source('functions/razorpayCheckout.js');
const inventorySource = source('functions/onlineOrderInventory.js');
const clientInventorySource = source('frontend/lib/inventoryDeduction.ts');
const functionsIndex = source('functions/index.js');
const customerAuth = source('frontend/lib/customerAuth.ts');
const customerOrder = source('frontend/pages/customer/CustomerOrder.tsx');
const tracking = source('frontend/pages/customer/CustomerOrderStatus.tsx');
const myOrders = source('frontend/pages/customer/CustomerMyOrders.tsx');
const incoming = source('frontend/pages/pos/IncomingOnlineOrders.tsx');
const inventoryControl = source('frontend/pages/inventory/InventoryControl.tsx');
const conversion = source('frontend/lib/onlineOrderConversion.ts');
const persistence = source('frontend/lib/customerOrderPersistence.ts');
const checkoutPersistence = source('frontend/lib/customerCheckoutPersistence.ts');
const reportingSource = source('functions/reportingCore.mjs');
const reportingLoader = source('functions/reporting.js');
const franchiseSource = source('functions/franchiseSalesPolicy.js');
const reversalSource = source('frontend/lib/paymentReversal.ts');
const rules = source('firestore.rules');
const envExample = source('.env.example');

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('1. Online payment requires verified customer phone OTP', () => {
  assert.match(backend, /verifiedCustomerIdentity\(request\)/);
  assert.match(backend, /sign_in_provider/);
});
test('2. Unverified phone cannot create a checkout session', () => {
  assert.throws(() => paymentFirst.verifiedCustomerIdentity({ auth: null }), /Verify your mobile number/);
});
test('3. Customer OTP uses an isolated Firebase Auth instance', () => {
  assert.match(customerAuth, /CUSTOMER_APP_NAME = 'coffee-bond-customer-auth'/);
  assert.match(customerAuth, /initializeApp\(firebaseConfig, CUSTOMER_APP_NAME\)/);
});
test('4. Staff session remains unchanged during customer OTP', () => {
  assert.doesNotMatch(customerAuth, /import\s*\{[^}]*auth[^}]*\}\s*from '\.\/firebase'/);
  assert.match(customerAuth, /signOut\(customerAuth\)/);
});
test('5. Phone change invalidates verification', () => {
  assert.match(customerOrder, /setVerifiedCustomer\(null\)/);
  assert.match(customerAuth, /invalidateCustomerVerification/);
});
test('6. Customer cannot access another customer session', () => {
  assert.match(backend, /session\.customerUid !== identity\.uid/);
  assert.match(backend, /This checkout belongs to another customer/);
});
test('7. Pay Online does not create onlineOrders before payment', () => {
  const createStart = backend.indexOf('async function createCheckoutSession');
  const createEnd = backend.indexOf('async function createPaidOnlineOrder');
  assert.doesNotMatch(backend.slice(createStart, createEnd), /collection\('onlineOrders'\)/);
  assert.match(functionsIndex, /Pay Online must use verified mobile checkout/);
});
test('8. Pay at Counter behaviour remains on submitCustomerOrder', () => {
  assert.match(functionsIndex, /const paymentProvider = 'PAY_AT_COUNTER'/);
  assert.match(customerOrder, /submitCustomerOrderCallable/);
});
test('9. Razorpay Customer is created once per verified customer', () => {
  assert.match(backend, /if \(cleanText\(profile\.razorpayCustomerId, 120\)\)/);
  assert.match(backend, /razorpayCustomerLeaseId/);
  assert.match(backend, /client\.customers\.create/);
});
test('10. Existing Razorpay Customer is reused', () => {
  assert.match(backend, /razorpayCustomerId: profile\.razorpayCustomerId \|\| providerCustomerId/);
  assert.match(backend, /client\.customers\.all/);
});
test('11. Checkout receives customer_id', () => {
  assert.match(customerOrder, /customer_id: checkoutResult\.customerId/);
});
test('12. Checkout receives remember_customer true', () => {
  assert.match(backend, /rememberCustomer: true/);
  assert.match(customerOrder, /remember_customer: checkoutResult\.rememberCustomer/);
});
test('13. Contact is prefilled and readonly', () => {
  assert.match(backend, /prefill:[\s\S]*contact: session\.verifiedPhone/);
  assert.match(backend, /readonly: \{ contact: true \}/);
});
test('14. Browser amount is ignored', () => {
  assert.doesNotMatch(backend, /request\.data\?\.amount|request\.data\.amount/);
  assert.match(backend, /amountPaise = rupeesToPaise\(canonical\.grandTotal\)/);
});
test('15. Captured payment creates PAID_PENDING_ACCEPTANCE order', () => {
  assert.match(backend, /status: 'PAID_PENDING_ACCEPTANCE'/);
  assert.match(backend, /paymentStatus: 'PAID'/);
});
test('16. Paid order appears in Incoming Online Orders', () => {
  assert.match(incoming, /'PAID_PENDING_ACCEPTANCE'/);
  assert.match(incoming, /RAZORPAY · PAID/);
});
test('17. KOT is not created before staff acceptance', () => {
  const paidStart = backend.indexOf('async function createPaidOnlineOrder');
  const acceptStart = backend.indexOf('async function acceptPaidOrder');
  assert.doesNotMatch(backend.slice(paidStart, acceptStart), /collection\('kotItems'\)/);
});
test('18. Permanent stock deduction is not created before acceptance', () => {
  const paidStart = backend.indexOf('async function createPaidOnlineOrder');
  const acceptStart = backend.indexOf('async function acceptPaidOrder');
  assert.doesNotMatch(backend.slice(paidStart, acceptStart), /collection\('stockMovements'\)/);
});
test('19. Reservation is created exactly once', () => {
  assert.match(backend, /transaction\.create\(reservationRef/);
  assert.match(backend, /idempotencyKey: onlineOrderId/);
});
test('20. Staff acceptance creates POS, KOT and stock through the operational finalizer', () => {
  assert.match(backend, /finalizePaidOnlineOrder\(/);
  assert.match(legacyBackend, /collection\('kotItems'\)/);
  assert.match(legacyBackend, /collection\('stockMovements'\)/);
});
test('21. Repeated acceptance is idempotent', () => {
  assert.match(backend, /order\.status === 'CONVERTED' && order\.linkedOrderId/);
  assert.match(legacyBackend, /alreadyFinalized: true/);
});
test('22. Manager can cancel and refund an unaccepted paid order', () => {
  assert.match(backend, /staffIdentity\(request, db, \['ADMIN', 'STORE_MANAGER'\]\)/);
});
test('23. Admin can cancel and refund', () => {
  assert.match(backend, /\['ADMIN', 'STORE_MANAGER'\]/);
});
test('24. Cashier cannot cancel or refund', () => {
  assert.doesNotMatch(
    backend.slice(backend.indexOf('async function cancelAndRefund'), backend.indexOf('async function listMyOrders')),
    /CASHIER/,
  );
  assert.match(incoming, /staffProfile\.role === 'ADMIN' \|\| staffProfile\.role === 'STORE_MANAGER'/);
});
test('25. Manager cannot refund another store order', () => {
  assert.match(backend, /This manager cannot refund another store’s order/);
});
test('26. Refund requires a reason', () => {
  assert.match(backend, /if \(!onlineOrderId \|\| !reason\)/);
});
test('27. Refund requires confirmation', () => {
  assert.match(backend, /\['REFUND', order\.publicOrderReference\]\.includes\(confirmation\)/);
});
test('28. Refund API uses authoritative payment ID and full amount', () => {
  assert.match(backend, /createProviderRefund\(client, order\.providerPaymentId/);
  assert.match(backend, /amount: rupeesToPaise\(Number\(order\.grandTotal\)\)/);
  assert.match(backend, /receipt: refundRequestId/);
});
test('29. Duplicate refund request is idempotent', () => {
  assert.match(backend, /\['REFUND_PENDING', 'REFUNDED'\]\.includes\(existing\.status\)/);
  assert.match(backend, /existing\?\.status === 'REFUND_REQUESTING'/);
  assert.match(backend, /'X-Refund-Idempotency': refundRequestId/);
});
test('30. refund.created keeps REFUND_PENDING', () => {
  assert.match(backend, /eventName === 'refund\.created'\) return \{ handled: true, outcome: 'REFUND_PENDING'/);
});
test('31. refund.processed sets REFUNDED', () => {
  assert.match(backend, /eventName === 'refund\.processed' \? 'REFUNDED' : 'REFUND_FAILED'/);
});
test('32. refund.failed sets REFUND_FAILED', () => {
  assert.match(backend, /'REFUND_FAILED'/);
});
test('33. Reservation releases on cancellation and refund', () => {
  assert.match(backend, /status: 'RELEASED'/);
  assert.match(backend, /releaseReason: 'REFUND_REQUESTED'/);
});
test('34. Refunded order cannot be accepted', () => {
  assert.match(backend, /!\['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS\]\.includes\(order\.status\)/);
  assert.match(backend, /order\.paymentStatus !== 'PAID'/);
});
test('35. Accepted or preparing order is not silently refunded', () => {
  assert.match(backend, /Only an unaccepted captured Razorpay order can be refunded here/);
  assert.doesNotMatch(backend.match(/Only an unaccepted[\s\S]{0,400}/)?.[0] || '', /CONVERTED|PREPARING/);
});
test('36. Payment success automatically creates the POS incoming order', () => {
  assert.match(backend, /transaction\.create\(onlineOrderRef, onlineOrder\)/);
});
test('37. Refresh restores the status page', () => {
  assert.match(tracking, /onSnapshot\(/);
  assert.match(tracking, /rememberCustomerOrder\(trackingToken\)/);
});
test('38. Stable tracking URL survives refresh', () => {
  assert.match(customerOrder, /\/order\/status\/\$\{verifiedOrder\.trackingToken\}/);
  assert.match(tracking, /useParams/);
});
test('39. Local storage restores the last order', () => {
  assert.match(persistence, /coffeeBondLastOrderTrackingToken/);
  assert.match(persistence, /coffeeBondPendingOrderTokens/);
});
test('40. Verified customer My Orders restores lost tracking state', () => {
  assert.match(myOrders, /listMyCustomerOrders/);
  assert.match(backend, /where\('customerUid', '==', identity\.uid\)/);
});
test('41. Lost browser callback is recovered by webhook', () => {
  assert.match(backend, /\['payment\.captured', 'payment\.failed', 'order\.paid'\]/);
  assert.match(backend, /createPaidOnlineOrder\(/);
});
test('42. Duplicate webhook does not create another order', () => {
  assert.match(backend, /auditSnapshot\.exists && auditSnapshot\.data\(\)\?\.status === 'PROCESSED'/);
  assert.match(backend, /existingOrderSnapshot\.exists/);
});
test('43. Payment failed creates no online order', () => {
  const failedBranch = backend.slice(
    backend.indexOf("if (eventName === 'payment.failed')"),
    backend.indexOf("const client = razorpayClient", backend.indexOf("if (eventName === 'payment.failed')")),
  );
  assert.doesNotMatch(failedBranch, /collection\('onlineOrders'\)|createPaidOnlineOrder/);
});
test('44. Modal dismiss creates no online order', () => {
  assert.match(customerOrder, /Payment cancelled\. No order was placed\. Your cart has been saved\./);
});
test('45. Customer cart is retained after failed or dismissed payment', () => {
  assert.doesNotMatch(customerOrder.match(/modal:[\s\S]{0,260}/)?.[0] || '', /setCart\(\[\]\)/);
});
test('46. Customer cart clears only after verified order creation', () => {
  const verifyPosition = customerOrder.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)');
  assert.ok(verifyPosition > 0);
  assert.ok(customerOrder.indexOf('setCart([])', verifyPosition) > verifyPosition);
});
test('47. Refund pending is reported separately', () => {
  assert.match(reportingSource, /refundsPending/);
  assert.match(reportingSource, /gatewayPaymentRows/);
});
test('48. Processed refund reduces net Razorpay collections once', () => {
  assert.match(reportingSource, /amount - refunded/);
  assert.match(reportingSource, /!order\?\.linkedOrderId/);
});
test('49. Refund failure does not reduce collections', () => {
  assert.match(reportingSource, /const refunded = order\.paymentStatus === 'REFUNDED' \? amount : 0/);
});
test('50. Cash UPI Card Split and Complimentary reporting remain unchanged', () => {
  const cash = reporting.normalizedPaymentRows(
    { paymentStatus: 'PAID', paymentMethod: 'CASH', grandTotal: 100 },
    [{ method: 'CASH', amount: 40 }, { method: 'UPI', amount: 60 }],
  );
  assert.deepEqual(cash.map(row => row.method), ['CASH', 'UPI']);
  assert.deepEqual(reporting.normalizedPaymentRows({
    commercialStatus: 'COMPLIMENTARY',
    paymentStatus: 'NOT_REQUIRED',
    paymentMethod: 'COMPLIMENTARY',
    grandTotal: 0,
  }), []);
});
test('51. Customer profile is private', () => {
  assert.match(rules, /match \/customerProfiles\/\{customerUid\} \{\s*allow read, create, update, delete: if false;/);
});
test('52. Checkout sessions are server-write-only', () => {
  assert.match(rules, /match \/customerCheckoutSessions\/\{sessionId\} \{\s*allow read, create, update, delete: if false;/);
});
test('53. Refund records are server-write-only', () => {
  assert.match(rules, /match \/razorpayRefunds\/\{refundId\} \{\s*allow read, create, update, delete: if false;/);
});
test('54. Cashier refund access is denied in Firestore and backend', () => {
  assert.match(rules, /Paid gateway orders are accepted or refunded only by secured callables/);
  assert.doesNotMatch(backend.slice(backend.indexOf('async function cancelAndRefund'), backend.indexOf('async function listMyOrders')), /CASHIER/);
});
test('55. No payment secret or instrument data appears in frontend, reports or franchise output', () => {
  assert.doesNotMatch(customerAuth + customerOrder + tracking + myOrders, /RAZORPAY_KEY_SECRET|key_secret|card_number|cvv|upi_pin/);
  assert.doesNotMatch(reportingSource + franchiseSource, /razorpayCustomerId|razorpay_signature|verifiedPhone/);
  assert.doesNotMatch(reversalSource, /razorpay_signature/);
});
test('56. Standard Checkout fallback works when Magic Checkout is disabled', () => {
  assert.match(envExample, /RAZORPAY_MAGIC_CHECKOUT_ENABLED="false"/);
  assert.match(customerOrder, /remember_customer/);
});
test('57. Magic Checkout option is passed only when feature flag is enabled', () => {
  assert.match(customerOrder, /\.\.\.\(checkoutResult\.magicCheckoutEnabled \? \{/);
  assert.match(backend, /booleanParameter\(magicCheckoutParameter\)/);
});
test('58. Public order data exposes no customer profile or Razorpay customer ID', () => {
  assert.doesNotMatch(backend.match(/function publicTrackingPayload[\s\S]*?\n\}/)?.[0] || '', /customerUid|razorpayCustomerId|verifiedPhone/);
  assert.doesNotMatch(rules.match(/function isSafePublicTrackingDocument[\s\S]*?\n\s*\}/)?.[0] || '', /customerUid|razorpayCustomerId|verifiedPhone/);
  assert.match(reportingLoader, /loadOnlineOrders/);
  assert.match(conversion, /Paid Razorpay orders must use the secured staff acceptance service/);
});

test('59. HMAC uses safe length handling and authoritative provider order', () => {
  const signature = createHmac('sha256', 'mock-secret').update('order_mock|pay_mock').digest('hex');
  assert.equal(policy.verifyCheckoutSignature({
    storedOrderId: 'order_mock',
    paymentId: 'pay_mock',
    signature,
    keySecret: 'mock-secret',
  }), true);
  assert.equal(policy.verifyCheckoutSignature({
    storedOrderId: 'order_mock',
    paymentId: 'pay_mock',
    signature: 'short',
    keySecret: 'mock-secret',
  }), false);
});
test('60. Minimum provider amount is 100 paise', () => {
  assert.equal(policy.rupeesToPaise(1), 100);
  assert.throws(() => policy.rupeesToPaise(0.99), /PAYABLE_BELOW_PROVIDER_MINIMUM/);
});
test('61. Provider amount currency and captured status are verified', () => {
  assert.deepEqual(policy.isFinalProviderState({
    payment: { id: 'pay', order_id: 'order', amount: 100, currency: 'INR', status: 'captured' },
    providerOrder: { id: 'order', amount: 100, currency: 'INR', status: 'paid' },
    expectedOrderId: 'order',
    expectedAmountPaise: 100,
  }), { valid: true, code: null });
});
test('62. Built output contains no Razorpay secret names or live keys', () => {
  const dist = resolve(root, 'dist');
  if (!existsSync(dist)) return;
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dist);
  const output = files.filter(path => /\.(js|html|css|json)$/.test(path))
    .map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(output, /RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|rzp_live_[A-Za-z0-9]+/);
});
test('63. Mocked Razorpay Customer API creates canonical customer metadata', async () => {
  let createPayload = null;
  const customer = await paymentFirst.findOrCreateProviderCustomer({
    customers: {
      all: async () => ({ items: [] }),
      create: async payload => {
        createPayload = payload;
        return { id: 'cust_mock', contact: payload.contact };
      },
    },
  }, {
    customerUid: 'firebase_customer',
    verifiedPhone: '+919999999999',
    customerName: 'Customer Test',
  });
  assert.equal(customer.id, 'cust_mock');
  assert.equal(createPayload.contact, '+919999999999');
  assert.doesNotMatch(JSON.stringify(createPayload), /firebase_customer/);
});
test('64. Mocked Razorpay Customer API reuses a matching existing customer', async () => {
  let createCalls = 0;
  const customer = await paymentFirst.findOrCreateProviderCustomer({
    customers: {
      all: async () => ({ items: [{ id: 'cust_existing', contact: '+919999999999' }] }),
      create: async () => {
        createCalls += 1;
        return { id: 'cust_new' };
      },
    },
  }, {
    customerUid: 'firebase_customer',
    verifiedPhone: '+919999999999',
    customerName: 'Customer Test',
  });
  assert.equal(customer.id, 'cust_existing');
  assert.equal(createCalls, 0);
});
test('65. Mocked Razorpay Order API recovers a matching provider order', async () => {
  let createCalls = 0;
  const order = await paymentFirst.findOrCreateProviderOrder({
    orders: {
      all: async () => ({
        items: [{ id: 'order_existing', receipt: 'CBRZP123', amount: 35000, currency: 'INR' }],
      }),
      create: async () => {
        createCalls += 1;
        return { id: 'order_new' };
      },
    },
  }, { receipt: 'CBRZP123', amount: 35000, currency: 'INR' });
  assert.equal(order.id, 'order_existing');
  assert.equal(createCalls, 0);
});
test('66. Mocked Razorpay Order API creates only when no matching receipt exists', async () => {
  let createPayload = null;
  const order = await paymentFirst.findOrCreateProviderOrder({
    orders: {
      all: async () => ({ items: [] }),
      create: async payload => {
        createPayload = payload;
        return { id: 'order_new', ...payload };
      },
    },
  }, { receipt: 'CBRZP456', amount: 22500, currency: 'INR' });
  assert.equal(order.id, 'order_new');
  assert.equal(createPayload.amount, 22500);
});
test('67. Mocked Payment and Order APIs fetch authoritative provider state', async () => {
  const fetched = [];
  const [payment, order] = await paymentFirst.fetchProviderPaymentAndOrder({
    payments: { fetch: async id => { fetched.push(id); return { id, status: 'captured' }; } },
    orders: { fetch: async id => { fetched.push(id); return { id, status: 'paid' }; } },
  }, 'pay_mock', 'order_mock');
  assert.deepEqual(fetched.sort(), ['order_mock', 'pay_mock']);
  assert.equal(payment.status, 'captured');
  assert.equal(order.status, 'paid');
});
test('68. Mocked Refund API receives the authoritative payment and full payload', async () => {
  let call = null;
  const response = await paymentFirst.createProviderRefund({
    payments: {
      refund: async (paymentId, payload) => {
        call = { paymentId, payload };
        return { id: 'rfnd_mock' };
      },
    },
  }, 'pay_authoritative', {
    amount: 35000,
    receipt: paymentFirst.deterministicRefundRequestId('online_order'),
    speed: 'normal',
  });
  assert.equal(response.id, 'rfnd_mock');
  assert.equal(call.paymentId, 'pay_authoritative');
  assert.equal(call.payload.amount, 35000);
});
test('69. Refund client binds Razorpay idempotency header', () => {
  class MockRazorpay {
    constructor(options) {
      this.options = options;
    }
  }
  const requestId = paymentFirst.deterministicRefundRequestId('online_order');
  const client = checkoutBackend.razorpayClient('key_mock', 'secret_mock', MockRazorpay, {
    headers: { 'X-Refund-Idempotency': requestId },
  });
  assert.equal(client.options.headers['X-Refund-Idempotency'], requestId);
  assert.match(requestId, /^CBREF_[A-F0-9]{32}$/);
});
test('70. Concurrency leases and captured-payment review recovery are present', () => {
  assert.match(backend, /providerCreationLeaseId/);
  assert.match(backend, /razorpayCustomerLeaseId/);
  assert.match(backend, /status: 'REFUND_REQUESTING'/);
  assert.match(backend, /status: REVIEW_STATUS,[\s\S]{0,160}failureCode: 'PAID_ORDER_CREATION_FAILED'/);
});
test('71. Checkout draft uses a versioned localStorage key', () => {
  assert.match(checkoutPersistence, /coffeeBondCustomerCheckoutDraft:v1/);
  assert.match(checkoutPersistence, /CUSTOMER_CHECKOUT_DRAFT_VERSION = 1/);
});
test('72. Checkout draft expires after 24 hours', () => {
  assert.match(checkoutPersistence, /24 \* 60 \* 60 \* 1000/);
  assert.match(checkoutPersistence, /status: 'EXPIRED'/);
});
test('73. Checkout hydration prevents the initial empty cart from overwriting storage', () => {
  assert.match(customerOrder, /CheckoutHydrationState/);
  assert.match(customerOrder, /checkoutHydration !== 'RESTORED'/);
  assert.match(customerOrder, /cart\.length === 0/);
});
test('74. Restored cart is rebuilt from current menu products and add-ons', () => {
  assert.match(customerOrder, /restoreCustomerCheckoutDraft<CustomerMenuItem, AddOnSelection>/);
  assert.match(customerOrder, /canonicalAddOnSelections/);
  assert.match(checkoutPersistence, /isItemAvailable/);
});
test('75. Pay Online tracks the order before clearing the persisted draft', () => {
  const remember = customerOrder.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)');
  const clear = customerOrder.indexOf('clearCustomerCheckoutDraft(window.localStorage)', remember);
  assert.ok(remember > 0 && clear > remember);
});
test('76. Pay-at-Counter tracks the order before clearing the persisted draft', () => {
  const remember = customerOrder.indexOf('rememberCustomerOrder(submittedOrder.trackingToken)');
  const clear = customerOrder.indexOf('clearCustomerCheckoutDraft(window.localStorage)', remember);
  assert.ok(remember > 0 && clear > remember);
});
test('77. Customer authentication waits for browser persistence restoration', () => {
  assert.match(customerAuth, /customerAuthPersistenceReady/);
  assert.match(customerAuth, /await customerAuth\.authStateReady\(\)/);
  assert.match(customerOrder, /restoreCustomerProfile\(\)/);
});
test('78. My Orders does not decide signed-out state before auth restoration', () => {
  assert.match(myOrders, /waitForCustomerAuthRestoration\(\)/);
  assert.match(myOrders, /authRestored/);
});
test('79. Persisted checkout contains references, not authoritative prices or payment secrets', () => {
  assert.match(checkoutPersistence, /productId/);
  assert.match(checkoutPersistence, /productCode/);
  assert.match(checkoutPersistence, /optionId/);
  assert.doesNotMatch(checkoutPersistence.match(/export type CustomerCheckoutDraft = \{[\s\S]*?\n\};/)?.[0] || '', /salePrice|unitPrice|gst|total|otp|signature|token|customerUid/i);
});
test('80. Failed payment paths do not clear the persisted checkout draft', () => {
  const failedFlow = customerOrder.slice(
    customerOrder.indexOf('const verifiedOrder = await new Promise'),
    customerOrder.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)'),
  );
  assert.doesNotMatch(failedFlow, /clearCustomerCheckoutDraft/);
});

function inventoryMovement({
  stockId = 'GOLDEN_I_RAW_INGREDIENT_SOURDOUGH_BREAD',
  currentStock,
  requiredQuantity,
  finishedGoodCode = 'BREAD_2_SLICES',
  stockCode = 'SOURDOUGH_BREAD',
  stockType = 'RAW_INGREDIENT',
}) {
  return {
    stock: {
      id: stockId,
      exists: true,
      type: stockType,
      code: stockCode,
      name: 'Sourdough Bread',
      currentStock,
      unit: 'PCS',
    },
    quantity: requiredQuantity,
    finishedGoodCode,
    finishedGoodName: 'Bread (2 Slices)',
  };
}

function availabilityBlockers(movements, store = { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' }) {
  const grouped = new Map();
  for (const movement of movements) {
    if (!grouped.has(movement.stock.id)) grouped.set(movement.stock.id, []);
    grouped.get(movement.stock.id).push(movement);
  }
  return onlineOrderInventory.insufficientStockBlockers(grouped, store);
}

function inventoryPlannerHarness(records = {}) {
  const db = {
    collection(collectionName) {
      return {
        doc(id) {
          return { id, path: `${collectionName}/${id}` };
        },
      };
    },
  };
  const transaction = {
    async get(ref) {
      const value = records[ref.path];
      return {
        id: ref.id,
        exists: value !== undefined,
        data: () => value,
      };
    },
  };
  const admin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
      },
    },
  };
  return { db, transaction, admin };
}

function goldenStore(overrides = {}) {
  return {
    id: 'GOLDEN_I',
    code: 'GOLDEN_I',
    name: 'Golden I',
    isActive: true,
    posEnabled: true,
    customerOrderingEnabled: true,
    onlineOrderingEnabled: true,
    publicOrderingEnabled: true,
    acceptingOrders: true,
    isAcceptingOrders: true,
    inventoryPolicy: 'ALLOW_NEGATIVE_DEFER_BOM',
    ...overrides,
  };
}

function madeToOrderFinishedGood(overrides = {}) {
  return {
    id: 'HOT_LATTE',
    code: 'HOT_LATTE',
    name: 'Hot Latte',
    displayName: 'Hot Latte',
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    availableStoreIds: ['GOLDEN_I'],
    isActive: true,
    isSellable: true,
    isAvailable: true,
    bom: [],
    ...overrides,
  };
}

async function planInventory({ store = goldenStore(), finishedGood, records = {}, requireAvailableStock = true }) {
  const harness = inventoryPlannerHarness(records);
  return onlineOrderInventory.planOnlineOrderInventory({
    ...harness,
    store,
    orderId: 'POS_ORDER_1',
    orderNumber: 'CB-TEST-0001',
    orderType: 'TAKEAWAY',
    businessDate: '20260801',
    staff: { uid: 'admin-1', name: 'Admin' },
    lines: [{
      lineKey: 'LINE_1',
      quantity: 1,
      finishedGood,
      addOns: [],
    }],
    requireAvailableStock,
  });
}

test('81. Golden I zero or negative stock does not enable the paid available-stock gate', () => {
  assert.equal(onlineOrderInventory.shouldRequireAvailableStock(goldenStore(), true), false);
  assert.equal(onlineOrderInventory.shouldRequireAvailableStock(goldenStore(), false), false);
});
test('82. Other stores retain the paid available-stock gate', () => {
  const strictStore = { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' };
  assert.equal(onlineOrderInventory.shouldRequireAvailableStock(strictStore, true), true);
  const blockers = availabilityBlockers([inventoryMovement({ currentStock: -1, requiredQuantity: 2 })], strictStore);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].availableQuantity, -1);
});
test('83. Stock below the aggregate required quantity blocks acceptance', () => {
  const movements = [
    inventoryMovement({ currentStock: 3, requiredQuantity: 2 }),
    inventoryMovement({ currentStock: 3, requiredQuantity: 2 }),
  ];
  const blockers = availabilityBlockers(movements);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].requiredQuantity, 4);
  assert.equal(blockers[0].availableQuantity, 3);
});
test('84. Exact required stock passes acceptance validation', () => {
  assert.deepEqual(
    availabilityBlockers([inventoryMovement({ currentStock: 2, requiredQuantity: 2 })]),
    [],
  );
});
test('85. Sufficient stock passes acceptance validation', () => {
  assert.deepEqual(
    availabilityBlockers([inventoryMovement({ currentStock: 5, requiredQuantity: 2 })]),
    [],
  );
});
test('86. An unrelated inventory row cannot satisfy the mapped item', () => {
  const blockers = availabilityBlockers([
    inventoryMovement({ currentStock: -1, requiredQuantity: 2 }),
    inventoryMovement({
      stockId: 'GOLDEN_I_RAW_INGREDIENT_OTHER_BREAD',
      currentStock: 100,
      requiredQuantity: 1,
      stockCode: 'OTHER_BREAD',
    }),
  ]);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].componentCode, 'SOURDOUGH_BREAD');
});
test('87. DIRECT_STOCK items are scheduled against their exact finished-good row', () => {
  const directStockBranch = inventorySource.slice(
    inventorySource.indexOf('if (directStock(item))'),
    inventorySource.indexOf('perLineConsumptionStatus[line.lineKey] = await addOnInventory', inventorySource.indexOf('if (directStock(item))')),
  );
  assert.match(directStockBranch, /schedule\(line, 'FINISHED_GOOD', item\.code/);
  assert.match(legacyBackend, /requireAvailableStock: true/);
});
test('88. Failed paid acceptance writes review state before any operational records', () => {
  const blockerBranch = legacyBackend.slice(
    legacyBackend.indexOf('if (inventoryPlan.blockers.length > 0)'),
    legacyBackend.indexOf('inventoryPlan.stockUpdates.forEach'),
  );
  assert.doesNotMatch(blockerBranch, /transaction\.create\(/);
  assert.match(blockerBranch, /paymentStatus: PAID_STATUS/);
  assert.match(blockerBranch, /return \{ reviewRequired: true/);
});
test('89. Review-state paid orders remain retryable and refundable', () => {
  assert.match(backend, /\['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS\]\.includes\(order\.status\)/);
  assert.match(legacyBackend, /\['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS\]\.includes\(onlineOrder\.status\)/);
  assert.match(backend, /\['PAID_PENDING_ACCEPTANCE', REVIEW_STATUS, 'REFUND_FAILED'\]\.includes\(order\.status\)/);
});
test('90. Acceptance retry remains idempotent for POS KOT and stock records', () => {
  assert.match(legacyBackend, /intent\.status === PAID_STATUS && existingPosOrderSnapshot\.exists/);
  assert.match(legacyBackend, /existingPosOrderSnapshot\.exists[\s\S]{0,120}already-exists/);
  assert.match(legacyBackend, /doc\(`\$\{posOrderId\}_SALE_\$\{String\(index \+ 1\)\.padStart\(3, '0'\)\}`\)/);
  assert.match(incoming, /paidResult\.data\.reviewRequired/);
  assert.match(incoming, /'Retry acceptance'/);
});
test('91. Staff-POS launch exception does not control the exact Golden I customer policy', () => {
  assert.match(legacyBackend, /requireAvailableStock: true/);
  assert.match(inventorySource, /shouldRequireAvailableStock\(store, requireAvailableStock\)/);
  assert.match(inventorySource, /store\?\.id === 'GOLDEN_I'/);
  assert.doesNotMatch(inventorySource, /posLaunchException|STAFF_POS_ONLY/);
  assert.doesNotMatch(backend, /posLaunchException|STAFF_POS_ONLY/);
});

test('92. Golden I valid BOM deducts into negative stock with an auditable movement', async () => {
  const plan = await planInventory({
    finishedGood: madeToOrderFinishedGood({
      bom: [{
        componentType: 'RAW_INGREDIENT',
        componentCode: 'MILK',
        componentName: 'Fresh Milk',
        quantity: 150,
        uom: 'ML',
      }],
    }),
    records: {
      'rawIngredients/MILK': { code: 'MILK', name: 'Fresh Milk', usageUOM: 'ML', costPerUsageUnit: 0.1 },
      'storeStock/GOLDEN_I_RAW_INGREDIENT_MILK': {
        stockItemName: 'Fresh Milk',
        currentStock: 0,
        uom: 'ML',
        costPerUnit: 0.1,
      },
    },
  });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.pendingConsumptionPayloads.length, 0);
  assert.equal(plan.movementPayloads.length, 1);
  assert.equal(plan.movementPayloads[0].quantity, -150);
  assert.equal(plan.movementPayloads[0].previousQty, 0);
  assert.equal(plan.movementPayloads[0].newQty, -150);
  assert.equal(plan.movementPayloads[0].wentNegative, true);
  assert.equal(plan.stockUpdates[0].newQty, -150);
});

test('93. Golden I missing BOM creates one deterministic unresolved-inventory audit and no fake movement', async () => {
  const first = await planInventory({ finishedGood: madeToOrderFinishedGood() });
  const retry = await planInventory({ finishedGood: madeToOrderFinishedGood() });
  assert.equal(first.blockers.length, 0);
  assert.equal(first.movementPayloads.length, 0);
  assert.equal(first.stockUpdates.length, 0);
  assert.equal(first.pendingConsumptionPayloads.length, 1);
  assert.equal(first.pendingConsumptionPayloads[0].status, 'PENDING_BOM');
  assert.equal(first.pendingConsumptionPayloads[0].idempotencyKey, 'GOLDEN_I_POS_ORDER_1_LINE_1');
  assert.equal(retry.pendingConsumptionPayloads[0].idempotencyKey, first.pendingConsumptionPayloads[0].idempotencyKey);
  assert.equal(first.perLineConsumptionStatus.LINE_1, 'PENDING_BOM');
});

test('94. Golden I missing prep dependency is deferred without inventing a deduction', async () => {
  const plan = await planInventory({
    finishedGood: madeToOrderFinishedGood({
      bom: [{
        componentType: 'PREP_ITEM',
        componentCode: 'MISSING_PREP',
        componentName: 'Missing Prep',
        quantity: 50,
        uom: 'G',
      }],
    }),
  });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.movementPayloads.length, 0);
  assert.equal(plan.pendingConsumptionPayloads.length, 1);
  assert.match(plan.pendingConsumptionPayloads[0].reason, /Missing prep\/raw ingredient reference/);
});

test('95. An ordinary store with missing BOM remains blocked and gets no pending audit', async () => {
  const strictStore = { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' };
  const plan = await planInventory({
    store: strictStore,
    finishedGood: madeToOrderFinishedGood({ availableStoreIds: ['UDAY_PARK'] }),
  });
  assert.equal(plan.blockers.length, 1);
  assert.equal(plan.blockers[0].blockerType, 'Missing BOM');
  assert.equal(plan.pendingConsumptionPayloads.length, 0);
  assert.equal(plan.movementPayloads.length, 0);
});

test('96. Golden I setup-incomplete status is warning-only only for the exact store identity', () => {
  assert.equal(checkoutCanonicalization.isGoldenISalesFirstOrderingStore(goldenStore()), true);
  assert.equal(checkoutCanonicalization.isCustomerOrderingEnabledForStore(goldenStore()), true);
  assert.equal(checkoutCanonicalization.isCustomerOrderingEnabledForStore(goldenStore({ acceptingOrders: false })), false);
  assert.equal(checkoutCanonicalization.isGoldenISalesFirstOrderingStore({ id: 'GOLDEN_I', code: 'NOIDA_29' }), false);
  assert.equal(checkoutCanonicalization.isGoldenISalesFirstOrderingStore({ id: 'UDAY_PARK', code: 'GOLDEN_I' }), false);
  assert.match(functionsIndex, /availability\.publicStatus === 'SETUP_INCOMPLETE'/);
  assert.match(functionsIndex, /if \(!isGoldenISalesFirstOrderingStore\(store\)\) return store\?\.onlineOrderingEnabled !== false/);
  assert.match(customerOrder, /isGoldenISetupWarningOnly\(selectedStore, publicItem\?\.publicStatus\)/);
});

test('97. Existing deterministic POS, payment, KOT and movement IDs remain unchanged', () => {
  assert.match(legacyBackend, /deterministicPosOrderId/);
  assert.match(legacyBackend, /collection\('payments'\)\.doc\('razorpay'\)/);
  assert.match(legacyBackend, /doc\(`\$\{posOrderId\}_\$\{line\.lineId\}_\$\{kotStation\}`\)/);
  assert.match(legacyBackend, /doc\(`\$\{posOrderId\}_SALE_\$\{String\(index \+ 1\)\.padStart\(3, '0'\)\}`\)/);
});

test('98. Pay-at-Counter acceptance uses the same exact Golden I deferred-inventory identity', () => {
  assert.match(clientInventorySource, /isGoldenISalesFirstOrderingStore\(store\)/);
  assert.doesNotMatch(clientInventorySource, /store\.id === 'GOLDEN_I' \|\| store\.code === 'GOLDEN_I'/);
  assert.match(conversion, /planInventoryDeductionForSale/);
  assert.match(conversion, /pendingInventoryConsumption/);
});

test('99. Admin inventory readiness keeps setup, negative-stock, and pending-BOM warnings visible', () => {
  assert.match(inventoryControl, /buildSetupBlockers/);
  assert.match(inventoryControl, /Negative stock items/);
  assert.match(inventoryControl, /Pending BOM lines/);
  assert.match(inventoryControl, /status === 'PENDING_BOM'/);
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

assert.equal(tests.length, 99);
console.log(`Razorpay payment-first checkout tests passed: ${passed}/${tests.length}. Mocked/static checks only; no Razorpay network or Firebase writes were performed.`);
