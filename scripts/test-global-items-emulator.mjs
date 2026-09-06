#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  setDoc,
} from 'firebase/firestore';
import {
  buildOverridePublishPlan,
  emptyDraft,
  snapshotRevisionToken,
} from '../frontend/lib/storeItemConfigAdmin.ts';
import {
  STORE_ITEM_CONFIG_COLLECTION,
  storeItemConfigDocId,
} from '../frontend/lib/storeItemConfig.ts';

const PROJECT_ID = 'demo-coffee-bond-global-items';
const [host, portText] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const port = Number(portText || 8080);

const GOLDEN_ID = 'golden-doc';
const GOLDEN_CODE = 'GOLDEN_I';
const NOIDA_ID = 'noida-29-doc';
const NOIDA_CODE = 'NOIDA_29';
const ITEM_CODE = 'FG_A';
const OTHER_CODE = 'FG_B';
const ITEM_CONFIG_ID = storeItemConfigDocId(GOLDEN_ID, ITEM_CODE);

let checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
}
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, `${message} (actual=${JSON.stringify(actual)})`);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
}

if (!PROJECT_ID.startsWith('demo-')) throw new Error('Refusing to run against a non-demo project.');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required; run through firebase emulators:exec.');

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host, port },
});

const store = (id, code) => ({
  id,
  code,
  name: code,
  address: 'Test address',
  isActive: true,
  posEnabled: true,
  customerOrderingEnabled: true,
  onlineOrderingEnabled: true,
  publicOrderingEnabled: true,
  acceptingOrders: true,
  isAcceptingOrders: true,
  estimatedPrepMinutes: 20,
  createdAt: null,
  updatedAt: null,
});

const raw = (code) => ({
  id: code,
  code,
  name: code,
  category: 'Test',
  purchaseUOM: 'PCS',
  usageUOM: 'PCS',
  conversionFactor: 1,
  purchaseCost: 1,
  costPerUsageUnit: 1,
  isActive: true,
});

const product = (code, extra = {}) => ({
  id: code,
  code,
  name: code,
  displayName: code,
  posCategoryCode: 'COFFEE',
  posCategoryName: 'Coffee',
  salePrice: code === ITEM_CODE ? 350 : 250,
  productionMode: 'MADE_TO_ORDER',
  itemType: 'MADE_TO_ORDER',
  prepStation: 'BARISTA',
  taxRate: 5,
  addOnGroupIds: [],
  bom: [{
    componentType: 'RAW_INGREDIENT',
    componentCode: `${code}_RAW`,
    componentName: `${code} raw`,
    quantity: 1,
    uom: 'PCS',
    costPerUnit: 1,
    lineCost: 1,
  }],
  bomVersion: 1,
  recipeCost: 1,
  grossMargin: 0,
  cogsPercent: 0,
  sortOrder: code === ITEM_CODE ? 20 : 30,
  availableStoreIds: [GOLDEN_ID, NOIDA_ID],
  isSellable: true,
  isAvailable: true,
  isActive: true,
  ...extra,
});

const GOLDEN = store(GOLDEN_ID, GOLDEN_CODE);
const NOIDA = store(NOIDA_ID, NOIDA_CODE);
const CATALOGUE = [
  product(ITEM_CODE),
  product(OTHER_CODE),
  product('LEGACY_NAMELESS', { name: undefined, displayName: 'Legacy Display Name', sortOrder: 40 }),
];
const RAW_INGREDIENTS = CATALOGUE.map((item) => raw(`${item.code}_RAW`));

