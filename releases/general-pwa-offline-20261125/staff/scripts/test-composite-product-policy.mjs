import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function loadWithFirebaseFunctionsStub(request, parent, isMain) {
  if (request === 'razorpay') {
    return class RazorpayStub {};
  }
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
  if (request === 'firebase-functions/params') {
    return {
      defineSecret: () => ({ value: () => '' }),
      defineString: () => ({ value: () => '' }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  allowsDeferredComponentBom,
  collectFrozenComponentFinishedGoodIds,
  collectRequiredComponentFinishedGoodIds,
  resolveCanonicalCompositeComponents,
  validateFrozenCanonicalCompositeComponents,
} = require('../functions/compositeProductPolicy.js');
const {
  assertImmutableSourceOnlineOrder,
  canonicalizeFrozenOrderCart,
  canonicalizeRequestedCart,
} = require('../functions/posAddOnAuthorization.js');
const { canonicalizeCustomerCheckout } = require('../functions/customerCheckoutCanonicalization.js');
const { storeItemConfigDocId } = require('../functions/storeItemConfigPolicy.js');
const {
  buildKotTasks,
  expandCompositeInventoryLines,
} = require('../functions/compositeFulfillment.js');
const {
  immutableCompositeComponentSnapshotsEqual,
} = require('../functions/razorpayCheckout.js');
const { planOnlineOrderInventory } = require('../functions/onlineOrderInventory.js');
Module._load = originalLoad;

const STORE_ID = 'TASTING_ROOM_29';

function child(id, prepStation = 'KITCHEN', overrides = {}) {
  return {
    id,
    code: id,
    name: id.replaceAll('_', ' '),
    isActive: true,
    isAvailable: true,
    isSellable: false,
    availableStoreIds: [STORE_ID],
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    prepStation,
    bomVersion: 3,
    bom: [{
      componentType: 'RAW_INGREDIENT',
      componentCode: `${id}_RAW`,
      componentName: `${id} raw`,
      quantity: 1,
      uom: 'PCS',
      costPerUnit: 12,
      lineCost: 12,
    }],
    ...overrides,
  };
}

const children = Object.fromEntries([
  child('TR_ESPRESSO_BUN'),
  child('TR_CHARRED_HALLOUMI'),
  child('TR_TOMATO_MOZZARELLA_PIZZA'),
  child('TR_COLD_BREW', 'BARISTA'),
  child('TR_TONIC', 'BARISTA'),
  child('TR_LEMONADE', 'BARISTA'),
  child('TR_CASCARA', 'BARISTA'),
  child('TR_COMPONENT_MINI_ESPRESSO', 'BARISTA'),
  child('TR_COMPONENT_MINI_CORTADO', 'BARISTA'),
  child('TR_COMPONENT_COLD_BREW_MANUAL_BREW', 'BARISTA'),
].map(product => [product.id, product]));

const setChoice = {
  id: 'TR_SET_A_MAIN',
  name: 'Choose halloumi or one small pizza',
  purpose: 'COMPOSITE_CHOICE',
  isActive: true,
  isRequired: true,
  selectionMode: 'SINGLE',
  minimumSelections: 1,
  maximumSelections: 1,
  options: [
    {
      id: 'HALLOUMI', code: 'HALLOUMI', name: 'Charred Halloumi', price: 0,
      isActive: true, sortOrder: 1,
      finishedGoodComponent: {
        finishedGoodId: 'TR_CHARRED_HALLOUMI',
        finishedGoodCode: 'TR_CHARRED_HALLOUMI',
        quantity: 1,
      },
    },
    {
      id: 'PIZZA', code: 'PIZZA', name: 'Tomato, Mozzarella', price: 0,
      isActive: true, sortOrder: 2,
      finishedGoodComponent: {
        finishedGoodId: 'TR_TOMATO_MOZZARELLA_PIZZA',
        finishedGoodCode: 'TR_TOMATO_MOZZARELLA_PIZZA',
        quantity: 1,
      },
    },
  ],
};

const flightChoice = {
  id: 'TR_COLD_FLIGHT',
  name: 'Choose any 3',
  purpose: 'COMPOSITE_CHOICE',
  isActive: true,
  isRequired: true,
  selectionMode: 'EXACT_DISTINCT',
  minimumSelections: 3,
  maximumSelections: 3,
  options: [
    ['COLD_BREW', 'TR_COLD_BREW'],
    ['TONIC', 'TR_TONIC'],
    ['LEMONADE', 'TR_LEMONADE'],
    ['CASCARA', 'TR_CASCARA'],
  ].map(([id, finishedGoodId], index) => ({
    id,
    code: id,
    name: id.replaceAll('_', ' '),
    price: 0,
    isActive: true,
    sortOrder: index + 1,
    finishedGoodComponent: { finishedGoodId, finishedGoodCode: finishedGoodId, quantity: 1 },
  })),
};

function parent(id, group, staticComponents = []) {
  return {
    id,
    code: id,
    name: id,
    isActive: true,
    isAvailable: true,
    isSellable: true,
    availableStoreIds: [STORE_ID],
    salePrice: 2795,
    taxRate: 5,
    addOnGroupIds: [group.id],
    addOnOptionIdsByGroup: { [group.id]: group.options.map(option => option.id) },
    composite: {
      schemaVersion: 1,
      staticComponents,
      choiceGroupIds: [group.id],
    },
  };
}

const setParent = parent('TR_SET_A', setChoice, [{
  finishedGoodId: 'TR_ESPRESSO_BUN',
  finishedGoodCode: 'TR_ESPRESSO_BUN',
  quantity: 1,
}]);
const flightParent = parent('TR_COLD_BOND_FLIGHT', flightChoice);
const coffeeThreeWaysComponentCodes = [
  'TR_COMPONENT_MINI_ESPRESSO',
  'TR_COMPONENT_MINI_CORTADO',
  'TR_COMPONENT_COLD_BREW_MANUAL_BREW',
];
const coffeeThreeWaysParent = {
  ...flightParent,
  id: 'TR_COFFEE_THREE_WAYS',
  code: 'TR_COFFEE_THREE_WAYS',
  name: 'Coffee Three Ways',
  addOnGroupIds: [],
  addOnOptionIdsByGroup: {},
  composite: {
    schemaVersion: 1,
    staticComponents: coffeeThreeWaysComponentCodes.map(finishedGoodId => ({
      finishedGoodId,
      finishedGoodCode: finishedGoodId,
      quantity: 1,
    })),
    choiceGroupIds: [],
  },
};

const requiredIds = collectRequiredComponentFinishedGoodIds({
  products: [setParent, flightParent],
  groupsById: { [setChoice.id]: setChoice, [flightChoice.id]: flightChoice },
});
assert.deepEqual(requiredIds, [
  'TR_ESPRESSO_BUN',
  'TR_CHARRED_HALLOUMI',
  'TR_TOMATO_MOZZARELLA_PIZZA',
  'TR_COLD_BREW',
  'TR_TONIC',
  'TR_LEMONADE',
  'TR_CASCARA',
]);
assert.throws(() => collectRequiredComponentFinishedGoodIds({
  products: [{
    ...setParent,
    unresolvedCompositeRequirements: [{
      name: 'Two miniature drinks',
      quantity: 2,
      reason: 'Owner confirmation required.',
    }],
  }],
  groupsById: { [setChoice.id]: setChoice },
}), /unresolved component requirements/i);
assert.throws(() => collectRequiredComponentFinishedGoodIds({
  products: [{
    ...setParent,
    addOnGroupIds: [setChoice.id, 'EXTRA_SAUCE'],
    addOnOptionIdsByGroup: {
      ...setParent.addOnOptionIdsByGroup,
      EXTRA_SAUCE: ['SAUCE'],
    },
  }],
  groupsById: {
    [setChoice.id]: setChoice,
    EXTRA_SAUCE: {
      id: 'EXTRA_SAUCE',
      name: 'Extra sauce',
      purpose: 'ADD_ON',
      selectionMode: 'MULTIPLE',
      minimumSelections: 0,
      maximumSelections: 2,
      isActive: true,
      options: [{ id: 'SAUCE', name: 'Sauce', price: 20, isActive: true }],
    },
  },
}), /cannot mix component choices with ordinary add-ons/i);

const setComponents = resolveCanonicalCompositeComponents({
  parentProduct: setParent,
  requestedSelections: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
  groupsById: { [setChoice.id]: setChoice },
  componentProductsById: children,
  storeId: STORE_ID,
});
assert.deepEqual(setComponents.map(component => [
  component.sequence,
  component.source,
  component.componentFinishedGoodCode,
  component.quantity,
  component.prepStation,
]), [
  [1, 'STATIC', 'TR_ESPRESSO_BUN', 1, 'KITCHEN'],
  [2, 'CHOICE', 'TR_TOMATO_MOZZARELLA_PIZZA', 1, 'KITCHEN'],
]);
assert.equal(setComponents[1].groupId, setChoice.id);
assert.equal(setComponents[1].optionId, 'PIZZA');
assert.equal(setComponents[0].bom[0].quantity, 1);
assert.equal('costPerUnit' in setComponents[0].bom[0], false);
assert.equal('lineCost' in setComponents[0].bom[0], false);
children.TR_ESPRESSO_BUN.bom[0].quantity = 99;
assert.equal(setComponents[0].bom[0].quantity, 1, 'the ordered component keeps an independent BOM snapshot');
children.TR_ESPRESSO_BUN.bom[0].quantity = 1;

assert.equal(
  immutableCompositeComponentSnapshotsEqual(setComponents, structuredClone(setComponents)),
  true,
  'an unchanged canonical component snapshot is accepted',
);
const remappedSetChoice = structuredClone(setChoice);
remappedSetChoice.options.find(option => option.id === 'PIZZA').finishedGoodComponent = {
  finishedGoodId: 'TR_CHARRED_HALLOUMI',
  finishedGoodCode: 'TR_CHARRED_HALLOUMI',
  quantity: 1,
};
const zeroPriceMappingDrift = resolveCanonicalCompositeComponents({
  parentProduct: setParent,
  requestedSelections: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
  groupsById: { [setChoice.id]: remappedSetChoice },
  componentProductsById: children,
  storeId: STORE_ID,
});
assert.equal(
  immutableCompositeComponentSnapshotsEqual(setComponents, zeroPriceMappingDrift),
  false,
  'a zero-price choice remapped to another Finished Good cannot pass acceptance',
);
const bomDrift = structuredClone(setComponents);
bomDrift[0].bom[0].quantity = 2;
assert.equal(
  immutableCompositeComponentSnapshotsEqual(setComponents, bomDrift),
  false,
  'a changed nested BOM cannot replace the paid checkout snapshot',
);
assert.equal(
  immutableCompositeComponentSnapshotsEqual(undefined, []),
  false,
  'missing and malformed empty component snapshots are not interchangeable',
);
assert.equal(immutableCompositeComponentSnapshotsEqual(undefined, undefined), true);

const sourceOrderSnapshot = components => ({
  exists: true,
  data: () => ({
    storeId: STORE_ID,
    source: 'CUSTOMER_WEB',
    paymentProvider: 'PAY_AT_COUNTER',
    status: 'PENDING',
    items: [{
      finishedGoodCode: setParent.code,
      quantity: 1,
      addOns: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
      components,
    }],
  }),
});
const sourceRequestedItems = [{
  orderItemId: 'LINE_1',
  parentProductId: setParent.id,
  parentProductCode: setParent.code,
  quantity: 1,
  selectedAddOns: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
}];
assert.doesNotThrow(() => assertImmutableSourceOnlineOrder({
  sourceOnlineOrderSnapshot: sourceOrderSnapshot(setComponents),
  storeId: STORE_ID,
  requestedItems: sourceRequestedItems,
  canonicalItems: { LINE_1: { components: setComponents } },
}));
assert.throws(() => assertImmutableSourceOnlineOrder({
  sourceOnlineOrderSnapshot: sourceOrderSnapshot(setComponents),
  storeId: STORE_ID,
  requestedItems: sourceRequestedItems,
  canonicalItems: { LINE_1: { components: zeroPriceMappingDrift } },
}), /component snapshot no longer matches/i);

assert.throws(() => resolveCanonicalCompositeComponents({
  parentProduct: setParent,
  requestedSelections: [],
  groupsById: { [setChoice.id]: setChoice },
  componentProductsById: children,
  storeId: STORE_ID,
}), /selected components/i);

assert.throws(() => resolveCanonicalCompositeComponents({
  parentProduct: setParent,
  requestedSelections: [
    { groupId: setChoice.id, optionId: 'HALLOUMI', quantity: 1 },
    { groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 },
  ],
  groupsById: { [setChoice.id]: setChoice },
  componentProductsById: children,
  storeId: STORE_ID,
}), /only one/i);

const flightSelections = ['COLD_BREW', 'TONIC', 'LEMONADE'].map(optionId => ({
  groupId: flightChoice.id,
  optionId,
  quantity: 1,
}));
const flightComponents = resolveCanonicalCompositeComponents({
  parentProduct: flightParent,
  requestedSelections: flightSelections,
  groupsById: { [flightChoice.id]: flightChoice },
  componentProductsById: children,
  storeId: STORE_ID,
});
assert.deepEqual(
  flightComponents.map(component => component.componentFinishedGoodCode),
  ['TR_COLD_BREW', 'TR_TONIC', 'TR_LEMONADE'],
);
assert.ok(flightComponents.every(component => component.quantity === 1));
assert.throws(() => resolveCanonicalCompositeComponents({
  parentProduct: flightParent,
  requestedSelections: [
    { groupId: flightChoice.id, optionId: 'COLD_BREW', quantity: 2 },
    { groupId: flightChoice.id, optionId: 'TONIC', quantity: 1 },
  ],
  groupsById: { [flightChoice.id]: flightChoice },
  componentProductsById: children,
  storeId: STORE_ID,
}), /cannot repeat/i);

const missingBomChildren = {
  ...children,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', { bom: [] }),
};
assert.throws(() => resolveCanonicalCompositeComponents({
  parentProduct: flightParent,
  requestedSelections: flightSelections,
  groupsById: { [flightChoice.id]: flightChoice },
  componentProductsById: missingBomChildren,
  storeId: STORE_ID,
}), /no authoritative BOM/i);

function canonicalize(product, group, selections, componentProductsById = children) {
  return canonicalizeRequestedCart({
    storeId: STORE_ID,
    store: { id: STORE_ID, code: STORE_ID, gstRate: 5 },
    gstConfig: { defaultGstRate: 5 },
    requestedItems: [{
      orderItemId: 'LINE_1',
      parentProductId: product.id,
      parentProductCode: product.code,
      quantity: 1,
      selectedAddOns: selections,
    }],
    productsById: { [product.id]: product },
    groupsById: group ? { [group.id]: group } : {},
    componentProductsById,
  });
}

const canonicalSet = canonicalize(setParent, setChoice, [
  { groupId: setChoice.id, optionId: 'HALLOUMI', quantity: 1 },
]);
assert.deepEqual(
  canonicalSet.canonicalItems.LINE_1.components.map(component => component.componentFinishedGoodCode),
  ['TR_ESPRESSO_BUN', 'TR_CHARRED_HALLOUMI'],
);

assert.throws(() => canonicalize(flightParent, flightChoice, [
  { groupId: flightChoice.id, optionId: 'COLD_BREW', quantity: 2 },
  { groupId: flightChoice.id, optionId: 'TONIC', quantity: 1 },
]), /cannot repeat/i);

// Ordinary add-ons keep their previous quantity and canonical-item shape.
const ordinaryGroup = {
  id: 'EXTRAS',
  name: 'Extras',
  isActive: true,
  selectionMode: 'MULTIPLE',
  minimumSelections: 0,
  maximumSelections: 4,
  options: [{ id: 'SHOT', code: 'SHOT', name: 'Extra shot', price: 60, isActive: true, sortOrder: 1 }],
};
const ordinaryProduct = {
  id: 'LATTE', code: 'LATTE', name: 'Latte', salePrice: 225, taxRate: 5,
  isActive: true, isAvailable: true, isSellable: true, availableStoreIds: [STORE_ID],
  addOnGroupIds: ['EXTRAS'], addOnOptionIdsByGroup: { EXTRAS: ['SHOT'] },
};
const ordinary = canonicalize(ordinaryProduct, ordinaryGroup, [
  { groupId: 'EXTRAS', optionId: 'SHOT', quantity: 2 },
]);
assert.equal(ordinary.canonicalItems.LINE_1.addOns[0].quantity, 2);
assert.equal('components' in ordinary.canonicalItems.LINE_1, false);

function fakeSnapshot(id, value) {
  return {
    id,
    exists: value !== undefined,
    data: () => value,
  };
}

function fakeDb(documents) {
  return {
    collection(collectionName) {
      return {
        doc(id) {
          return {
            async get() {
              return fakeSnapshot(id, documents[`${collectionName}/${id}`]);
            },
          };
        },
      };
    },
  };
}

const customerDocuments = {
  [`stores/${STORE_ID}`]: {
    id: STORE_ID,
    code: STORE_ID,
    isActive: true,
    onlineOrderingEnabled: true,
    gstRate: 5,
  },
  'appSettings/gstConfig': { defaultGstRate: 5 },
  [`publicMenuAvailability/${STORE_ID}`]: {
    items: { [setParent.code]: {
      itemCode: setParent.code,
      fgCode: setParent.code,
      available: true,
      publicStatus: 'AVAILABLE',
    } },
    menuItems: { [setParent.code]: {
      ...setParent,
      id: setParent.code,
      code: setParent.code,
      availableStoreIds: [STORE_ID],
    } },
  },
  [`finishedGoods/${setParent.id}`]: setParent,
  [`addOnGroups/${setChoice.id}`]: setChoice,
  ...Object.fromEntries(Object.values(children).map(product => [
    `finishedGoods/${product.id}`,
    product,
  ])),
};
const customerDb = fakeDb(customerDocuments);
const customerCanonical = await canonicalizeCustomerCheckout({
  db: customerDb,
  sessionId: 'SESSION_1',
  data: {
    storeId: STORE_ID,
    storeCode: STORE_ID,
    customerName: 'Test Customer',
    orderType: 'DINE_IN',
    tableNumber: 'T1',
    items: [{
      itemCode: setParent.code,
      quantity: 1,
      addOns: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
    }],
  },
});
assert.deepEqual(
  customerCanonical.items[0].components.map(component => component.componentFinishedGoodCode),
  ['TR_ESPRESSO_BUN', 'TR_TOMATO_MOZZARELLA_PIZZA'],
);
assert.equal(customerCanonical.items[0].components[1].prepStation, 'KITCHEN');

const selectedChildCode = 'TR_TOMATO_MOZZARELLA_PIZZA';
const childConfigPath = `storeItemConfig/${storeItemConfigDocId(STORE_ID, selectedChildCode)}`;
await assert.rejects(
  canonicalizeCustomerCheckout({
    db: fakeDb({
      ...customerDocuments,
      [childConfigPath]: {
        storeId: STORE_ID,
        itemCode: selectedChildCode,
        isAvailableOverride: false,
      },
    }),
    sessionId: 'SESSION_CHILD_OFF',
    data: {
      storeId: STORE_ID,
      storeCode: STORE_ID,
      customerName: 'Child Off',
      orderType: 'PICKUP',
      items: [{
        itemCode: setParent.code,
        quantity: 1,
        addOns: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
      }],
    },
  }),
  /not available|unavailable/i,
);

const childOnDocuments = {
  ...customerDocuments,
  [`finishedGoods/${selectedChildCode}`]: { ...children[selectedChildCode], isAvailable: false },
  [childConfigPath]: {
    storeId: STORE_ID,
    itemCode: selectedChildCode,
    isAvailableOverride: true,
  },
};
const childOnCanonical = await canonicalizeCustomerCheckout({
  db: fakeDb(childOnDocuments),
  sessionId: 'SESSION_CHILD_ON',
  data: {
    storeId: STORE_ID,
    storeCode: STORE_ID,
    customerName: 'Child On',
    orderType: 'PICKUP',
    items: [{
      itemCode: setParent.code,
      quantity: 1,
      addOns: [{ groupId: setChoice.id, optionId: 'PIZZA', quantity: 1 }],
    }],
  },
});
assert.equal(childOnCanonical.items[0].components[1].componentFinishedGoodCode, selectedChildCode);

const expanded = expandCompositeInventoryLines([{
  lineKey: 'ORDER_LINE_1',
  quantity: 2,
  finishedGood: setParent,
  addOns: [],
  components: setComponents,
}], STORE_ID);
assert.equal(expanded.length, 2);
assert.deepEqual(expanded.map(line => [line.lineKey, line.quantity]), [
  ['ORDER_LINE_1__COMP_001', 2],
  ['ORDER_LINE_1__COMP_002', 2],
]);
assert.equal(expanded[0].finishedGood.code, 'TR_ESPRESSO_BUN');
const kotTasks = buildKotTasks({ quantity: 2, components: setComponents });
assert.deepEqual(kotTasks.map(task => [task.taskKey, task.itemCode, task.quantity]), [
  ['COMP_001_KITCHEN', 'TR_ESPRESSO_BUN', 2],
  ['COMP_002_KITCHEN', 'TR_TOMATO_MOZZARELLA_PIZZA', 2],
]);

// Exercise the real TypeScript customer validator/sanitizer.
execFileSync('npx', [
  'esbuild', 'frontend/lib/addOns.ts',
  '--bundle', '--platform=node', '--format=esm',
  '--outfile=/tmp/composite-addons-test.mjs',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const addOns = await import('file:///tmp/composite-addons-test.mjs');
assert.equal(addOns.validateAddOnQuantities(flightChoice, {
  COLD_BREW: 1, TONIC: 1, LEMONADE: 1,
}).ok, true);
assert.equal(addOns.validateAddOnQuantities(flightChoice, {
  COLD_BREW: 2, TONIC: 1,
}).ok, false);
assert.equal(addOns.validateAddOnQuantities(ordinaryGroup, { SHOT: 2 }).ok, true);
const publicChoice = addOns.sanitizeAddOnGroupsForPublic([flightChoice])[0];
assert.equal(publicChoice.purpose, 'COMPOSITE_CHOICE');
assert.equal(publicChoice.selectionMode, 'EXACT_DISTINCT');
assert.deepEqual(publicChoice.options[0].finishedGoodComponent, {
  finishedGoodId: 'TR_COLD_BREW',
  finishedGoodCode: 'TR_COLD_BREW',
  quantity: 1,
});
assert.doesNotMatch(JSON.stringify(publicChoice), /costPerUnit|lineCost|bom/i);

execFileSync('npx', [
  'esbuild', 'frontend/lib/immutableCompositeSnapshot.ts',
  '--bundle', '--platform=node', '--format=esm',
  '--outfile=/tmp/immutable-composite-snapshot-test.mjs',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const clientSnapshotPolicy = await import('file:///tmp/immutable-composite-snapshot-test.mjs');
assert.equal(clientSnapshotPolicy.immutableCompositeComponentSnapshotsEqual(
  setComponents,
  structuredClone(setComponents),
), true);
assert.equal(clientSnapshotPolicy.immutableCompositeComponentSnapshotsEqual(
  setComponents,
  zeroPriceMappingDrift,
), false);

execFileSync('npx', [
  'esbuild', 'frontend/lib/compositeFulfillment.ts',
  '--bundle', '--platform=node', '--format=esm',
  '--outfile=/tmp/composite-fulfillment-client-test.mjs',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const clientFulfillment = await import('file:///tmp/composite-fulfillment-client-test.mjs');
assert.equal(clientFulfillment.aggregateKotTaskStatus([]), 'PENDING');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['SERVED', 'PENDING']), 'PENDING');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['SERVED', 'PREPARING']), 'PREPARING');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['SERVED', 'READY']), 'READY');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['CANCELLED', 'CANCELLED']), 'CANCELLED');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['SERVED', 'CANCELLED']), 'CANCELLED');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['WASTAGE_RECORDED', 'SERVED']), 'CANCELLED');
assert.equal(clientFulfillment.aggregateKotTaskStatus(['REMAKE_REQUESTED', 'SERVED']), 'PENDING');

