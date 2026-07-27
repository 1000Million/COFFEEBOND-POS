import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CUSTOMER_CHECKOUT_DRAFT_KEY,
  CUSTOMER_CHECKOUT_DRAFT_MAX_AGE_MS,
  buildCustomerCheckoutDraft,
  checkoutCatalogMarker,
  clearCustomerCheckoutDraft,
  readCustomerCheckoutDraft,
  restoreCustomerCheckoutDraft,
  writeCustomerCheckoutDraft,
} from '../frontend/lib/customerCheckoutPersistence';

type TestItem = {
  id: string;
  code: string;
  price: number;
  available: boolean;
  allowedAddOns: string[];
};

type TestAddOn = {
  groupId: string;
  optionId: string;
  quantity: number;
};

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const NOW = Date.UTC(2026, 6, 26, 10, 0, 0);
const root = process.cwd();
const customerOrderSource = readFileSync(resolve(root, 'frontend/pages/customer/CustomerOrder.tsx'), 'utf8');
const customerAuthSource = readFileSync(resolve(root, 'frontend/lib/customerAuth.ts'), 'utf8');
const myOrdersSource = readFileSync(resolve(root, 'frontend/pages/customer/CustomerMyOrders.tsx'), 'utf8');

function input() {
  return {
    selectedStoreId: 'GOLDEN_I',
    paymentProvider: 'RAZORPAY' as const,
    orderType: 'DINE_IN' as const,
    customerName: 'Customer Test',
    notes: 'No sugar',
    lines: [{
      lineId: 'line-1',
      productId: 'latte-doc',
      productCode: 'LATTE',
      quantity: 2,
      addOns: [{ groupId: 'beverage_add_on', optionId: 'OAT_MILK', quantity: 1 }],
      catalogMarker: checkoutCatalogMarker(['LATTE', 235, 'OAT_MILK', 50]),
    }],
  };
}

function restore(draft: ReturnType<typeof buildCustomerCheckoutDraft>, items: TestItem[]) {
  return restoreCustomerCheckoutDraft<TestItem, TestAddOn>(draft, {
    items,
    itemId: item => item.id,
    itemCode: item => item.code,
    isItemAvailable: item => item.available,
    restoreAddOns: (item, saved) => {
      const valid = saved.filter(addOn => item.allowedAddOns.includes(addOn.optionId));
      return {
        addOns: valid,
        removedCount: saved.length - valid.length,
        lineValid: true,
      };
    },
    catalogMarker: (item, addOns) => checkoutCatalogMarker([
      item.code,
      item.price,
      ...addOns.map(addOn => [addOn.groupId, addOn.optionId, addOn.quantity]),
    ]),
  });
}

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

test('1. Cart with one item survives storage round trip', () => {
  const storage = new MemoryStorage();
  assert.equal(writeCustomerCheckoutDraft(storage, input(), NOW), true);
  const result = readCustomerCheckoutDraft(storage, NOW + 1000);
  assert.equal(result.status, 'VALID');
  assert.equal(result.draft?.lines.length, 1);
});

test('2. Cart quantity survives storage round trip', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  assert.equal(draft.lines[0].quantity, 2);
});

test('3. Product add-on references survive without prices', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  assert.deepEqual(draft.lines[0].addOns, [{
    groupId: 'beverage_add_on',
    optionId: 'OAT_MILK',
    quantity: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(draft.lines[0].addOns), /price|tax/i);
});

test('4. Selected store survives refresh', () => {
  assert.equal(buildCustomerCheckoutDraft(input(), NOW).selectedStoreId, 'GOLDEN_I');
});

test('5. Payment method survives refresh', () => {
  assert.equal(buildCustomerCheckoutDraft(input(), NOW).paymentProvider, 'RAZORPAY');
});

test('6. Pickup or Dine-in survives refresh', () => {
  assert.equal(buildCustomerCheckoutDraft(input(), NOW).orderType, 'DINE_IN');
});

test('7. Customer display name and notes survive refresh', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  assert.equal(draft.customerName, 'Customer Test');
  assert.equal(draft.notes, 'No sugar');
});