const initialGoldenSnapshot = {
  storeId: GOLDEN_ID,
  storeCode: GOLDEN_CODE,
  storeName: GOLDEN_CODE,
  items: {
    [ITEM_CODE]: { itemCode: ITEM_CODE, fgCode: ITEM_CODE, available: true, publicStatus: 'AVAILABLE', publicMessage: 'Available' },
    STALE_ITEM: { itemCode: 'STALE_ITEM', fgCode: 'STALE_ITEM', available: true, publicStatus: 'AVAILABLE', publicMessage: 'Available' },
  },
  menuItems: {
    [ITEM_CODE]: { id: ITEM_CODE, code: ITEM_CODE, name: ITEM_CODE, salePrice: 350 },
    STALE_ITEM: { id: 'STALE_ITEM', code: 'STALE_ITEM', name: 'Stale', salePrice: 1 },
  },
  addOnGroups: { STALE_GROUP: { id: 'STALE_GROUP', name: 'Stale', isActive: true, options: [] } },
  itemCount: 2,
  availableCount: 2,
  unavailableCount: 0,
  publicationRevision: 'initial-golden',
  updatedAt: 'initial-golden',
};
const initialNoidaSnapshot = {
  storeId: NOIDA_ID,
  storeCode: NOIDA_CODE,
  storeName: NOIDA_CODE,
  items: { NOIDA_SENTINEL: { available: true } },
  menuItems: { NOIDA_SENTINEL: { code: 'NOIDA_SENTINEL', salePrice: 99 } },
  addOnGroups: {},
  itemCount: 1,
  availableCount: 1,
  unavailableCount: 0,
  sentinel: 'unchanged',
  publicationRevision: 'initial-noida',
  updatedAt: 'initial-noida',
};

await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  const users = {
    admin: { uid: 'admin', role: 'ADMIN', isActive: true, storeIds: [] },
    manager: { uid: 'manager', role: 'STORE_MANAGER', isActive: true, storeIds: [GOLDEN_ID], assignedStoreIds: [GOLDEN_ID] },
    cashier: { uid: 'cashier', role: 'CASHIER', isActive: true, storeIds: [GOLDEN_ID], assignedStoreIds: [GOLDEN_ID] },
    inactive: { uid: 'inactive', role: 'ADMIN', isActive: false, storeIds: [] },
    customer: { uid: 'customer' },
  };
  for (const [uid, data] of Object.entries(users)) await setDoc(doc(db, 'users', uid), data);
  await setDoc(doc(db, 'stores', GOLDEN_ID), GOLDEN);
  await setDoc(doc(db, 'stores', NOIDA_ID), NOIDA);
  for (const item of CATALOGUE) {
    const persisted = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));
    await setDoc(doc(db, 'finishedGoods', item.code), persisted);
  }
  await setDoc(doc(db, 'publicMenuAvailability', GOLDEN_CODE), initialGoldenSnapshot);
  await setDoc(doc(db, 'publicMenuAvailability', NOIDA_CODE), initialNoidaSnapshot);
});

const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
const asPublic = () => testEnv.unauthenticatedContext().firestore();
const adminDb = asUser('admin');

let currentConfigs = [];
const currentConfig = () => currentConfigs.find((row) => row.itemCode === ITEM_CODE) || null;
const plan = (draft, existing = currentConfig()) => buildOverridePublishPlan({
  store: GOLDEN,
  itemCode: ITEM_CODE,
  draft,
  existing,
  storeConfigs: currentConfigs,
  finishedGoods: CATALOGUE,
  rawIngredients: RAW_INGREDIENTS,
  prepItems: [],
  addOnGroups: [],
  updatedBy: 'admin',
  createdAt: existing?.createdAt || 'created-test',
  updatedAt: 'updated-test',
});

async function commitPublish(db, publish, expectedRevision = null, nextRevision = `test-${Date.now()}-${Math.random()}`) {
  const overrideRef = doc(db, STORE_ITEM_CONFIG_COLLECTION, publish.overridePlan.docId);
  const snapshotRef = doc(db, 'publicMenuAvailability', publish.snapshotDocId);
  const observedRevision = expectedRevision ?? snapshotRevisionToken((await getDoc(snapshotRef)).data());
  await runTransaction(db, async (transaction) => {
    const liveSnapshot = await transaction.get(snapshotRef);
    if (snapshotRevisionToken(liveSnapshot.exists() ? liveSnapshot.data() : null) !== observedRevision) {
      throw new Error('STALE_PUBLIC_SNAPSHOT');
    }
    if (publish.overridePlan.action === 'DELETE') transaction.delete(overrideRef);
    if (publish.overridePlan.action === 'SET') transaction.set(overrideRef, publish.overridePlan.data);
    if (publish.overridePlan.action !== 'NONE') transaction.set(snapshotRef, {
      ...publish.snapshot,
      publicationRevision: nextRevision,
      updatedAt: nextRevision,
      updatedBy: 'admin',
      updatedByName: 'Release 1B test',
    });
  });
}

