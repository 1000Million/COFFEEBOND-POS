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
  collectRequiredComponentFinishedGoodIds,
  resolveCanonicalCompositeComponents,
} = require('../functions/compositeProductPolicy.js');
const {
  assertImmutableSourceOnlineOrder,
  canonicalizeRequestedCart,
} = require('../functions/posAddOnAuthorization.js');
const { canonicalizeCustomerCheckout } = require('../functions/customerCheckoutCanonicalization.js');
const {
  buildKotTasks,
  expandCompositeInventoryLines,
} = require('../functions/compositeFulfillment.js');
const {
  immutableCompositeComponentSnapshotsEqual,
} = require('../functions/razorpayCheckout.js');
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

const customerDb = fakeDb({
  [`stores/${STORE_ID}`]: {
    id: STORE_ID,
    code: STORE_ID,
    isActive: true,
    onlineOrderingEnabled: true,
    gstRate: 5,
  },
  'appSettings/gstConfig': { defaultGstRate: 5 },
  [`publicMenuAvailability/${STORE_ID}`]: {
    items: { [setParent.code]: { available: true } },
  },
  [`finishedGoods/${setParent.id}`]: setParent,
  [`addOnGroups/${setChoice.id}`]: setChoice,
  ...Object.fromEntries(Object.values(children).map(product => [
    `finishedGoods/${product.id}`,
    product,
  ])),
});
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
assert.match(customerRazorpayBackend, /storedItem\.components/);
assert.match(customerRazorpayBackend, /COMPOSITE_COMPONENT_SNAPSHOT_CHANGED_AFTER_PAYMENT/);
const snapshotGuardPosition = customerRazorpayBackend.indexOf('const componentSnapshotChanged');
const calculatedLinesPosition = customerRazorpayBackend.indexOf('const calculatedLines', snapshotGuardPosition);
const inventoryPlanPosition = customerRazorpayBackend.indexOf('const inventoryPlan', snapshotGuardPosition);
assert.ok(snapshotGuardPosition > 0 && snapshotGuardPosition < calculatedLinesPosition);
assert.ok(snapshotGuardPosition < inventoryPlanPosition);
assert.match(
  customerRazorpayBackend.slice(snapshotGuardPosition, calculatedLinesPosition),
  /paymentStatus: PAID_STATUS/,
);

console.log('composite product policy tests passed');