test('8. Initial empty state cannot save before hydration', () => {
  assert.match(customerOrderSource, /checkoutHydration !== 'RESTORED'/);
  assert.match(customerOrderSource, /cart\.length === 0/);
});

test('9. Restoration is guarded to run exactly once', () => {
  assert.match(customerOrderSource, /hydrationAppliedRef\.current/);
  assert.match(customerOrderSource, /hydrationAppliedRef\.current = true/);
});

test('10. Current menu item replaces all persisted commercial values', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  const currentItem = { id: 'latte-doc', code: 'LATTE', price: 250, available: true, allowedAddOns: ['OAT_MILK'] };
  const result = restore(draft, [currentItem]);
  assert.equal(result.lines[0].item.price, 250);
  assert.doesNotMatch(JSON.stringify(draft), /salePrice|unitPrice|taxRate|gst|total/i);
});

test('11. Unavailable product is removed with a warning', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  const result = restore(draft, [{
    id: 'latte-doc',
    code: 'LATTE',
    price: 235,
    available: false,
    allowedAddOns: ['OAT_MILK'],
  }]);
  assert.equal(result.lines.length, 0);
  assert.equal(result.notices[0].code, 'ITEM_REMOVED');
});

test('12. Invalid add-on is removed with a warning', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  const result = restore(draft, [{
    id: 'latte-doc',
    code: 'LATTE',
    price: 235,
    available: true,
    allowedAddOns: [],
  }]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].addOns.length, 0);
  assert.equal(result.notices[0].code, 'ADD_ON_REMOVED');
});

test('13. Corrupt localStorage is discarded without throwing', () => {
  const storage = new MemoryStorage();
  storage.setItem(CUSTOMER_CHECKOUT_DRAFT_KEY, '{bad-json');
  assert.deepEqual(readCustomerCheckoutDraft(storage, NOW), { draft: null, status: 'CORRUPT' });
  assert.equal(storage.getItem(CUSTOMER_CHECKOUT_DRAFT_KEY), null);
});

test('14. Expired draft is discarded', () => {
  const storage = new MemoryStorage();
  writeCustomerCheckoutDraft(storage, input(), NOW - CUSTOMER_CHECKOUT_DRAFT_MAX_AGE_MS - 1);
  assert.equal(readCustomerCheckoutDraft(storage, NOW).status, 'EXPIRED');
  assert.equal(storage.getItem(CUSTOMER_CHECKOUT_DRAFT_KEY), null);
});

test('15. Changed current catalogue marker creates a price notice', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  const result = restore(draft, [{
    id: 'latte-doc',
    code: 'LATTE',
    price: 250,
    available: true,
    allowedAddOns: ['OAT_MILK'],
  }]);
  assert.ok(result.notices.some(notice => notice.code === 'PRICE_CHANGED'));
});