const sheet = readFileSync(resolve('frontend/components/customer/CustomerProductCustomizationSheet.tsx'), 'utf8');
assert.match(sheet, /selectionMode === 'EXACT_DISTINCT'/);
assert.match(sheet, /!single && !exactDistinct/);
assert.match(sheet, /Choose exactly \$\{minimum\} different options/);

const payAtCounterBackend = readFileSync(resolve('functions/index.js'), 'utf8');
assert.match(payAtCounterBackend, /privateGroup\.selectionMode === 'EXACT_DISTINCT'/);
assert.match(payAtCounterBackend, /selected\.quantity !== 1/);
assert.match(payAtCounterBackend, /new Set\(requestedForGroup\.map\(\(selected\) => selected\.optionId\)\)/);
assert.match(payAtCounterBackend, /resolveCanonicalCompositeComponents/);
assert.match(payAtCounterBackend, /componentsByRequestedIndex/);
assert.match(payAtCounterBackend, /components\.length > 0 \? \{ components \} : \{\}/);

const posAuthorizationBackend = readFileSync(resolve('functions/posAddOnAuthorization.js'), 'utf8');
assert.match(posAuthorizationBackend, /sourceOnlineOrderId/);
assert.match(posAuthorizationBackend, /assertImmutableSourceOnlineOrder/);
assert.match(posAuthorizationBackend, /canonicalizeFrozenOrderCart/);
assert.match(posAuthorizationBackend, /collectFrozenComponentFinishedGoodIds/);
assert.match(posAuthorizationBackend, /sourceItem\?\.components, canonicalItem\.components/);

