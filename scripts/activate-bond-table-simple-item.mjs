#!/usr/bin/env node
import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PRODUCTION_PROJECT_ID = 'coffee-bond-pos';
const STORE_ID = 'TASTING_ROOM_29';
const CATEGORY_ID = 'TR_FOR_TWO';
const ITEM_ID = 'TR_BOND_TABLE';
const BASE_COUNTS = Object.freeze({ itemCount: 21, availableCount: 18, unavailableCount: 3 });
const APPLY = process.argv.includes('--apply-production');
const ROLLBACK = process.argv.includes('--rollback-production');

function argument(name) {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || '';
}

function fail(message) {
  throw new Error(message);
}

function stableValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

const finishedGood = Object.freeze({
  id: ITEM_ID,
  code: ITEM_ID,
  name: 'The Bond Table',
  displayName: 'The Bond Table',
  description: 'For 2 guests',
  posCategoryCode: CATEGORY_ID,
  posCategoryName: 'FOR TWO',
  categorySortOrder: 80,
  posSubcategoryCode: null,
  posSubcategoryName: null,
  subcategorySortOrder: null,
  salePrice: 4761.9,
  productionMode: 'NO_STOCK',
  itemType: 'NO_STOCK',
  prepStation: 'KITCHEN',
  taxRate: 5,
  bom: [],
  bomVersion: 1,
  recipeCost: 0,
  grossMargin: 4761.9,
  cogsPercent: 0,
  sortOrder: 220,
  availableStoreIds: [STORE_ID],
  isSellable: true,
  isAvailable: true,
  isActive: true,
});

const publicAvailability = Object.freeze({
  itemCode: ITEM_ID,
  fgCode: ITEM_ID,
  available: true,
  publicStatus: 'AVAILABLE',
  publicMessage: 'Available',
});

const publicMenuItem = Object.freeze({
  id: ITEM_ID,
  code: ITEM_ID,
  name: 'The Bond Table',
  displayName: 'The Bond Table',
  description: 'For 2 guests',
  posCategoryCode: CATEGORY_ID,
  posCategoryName: 'FOR TWO',
  salePrice: 4761.9,
  prepStation: 'KITCHEN',
  itemType: 'NO_STOCK',
  productionMode: 'NO_STOCK',
  sortOrder: 220,
  availableStoreIds: [STORE_ID],
  isSellable: true,
  isAvailable: true,
  isActive: true,
  taxRate: 5,
});

const quarantinedPublicAvailability = Object.freeze({
  ...publicAvailability,
  available: false,
  publicStatus: 'CURRENTLY_UNAVAILABLE',
  publicMessage: 'Temporarily unavailable',
});

const quarantinedPublicMenuItem = Object.freeze({
  ...publicMenuItem,
  isAvailable: false,
});

export {
  finishedGood as bondTableFinishedGood,
  publicAvailability as bondTablePublicAvailability,
  publicMenuItem as bondTablePublicMenuItem,
};

function assertProject() {
  if (String(process.env.FIRESTORE_EMULATOR_HOST || '').trim()) {
    fail('FIRESTORE_EMULATOR_HOST is set. Production activation refuses emulator routing; no write was made.');
  }
  const requestedProject = argument('--project');
  if (requestedProject !== PRODUCTION_PROJECT_ID) {
    fail(`Pass --project=${PRODUCTION_PROJECT_ID}. No write was made.`);
  }
  if (APPLY && ROLLBACK) fail('Choose apply or rollback, not both. No write was made.');
  if ((APPLY || ROLLBACK) && !argument('--guard')) {
    fail('A guard from the immediately preceding dry run is required. No write was made.');
  }
}

function refs(db) {
  return {
    store: db.collection('stores').doc(STORE_ID),
    category: db.collection('categories').doc(CATEGORY_ID),
    item: db.collection('finishedGoods').doc(ITEM_ID),
    snapshot: db.collection('publicMenuAvailability').doc(STORE_ID),
  };
}