async function publishAsAdmin(draft) {
  const publish = plan(draft);
  await assertSucceeds(commitPublish(adminDb, publish));
  currentConfigs = publish.projectedConfigs;
  return publish;
}

// Full collection reads include legacy items without a `name`; sorting is client-side.
const loadedItems = await getDocs(collection(adminDb, 'finishedGoods'));
ok(loadedItems.docs.some((entry) => entry.id === 'LEGACY_NAMELESS'), 'ADMIN loads an existing master item without a name field');
eq(CATALOGUE[0].availableStoreIds, [GOLDEN_ID, NOIDA_ID], 'Store assignment uses document IDs, not store codes or positions');

const price = emptyDraft();
price.price = { mode: 'OVERRIDE', value: '375' };
await publishAsAdmin(price);
let persistedConfig = (await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID))).data();
let persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(persistedConfig.storeId, GOLDEN_ID, 'Override document uses the physical store document ID');
eq(persistedSnapshot.storeCode, GOLDEN_CODE, 'Public snapshot uses the store code as its document identity');
eq(persistedSnapshot.menuItems[ITEM_CODE].salePrice, 375, 'Price override is persisted in the rebuilt snapshot');

const zeroPrice = emptyDraft();
zeroPrice.price = { mode: 'OVERRIDE', value: '0' };
await publishAsAdmin(zeroPrice);
persistedConfig = (await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID))).data();
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(persistedConfig.priceOverride, 0, 'Explicit price 0 survives Firestore persistence');
eq(persistedSnapshot.menuItems[ITEM_CODE].salePrice, 0, 'Explicit price 0 reaches the derived snapshot');
eq(persistedSnapshot.items[ITEM_CODE].available, false, 'Zero price remains structurally unavailable');

const unavailable = emptyDraft();
unavailable.availability = { mode: 'OVERRIDE', value: false };
await publishAsAdmin(unavailable);
persistedConfig = (await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID))).data();
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(persistedConfig.isAvailableOverride, false, 'Explicit availability false survives Firestore persistence');
eq(persistedSnapshot.items[ITEM_CODE].available, false, 'Availability false reaches the derived snapshot');

const hidden = emptyDraft();
hidden.menuVisibility = { mode: 'OVERRIDE', value: false };
await publishAsAdmin(hidden);
persistedConfig = (await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID))).data();
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(persistedConfig.menuVisibilityOverride, false, 'Explicit visibility false survives Firestore persistence');
ok(!(ITEM_CODE in persistedSnapshot.menuItems) && !(ITEM_CODE in persistedSnapshot.items), 'Hidden item is removed from both persisted snapshot maps');
ok(!('STALE_ITEM' in persistedSnapshot.menuItems) && !('STALE_ITEM' in persistedSnapshot.items), 'Full replacement removes stale nested item keys');
eq(persistedSnapshot.addOnGroups, {}, 'Full replacement removes stale add-on group keys');

const sorted = emptyDraft();
sorted.sortOrder = { mode: 'OVERRIDE', value: '0' };
await publishAsAdmin(sorted);
persistedConfig = (await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID))).data();
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(persistedConfig.sortOrderOverride, 0, 'Explicit sort order 0 survives Firestore persistence');
eq(persistedSnapshot.menuItems[ITEM_CODE].sortOrder, 0, 'Sort order 0 reaches the derived snapshot');

await publishAsAdmin(emptyDraft());
const inheritedConfig = await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID));
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
ok(!inheritedConfig.exists(), 'All-inherit state deletes the private override document');
eq(persistedSnapshot.menuItems[ITEM_CODE].salePrice, 350, 'Inherit rebuild restores the global price');

const noidaAfter = (await getDoc(doc(adminDb, 'publicMenuAvailability', NOIDA_CODE))).data();
eq(noidaAfter, initialNoidaSnapshot, 'Another store snapshot remains byte-for-byte unchanged');

