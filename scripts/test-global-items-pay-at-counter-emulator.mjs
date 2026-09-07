#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { storeItemConfigDocId } = require('../functions/storeItemConfigPolicy.js');

const PROJECT_ID = 'demo-coffee-bond-global-items-checkout';
const STORE_ID = 'STORE_1';
const ITEM_CODE = 'AFFOGATO';
if (!PROJECT_ID.startsWith('demo-')) throw new Error('Refusing to run against a non-demo project.');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required.');

const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const endpoint = `http://${functionsHost}/${PROJECT_ID}/us-central1/submitCustomerOrder`;
const posCatalogueEndpoint = `http://${functionsHost}/${PROJECT_ID}/us-central1/getEffectivePosProducts`;
const posAuthorizationEndpoint = `http://${functionsHost}/${PROJECT_ID}/us-central1/authorizePosAddOns`;
const app = admin.initializeApp({ projectId: PROJECT_ID }, `global-items-pay-at-counter-${Date.now()}`);
const db = admin.firestore(app);
let checks = 0;
let sequence = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};

const store = {
  id: STORE_ID,
  code: STORE_ID,
  name: 'Store 1',
  isActive: true,
  onlineOrderingEnabled: true,
  estimatedPrepMinutes: 20,
};
const product = (overrides = {}) => ({
  id: ITEM_CODE,
  code: ITEM_CODE,
  name: 'Global Item',
  displayName: 'Global Item',
  posCategoryCode: 'COFFEE',
  posCategoryName: 'Coffee',
  salePrice: 350,
  taxRate: 5,
  itemType: 'NO_STOCK',
  productionMode: 'NO_STOCK',
  prepStation: 'NONE',
  availableStoreIds: [STORE_ID],
  addOnGroupIds: [],
  isActive: true,
  isSellable: true,
  isAvailable: true,
  ...overrides,
});
const publicAvailability = (overrides = {}) => ({
  itemCode: ITEM_CODE,
  fgCode: ITEM_CODE,
  available: true,
  publicStatus: 'AVAILABLE',
  publicMessage: 'Available',
  ...overrides,
});
const publicItem = (overrides = {}) => ({
  id: ITEM_CODE,
  code: ITEM_CODE,
  name: 'Global Item',
  displayName: 'Global Item',
  posCategoryCode: 'COFFEE',
  posCategoryName: 'Coffee',
  salePrice: 350,
  taxRate: 5,
  itemType: 'NO_STOCK',
  productionMode: 'NO_STOCK',
  prepStation: 'NONE',
  availableStoreIds: [STORE_ID],
  addOnGroupIds: [],
  isActive: true,
  isSellable: true,
  isAvailable: true,
  ...overrides,
});

await Promise.all([
  db.collection('stores').doc(STORE_ID).set(store),
  db.collection('appSettings').doc('gstConfig').set({ defaultGstRate: 5 }),
]);

async function setState({ privateProduct = product(), config = null, availability = publicAvailability(), menuItem = publicItem() } = {}) {
  const batch = db.batch();
  batch.set(db.collection('finishedGoods').doc(ITEM_CODE), privateProduct);
  const configRef = db.collection('storeItemConfig').doc(storeItemConfigDocId(STORE_ID, ITEM_CODE));
  if (config) batch.set(configRef, config);
  else batch.delete(configRef);
  batch.set(db.collection('publicMenuAvailability').doc(STORE_ID), {
    storeId: STORE_ID,
    storeCode: STORE_ID,
    storeName: store.name,
    items: { [ITEM_CODE]: availability },
    menuItems: { [ITEM_CODE]: menuItem },
    addOnGroups: {},
    itemCount: 1,
    availableCount: availability.available ? 1 : 0,
    unavailableCount: availability.available ? 0 : 1,
  });
  await batch.commit();
}

async function submit(label) {
  sequence += 1;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        storeCode: STORE_ID,
        customerName: `Emulator ${label}`,
        customerPhone: `9${String(100000000 + sequence).slice(-9)}`,
        orderType: 'PICKUP',
        items: [{ itemCode: ITEM_CODE, quantity: 1, addOns: [] }],
        paymentProvider: 'PAY_AT_COUNTER',
        clientIdempotencyKey: `global-items-${label}-${sequence}-safe`,
      },
    }),
  });
  const payload = await response.json();
  return {
    ok: response.ok && !payload.error,
    result: payload.result ?? payload.data,
    error: payload.error,
    status: response.status,
  };
}