const payAtCounterAcceptance = readFileSync(resolve('frontend/lib/onlineOrderConversion.ts'), 'utf8');
assert.match(payAtCounterAcceptance, /sourceOnlineOrderId: preflightOnlineOrder\.id/);
assert.match(payAtCounterAcceptance, /immutableCompositeComponentSnapshotsEqual\(/);

const posRazorpayBackend = readFileSync(resolve('functions/posRazorpay.js'), 'utf8');
assert.match(posRazorpayBackend, /collectRequiredComponentFinishedGoodIds/);
assert.match(posRazorpayBackend, /componentProductsById/);
assert.match(posRazorpayBackend, /expandCompositeInventoryLines/);
assert.match(posRazorpayBackend, /buildKotTasks/);

const customerRazorpayBackend = readFileSync(resolve('functions/razorpayCheckout.js'), 'utf8');
assert.match(customerRazorpayBackend, /immutableCompositeComponentSnapshotsEqual\(/);
assert.match(customerRazorpayBackend, /collectFrozenComponentFinishedGoodIds\(onlineOrder\.items\)/);
assert.match(customerRazorpayBackend, /canonicalizeFrozenOrderCart\(\{/);
assert.match(customerRazorpayBackend, /sourceItems: onlineOrder\.items/);
assert.doesNotMatch(customerRazorpayBackend, /collectRequiredComponentFinishedGoodIds/);
assert.doesNotMatch(customerRazorpayBackend, /const componentSnapshotChanged/);
const frozenCanonicalPosition = customerRazorpayBackend.indexOf('canonicalizeFrozenOrderCart({');
const calculatedLinesPosition = customerRazorpayBackend.indexOf('const calculatedLines', frozenCanonicalPosition);
const inventoryPlanPosition = customerRazorpayBackend.indexOf('const inventoryPlan', frozenCanonicalPosition);
assert.ok(frozenCanonicalPosition > 0 && frozenCanonicalPosition < calculatedLinesPosition);
assert.ok(frozenCanonicalPosition < inventoryPlanPosition);

const paymentFirstBackend = readFileSync(resolve('functions/razorpayPaymentFirst.js'), 'utf8');
assert.match(paymentFirstBackend, /items: canonical\.items/);
assert.match(paymentFirstBackend, /items: session\.items/);


/* ---------------------------------------------------------------------------
 * Deferred component BOM (ALLOW_NEGATIVE_DEFER_BOM)
 *
 * The Tasting Room flights ship with real component Finished Goods whose recipes have not
 * been costed yet. For a store that has EXPLICITLY opted in, an empty child BOM must not
 * block a commercially valid sale: it resolves carrying PENDING_BOM so inventory is
 * reconciled later. Every other store, and every genuine structural fault, still fails closed.
 * ------------------------------------------------------------------------- */

const DEFER_STORE = { id: STORE_ID, inventoryPolicy: 'ALLOW_NEGATIVE_DEFER_BOM' };
const STRICT_STORE = { id: STORE_ID, inventoryPolicy: 'STRICT' };

// Representative Tasting Room flight children, including the current Coffee Three Ways
// identities: valid in every respect except that their BOM is empty.
const emptyBomChildren = {
  ...children,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', { bom: [] }),
  TR_TONIC: child('TR_TONIC', 'BARISTA', { bom: [] }),
  TR_LEMONADE: child('TR_LEMONADE', 'BARISTA', { bom: [] }),
  TR_COMPONENT_MINI_ESPRESSO: child('TR_COMPONENT_MINI_ESPRESSO', 'BARISTA', { bom: [] }),
  TR_COMPONENT_MINI_CORTADO: child('TR_COMPONENT_MINI_CORTADO', 'BARISTA', { bom: [] }),
  TR_COMPONENT_COLD_BREW_MANUAL_BREW: child('TR_COMPONENT_COLD_BREW_MANUAL_BREW', 'BARISTA', { bom: [] }),
};

function resolveFlight(store, componentProductsById = emptyBomChildren, selections = flightSelections) {
  return resolveCanonicalCompositeComponents({
    parentProduct: flightParent,
    requestedSelections: selections,
    groupsById: { [flightChoice.id]: flightChoice },
    componentProductsById,
    storeId: STORE_ID,
    allowDeferredComponentBom: allowsDeferredComponentBom(store),
  });
}

function resolveCoffeeThreeWays(store, componentProductsById = emptyBomChildren) {
  return resolveCanonicalCompositeComponents({
    parentProduct: coffeeThreeWaysParent,
    requestedSelections: [],
    groupsById: {},
    componentProductsById,
    storeId: STORE_ID,
    allowDeferredComponentBom: allowsDeferredComponentBom(store),
  });
}

// 1 + 5. An explicitly opted-in store resolves the flight and marks every empty-BOM child
// for deferred consumption rather than rejecting the order.
const deferredComponents = resolveFlight(DEFER_STORE);
assert.equal(deferredComponents.length, 3);
assert.deepEqual(
  deferredComponents.map(component => component.componentFinishedGoodCode),
  ['TR_COLD_BREW', 'TR_TONIC', 'TR_LEMONADE'],
);
assert.ok(deferredComponents.every(component => component.bomStatus === 'PENDING_BOM'));
assert.ok(deferredComponents.every(component => Array.isArray(component.bom) && component.bom.length === 0));
assert.deepEqual(collectFrozenComponentFinishedGoodIds([{ components: deferredComponents }]), [
  'TR_COLD_BREW',
  'TR_TONIC',
  'TR_LEMONADE',
]);
assert.deepEqual(validateFrozenCanonicalCompositeComponents({
  components: deferredComponents,
  componentProductsById: emptyBomChildren,
  store: DEFER_STORE,
  storeId: STORE_ID,
}), deferredComponents);

const coffeeThreeWaysComponents = resolveCoffeeThreeWays(DEFER_STORE);
assert.equal(coffeeThreeWaysComponents.length, 3);
assert.deepEqual(
  coffeeThreeWaysComponents.map(component => component.componentFinishedGoodCode),
  coffeeThreeWaysComponentCodes,
);
assert.ok(coffeeThreeWaysComponents.every(component => component.bomStatus === 'PENDING_BOM'));
assert.ok(coffeeThreeWaysComponents.every(component => component.bom.length === 0));
assert.equal(coffeeThreeWaysComponents[0].source, 'STATIC');
assert.equal(coffeeThreeWaysComponents[0].componentFinishedGoodId, 'TR_COMPONENT_MINI_ESPRESSO');
assert.equal(coffeeThreeWaysComponents[0].componentFinishedGoodCode, 'TR_COMPONENT_MINI_ESPRESSO');
assert.equal(coffeeThreeWaysComponents[0].quantity, 1);
assert.equal(coffeeThreeWaysComponents[0].prepStation, 'BARISTA');
assert.equal(coffeeThreeWaysComponents[0].itemType, 'MADE_TO_ORDER');
assert.equal(coffeeThreeWaysComponents[0].productionMode, 'MADE_TO_ORDER');
assert.equal(coffeeThreeWaysComponents[0].bomVersion, 3);

// Pay at Counter's authoritative cart resolver receives the explicit policy for the real
// Coffee Three Ways static-component shape.
const deferredPayAtCounterCanonical = canonicalizeRequestedCart({
  storeId: STORE_ID,
  store: DEFER_STORE,
  gstConfig: { defaultGstRate: 5 },
  requestedItems: [{
    orderItemId: 'PRIVATE_CUSTOMER_SUBMISSION_ITEM_01',
    parentProductId: coffeeThreeWaysParent.id,
    parentProductCode: coffeeThreeWaysParent.code,
    quantity: 1,
    selectedAddOns: [],
  }],
  productsById: { [coffeeThreeWaysParent.id]: coffeeThreeWaysParent },
  groupsById: {},
  componentProductsById: emptyBomChildren,
});
assert.deepEqual(
  deferredPayAtCounterCanonical.canonicalItems.PRIVATE_CUSTOMER_SUBMISSION_ITEM_01.components,
  coffeeThreeWaysComponents,
);

// Pay Online uses canonicalizeCustomerCheckout before PRIVATE_CHECKOUT_SESSION is written.
// Its stored items therefore carry the identical frozen server snapshot.
const deferredCustomerDb = fakeDb({
  [`stores/${STORE_ID}`]: {
    ...DEFER_STORE,
    code: STORE_ID,
    name: 'Tasting Room',
    isActive: true,
    onlineOrderingEnabled: true,
    gstRate: 5,
  },
  'appSettings/gstConfig': { defaultGstRate: 5 },
  [`publicMenuAvailability/${STORE_ID}`]: {
    items: { [coffeeThreeWaysParent.code]: {
      itemCode: coffeeThreeWaysParent.code,
      fgCode: coffeeThreeWaysParent.code,
      available: true,
      publicStatus: 'AVAILABLE',
    } },
    menuItems: { [coffeeThreeWaysParent.code]: {
      ...coffeeThreeWaysParent,
      id: coffeeThreeWaysParent.code,
      code: coffeeThreeWaysParent.code,
      availableStoreIds: [STORE_ID],
    } },
  },
  [`finishedGoods/${coffeeThreeWaysParent.id}`]: coffeeThreeWaysParent,
  ...Object.fromEntries(Object.values(emptyBomChildren).map(product => [
    `finishedGoods/${product.id}`,
    product,
  ])),
});
const deferredCustomerCanonical = await canonicalizeCustomerCheckout({
  db: deferredCustomerDb,
  sessionId: 'PRIVATE_CHECKOUT_SESSION_1',
  data: {
    storeId: STORE_ID,
    storeCode: STORE_ID,
    customerName: 'Deferred BOM Customer',
    orderType: 'PICKUP',
    items: [{
      itemCode: coffeeThreeWaysParent.code,
      quantity: 1,
      addOns: [],
    }],
  },
});
assert.deepEqual(deferredCustomerCanonical.items[0].components, coffeeThreeWaysComponents);

// 8. The same product at a STRICT store is still blocked outright.
assert.throws(() => resolveFlight(STRICT_STORE), /no authoritative BOM/i);
assert.throws(() => resolveCoffeeThreeWays(STRICT_STORE), /no authoritative BOM/i);
// ALLOW_NEGATIVE permits negative stock but is NOT consent to sell an unrecipied component.
assert.throws(() => resolveFlight({ id: STORE_ID, inventoryPolicy: 'ALLOW_NEGATIVE' }), /no authoritative BOM/i);
// An unset policy fails closed.
assert.throws(() => resolveFlight({ id: STORE_ID }), /no authoritative BOM/i);
// Store identity must never grant the bypass: only the explicit field does.
assert.equal(allowsDeferredComponentBom({ id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I' }), false);
assert.throws(
  () => resolveFlight({ id: 'GOLDEN_I', code: 'GOLDEN_I', storeCode: 'GOLDEN_I', name: 'Golden I' }),
  /no authoritative BOM/i,
);
assert.equal(allowsDeferredComponentBom({ inventoryPolicy: '  allow_negative_defer_bom  ' }), true);

// 9. A BOM that EXISTS but is malformed is a structural fault, not a missing recipe, and is
// still rejected for the opted-in store.
assert.throws(() => resolveFlight(DEFER_STORE, {
  ...emptyBomChildren,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', {
    bom: [{ componentType: 'RAW_INGREDIENT', componentCode: '', componentName: '', quantity: 0, uom: '' }],
  }),
}), /BOM line/i);
assert.throws(() => resolveFlight(DEFER_STORE, {
  ...emptyBomChildren,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', { bom: { unexpected: true } }),
}), /invalid BOM/i);

// 10. A missing child Finished Good is still rejected for the opted-in store.
const withoutChild = { ...emptyBomChildren };
delete withoutChild.TR_COLD_BREW;
assert.throws(() => resolveFlight(DEFER_STORE, withoutChild), /Finished Good is missing/i);

// 11. An invalid prep station is still rejected for the opted-in store.
assert.throws(() => resolveFlight(DEFER_STORE, {
  ...emptyBomChildren,
  TR_COLD_BREW: child('TR_COLD_BREW', 'NOT_A_STATION', { bom: [] }),
}), /preparation station/i);

// Remaining structural guards survive the relaxation for the opted-in store.
assert.throws(() => resolveFlight(DEFER_STORE, {
  ...emptyBomChildren,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', { bom: [], itemType: 'NOT_A_TYPE' }),
}), /item type/i);
assert.throws(() => resolveFlight(DEFER_STORE, {
  ...emptyBomChildren,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', { bom: [], isAvailable: false }),
}), /unavailable at this store/i);
assert.throws(() => resolveFlight(DEFER_STORE, {
  ...emptyBomChildren,
  TR_COLD_BREW: child('TR_COLD_BREW', 'BARISTA', { bom: [], composite: { schemaVersion: 1, staticComponents: [], choiceGroupIds: [] } }),
}), /Nested composite|at least one component/i);
assert.throws(() => resolveFlight(DEFER_STORE, emptyBomChildren, [
  { groupId: flightChoice.id, optionId: 'COLD_BREW', quantity: 1 },
  { groupId: flightChoice.id, optionId: 'TONIC', quantity: 1 },
]), /selected components/i);

// 2 + 7. Acceptance validates and reuses the frozen order snapshot. It does not re-resolve
// component mappings, prep data, or BOMs from today's parent/child definitions.
const deferredAgain = resolveFlight(DEFER_STORE);
assert.deepEqual(deferredAgain, deferredComponents);
assert.ok(immutableCompositeComponentSnapshotsEqual(deferredComponents, deferredAgain));
assertImmutableSourceOnlineOrder({
  sourceOnlineOrderSnapshot: sourceOrderSnapshot(deferredComponents),
  storeId: STORE_ID,
  requestedItems: sourceRequestedItems,
  canonicalItems: { LINE_1: { components: deferredComponents } },
});
const laterChangedParent = structuredClone(coffeeThreeWaysParent);
laterChangedParent.composite.staticComponents = [];
laterChangedParent.composite.choiceGroupIds = [];
laterChangedParent.addOnGroupIds = [];
laterChangedParent.addOnOptionIdsByGroup = {};
const frozenAcceptanceRequest = [{
  orderItemId: 'FROZEN_ACCEPT_LINE_1',
  parentProductId: coffeeThreeWaysParent.id,
  parentProductCode: coffeeThreeWaysParent.code,
  quantity: 1,
  selectedAddOns: [],
}];
const frozenAcceptance = canonicalizeFrozenOrderCart({
  storeId: STORE_ID,
  store: DEFER_STORE,
  requestedItems: frozenAcceptanceRequest,
  sourceItems: deferredCustomerCanonical.items,
  productsById: { [coffeeThreeWaysParent.id]: laterChangedParent },
  // Simulate a later recipe backfill: current child documents now have non-empty BOMs.
  componentProductsById: children,
});
assert.deepEqual(
  frozenAcceptance.canonicalItems.FROZEN_ACCEPT_LINE_1.components,
  coffeeThreeWaysComponents,
  'acceptance must retain the historical empty-BOM snapshot after definitions change',
);
assertImmutableSourceOnlineOrder({
  sourceOnlineOrderSnapshot: {
    exists: true,
    data: () => ({
      storeId: STORE_ID,
      source: 'CUSTOMER_WEB',
      paymentProvider: 'PAY_AT_COUNTER',
      status: 'PENDING',
      items: deferredCustomerCanonical.items,
    }),
  },
  storeId: STORE_ID,
  requestedItems: frozenAcceptanceRequest,
  canonicalItems: frozenAcceptance.canonicalItems,
});

// The snapshot is immutable but acceptance still revalidates current child existence and
// manual availability, and the current store must still explicitly permit deferred BOMs.
assert.throws(() => canonicalizeFrozenOrderCart({
  storeId: STORE_ID,
  store: STRICT_STORE,
  requestedItems: frozenAcceptanceRequest,
  sourceItems: deferredCustomerCanonical.items,
  productsById: { [coffeeThreeWaysParent.id]: laterChangedParent },
  componentProductsById: children,
}), /no authoritative BOM/i);
const missingFrozenChild = { ...children };
delete missingFrozenChild.TR_COMPONENT_MINI_ESPRESSO;
assert.throws(() => canonicalizeFrozenOrderCart({
  storeId: STORE_ID,
  store: DEFER_STORE,
  requestedItems: frozenAcceptanceRequest,
  sourceItems: deferredCustomerCanonical.items,
  productsById: { [coffeeThreeWaysParent.id]: laterChangedParent },
  componentProductsById: missingFrozenChild,
}), /Finished Good is missing or changed/i);
assert.throws(() => canonicalizeFrozenOrderCart({
  storeId: STORE_ID,
  store: DEFER_STORE,
  requestedItems: frozenAcceptanceRequest,
  sourceItems: deferredCustomerCanonical.items,
  productsById: { [coffeeThreeWaysParent.id]: laterChangedParent },
  componentProductsById: {
    ...children,
    TR_COMPONENT_MINI_ESPRESSO: {
      ...children.TR_COMPONENT_MINI_ESPRESSO,
      isAvailable: false,
    },
  },
}), /unavailable at this store/i);

const malformedFrozenSourceItems = structuredClone(deferredCustomerCanonical.items);
malformedFrozenSourceItems[0].components[0].bom = [{
  componentType: 'RAW_INGREDIENT',
  componentCode: '',
  componentName: '',
  quantity: 0,
  uom: '',
}];
delete malformedFrozenSourceItems[0].components[0].bomStatus;
assert.throws(() => canonicalizeFrozenOrderCart({
  storeId: STORE_ID,
  store: DEFER_STORE,
  requestedItems: frozenAcceptanceRequest,
  sourceItems: malformedFrozenSourceItems,
  productsById: { [coffeeThreeWaysParent.id]: laterChangedParent },
  componentProductsById: children,
}), /BOM line/i);

// 3 + 4. One accepted composite line produces exactly one KOT task per component, and exactly
// one inventory line per component — no duplication introduced by the deferral marker.
const deferredLine = {
  lineKey: 'LINE_1',
  quantity: 1,
  itemName: 'Coffee Three Ways',
  itemCode: coffeeThreeWaysParent.code,
  finishedGood: coffeeThreeWaysParent,
  components: coffeeThreeWaysComponents,
  addOns: [],
};
const deferredKots = buildKotTasks(deferredLine);
assert.equal(deferredKots.length, 3);
assert.equal(new Set(deferredKots.map(task => task.taskKey)).size, 3);
assert.ok(deferredKots.every(task => task.station === 'BARISTA'));
assert.ok(deferredKots.every(task => task.component && task.component.bomStatus === 'PENDING_BOM'));
const deferredInventoryLines = expandCompositeInventoryLines([deferredLine], STORE_ID);
assert.equal(deferredInventoryLines.length, 3);
assert.equal(new Set(deferredInventoryLines.map(line => line.lineKey)).size, 3);
// Every expanded line carries the empty BOM through to the inventory layer, which is what
// makes onlineOrderInventory defer it to PENDING_BOM instead of consuming nothing silently.
assert.ok(deferredInventoryLines.every(line => Array.isArray(line.finishedGood.bom) && line.finishedGood.bom.length === 0));

const deferredInventoryHarness = {
  db: {
    collection(collectionName) {
      return { doc: id => ({ id, path: `${collectionName}/${id}` }) };
    },
  },
  transaction: {
    async get(ref) {
      return { id: ref.id, exists: false, data: () => undefined };
    },
  },
  admin: {
    firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } },
  },
};
async function planDeferredFlightInventory() {
  return planOnlineOrderInventory({
    ...deferredInventoryHarness,
    store: { ...DEFER_STORE, code: STORE_ID, name: 'The Tasting Room' },
    orderId: 'ORDER_DEFERRED_FLIGHT_1',
    orderNumber: 'CB-TR-0001',
    orderType: 'DINE_IN',
    businessDate: '20260904',
    staff: { uid: 'manager-1', name: 'Manager' },
    lines: deferredInventoryLines,
    requireAvailableStock: true,
  });
}
const deferredInventoryPlan = await planDeferredFlightInventory();
const deferredInventoryRetry = await planDeferredFlightInventory();
assert.equal(deferredInventoryPlan.blockers.length, 0);
assert.equal(deferredInventoryPlan.pendingConsumptionPayloads.length, 3);
assert.equal(new Set(deferredInventoryPlan.pendingConsumptionPayloads.map(row => row.idempotencyKey)).size, 3);
assert.ok(deferredInventoryPlan.pendingConsumptionPayloads.every(row => row.status === 'PENDING_BOM'));
assert.deepEqual(
  deferredInventoryRetry.pendingConsumptionPayloads.map(row => row.idempotencyKey),
  deferredInventoryPlan.pendingConsumptionPayloads.map(row => row.idempotencyKey),
  'acceptance retry must target the same pending-BOM documents',
);

// 6. Re-running acceptance over the same stored snapshot is deterministic: the same three
// KOT task keys and the same three inventory line keys, so a duplicate Accept cannot create
// a second set of either.
assert.deepEqual(buildKotTasks(deferredLine).map(task => task.taskKey), deferredKots.map(task => task.taskKey));
assert.deepEqual(
  expandCompositeInventoryLines([deferredLine], STORE_ID).map(line => line.lineKey),
  deferredInventoryLines.map(line => line.lineKey),
);

// 12. Non-composite products and fully-recipied composites are untouched by the change: no
// deferral marker appears anywhere.
const recipiedComponents = resolveFlight(DEFER_STORE, children);
assert.ok(recipiedComponents.every(component => component.bomStatus === undefined));
assert.ok(recipiedComponents.every(component => component.bom.length === 1));
const simpleLine = {
  lineKey: 'LINE_S',
  quantity: 2,
  itemName: 'Flat White',
  itemCode: 'TR_FLAT_WHITE',
  finishedGood: { code: 'TR_FLAT_WHITE', name: 'Flat White', prepStation: 'BARISTA', bom: [] },
  components: [],
  addOns: [],
};
assert.deepEqual(buildKotTasks(simpleLine).map(task => task.taskKey), ['BARISTA']);
assert.equal(expandCompositeInventoryLines([simpleLine], STORE_ID).length, 1);

// The opt-in must be threaded at every authoritative server resolution site, or the customer
// could place an order the till cannot accept.
const deferOptInAuthorizationBackend = readFileSync(resolve('functions/posAddOnAuthorization.js'), 'utf8');
assert.match(deferOptInAuthorizationBackend, /allowDeferredComponentBom: allowsDeferredComponentBom\(store\)/);
const deferOptInSubmitBackend = readFileSync(resolve('functions/index.js'), 'utf8');
assert.match(deferOptInSubmitBackend, /allowDeferredComponentBom: allowsDeferredComponentBom\(store\)/);

console.log('composite product policy tests passed');
