#!/usr/bin/env node
import process from 'node:process';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const TARGET_STORE_CODE = 'GOLDEN_I';
const DEFAULT_SOURCE_STORE_CODE = 'NOIDA_29';
const DRY_RUN = process.argv.includes('--dry-run');
const GOOGLE_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

function readArgValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : fallback;
}

const SOURCE_STORE_CODE = readArgValue('--source-store', DEFAULT_SOURCE_STORE_CODE);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function requireRuntimeEnv() {
  if (!GOOGLE_CREDENTIALS) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required. Point it to your local Firebase service-account JSON before running.');
  }
}

function initializeAdmin() {
  const app = getApps().length > 0
    ? getApp()
    : initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });

  return getFirestore(app);
}

async function getStoreByIdOrCode(firestore, idOrCode) {
  const direct = await firestore.collection('stores').doc(idOrCode).get();
  if (direct.exists) {
    return { id: direct.id, ref: direct.ref, data: direct.data() || {} };
  }

  const byCode = await firestore.collection('stores')
    .where('code', '==', idOrCode)
    .limit(1)
    .get();

  if (byCode.empty) return null;
  const doc = byCode.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() || {} };
}

function isActive(item) {
  return item.isActive !== false;
}

function isSellable(item) {
  return item.isSellable !== false;
}

function isAvailable(item) {
  return item.isAvailable !== false;
}

function storeIdsFor(item) {
  return Array.isArray(item.availableStoreIds) ? item.availableStoreIds.filter(Boolean) : [];
}

function isAssignedToStore(item, storeId) {
  return storeIdsFor(item).includes(storeId);
}

function isPosVisibleForStore(item, storeId) {
  return isActive(item) && isSellable(item) && isAvailable(item) && isAssignedToStore(item, storeId);
}

function summarizeStoreMenu(finishedGoods, store) {
  const assigned = finishedGoods.filter((item) => isAssignedToStore(item.data, store.id));
  const active = assigned.filter((item) => isActive(item.data));
  const sellable = active.filter((item) => isSellable(item.data));
  const posVisible = sellable.filter((item) => isAvailable(item.data));

  return {
    storeId: store.id,
    storeCode: store.data.code || store.id,
    storeName: store.data.name || store.id,
    assignedCount: assigned.length,
    activeCount: active.length,
    sellableCount: sellable.length,
    posVisibleCount: posVisible.length,
  };
}

function itemLabel(item) {
  return `${item.data.code || item.id} — ${item.data.displayName || item.data.name || item.id}`;
}

function printSummary(summary) {
  console.log(
    `${summary.storeCode} (${summary.storeId}): assigned=${summary.assignedCount}, active=${summary.activeCount}, sellable=${summary.sellableCount}, POS-visible=${summary.posVisibleCount}`,
  );
}

async function main() {
  requireRuntimeEnv();
  const firestore = initializeAdmin();

  const [sourceStore, targetStore] = await Promise.all([
    getStoreByIdOrCode(firestore, SOURCE_STORE_CODE),
    getStoreByIdOrCode(firestore, TARGET_STORE_CODE),
  ]);

  if (!sourceStore) fail(`Source store not found: ${SOURCE_STORE_CODE}`);
  if (!targetStore) fail(`Target store not found: ${TARGET_STORE_CODE}. Create stores/GOLDEN_I first.`);

  const comparisonStores = [];
  for (const code of ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51', TARGET_STORE_CODE]) {
    const store = await getStoreByIdOrCode(firestore, code);
    if (store) comparisonStores.push(store);
  }

  const finishedSnap = await firestore.collection('finishedGoods').get();
  const finishedGoods = finishedSnap.docs.map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  }));

  const sourceVisibleItems = finishedGoods
    .filter((item) => isPosVisibleForStore(item.data, sourceStore.id))
    .sort((a, b) => {
      const orderA = typeof a.data.sortOrder === 'number' ? a.data.sortOrder : 999;
      const orderB = typeof b.data.sortOrder === 'number' ? b.data.sortOrder : 999;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.data.displayName || a.data.name || a.id).localeCompare(String(b.data.displayName || b.data.name || b.id));
    });

  const alreadyConfigured = [];
  const toUpdate = [];
  const skippedSourceAssigned = [];

  for (const item of finishedGoods) {
    if (isAssignedToStore(item.data, sourceStore.id) && !isPosVisibleForStore(item.data, sourceStore.id)) {
      skippedSourceAssigned.push(item);
    }
  }

  for (const item of sourceVisibleItems) {
    if (isAssignedToStore(item.data, targetStore.id)) {
      alreadyConfigured.push(item);
    } else {
      toUpdate.push(item);
    }
  }

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`Source store: ${sourceStore.data.name || sourceStore.id} (${sourceStore.data.code || sourceStore.id}, doc ${sourceStore.id})`);
  console.log(`Target store: ${targetStore.data.name || targetStore.id} (${targetStore.data.code || targetStore.id}, doc ${targetStore.id})`);
  console.log(`Target public ordering: onlineOrderingEnabled=${targetStore.data.onlineOrderingEnabled === false ? 'false' : String(targetStore.data.onlineOrderingEnabled)}`);
  console.log('');
  console.log('Existing store menu counts:');
  comparisonStores.map((store) => summarizeStoreMenu(finishedGoods, store)).forEach(printSummary);
  console.log('');
  console.log(`Source POS-visible item count: ${sourceVisibleItems.length}`);
  console.log(`Items to add to ${targetStore.id}: ${toUpdate.length}`);
  console.log(`Items already configured for ${targetStore.id}: ${alreadyConfigured.length}`);
  console.log(`Disabled/skipped source-assigned items: ${skippedSourceAssigned.length}`);
  console.log('Stock records created: 0');
  console.log('Public availability snapshot written: no');
  console.log('');

  if (toUpdate.length > 0) {
    console.log('Items to enable for Golden I:');
    toUpdate.forEach((item) => console.log(`  + ${itemLabel(item)}`));
    console.log('');
  }

  if (skippedSourceAssigned.length > 0) {
    console.log('Source-assigned items skipped because they are inactive, unsellable, or unavailable:');
    skippedSourceAssigned.slice(0, 40).forEach((item) => console.log(`  - ${itemLabel(item)}`));
    if (skippedSourceAssigned.length > 40) {
      console.log(`  ...and ${skippedSourceAssigned.length - 40} more`);
    }
    console.log('');
  }

  if (targetStore.data.onlineOrderingEnabled !== false) {
    console.log('WARNING: Target store onlineOrderingEnabled is not false. This script will not change it.');
  }

  if (DRY_RUN) {
    console.log('Dry run complete. No writes were performed.');
    return;
  }

  let batch = firestore.batch();
  let operationCount = 0;
  let updatedCount = 0;

  for (const item of toUpdate) {
    const nextAvailableStoreIds = [...new Set([...storeIdsFor(item.data), targetStore.id])];
    batch.set(item.ref, {
      availableStoreIds: nextAvailableStoreIds,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    operationCount++;
    updatedCount++;

    if (operationCount === 450) {
      await batch.commit();
      batch = firestore.batch();
      operationCount = 0;
    }
  }

  if (operationCount > 0) {
    await batch.commit();
  }

  console.log(`Live run complete. Updated finishedGoods: ${updatedCount}. Already configured: ${alreadyConfigured.length}. Stock rows created: 0.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