async function orderCount() {
  return (await db.collection('onlineOrders').get()).size;
}

await setState();
let result = await submit('baseline');
ok(result.ok, `baseline Pay at Counter callable succeeds (${result.status})`);
eq(result.result.subtotal, 350, 'baseline Pay at Counter keeps the global price');

const priceConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, priceOverride: 375.5 };
await setState({ config: priceConfig, menuItem: publicItem({ salePrice: 375.5 }) });
result = await submit('price-override');
ok(result.ok, `price override Pay at Counter callable succeeds (${result.status})`);
eq(result.result.subtotal, 375.5, 'Pay at Counter uses the private source-resolved store price');

await setState({
  config: priceConfig,
  menuItem: publicItem({ salePrice: 375.5, taxRate: 99, displayName: 'Tampered public name' }),
});
result = await submit('private-authority');
ok(result.ok, 'Pay at Counter accepts a valid effective item without trusting non-authoritative public fields');
eq(result.result.gstTotal, 18.77, 'Pay at Counter tax comes from the private canonical product without changing the baseline money policy');
eq(result.result.items[0].itemName, 'Global Item', 'Pay at Counter item identity comes from the private canonical product');

let before = await orderCount();
await setState({ config: priceConfig, menuItem: publicItem({ salePrice: 350 }) });
result = await submit('tampered-price');
ok(!result.ok && /unavailable/i.test(result.error?.message || ''), 'a stale public price is rejected by the actual Pay at Counter callable');
eq(await orderCount(), before, 'rejected stale price creates no online order');

before = await orderCount();
await setState({
  config: { storeId: STORE_ID, itemCode: ITEM_CODE, menuVisibilityOverride: false },
  menuItem: publicItem(),
});
result = await submit('hidden-readd');
ok(!result.ok, 'a public re-add cannot bypass a private visibility=false override');
eq(await orderCount(), before, 'rejected hidden item creates no online order');

before = await orderCount();
await setState({
  config: { storeId: STORE_ID, itemCode: ITEM_CODE, isAvailableOverride: false },
  availability: publicAvailability({ available: true }),
  menuItem: publicItem({ isAvailable: true }),
});
result = await submit('unavailable-readd');
ok(!result.ok, 'a public re-add cannot bypass a private availability=false override');
eq(await orderCount(), before, 'rejected unavailable item creates no online order');

await setState({
  privateProduct: product({ isAvailable: false }),
  config: { storeId: STORE_ID, itemCode: ITEM_CODE, isAvailableOverride: true },
  availability: publicAvailability({ available: true }),
  menuItem: publicItem({ isAvailable: true }),
});
result = await submit('available-on');
ok(result.ok, 'matching availability=true over a global false state succeeds in the actual callable');
eq(result.result.subtotal, 350, 'availability override does not change price');

await setState({
  privateProduct: product({ availableStoreIds: [] }),
  config: priceConfig,
  menuItem: publicItem({ salePrice: 375.5 }),
});
result = await submit('all-stores');
ok(result.ok, 'empty legacy assignment keeps its all-stores meaning in Pay at Counter');
eq(result.result.subtotal, 375.5, 'all-stores item still uses the matching source-resolved price');

