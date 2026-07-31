import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  DRAFT_SETUP_TEST_STORE_ID,
  PROVIDER,
  canonicalizeRequestedCart,
  createPosAddOnAuthorizationFunction,
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
  addOnOptionIdsByGroup: {
    beverage_add_on: ['OAT_MILK', 'INACTIVE', 'NO_INVENTORY_MAPPING'],
  },
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
const foodGroup = {
  id: 'food_add_on',
  name: 'Food Add On',
  isActive: true,
  minimumSelections: 0,
  maximumSelections: null,
  options: [
    {
      id: 'HONEY',
      code: 'HONEY',
      name: 'Honey',
      price: 50,
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

const cappuccino = canonicalize({
  product: {
    ...baseProduct,
    id: 'CAPPUCCINO',
    code: 'CAPPUCCINO',
    name: 'Cappuccino',
    posCategoryName: 'Espresso Bar',
  },
  item: requestedItem({
    parentProductId: 'CAPPUCCINO',
    parentProductCode: 'CAPPUCCINO',
  }),
});
assert.equal(cappuccino.canonicalItems['line-1'].addOns[0].optionId, 'OAT_MILK');

const anotherMappedBeverage = canonicalize({
  product: { ...baseProduct, posCategoryName: 'Hot Coffee' },
});
assert.equal(anotherMappedBeverage.canonicalItems['line-1'].addOns.length, 1);

const bondPizza = canonicalize({
  product: {
    ...baseProduct,
    id: 'BOND_PIZZA',
    code: 'BOND_PIZZA',
    name: 'Bond Pizza',
    posCategoryName: 'Pizza',
    addOnGroupIds: ['food_add_on'],
    addOnOptionIdsByGroup: { food_add_on: ['HONEY'] },
  },
  item: requestedItem({
    parentProductId: 'BOND_PIZZA',
    parentProductCode: 'BOND_PIZZA',
    selectedAddOns: [{ groupId: 'food_add_on', optionId: 'HONEY', quantity: 1 }],
  }),
  group: foodGroup,
});
assert.equal(bondPizza.canonicalItems['line-1'].addOns[0].optionId, 'HONEY');

expectFailure(
  () => canonicalize({
    product: { ...baseProduct, addOnGroupIds: [] },
  }),
  'do not belong',
);
expectFailure(
  () => canonicalize({
    product: {
      ...baseProduct,
      code: 'HOUSE_BLEND_BEANS_250G',
      addOnGroupIds: ['beverage_add_on'],
    },
    item: requestedItem({ parentProductCode: 'HOUSE_BLEND_BEANS_250G' }),
  }),
  'not available',
);
for (const deferredProductCode of [
  'MUSHROOM_MELT',
  'BUTTER_COOKIE',
  'COOKIEE',
  'AMERICANO',
  'PANEER_SANDWICH',
  'BUTTER_CROISSANT',
  'V_C_BURST',
  'ORANGE_ESPRESSO_TONIC',
  'DOUBLE_CHOCOLATE_COOKIE',
  'ALMOND_CROISSANT',
]) {
  expectFailure(
    () => canonicalize({
      product: {
        ...baseProduct,
        code: deferredProductCode,
        addOnGroupIds: ['beverage_add_on'],
      },
      item: requestedItem({ parentProductCode: deferredProductCode }),
    }),
    'not available',
  );
}
expectFailure(
  () => canonicalize({
    product: {
      ...baseProduct,
      code: 'ALMONDS',
      addOnGroupIds: ['beverage_add_on'],
    },
    item: requestedItem({ parentProductCode: 'ALMONDS' }),
  }),
  'not available',
);
expectFailure(
  () => canonicalize({
    product: {
      ...baseProduct,
      addOnOptionIdsByGroup: { beverage_add_on: ['OAT_MILK'] },
    },
    item: requestedItem({
      selectedAddOns: [{
        groupId: 'beverage_add_on',
        optionId: 'NO_INVENTORY_MAPPING',
        quantity: 1,
      }],
    }),
  }),
  'not enabled',
);
expectFailure(
  () => canonicalize({
    product: {
      ...baseProduct,
      addOnOptionIdsByGroup: { beverage_add_on: [] },
    },
  }),
  'not enabled',
);
expectFailure(
  () => canonicalize({
    product: {
      ...baseProduct,
      addOnGroupIds: ['food_add_on'],
      addOnOptionIdsByGroup: { food_add_on: ['HONEY'] },
    },
    item: requestedItem({
      selectedAddOns: [{ groupId: 'beverage_add_on', optionId: 'OAT_MILK', quantity: 1 }],
    }),
  }),
  'do not belong',
);
expectFailure(
  () => canonicalize({
    product: {
      ...baseProduct,
      posCategoryName: 'Pizza',
      addOnGroupIds: ['food_add_on'],
      addOnOptionIdsByGroup: { food_add_on: ['HONEY'] },
    },
    item: requestedItem({
      selectedAddOns: [{ groupId: 'beverage_add_on', optionId: 'OAT_MILK', quantity: 1 }],
    }),
  }),
  'do not belong',
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

const posSource = fs.readFileSync('frontend/pages/pos/POSHome.tsx', 'utf8');
assert.match(posSource, /checkoutMode: isSetupTestSale \? 'SETUP_TEST' : 'STANDARD_POS'/);
assert.match(posSource, /checkoutSource: 'POS'/);
assert.match(posSource, /paymentMethod: isSplitPayment \? 'SPLIT' : selectedPaymentMethod/);

const CALLABLE_USER_ID = 'test-admin';
const CALLABLE_NOW_MS = Date.parse('2026-08-01T00:00:00.000Z');

function fakeTimestamp(milliseconds) {
  return {
    toMillis: () => milliseconds,
    toDate: () => new Date(milliseconds),
  };
}

function createCallableFixture({
  storeId = STORE_ID,
  store = baseStore,
  staff = { isActive: true, role: 'ADMIN', displayName: 'Test Admin' },
  product = baseProduct,
  group = baseGroup,
} = {}) {
  const writes = [];
  const documents = new Map([
    [`users/${CALLABLE_USER_ID}`, staff],
    [`stores/${storeId}`, store],
    ['appSettings/gstConfig', { defaultGstRate: 5 }],
    [`finishedGoods/${product.id}`, { ...product, availableStoreIds: [storeId] }],
    [`addOnGroups/${group.id}`, group],
  ]);
  let generatedDocumentCount = 0;
  const db = {
    collection(collectionName) {
      return {
        doc(requestedId) {
          const documentId = requestedId || `generated-${++generatedDocumentCount}`;
          const path = `${collectionName}/${documentId}`;
          return {
            id: documentId,
            async get() {
              const data = documents.get(path);
              return {
                id: documentId,
                exists: data !== undefined,
                data: () => data,
              };
            },
            async create(data) {
              writes.push({ path, data });
            },
          };
        },
      };
    },
  };
  const admin = {
    firestore: {
      Timestamp: {
        now: () => fakeTimestamp(CALLABLE_NOW_MS),
        fromMillis: milliseconds => fakeTimestamp(milliseconds),
      },
    },
  };
  return {
    handler: createPosAddOnAuthorizationFunction({ admin, db, region: 'us-central1' }),
    writes,
  };
}

function callableRequest({
  storeId = STORE_ID,
  checkoutMode,
  checkoutSource,
  paymentMethod,
  selectedAddOns = requestedItem().selectedAddOns,
} = {}) {
  return {
    auth: { uid: CALLABLE_USER_ID, token: { name: 'Test Admin' } },
    data: {
      storeId,
      orderId: 'order-1',
      orderNumber: null,
      ...(checkoutMode ? { checkoutMode } : {}),
      ...(checkoutSource ? { checkoutSource } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      items: [{ ...requestedItem(), selectedAddOns }],
    },
  };
}

async function expectCallableFailure({ fixtureOptions, requestOptions, code = 'failed-precondition' }) {
  const fixture = createCallableFixture(fixtureOptions);
  await assert.rejects(
    () => fixture.handler(callableRequest(requestOptions)),
    error => error?.code === code,
  );
  assert.equal(fixture.writes.length, 0, 'Rejected authorization must perform zero Firestore writes.');
}

const activeStoreFixture = createCallableFixture();
await activeStoreFixture.handler(callableRequest());
assert.equal(activeStoreFixture.writes.length, 1, 'Active-store authorization behavior must remain unchanged.');

await expectCallableFailure({
  fixtureOptions: { store: { ...baseStore, isActive: false } },
});

const bakedDraftStore = {
  id: DRAFT_SETUP_TEST_STORE_ID,
  code: DRAFT_SETUP_TEST_STORE_ID,
  status: 'DRAFT',
  isActive: false,
  internalPosTestEnabled: true,
  setupTestMode: true,
  posEnabled: true,
  customerOrderingEnabled: false,
  onlineOrderingEnabled: false,
  publicOrderingEnabled: false,
  gstRate: 5,
};
const bakedRequest = {
  storeId: DRAFT_SETUP_TEST_STORE_ID,
  checkoutMode: 'SETUP_TEST',
  checkoutSource: 'POS',
  paymentMethod: 'CASH',
};

await expectCallableFailure({
  fixtureOptions: {
    storeId: DRAFT_SETUP_TEST_STORE_ID,
    store: { ...bakedDraftStore, setupTestMode: false },
  },
  requestOptions: bakedRequest,
});
for (const role of ['CASHIER', 'STORE_MANAGER']) {
  await expectCallableFailure({
    fixtureOptions: {
      storeId: DRAFT_SETUP_TEST_STORE_ID,
      store: bakedDraftStore,
      staff: {
        isActive: true,
        role,
        assignedStoreIds: [DRAFT_SETUP_TEST_STORE_ID],
        storeIds: [DRAFT_SETUP_TEST_STORE_ID],
      },
    },
    requestOptions: bakedRequest,
  });
}

const bakedAdminFixture = createCallableFixture({
  storeId: DRAFT_SETUP_TEST_STORE_ID,
  store: bakedDraftStore,
});
await bakedAdminFixture.handler(callableRequest({ ...bakedRequest, selectedAddOns: [] }));
assert.equal(bakedAdminFixture.writes.length, 1, 'Approved Admin setup-test authorization must be created once.');
assert.deepEqual(
  bakedAdminFixture.writes[0].data.canonicalItems['line-1'].addOns,
  [],
  'Zero-add-on setup checkout must remain supported.',
);

await expectCallableFailure({
  fixtureOptions: { storeId: DRAFT_SETUP_TEST_STORE_ID, store: bakedDraftStore },
  requestOptions: { ...bakedRequest, paymentMethod: 'UPI' },
});
await expectCallableFailure({
  fixtureOptions: { storeId: DRAFT_SETUP_TEST_STORE_ID, store: bakedDraftStore },
  requestOptions: { ...bakedRequest, checkoutSource: 'CUSTOMER_ORDER' },
});
await expectCallableFailure({
  fixtureOptions: { storeId: DRAFT_SETUP_TEST_STORE_ID, store: bakedDraftStore },
  requestOptions: { ...bakedRequest, checkoutMode: undefined },
});
await expectCallableFailure({
  fixtureOptions: { storeId: DRAFT_SETUP_TEST_STORE_ID, store: bakedDraftStore },
  requestOptions: { ...bakedRequest, paymentMethod: undefined },
});
for (const orderingFlag of [
  'customerOrderingEnabled',
  'onlineOrderingEnabled',
  'publicOrderingEnabled',
]) {
  await expectCallableFailure({
    fixtureOptions: {
      storeId: DRAFT_SETUP_TEST_STORE_ID,
      store: { ...bakedDraftStore, [orderingFlag]: true },
    },
    requestOptions: bakedRequest,
  });
}
await expectCallableFailure({
  fixtureOptions: {
    storeId: DRAFT_SETUP_TEST_STORE_ID,
    store: { ...bakedDraftStore, internalPosTestEnabled: false },
  },
  requestOptions: bakedRequest,
});
await expectCallableFailure({
  fixtureOptions: {
    storeId: DRAFT_SETUP_TEST_STORE_ID,
    store: { ...bakedDraftStore, posEnabled: false },
  },
  requestOptions: bakedRequest,
});
await expectCallableFailure({
  fixtureOptions: {
    storeId: 'ARBITRARY_DRAFT',
    store: { ...bakedDraftStore, id: 'ARBITRARY_DRAFT', code: 'ARBITRARY_DRAFT' },
  },
  requestOptions: { ...bakedRequest, storeId: 'ARBITRARY_DRAFT' },
});
await expectCallableFailure({
  fixtureOptions: {
    storeId: DRAFT_SETUP_TEST_STORE_ID,
    store: bakedDraftStore,
    group: { ...baseGroup, isActive: false },
  },
  requestOptions: bakedRequest,
});

console.log('POS add-on authorization tests passed:');
console.log('- browser-supplied names, prices, tax, and inventory mappings are ignored');
console.log('- inactive options/groups and invalid selection counts are rejected');
console.log('- product/group, store, excluded category, and Retail Coffee mismatches are rejected');
console.log('- canonical add-on totals and inventory snapshots come from server-side group data');
console.log('- product-specific option allowlists are required and enforced');
console.log('- pricing-only options retain NOT_CONFIGURED and require no assumed inventory mapping');
console.log('- the Baked Draft setup-test exception requires active Admin, authoritative setup flags, POS source, and Cash');
console.log('- inactive, cross-store, customer-path, non-Admin, and misconfigured Draft attempts write nothing');
console.log('- active-store and zero-add-on authorization behavior remains unchanged');
