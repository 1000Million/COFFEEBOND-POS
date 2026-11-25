#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { storeItemConfigDocId } = require('../functions/storeItemConfigPolicy.js');

const PROJECT_ID = 'demo-coffee-bond-global-items-checkout';
const STORE_ID = 'STORE_1';
const ITEM_CODE = 'FG_A';
if (!PROJECT_ID.startsWith('demo-')) throw new Error('Refusing to run against a non-demo project.');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required.');

const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const endpoint = `http://${functionsHost}/${PROJECT_ID}/us-central1/submitCustomerOrder`;
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

await app.delete();
console.log(`\n${checks} Pay at Counter emulator checks passed. PROJECT=${PROJECT_ID}; PRODUCTION_WRITES=0.`);