const publishedProduct = product({
  name: 'Affogato Reserve',
  displayName: 'Affogato Reserve',
  posCategoryCode: 'EXPERIENCES',
  posCategoryName: 'Experiences',
  salePrice: 300,
  taxRate: 12,
  prepStation: 'KITCHEN',
  addOnGroupIds: ['B'],
  addOnOptionIdsByGroup: { B: ['B1'] },
  bom: [{
    componentType: 'RAW_INGREDIENT',
    componentCode: 'COMPONENT_B',
    componentName: 'Component B',
    quantity: 10,
    uom: 'G',
  }],
  availableStoreIds: [STORE_ID],
  menuVisible: true,
});
const fullVersionConfig = {
  storeId: STORE_ID,
  itemCode: ITEM_CODE,
  priceOverride: 999,
  managementMode: 'FULL_VERSION_MANAGED',
  publishedVersion: {
    schemaVersion: 1,
    storeId: STORE_ID,
    itemCode: ITEM_CODE,
    sourceDraftRevision: 'affogato-draft-v1',
    publishedRevision: 'affogato-published-v1',
    publishedAt: new Date('2026-09-07T00:00:00.000Z'),
    publishedBy: 'admin',
    publishedByName: 'Admin',
    product: publishedProduct,
  },
};
await setState({
  privateProduct: product({
    name: 'Affogato',
    displayName: 'Affogato',
    salePrice: 280,
    taxRate: 5,
    prepStation: 'BARISTA',
    addOnGroupIds: ['A'],
    addOnOptionIdsByGroup: { A: ['A1'] },
  }),
  config: fullVersionConfig,
  menuItem: publicItem({
    name: 'Affogato Reserve',
    displayName: 'Affogato Reserve',
    posCategoryCode: 'EXPERIENCES',
    posCategoryName: 'Experiences',
    salePrice: 300,
    taxRate: 12,
    prepStation: 'KITCHEN',
    addOnGroupIds: ['B'],
    addOnOptionIdsByGroup: { B: ['B1'] },
  }),
});
result = await submit('full-version');
ok(result.ok, 'full published version succeeds through the actual Pay at Counter callable');
eq(result.result.subtotal, 300, 'Pay at Counter charges the published full-version price');
eq(result.result.gstTotal, 36, 'Pay at Counter uses the published item tax rate');
eq(result.result.items[0].itemName, 'Affogato Reserve', 'Pay at Counter returns the published item name');
const publishedOrderQuery = await db.collection('onlineOrders')
  .where('trackingToken', '==', result.result.trackingToken)
  .limit(1)
  .get();
const publishedOrderItem = publishedOrderQuery.docs[0].data().items[0];
eq(publishedOrderItem.prepStation, 'KITCHEN', 'Pay at Counter freezes the published KOT station');
eq(publishedOrderItem.productSnapshot.bom[0].componentCode, 'COMPONENT_B', 'Pay at Counter freezes the published BOM for acceptance');

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!authHost) throw new Error('FIREBASE_AUTH_EMULATOR_HOST is required.');
const signUpResponse = await fetch(
  `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `catalogue-${Date.now()}@example.test`,
      password: 'local-emulator-only-password',
      returnSecureToken: true,
    }),
  },
);
const signedIn = await signUpResponse.json();
if (!signUpResponse.ok || !signedIn.localId || !signedIn.idToken) {
  throw new Error(`Unable to create emulator staff identity: ${JSON.stringify(signedIn)}`);
}
await db.collection('users').doc(signedIn.localId).set({
  uid: signedIn.localId,
  name: 'Catalogue Cashier',
  role: 'CASHIER',
  isActive: true,
  storeIds: [STORE_ID],
  assignedStoreIds: [STORE_ID],
});

async function loadPosCatalogue(idToken = null) {
  const response = await fetch(posCatalogueEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data: { storeId: STORE_ID } }),
  });
  const payload = await response.json();
  return { ok: response.ok && !payload.error, result: payload.result ?? payload.data, error: payload.error };
}

async function authorizePosCart(data) {
  const response = await fetch(posAuthorizationEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${signedIn.idToken}`,
    },
    body: JSON.stringify({ data }),
  });
  const payload = await response.json();
  return { ok: response.ok && !payload.error, result: payload.result ?? payload.data, error: payload.error };
}

let catalogueResult = await loadPosCatalogue();
ok(!catalogueResult.ok && /sign-in/i.test(catalogueResult.error?.message || ''), 'unauthenticated public caller cannot load the private effective POS catalogue');
catalogueResult = await loadPosCatalogue(signedIn.idToken);
ok(catalogueResult.ok, 'assigned Cashier can load the effective POS catalogue through the server boundary');
const effectiveAffogato = catalogueResult.result.products.find(item => item.code === ITEM_CODE);
eq(effectiveAffogato.displayName, 'Affogato Reserve', 'actual POS catalogue callable returns the published name');
eq(effectiveAffogato.salePrice, 300, 'actual POS catalogue callable returns the published price');
eq(effectiveAffogato.prepStation, 'KITCHEN', 'actual POS catalogue callable returns the published KOT station');
eq(effectiveAffogato.bom[0].componentCode, 'COMPONENT_B', 'actual POS catalogue callable returns the published BOM');
ok(!Object.hasOwn(effectiveAffogato, 'publishedVersion'), 'POS catalogue exposes no private publish metadata');

