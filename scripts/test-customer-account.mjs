import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const source = path => readFileSync(resolve(root, path), 'utf8');
const header = source('frontend/components/customer/CustomerHeader.tsx');
const auth = source('frontend/lib/customerAuth.ts');
const order = source('frontend/pages/customer/CustomerOrder.tsx');
const myOrders = source('frontend/pages/customer/CustomerMyOrders.tsx');
const status = source('frontend/pages/customer/CustomerOrderStatus.tsx');
const persistence = source('frontend/lib/customerOrderPersistence.ts');
const backend = source('functions/razorpayPaymentFirst.js');
const functionsIndex = source('functions/index.js');
const paymentFirst = require(resolve(root, 'functions/razorpayPaymentFirst.js'));

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('1. Account access is available before OTP', () => {
  // Screens with the customer bottom navigation pass onSignedOutAccountPress so the
  // header does not duplicate the Orders destination; screens without it keep the
  // link, so a signed-out customer can always reach My Orders.
  assert.match(header, /aria-label="Customer account"/);
  assert.match(header, /aria-label="Customer account and My Orders"/);
  assert.match(header, /onSignedOutAccountPress/);
  assert.doesNotMatch(header, />Sign in \/ My Orders</);
  assert.doesNotMatch(header, /Sign in or view My Orders/);
  // The path is resolved by the shared route helper so the same header serves the
  // staff origin (/order/my-orders) and the customer origin (/my-orders).
  assert.match(header, /to=\{CUSTOMER_MY_ORDERS_PATH\}/);
});
test('2. Before OTP My Orders asks the customer to verify', () => {
  assert.match(myOrders, /Verify your mobile number to view your orders/);
  assert.match(myOrders, /Verify on order page/);
});
test('3. Verified customer sees a profile account control', () => {
  assert.match(header, /aria-label="Open customer account"/);
  assert.match(header, /profile\.displayName \|\| 'My account'/);
});
test('4. Verified customer sees a masked phone', () => {
  assert.match(header, /maskedPhone\(profile\.normalisedPhone\)/);
  assert.match(header, /••••••/);
});
test('5. Customer name appears when a profile exists', () => {
  assert.match(header, /\{profile\.displayName \|\| 'My account'\}/);
});
test('6. Account menu contains My Orders', () => {
  assert.match(header, /<ClipboardList size=\{18\} \/> My Orders/);
});
test('7. Account menu contains Sign Out', () => {
  assert.match(header, /<LogOut size=\{18\} \/> Sign Out/);
});
test('8. Sign out targets only customer Auth', () => {
  assert.match(auth, /signOut\(customerAuth\)/);
  assert.match(header, /await signOutCustomer\(\)/);
});
test('9. Staff Auth is not imported into customer account code', () => {
  assert.doesNotMatch(auth + header, /import\s*\{[^}]*auth[^}]*\}\s*from '\.\/firebase'/);
  assert.match(auth, /CUSTOMER_APP_NAME = 'coffee-bond-customer-auth'/);
});
test('10. Customer profile mobile number is read only', () => {
  assert.match(header, /value=\{maskedPhone\(profile\.normalisedPhone\)\}[\s\S]{0,120}readOnly/);
  assert.match(header, /aria-readonly="true"/);
});
test('11. Customer can update their display name and default order type', () => {
  assert.match(auth, /updateCustomerProfile/);
  assert.match(header, /displayName: nextName/);
  assert.match(header, /defaultOrderType/);
});
test('12. Profile update rejects disallowed fields', async () => {
  await assert.rejects(() => paymentFirst.updateCustomerProfileHandler({
    request: {
      auth: {
        uid: 'customer-a',
        token: {
          phone_number: '+919999999999',
          firebase: { sign_in_provider: 'phone' },
        },
      },
      data: { displayName: 'Customer A', defaultOrderType: 'PICKUP', customerUid: 'customer-b' },
    },
    db: {},
    admin: {},
  }), /Only the customer name and default order type/);
});
test('13. My Orders waits for customer Auth restoration', () => {
  const restore = myOrders.indexOf('waitForCustomerAuthRestoration()');
  const subscribe = myOrders.indexOf('onAuthStateChanged(customerAuth');
  assert.ok(restore > 0 && subscribe > restore);
});
test('14. My Orders query is UID bound', () => {
  assert.match(backend, /where\('customerUid', '==', identity\.uid\)/);
});
test('15. Another UID cannot choose the query owner', () => {
  assert.doesNotMatch(myOrders, /customerUid\s*:/);
  assert.doesNotMatch(backend.match(/async function listMyOrders[\s\S]*?\n\}/)?.[0] || '', /request\.data.*customerUid/);
});
test('16. Empty My Orders state is clear', () => {
  assert.match(myOrders, /No orders yet/);
  assert.match(myOrders, /Your paid Coffee Bond orders will appear here/);
  assert.match(myOrders, /Order Now/);
});
test('17. Paid pending acceptance is human readable', () => {
  assert.match(myOrders, /Paid — awaiting store confirmation/);
});
test('18. Refund pending is human readable', () => {
  assert.match(myOrders, /Refund pending/);
});
test('19. Refunded status is human readable', () => {
  assert.match(myOrders, /Refunded/);
});
test('20. Current orders sort before completed orders', () => {
  assert.match(myOrders, /activeDifference = Number\(isCurrentOrder\(right\)\) - Number\(isCurrentOrder\(left\)\)/);
});
test('21. View Order uses the stable tracking route', () => {
  // Origin-correct status path, with the tracking token passed through unchanged.
  assert.match(myOrders, /to=\{customerStatusPath\(order\.trackingToken\)\}/);
});
test('22. Razorpay dismissal creates no online order', () => {
  const dismissal = order.match(/modal:\s*\{[\s\S]{0,260}?\}/)?.[0] || '';
  assert.doesNotMatch(dismissal, /onlineOrders|submitCustomerOrder|rememberCustomerOrder/);
});
test('23. Razorpay dismissal creates no payment record', () => {
  const dismissal = order.match(/modal:\s*\{[\s\S]{0,260}?\}/)?.[0] || '';
  assert.doesNotMatch(dismissal, /payments|paymentIntents|verifyCustomerRazorpayPayment/);
});
test('24. Razorpay dismissal creates no KOT', () => {
  assert.doesNotMatch(order.match(/modal:\s*\{[\s\S]{0,260}?\}/)?.[0] || '', /kotItems|KOT/);
});
test('25. Razorpay dismissal creates no stock movement', () => {
  assert.doesNotMatch(order.match(/modal:\s*\{[\s\S]{0,260}?\}/)?.[0] || '', /stockMovement|storeStock/);
});
test('26. Razorpay dismissal retains the cart', () => {
  const paymentPromise = order.slice(
    order.indexOf('const verifiedOrder = await new Promise'),
    order.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)'),
  );
  assert.doesNotMatch(paymentPromise, /setCart\(\[\]\)|clearCustomerCheckoutDraft/);
});
test('27. Razorpay dismissal retains customer verification', () => {
  const dismissal = order.match(/modal:\s*\{[\s\S]{0,260}?\}/)?.[0] || '';
  assert.doesNotMatch(dismissal, /setVerifiedCustomer|null|signOutCustomer/);
});
test('28. Razorpay dismissal displays the approved message', () => {
  assert.match(order, /Payment cancelled\. No order was placed\. Your cart has been saved\./);
  assert.match(order, /setPaymentNotice\(message\)/);
});
test('29. payment.failed retains cart and creates no order', () => {
  assert.match(order, /Payment was not completed\. No order was placed\. You can try again\./);
  const failed = order.match(/checkout\.on\('payment\.failed'[\s\S]{0,220}/)?.[0] || '';
  assert.doesNotMatch(failed, /setCart|onlineOrders|submitCustomerOrder/);
});
test('30. Retry Pay Online remains available after dismissal', () => {
  // Stage 4b moved the CTA label into the `checkoutAction` derivation. The contract is
  // unchanged: the online action still shows the authoritative grand total, and
  // dismissing a payment must not silently switch the customer's payment provider.
  assert.match(order, /Pay online[\s\S]{0,40}formatMoney\(totals\.grandTotal\)/);
  assert.doesNotMatch(order.match(/setPaymentNotice\(message\)[\s\S]{0,120}/)?.[0] || '', /setPaymentProvider/);
});
test('31. Checkout sessions do not appear in My Orders before payment', () => {
  assert.match(backend, /db\.collection\('onlineOrders'\)[\s\S]{0,120}where\('customerUid', '==', identity\.uid\)/);
  assert.doesNotMatch(backend.match(/async function listMyOrders[\s\S]*?\n\}/)?.[0] || '', /customerCheckoutSessions/);
});
test('32. Successful verified order saves tracking before clearing cart', () => {
  const remember = order.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)');
  const clearDraft = order.indexOf('clearCustomerCheckoutDraft(window.localStorage)', remember);
  const clearCart = order.indexOf('setCart([])', clearDraft);
  assert.ok(remember > 0 && clearDraft > remember && clearCart > clearDraft);
});
test('33. Current Order shortcut uses pending-order persistence', () => {
  assert.match(header, /lastCustomerOrderTrackingToken\(\)/);
  assert.match(header, /Current Order/);
  assert.match(persistence, /coffeeBondLastOrderTrackingToken/);
});
test('34. Shared customer header is present on all customer pages', () => {
  assert.match(order, /<CustomerHeader/);
  assert.match(status, /<CustomerHeader/);
  assert.match(myOrders, /<CustomerHeader/);
});
test('35. Customer navigation exposes no staff routes', () => {
  assert.doesNotMatch(header, /\/admin|\/pos|\/inventory|\/reports|\/franchise/);
});
test('36. Customer UI exposes no OTP token UID or provider signature', () => {
  assert.doesNotMatch(header + order + myOrders + status, /firebase uid|razorpay customer id|razorpay_signature|id token|otp value/i);
});
test('37. Profile update writes only to the authenticated customer document', async () => {
  const writes = [];
  const db = {
    collection: name => ({
      doc: id => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async (value, options) => writes.push({ name, id, value, options }),
      }),
    }),
  };
  const admin = {
    firestore: {
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
    },
  };
  const profile = await paymentFirst.updateCustomerProfileHandler({
    request: {
      auth: {
        uid: 'customer-a',
        token: {
          phone_number: '+919999999999',
          firebase: { sign_in_provider: 'phone' },
        },
      },
      data: { displayName: 'Customer A', defaultOrderType: 'DINE_IN' },
    },
    db,
    admin,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'customerProfiles');
  assert.equal(writes[0].id, 'customer-a');
  assert.equal(profile.customerUid, 'customer-a');
  assert.equal(profile.normalisedPhone, '+919999999999');
});
test('38. Profile callable is exported without a Firestore client-write path', () => {
  assert.match(functionsIndex, /exports\.updateCustomerProfile = razorpayCheckoutFunctions\.updateCustomerProfile/);
  assert.doesNotMatch(header + auth, /setDoc|updateDoc|customerProfiles/);
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

assert.equal(tests.length, 38);
console.log(`Customer account, My Orders and payment-cancellation tests passed: ${passed}/${tests.length}. No Firebase or Razorpay network calls were performed.`);