test('16. Explicit clear removes only the checkout draft key', () => {
  const storage = new MemoryStorage();
  storage.setItem('unrelated', 'keep');
  writeCustomerCheckoutDraft(storage, input(), NOW);
  assert.equal(clearCustomerCheckoutDraft(storage), true);
  assert.equal(storage.getItem(CUSTOMER_CHECKOUT_DRAFT_KEY), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('17. OTP send and verification do not clear the draft', () => {
  const otpPanel = customerOrderSource.slice(
    customerOrderSource.indexOf('<CustomerOtpPanel'),
    customerOrderSource.indexOf('/>', customerOrderSource.indexOf('<CustomerOtpPanel')) + 2,
  );
  assert.doesNotMatch(otpPanel, /clearCustomerCheckoutDraft/);
});

test('18. Razorpay modal dismissal and payment failure retain the draft', () => {
  const checkoutFlow = customerOrderSource.slice(
    customerOrderSource.indexOf('const verifiedOrder = await new Promise'),
    customerOrderSource.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)'),
  );
  assert.doesNotMatch(checkoutFlow, /clearCustomerCheckoutDraft/);
  assert.match(checkoutFlow, /Payment cancelled\. No order was placed\. Your cart has been saved\./);
  assert.match(checkoutFlow, /Payment was not completed\. No order was placed\. You can try again\./);
});

test('19. Verification or network failure retains the draft', () => {
  const catchBlock = customerOrderSource.slice(
    customerOrderSource.indexOf('} catch (err) {', customerOrderSource.indexOf('const submitOrder')),
    customerOrderSource.indexOf('} finally {', customerOrderSource.indexOf('const submitOrder')),
  );
  assert.doesNotMatch(catchBlock, /clearCustomerCheckoutDraft/);
});

test('20. Successful verified Pay Online order saves tracking before clearing', () => {
  const remember = customerOrderSource.indexOf('rememberCustomerOrder(verifiedOrder.trackingToken)');
  const clear = customerOrderSource.indexOf('clearCustomerCheckoutDraft(window.localStorage)', remember);
  const navigate = customerOrderSource.indexOf('navigate(trackingPath)', clear);
  assert.ok(remember > 0 && clear > remember && navigate > clear);
});

test('21. Successful Pay-at-Counter order saves tracking before clearing', () => {
  const remember = customerOrderSource.indexOf('rememberCustomerOrder(submittedOrder.trackingToken)');
  const clear = customerOrderSource.indexOf('clearCustomerCheckoutDraft(window.localStorage)', remember);
  assert.ok(remember > 0 && clear > remember);
});

test('22. Customer Auth explicitly uses browserLocalPersistence', () => {
  assert.match(customerAuthSource, /setPersistence\(customerAuth, browserLocalPersistence\)/);
});

test('23. Customer Auth restoration is awaited', () => {
  assert.match(customerAuthSource, /await customerAuth\.authStateReady\(\)/);
  assert.match(customerOrderSource, /restoreCustomerProfile\(\)/);
  assert.match(myOrdersSource, /waitForCustomerAuthRestoration\(\)/);
});

test('24. Staff Auth remains isolated', () => {
  assert.match(customerAuthSource, /CUSTOMER_APP_NAME = 'coffee-bond-customer-auth'/);
  assert.doesNotMatch(customerAuthSource, /import\s*\{[^}]*auth[^}]*\}\s*from '\.\/firebase'/);
});

test('25. Sensitive verification and provider values are never persisted', () => {
  const storage = new MemoryStorage();
  writeCustomerCheckoutDraft(storage, {
    ...input(),
    verificationId: 'forbidden',
    otp: '123456',
    razorpaySignature: 'forbidden',
  } as ReturnType<typeof input>, NOW);
  const raw = storage.getItem(CUSTOMER_CHECKOUT_DRAFT_KEY) || '';
  assert.doesNotMatch(raw, /verificationId|"otp"|razorpaySignature|providerPayment|idToken|trackingToken|customerUid|confirmationResult/i);
});

test('26. My Orders waits for restored customer UID before loading', () => {
  const wait = myOrdersSource.indexOf('waitForCustomerAuthRestoration()');
  const subscribe = myOrdersSource.indexOf('onAuthStateChanged(customerAuth');
  const list = myOrdersSource.indexOf('listMyCustomerOrders()');
  assert.ok(wait > 0 && subscribe > wait && list > subscribe);
});

test('27. Local checkout draft contains no order access identity', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  assert.doesNotMatch(JSON.stringify(draft), /uid|trackingToken|onlineOrderId|idToken/i);
});

test('28. Repeated restoration is deterministic and does not duplicate lines', () => {
  const draft = buildCustomerCheckoutDraft(input(), NOW);
  const items = [{
    id: 'latte-doc',
    code: 'LATTE',
    price: 235,
    available: true,
    allowedAddOns: ['OAT_MILK'],
  }];
  const first = restore(draft, items);
  const second = restore(draft, items);
  assert.equal(first.lines.length, 1);
  assert.deepEqual(second.lines, first.lines);
});

let passed = 0;
for (const entry of tests) {
  entry.run();
  passed += 1;
  console.log(`PASS ${entry.name}`);
}

assert.equal(tests.length, 28);
console.log(`Customer checkout persistence tests passed: ${passed}/${tests.length}. No Firebase or Razorpay calls were performed.`);