const heldAuthorization = await authorizePosCart({
  storeId: STORE_ID,
  orderId: 'HELD_AFFOGATO_1',
  orderNumber: 'HELD-1',
  authorizationPurpose: 'HELD_BILL',
  checkoutMode: 'STANDARD_POS',
  checkoutSource: 'POS',
  paymentMethod: null,
  items: [{
    orderItemId: 'HELD_LINE_1',
    parentProductId: ITEM_CODE,
    parentProductCode: ITEM_CODE,
    quantity: 1,
    selectedAddOns: [],
  }],
});
ok(heldAuthorization.ok, 'holding a bill creates a server-approved immutable product snapshot');
eq(heldAuthorization.result.canonicalItems.HELD_LINE_1.baseUnitPrice, 300, 'held bill freezes published revision N price');

await db.collection('storeItemConfig').doc(storeItemConfigDocId(STORE_ID, ITEM_CODE)).set({
  ...fullVersionConfig,
  publishedVersion: {
    ...fullVersionConfig.publishedVersion,
    sourceDraftRevision: 'affogato-draft-v2',
    publishedRevision: 'affogato-published-v2',
    product: {
      ...publishedProduct,
      salePrice: 325,
      taxRate: 18,
      prepStation: 'BARISTA',
      bom: [{
        componentType: 'RAW_INGREDIENT',
        componentCode: 'COMPONENT_C',
        componentName: 'Component C',
        quantity: 15,
        uom: 'G',
      }],
    },
  },
}, { merge: false });

const recalledAuthorization = await authorizePosCart({
  storeId: STORE_ID,
  orderId: 'SALE_FROM_HELD_1',
  orderNumber: 'SALE-1',
  sourceAuthorizationId: heldAuthorization.result.authorizationId,
  authorizationPurpose: 'SALE',
  checkoutMode: 'STANDARD_POS',
  checkoutSource: 'POS',
  paymentMethod: 'CASH',
  items: [{
    orderItemId: 'SALE_LINE_1',
    sourceOrderItemId: 'HELD_LINE_1',
    parentProductId: ITEM_CODE,
    parentProductCode: ITEM_CODE,
    quantity: 1,
    selectedAddOns: [],
  }],
});
ok(recalledAuthorization.ok, 'recalling an unchanged held bill rebinds its immutable snapshot');
eq(recalledAuthorization.result.canonicalItems.SALE_LINE_1.baseUnitPrice, 300, 'recalled bill keeps revision N price after revision N+1 publish');
eq(recalledAuthorization.result.canonicalItems.SALE_LINE_1.taxRate, 12, 'recalled bill keeps revision N GST after revision N+1 publish');
eq(recalledAuthorization.result.canonicalItems.SALE_LINE_1.productSnapshot.prepStation, 'KITCHEN', 'recalled bill keeps revision N KOT station');
eq(recalledAuthorization.result.canonicalItems.SALE_LINE_1.productSnapshot.bom[0].componentCode, 'COMPONENT_B', 'recalled bill keeps revision N BOM');

const replayedAuthorization = await authorizePosCart({
  storeId: STORE_ID,
  orderId: 'DIFFERENT_SALE_FROM_HELD_1',
  orderNumber: 'SALE-2',
  sourceAuthorizationId: heldAuthorization.result.authorizationId,
  authorizationPurpose: 'SALE',
  checkoutMode: 'STANDARD_POS',
  checkoutSource: 'POS',
  paymentMethod: 'CASH',
  items: [{
    orderItemId: 'SALE_LINE_2',
    sourceOrderItemId: 'HELD_LINE_1',
    parentProductId: ITEM_CODE,
    parentProductCode: ITEM_CODE,
    quantity: 1,
    selectedAddOns: [],
  }],
});
ok(!replayedAuthorization.ok, 'a held-bill snapshot cannot be replayed into a different order');

await app.delete();
console.log(`\n${checks} Pay at Counter emulator checks passed. PROJECT=${PROJECT_ID}; PRODUCTION_WRITES=0.`);