function assertStoreAndCategory(storeSnapshot, categorySnapshot) {
  if (!storeSnapshot.exists) fail(`Missing stores/${STORE_ID}.`);
  const store = storeSnapshot.data() || {};
  if (storeSnapshot.id !== STORE_ID || store.code !== STORE_ID || store.isActive !== true) {
    fail('The target Tasting Room store identity or active state changed.');
  }
  if (
    store.onlineOrderingEnabled !== true
    || store.customerOrderingEnabled !== true
    || store.publicOrderingEnabled !== true
    || store.acceptingOrders !== true
    || store.isAcceptingOrders !== true
  ) {
    fail('The target store is not fully enabled for normal customer ordering.');
  }
  if (!categorySnapshot.exists) fail(`Missing categories/${CATEGORY_ID}.`);
  const category = categorySnapshot.data() || {};
  if (
    category.code !== CATEGORY_ID
    || category.name !== 'FOR TWO'
    || category.isActive !== true
    || category.defaultPrepStation !== 'KITCHEN'
  ) {
    fail('The canonical FOR TWO category changed.');
  }
}

function assertBaseSnapshot(snapshotSnapshot) {
  if (!snapshotSnapshot.exists) fail(`Missing publicMenuAvailability/${STORE_ID}.`);
  const snapshot = snapshotSnapshot.data() || {};
  if (snapshot.storeId !== STORE_ID || snapshot.storeCode !== STORE_ID) {
    fail('The public snapshot store identity changed.');
  }
  for (const [field, value] of Object.entries(BASE_COUNTS)) {
    if (Number(snapshot[field]) !== value) fail(`Expected ${field}=${value}; found ${snapshot[field]}.`);
  }
  if (Object.keys(snapshot.items || {}).length !== BASE_COUNTS.itemCount) fail('The current item verdict count changed.');
  if (Object.keys(snapshot.menuItems || {}).length !== BASE_COUNTS.itemCount) fail('The current public menu count changed.');
  if (snapshot.items?.[ITEM_ID] || snapshot.menuItems?.[ITEM_ID]) fail(`${ITEM_ID} already exists in the public snapshot.`);
  return snapshot;
}

function assertAppliedSnapshot(snapshotSnapshot, itemSnapshot) {
  if (!snapshotSnapshot.exists || !itemSnapshot.exists) fail('The applied Bond Table state is incomplete.');
  const snapshot = snapshotSnapshot.data() || {};
  const item = itemSnapshot.data() || {};
  const expectedCounts = {
    itemCount: BASE_COUNTS.itemCount + 1,
    availableCount: BASE_COUNTS.availableCount + 1,
    unavailableCount: BASE_COUNTS.unavailableCount,
  };
  for (const [field, value] of Object.entries(expectedCounts)) {
    if (Number(snapshot[field]) !== value) fail(`Expected applied ${field}=${value}; found ${snapshot[field]}.`);
  }
  if (hash(snapshot.items?.[ITEM_ID]) !== hash(publicAvailability)) fail('The public availability entry drifted.');
  if (hash(snapshot.menuItems?.[ITEM_ID]) !== hash(publicMenuItem)) fail('The public menu entry drifted.');
  const itemWithoutTimestamps = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== 'createdAt' && key !== 'updatedAt'),
  );
  if (hash(itemWithoutTimestamps) !== hash(finishedGood)) fail('The Finished Good drifted from the approved payload.');
  return snapshot;
}

function assertQuarantinedSnapshot(snapshotSnapshot, itemSnapshot) {
  if (!snapshotSnapshot.exists || !itemSnapshot.exists) fail('The quarantined Bond Table state is incomplete.');
  const snapshot = snapshotSnapshot.data() || {};
  const expectedCounts = {
    itemCount: BASE_COUNTS.itemCount + 1,
    availableCount: BASE_COUNTS.availableCount,
    unavailableCount: BASE_COUNTS.unavailableCount + 1,
  };
  for (const [field, value] of Object.entries(expectedCounts)) {
    if (Number(snapshot[field]) !== value) fail(`Expected quarantined ${field}=${value}; found ${snapshot[field]}.`);
  }
  if (hash(snapshot.items?.[ITEM_ID]) !== hash(quarantinedPublicAvailability)) {
    fail('The quarantined public availability entry drifted.');
  }
  if (hash(snapshot.menuItems?.[ITEM_ID]) !== hash(quarantinedPublicMenuItem)) {
    fail('The quarantined public menu entry drifted.');
  }
  const itemWithoutTimestamps = Object.fromEntries(
    Object.entries(itemSnapshot.data() || {}).filter(([key]) => key !== 'createdAt' && key !== 'updatedAt'),
  );
  if (hash(itemWithoutTimestamps) !== hash(finishedGood)) {
    fail('The retained Finished Good drifted from the approved payload.');
  }
  return snapshot;
}

