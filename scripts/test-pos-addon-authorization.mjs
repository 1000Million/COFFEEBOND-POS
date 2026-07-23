import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function loadWithFirebaseFunctionsStub(request, parent, isMain) {
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall: (_options, handler) => handler,
      HttpsError: class HttpsError extends Error {
        constructor(code, message) {
          super(message);
          this.code = code;
        }
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  AUTHORIZATION_TTL_MS,
  PROVIDER,
  canonicalizeRequestedCart,
  isExcludedBeverageCategory,
  isRetailCoffee,
  sanitizeCartItems,
} = require('../functions/posAddOnAuthorization.js');
Module._load = originalLoad;

const STORE_ID = 'UDAY_PARK';
const PRODUCT_ID = 'HOT_LATTE';
const baseStore = { id: STORE_ID, code: 'UDAY_PARK', isActive: true, gstRate: 5 };
const baseProduct = {
  id: PRODUCT_ID,
  code: PRODUCT_ID,
  name: 'Hot Latte',
  salePrice: 225,
  taxRate: 5,
  posCategoryName: 'Coffee',
  isActive: true,
  isSellable: true,
  isAvailable: true,
  availableStoreIds: [STORE_ID],
  addOnGroupIds: ['beverage_add_on'],
};
const baseGroup = {
  id: 'beverage_add_on',
  name: 'Beverage Add On',
  isActive: true,
  minimumSelections: 0,
  maximumSelections: null,
  options: [
    {
      id: 'OAT_MILK',
      code: 'OAT_MILK',
      name: 'Oat Milk',
      price: 50,
      taxRate: 5,
      isActive: true,
      inventoryItemType: 'RAW_INGREDIENT',
      inventoryItemCode: 'OAT_MILK',
      consumptionQuantity: 150,
      consumptionUnit: 'ML',
    },
    {
      id: 'INACTIVE',
      code: 'INACTIVE',
      name: 'Inactive option',
      price: 1,
      isActive: false,
    },
    {
      id: 'NO_INVENTORY_MAPPING',
      code: 'NO_INVENTORY_MAPPING',
      name: 'Pricing-only add-on',
      price: 25,
      taxRate: 5,
      isActive: true,
    },
  ],
};

function requestedItem(overrides = {}) {
  return {
    orderItemId: 'line-1',
    parentProductId: PRODUCT_ID,
    parentProductCode: PRODUCT_ID,
    quantity: 1,
    selectedAddOns: [{ groupId: 'beverage_add_on', optionId: 'OAT_MILK', quantity: 1 }],
    ...overrides,
  };
}

function canonicalize({
  item = requestedItem(),
  product = baseProduct,
  group = baseGroup,
  storeId = STORE_ID,
} = {}) {
  return canonicalizeRequestedCart({
    storeId,
    store: baseStore,
    gstConfig: { defaultGstRate: 5 },
    requestedItems: [item],
    productsById: { [product.id]: product },
    groupsById: { [group.id]: group },
  });
}

function expectFailure(run, text) {
  assert.throws(run, error => (
    error
    && typeof error.message === 'string'
    && error.message.toLowerCase().includes(text.toLowerCase())
  ));
}

const sanitized = sanitizeCartItems([{
  ...requestedItem(),
  selectedAddOns: [{
    groupId: 'beverage_add_on',
    optionId: 'OAT_MILK',
    quantity: 1,
    unitPrice: 0.01,
    optionName: 'Tampered',
    taxRate: 0,
  }],
}]);
const canonical = canonicalize({ item: sanitized[0] });
const canonicalLine = canonical.canonicalItems['line-1'];
assert.equal(canonicalLine.addOns[0].optionName, 'Oat Milk');
assert.equal(canonicalLine.addOns[0].unitPrice, 50);
assert.equal(canonicalLine.addOns[0].totalPrice, 50);
assert.equal(canonicalLine.addOns[0].taxRate, 5);
assert.equal(canonicalLine.addOns[0].inventoryTrackingStatus, 'CONFIGURED');
assert.equal(canonicalLine.addOns[0].inventoryItemCode, 'OAT_MILK');
assert.equal(canonicalLine.baseUnitPrice, 225);
assert.equal(canonical.canonicalAddOnTotal, 50);

expectFailure(
  () => canonicalize({ item: requestedItem({ selectedAddOns: [{ groupId: 'beverage_add_on', optionId: 'INACTIVE', quantity: 1 }] }) }),
  'inactive or unavailable',
);
expectFailure(
  () => canonicalize({ item: requestedItem({ selectedAddOns: [{ groupId: 'food_add_on', optionId: 'HONEY', quantity: 1 }] }) }),
  'do not belong',
);
expectFailure(
  () => canonicalize({
    product: { ...baseProduct, posCategoryName: 'Espesso bar' },
  }),
  'not available',
);
expectFailure(
  () => canonicalize({
    product: { ...baseProduct, code: 'HOUSE_BLEND_BEANS_250G' },
    item: requestedItem({ parentProductCode: 'HOUSE_BLEND_BEANS_250G' }),
  }),
  'not available',
);
expectFailure(
  () => canonicalize({ storeId: 'NOIDA_29' }),
  'no longer available',
);
expectFailure(
  () => canonicalize({ group: { ...baseGroup, isActive: false } }),
  'inactive',
);
expectFailure(
  () => canonicalize({ group: { ...baseGroup, minimumSelections: 2 } }),
  'invalid',
);
expectFailure(
  () => sanitizeCartItems([requestedItem({ quantity: 0 })]),
  'cart items',
);
expectFailure(
  () => sanitizeCartItems([requestedItem(), requestedItem()]),
  'cart items',
);

const noSelection = canonicalize({
  item: requestedItem({ selectedAddOns: [] }),
});
assert.deepEqual(noSelection.canonicalItems['line-1'].addOns, []);
assert.equal(noSelection.canonicalAddOnTotal, 0);
const pricingOnly = canonicalize({
  item: requestedItem({
    selectedAddOns: [{
      groupId: 'beverage_add_on',
      optionId: 'NO_INVENTORY_MAPPING',
      quantity: 1,
    }],
  }),
});
assert.equal(pricingOnly.canonicalItems['line-1'].addOns[0].inventoryTrackingStatus, 'NOT_CONFIGURED');
assert.equal(pricingOnly.canonicalItems['line-1'].addOns[0].unitPrice, 25);
assert.equal(pricingOnly.canonicalAddOnTotal, 25);
assert.equal(isExcludedBeverageCategory({ posCategoryName: 'Specality drinks' }), true);
assert.equal(isExcludedBeverageCategory({ posCategoryName: 'Manual Brews' }), true);
assert.equal(isRetailCoffee({ code: 'HOUSE_BLEND_BEANS_250G' }), true);
assert.equal(PROVIDER, 'SERVER_CANONICAL_ADD_ONS');
assert.equal(AUTHORIZATION_TTL_MS, 5 * 60 * 1000);

console.log('POS add-on authorization tests passed:');
console.log('- browser-supplied names, prices, tax, and inventory mappings are ignored');
console.log('- inactive options/groups and invalid selection counts are rejected');
console.log('- product/group, store, excluded category, and Retail Coffee mismatches are rejected');
console.log('- canonical add-on totals and inventory snapshots come from server-side group data');
console.log('- pricing-only options retain NOT_CONFIGURED and require no assumed inventory mapping');
