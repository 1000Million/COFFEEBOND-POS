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
/* Each customer screen is a data container plus a presentational screen component.
   These constants join the pair so every assertion below keeps testing the SCREEN,
   not whichever of its two files a given line happens to live in. */
const myOrders = source('frontend/pages/customer/CustomerMyOrders.tsx')
  + source('frontend/components/customer/CustomerOrdersScreen.tsx');
const status = source('frontend/pages/customer/CustomerOrderStatus.tsx')
  + source('frontend/components/customer/CustomerTrackingScreen.tsx');
const persistence = source('frontend/lib/customerOrderPersistence.ts');
const accountSheet = source('frontend/components/customer/CustomerAccountSheet.tsx');
// The sheet's doc comment names the rows Stage 5 removed, so absence must be measured
// against executable code only.
const accountSheetCode = accountSheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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
test('2. Before OTP Orders asks the customer to verify', () => {
  assert.match(myOrders, /Verify your mobile number to see your orders/);
  // Stage 5: the CTA is the shared Browse menu action, routed through the existing
  // home path rather than a second "verify" destination.
  assert.match(myOrders, /Browse menu/);
  assert.match(myOrders, /CUSTOMER_HOME_PATH/);
});
test('3. Verified customer sees a profile account control', () => {
  assert.match(header, /aria-label=\{`Open customer account/);
  assert.match(header, /profile\?\.displayName/);
  assert.match(header, /const initials =/);
  assert.match(header, /aria-haspopup="dialog"/);
});
test('4. Verified customer sees a masked phone', () => {
  // The compact reference header shows initials only. The account sheet remains the
  // single place that renders the masked identity; the header never exposes the phone.
  assert.doesNotMatch(header, /maskedPhone|normalisedPhone/);
  assert.match(accountSheet, /export function maskedPhone/);
  assert.match(accountSheet, /••••••/);
  assert.match(accountSheet, /maskedPhone\(profile\.normalisedPhone\)/);
  assert.doesNotMatch(header, /normalisedPhone\.slice|replace\(\/\\D\/g/);
});
test('5. Customer name appears when a profile exists', () => {
  assert.match(accountSheet, /\{profile\.displayName \|\| 'My account'\}/);
});
// Stage 5 inverted this contract. Account is an account surface, not a second copy of
// the navigation: Orders is a permanent tab that surfaces the live order itself, so
// neither "My Orders" nor "Current Order" may appear here.
test('6. Account does NOT duplicate the Orders tab', () => {
  assert.doesNotMatch(accountSheetCode, /My Orders|Current Order/);
  assert.doesNotMatch(accountSheetCode, /CUSTOMER_MY_ORDERS_PATH|customerStatusPath/);
  assert.doesNotMatch(header, /<ClipboardList[\s\S]{0,40}My Orders/);
  // What it does own instead.
  assert.match(accountSheet, /My Usual/);
  assert.match(accountSheet, /Profile/);
});
test('7. Account contains Sign out', () => {
  // Sign out is now a flat row rather than a filled block, so the icon and the label
  // are separate elements inside one control.
  assert.match(accountSheet, /<LogOut size=\{20\}[\s\S]{0,160}>Sign out<\/span>/);
});
test('8. Sign out targets only customer Auth', () => {
  assert.match(auth, /signOut\(customerAuth\)/);
  assert.match(accountSheet, /await signOutCustomer\(\)/);
});
test('9. Staff Auth is not imported into customer account code', () => {
  assert.doesNotMatch(auth + header, /import\s*\{[^}]*auth[^}]*\}\s*from '\.\/firebase'/);
  assert.match(auth, /CUSTOMER_APP_NAME = 'coffee-bond-customer-auth'/);
});
test('10. Customer profile mobile number is read only', () => {
  assert.match(accountSheet, /value=\{maskedPhone\(profile\.normalisedPhone\)\}[\s\S]{0,120}readOnly/);
  assert.match(accountSheet, /aria-readonly="true"/);
});
test('11. Customer can update their display name and default order type', () => {
  assert.match(auth, /updateCustomerProfile/);
  assert.match(accountSheet, /displayName: nextName/);
  assert.match(accountSheet, /defaultOrderType/);
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
test('16. Empty Orders state is clear', () => {
  // Stage 5 wording, still one plain-language empty state with one way onward.
  assert.match(myOrders, /No orders yet\./);
  assert.match(myOrders, /Your next Coffee Bond is waiting\./);
  assert.match(myOrders, /Browse menu/);
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
test('20. The live order is separated out and shown above history', () => {
  // Stage 5 replaced the single sorted list with an explicit split: one active order
  // above, everything else below. The decision still uses the canonical status helper.
  assert.match(myOrders, /const activeOrder = useMemo\(/);
  assert.match(myOrders, /\.filter\(isCurrentOrder\)/);
  assert.match(myOrders, /order\.trackingToken !== activeOrder\?\.trackingToken/);
  assert.match(myOrders, /Earlier/);
});
test('21. Order links use the stable tracking route helper', () => {
  // Stage 5 moved the link into CustomerOrderCard, and the active order into
  // CustomerActiveOrderCard. Both still resolve through the same route helper — no
  // customer screen hardcodes a status path.
  assert.match(myOrders, /viewPath: customerStatusPath\(order\.trackingToken\)/);
  assert.match(myOrders, /trackPath: customerStatusPath\(activeOrder\.trackingToken\)/);
  assert.doesNotMatch(myOrders, /to="\/(order\/)?status\//);
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
// Stage 5: the account panel no longer carries a Current Order shortcut — Orders shows
// the live order at the top of the page. The persistence module it used is untouched
// and still records the last order, which is what the tracking screen relies on.
test('33. Current Order shortcut is gone from the account surface', () => {
  assert.doesNotMatch(accountSheetCode, /lastCustomerOrderTrackingToken/);
  assert.doesNotMatch(accountSheetCode, /Current Order/);
  assert.match(persistence, /coffeeBondLastOrderTrackingToken/);
  // Orders decides the live order from the authenticated history, not from a device token.
  assert.match(myOrders, /isCurrentOrder/);
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