function stateGuard(storeSnapshot, categorySnapshot, itemSnapshot, snapshotSnapshot) {
  return hash({
    projectId: PRODUCTION_PROJECT_ID,
    store: storeSnapshot.data() || null,
    storeUpdateTime: storeSnapshot.updateTime?.toDate().toISOString() || null,
    category: categorySnapshot.data() || null,
    categoryUpdateTime: categorySnapshot.updateTime?.toDate().toISOString() || null,
    item: itemSnapshot.exists ? itemSnapshot.data() : null,
    itemUpdateTime: itemSnapshot.updateTime?.toDate().toISOString() || null,
    snapshot: snapshotSnapshot.data() || null,
    snapshotUpdateTime: snapshotSnapshot.updateTime?.toDate().toISOString() || null,
  });
}

async function readState(db) {
  const targetRefs = refs(db);
  const [store, category, item, snapshot] = await Promise.all([
    targetRefs.store.get(),
    targetRefs.category.get(),
    targetRefs.item.get(),
    targetRefs.snapshot.get(),
  ]);
  return { targetRefs, store, category, item, snapshot };
}

async function dryRun(db) {
  const state = await readState(db);
  assertStoreAndCategory(state.store, state.category);
  if (state.item.exists) {
    const snapshot = state.snapshot.data() || {};
    if (snapshot.items?.[ITEM_ID]?.available === true) {
      assertAppliedSnapshot(state.snapshot, state.item);
      console.log('MODE=APPLIED_STATE_DRY_RUN');
      console.log(`ROLLBACK_GUARD=${stateGuard(state.store, state.category, state.item, state.snapshot)}`);
      console.log('PRODUCTION_WRITES=0');
      return;
    }
    assertQuarantinedSnapshot(state.snapshot, state.item);
    console.log('MODE=QUARANTINED_STATE_DRY_RUN');
    console.log('NEW_CHECKOUTS_BLOCKED=YES');
    console.log('FINISHED_GOOD_RETAINED_FOR_EXISTING_ORDERS=YES');
    console.log('PRODUCTION_WRITES=0');
    return;
  }
  assertBaseSnapshot(state.snapshot);
  console.log('MODE=DRY_RUN');
  console.log(`ITEM_PATH=finishedGoods/${ITEM_ID}`);
  console.log(`SNAPSHOT_PATH=publicMenuAvailability/${STORE_ID}`);
  console.log('PROJECTED_COUNTS=22/19/3');
  console.log(`APPLY_GUARD=${stateGuard(state.store, state.category, state.item, state.snapshot)}`);
  console.log('PRODUCTION_WRITES=0');
}