// Two Admin tabs may both start from one complete snapshot. The first commit wins;
// the second must fail closed, then succeed only after rebuilding from fresh configs.
const sharedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
const sharedRevision = snapshotRevisionToken(sharedSnapshot);
const writerADraft = emptyDraft();
writerADraft.price = { mode: 'OVERRIDE', value: '390' };
const writerA = plan(writerADraft, null);
const writerBDraft = emptyDraft();
writerBDraft.price = { mode: 'OVERRIDE', value: '275' };
const writerBStale = buildOverridePublishPlan({
  store: GOLDEN,
  itemCode: OTHER_CODE,
  draft: writerBDraft,
  existing: null,
  storeConfigs: [],
  finishedGoods: CATALOGUE,
  rawIngredients: RAW_INGREDIENTS,
  prepItems: [],
  addOnGroups: [],
  updatedBy: 'admin-b',
  createdAt: 'created-b',
  updatedAt: 'updated-b',
});
await commitPublish(adminDb, writerA, sharedRevision, 'writer-a');
currentConfigs = writerA.projectedConfigs;
await assert.rejects(
  commitPublish(adminDb, writerBStale, sharedRevision, 'writer-b-stale'),
  /STALE_PUBLIC_SNAPSHOT/,
);
ok(!(await getDoc(doc(adminDb, STORE_ITEM_CONFIG_COLLECTION, writerBStale.overridePlan.docId))).exists(), 'A stale second Admin writes neither its override nor its snapshot');
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(persistedSnapshot.menuItems[ITEM_CODE].salePrice, 390, 'The first Admin complete snapshot remains intact after the rejected stale write');

const writerBFresh = buildOverridePublishPlan({
  store: GOLDEN,
  itemCode: OTHER_CODE,
  draft: writerBDraft,
  existing: null,
  storeConfigs: currentConfigs,
  finishedGoods: CATALOGUE,
  rawIngredients: RAW_INGREDIENTS,
  prepItems: [],
  addOnGroups: [],
  updatedBy: 'admin-b',
  createdAt: 'created-b',
  updatedAt: 'updated-b',
});
const freshRevision = snapshotRevisionToken((await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data());
await commitPublish(adminDb, writerBFresh, freshRevision, 'writer-b-fresh');
currentConfigs = writerBFresh.projectedConfigs;
persistedSnapshot = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
eq(
  [persistedSnapshot.menuItems[ITEM_CODE].salePrice, persistedSnapshot.menuItems[OTHER_CODE].salePrice],
  [390, 275],
  'After refresh, the second Admin publishes a snapshot containing both overrides',
);

const deniedDraft = emptyDraft();
deniedDraft.price = { mode: 'OVERRIDE', value: '401' };
const deniedPlan = plan(deniedDraft, null);
const goldenBeforeDenied = (await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data();
await assertFails(commitPublish(asUser('manager'), deniedPlan));
eq((await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data(), goldenBeforeDenied, 'Denied Manager batch changes neither snapshot nor override');
await assertFails(commitPublish(asUser('cashier'), deniedPlan));
eq((await getDoc(doc(adminDb, 'publicMenuAvailability', GOLDEN_CODE))).data(), goldenBeforeDenied, 'Denied Cashier batch changes neither snapshot nor override');

await assertFails(getDoc(doc(asUser('manager'), STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID)));
await assertFails(getDoc(doc(asUser('cashier'), STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID)));
await assertFails(getDoc(doc(asUser('inactive'), STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID)));
await assertFails(getDoc(doc(asUser('customer'), STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID)));
await assertFails(getDoc(doc(asPublic(), STORE_ITEM_CONFIG_COLLECTION, ITEM_CONFIG_ID)));
await assertSucceeds(getDoc(doc(asPublic(), 'publicMenuAvailability', GOLDEN_CODE)));
ok(true, 'Manager, Cashier, inactive Admin, customer, and public are denied private override reads; public snapshot remains readable');

await testEnv.cleanup();
console.log(`\n${checks} Global Items emulator integration checks passed.`);