async function apply(db) {
  const expectedGuard = argument('--guard');
  const targetRefs = refs(db);
  let before;
  await db.runTransaction(async (transaction) => {
    const [store, category, item, snapshot] = await Promise.all([
      transaction.get(targetRefs.store),
      transaction.get(targetRefs.category),
      transaction.get(targetRefs.item),
      transaction.get(targetRefs.snapshot),
    ]);
    assertStoreAndCategory(store, category);
    if (item.exists) fail(`finishedGoods/${ITEM_ID} already exists.`);
    const beforeSnapshot = assertBaseSnapshot(snapshot);
    if (stateGuard(store, category, item, snapshot) !== expectedGuard) {
      fail('The production state changed after dry run. Re-run dry run; no write was made.');
    }
    before = {
      items: beforeSnapshot.items || {},
      menuItems: beforeSnapshot.menuItems || {},
      addOnGroups: beforeSnapshot.addOnGroups || {},
    };
    transaction.create(targetRefs.item, {
      ...finishedGood,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(targetRefs.snapshot, {
      [`items.${ITEM_ID}`]: publicAvailability,
      [`menuItems.${ITEM_ID}`]: publicMenuItem,
      itemCount: BASE_COUNTS.itemCount + 1,
      availableCount: BASE_COUNTS.availableCount + 1,
      unavailableCount: BASE_COUNTS.unavailableCount,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'bond-table-simple-item-release',
      updatedByName: 'Owner-approved Bond Table activation',
    });
  });

  const after = await readState(db);
  assertStoreAndCategory(after.store, after.category);
  const appliedSnapshot = assertAppliedSnapshot(after.snapshot, after.item);
  const remainingItems = { ...(appliedSnapshot.items || {}) };
  const remainingMenuItems = { ...(appliedSnapshot.menuItems || {}) };
  delete remainingItems[ITEM_ID];
  delete remainingMenuItems[ITEM_ID];
  if (
    hash(remainingItems) !== hash(before.items)
    || hash(remainingMenuItems) !== hash(before.menuItems)
    || hash(appliedSnapshot.addOnGroups || {}) !== hash(before.addOnGroups)
  ) {
    fail('Post-write verification found an unrelated public-menu change. Run the guarded rollback immediately.');
  }
  console.log('MODE=LIVE_APPLY');
  console.log(`CREATED=finishedGoods/${ITEM_ID}`);
  console.log(`UPDATED=publicMenuAvailability/${STORE_ID}`);
  console.log('VERIFIED_COUNTS=22/19/3');
  console.log('OTHER_MENU_ITEMS_CHANGED=0');
  console.log(`ROLLBACK_GUARD=${stateGuard(after.store, after.category, after.item, after.snapshot)}`);
  console.log('PRODUCTION_WRITES=2');
}

async function rollback(db) {
  const expectedGuard = argument('--guard');
  const targetRefs = refs(db);
  await db.runTransaction(async (transaction) => {
    const [store, category, item, snapshot] = await Promise.all([
      transaction.get(targetRefs.store),
      transaction.get(targetRefs.category),
      transaction.get(targetRefs.item),
      transaction.get(targetRefs.snapshot),
    ]);
    assertStoreAndCategory(store, category);
    assertAppliedSnapshot(snapshot, item);
    if (stateGuard(store, category, item, snapshot) !== expectedGuard) {
      fail('The applied production state drifted. Manual review is required; no rollback write was made.');
    }
    // Safe rollback is a quarantine, not deletion. An explicit unavailable verdict
    // blocks both new checkout paths (including stale clients), while the active
    // canonical Finished Good remains available for acceptance/recovery of any
    // session or paid order already in flight.
    transaction.update(targetRefs.snapshot, {
      [`items.${ITEM_ID}`]: quarantinedPublicAvailability,
      [`menuItems.${ITEM_ID}`]: quarantinedPublicMenuItem,
      itemCount: BASE_COUNTS.itemCount + 1,
      availableCount: BASE_COUNTS.availableCount,
      unavailableCount: BASE_COUNTS.unavailableCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'bond-table-simple-item-rollback',
      updatedByName: 'Guarded Bond Table quarantine',
    });
  });
  const after = await readState(db);
  assertQuarantinedSnapshot(after.snapshot, after.item);
  console.log('MODE=LIVE_SAFE_QUARANTINE');
  console.log(`RETAINED_ACTIVE=finishedGoods/${ITEM_ID}`);
  console.log(`UPDATED=publicMenuAvailability/${STORE_ID}`);
  console.log('VERIFIED_COUNTS=22/18/4');
  console.log('NEW_CHECKOUTS_BLOCKED=YES');
  console.log('EXISTING_ORDER_RECOVERY_PRESERVED=YES');
  console.log('FINISHED_GOOD_DELETE_REQUIRES_SEPARATE_ZERO_REFERENCE_AUDIT=YES');
}

async function main() {
  assertProject();
  console.log(`TARGET_PROJECT=${PRODUCTION_PROJECT_ID}`);
  console.log('TARGET_IS_PRODUCTION=YES');
  const app = initializeApp({ credential: applicationDefault(), projectId: PRODUCTION_PROJECT_ID }, `bond-table-${Date.now()}`);
  try {
    const db = getFirestore(app);
    if (ROLLBACK) await rollback(db);
    else if (APPLY) await apply(db);
    else await dryRun(db);
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
