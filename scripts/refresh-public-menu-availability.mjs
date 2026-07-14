#!/usr/bin/env node
import process from 'node:process';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const DEFAULT_STORE_CODE = 'GOLDEN_I';
const DEFAULT_SOURCE_STORE_CODE = 'NOIDA_29';
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

function readArgValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : fallback;
}

const TARGET_STORE_CODE = readArgValue('--store', DEFAULT_STORE_CODE);
const SOURCE_STORE_CODE = readArgValue('--source-store', DEFAULT_SOURCE_STORE_CODE);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function initializeAdmin() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required. This script is dry-run by default but still needs read access to inspect Firestore.');
  }

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

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function storeIdsFor(item) {
  return Array.isArray(item.availableStoreIds) ? item.availableStoreIds.filter(Boolean) : [];
}

function isAssignedToStore(item, storeId) {
  return storeIdsFor(item).includes(storeId);
}

function isActiveSellableAvailable(item, storeId) {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isAssignedToStore(item, storeId);
}

function isPubliclyDisplayable(item, storeId) {
  return isActiveSellableAvailable(item, storeId)
    && item.onlineOrderingEnabled !== false
    && item.customerOrderingEnabled !== false
    && toNumber(item.salePrice) > 0
    && ['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation);
}

function sanitizedDisplayItem(store, item) {
  const imageUrl = ['imageUrl', 'image', 'photoUrl', 'photo', 'thumbnailUrl', 'thumbnail']
    .map((key) => item[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0);

  const display = {
    id: item.code,
    code: item.code,
    name: item.name,
    posCategoryCode: item.posCategoryCode || 'MISC',
    posCategoryName: item.posCategoryName || 'Other',
    salePrice: toNumber(item.salePrice),
    prepStation: item.prepStation,
    itemType: item.itemType || 'MADE_TO_ORDER',
    sortOrder: toNumber(item.sortOrder),
    availableStoreIds: [store.id],
    isSellable: item.isSellable !== false,
    isAvailable: item.isAvailable !== false,
    isActive: item.isActive !== false,
  };

  if (item.displayName) display.displayName = item.displayName;
  if (item.description) display.description = item.description;
  if (item.productionMode) display.productionMode = item.productionMode;
  if (toNumber(item.taxRate) > 0) display.taxRate = toNumber(item.taxRate);
  if (imageUrl) display.imageUrl = imageUrl.trim();

  return display;
}

function sourceAvailabilityFor(sourceSnapshot, itemCode) {
  const item = sourceSnapshot?.items?.[itemCode];
  if (!item) {
    return {
      itemCode,
      fgCode: itemCode,
      available: true,
      publicStatus: 'AVAILABLE',
      publicMessage: 'Available',
    };
  }

  return {
    itemCode,
    fgCode: itemCode,
    available: item.available === true,
    publicStatus: item.available === true ? 'AVAILABLE' : (item.publicStatus || 'CURRENTLY_UNAVAILABLE'),
    publicMessage: item.available === true ? 'Available' : (item.publicMessage || 'Currently unavailable'),
  };
}

function unavailableItem(itemCode, status = 'CURRENTLY_UNAVAILABLE', message = 'Currently unavailable') {
  return {
    itemCode,
    fgCode: itemCode,
    available: false,
    publicStatus: status,
    publicMessage: message,
  };
}

function buildSnapshot({ targetStore, sourceSnapshot, finishedGoods }) {
  const visibleItems = finishedGoods
    .filter((item) => isActiveSellableAvailable(item.data, targetStore.id))
    .sort((a, b) => {
      const orderA = toNumber(a.data.sortOrder) || 999;
      const orderB = toNumber(b.data.sortOrder) || 999;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.data.displayName || a.data.name || a.id).localeCompare(String(b.data.displayName || b.data.name || b.id));
    });

  const items = {};
  const menuItems = {};

  for (const item of visibleItems) {
    const itemCode = item.data.code || item.id;
    if (targetStore.data.onlineOrderingEnabled === false) {
      items[itemCode] = unavailableItem(itemCode, 'STORE_DISABLED', 'Online ordering unavailable for this store');
    } else if (!isPubliclyDisplayable(item.data, targetStore.id)) {
      items[itemCode] = unavailableItem(itemCode);
    } else {
      items[itemCode] = sourceAvailabilityFor(sourceSnapshot, itemCode);
    }
    menuItems[itemCode] = sanitizedDisplayItem(targetStore, item.data);
  }

  const availabilityValues = Object.values(items);
  return {
    storeId: targetStore.id,
    storeCode: targetStore.data.code || targetStore.id,
    storeName: targetStore.data.name || targetStore.id,
    items,
    menuItems,
    itemCount: availabilityValues.length,
    availableCount: availabilityValues.filter((item) => item.available).length,
    unavailableCount: availabilityValues.filter((item) => !item.available).length,
  };
}

function snapshotCount(snapshot, key) {
  const value = snapshot?.[key];
  return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

function diffSnapshot(current, next) {
  const currentItemCount = snapshotCount(current, 'menuItems');
  const nextItemCount = snapshotCount(next, 'menuItems');
  const currentAvailable = toNumber(current?.availableCount);
  const currentUnavailable = toNumber(current?.unavailableCount);

  return {
    needsWrite: !current
      || currentItemCount !== nextItemCount
      || currentAvailable !== next.availableCount
      || currentUnavailable !== next.unavailableCount
      || current?.storeId !== next.storeId
      || current?.storeCode !== next.storeCode,
    currentItemCount,
    nextItemCount,
    currentAvailable,
    nextAvailable: next.availableCount,
    currentUnavailable,
    nextUnavailable: next.unavailableCount,
  };
}

async function main() {
  const firestore = initializeAdmin();
  const [targetStore, sourceStore] = await Promise.all([
    getStoreByIdOrCode(firestore, TARGET_STORE_CODE),
    getStoreByIdOrCode(firestore, SOURCE_STORE_CODE),
  ]);

  if (!targetStore) fail(`Target store not found: ${TARGET_STORE_CODE}`);
  if (!sourceStore) fail(`Source store not found: ${SOURCE_STORE_CODE}`);

  const [finishedSnap, targetAvailabilitySnap, sourceAvailabilitySnap] = await Promise.all([
    firestore.collection('finishedGoods').get(),
    firestore.collection('publicMenuAvailability').doc(targetStore.data.code || targetStore.id).get(),
    firestore.collection('publicMenuAvailability').doc(sourceStore.data.code || sourceStore.id).get(),
  ]);

  const finishedGoods = finishedSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  const sourceSnapshot = sourceAvailabilitySnap.exists ? sourceAvailabilitySnap.data() || {} : null;
  const currentSnapshot = targetAvailabilitySnap.exists ? targetAvailabilitySnap.data() || {} : null;
  const nextSnapshot = buildSnapshot({ targetStore, sourceSnapshot, finishedGoods });
  const diff = diffSnapshot(currentSnapshot, nextSnapshot);
  const targetPath = `publicMenuAvailability/${targetStore.data.code || targetStore.id}`;

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`Target store: ${targetStore.data.name || targetStore.id} (${targetStore.data.code || targetStore.id}, doc ${targetStore.id})`);
  console.log(`Source availability template: ${sourceStore.data.name || sourceStore.id} (${sourceStore.data.code || sourceStore.id})`);
  console.log(`Target onlineOrderingEnabled: ${targetStore.data.onlineOrderingEnabled !== false}`);
  console.log(`Target document: ${targetPath}`);
  console.log('');
  console.log(`Existing public menu items: ${diff.currentItemCount}`);
  console.log(`Projected public menu items: ${diff.nextItemCount}`);
  console.log(`Existing available/unavailable: ${diff.currentAvailable}/${diff.currentUnavailable}`);
  console.log(`Projected available/unavailable: ${diff.nextAvailable}/${diff.nextUnavailable}`);
  console.log(`Record affected: ${diff.needsWrite ? targetPath : 'none'}`);
  console.log('Sanitized fields only: itemCode, fgCode, available, publicStatus, publicMessage, public display menu fields.');
  console.log('Internal data excluded: recipes, BOM, costs, inventory quantities, staff data, storeStock, stockMovements.');
  console.log('');

  if (!diff.needsWrite) {
    console.log('No write is needed. Public menu availability is already aligned.');
    return;
  }

  if (DRY_RUN) {
    console.log(`Dry run complete. To write this single sanitized snapshot, run with --apply.`);
    return;
  }

  await firestore.collection('publicMenuAvailability').doc(targetStore.data.code || targetStore.id).set({
    ...nextSnapshot,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'admin-script',
    updatedByName: 'Public menu refresh script',
  }, { merge: true });

  console.log(`Wrote ${targetPath}. Public items: ${nextSnapshot.itemCount}, available: ${nextSnapshot.availableCount}, unavailable: ${nextSnapshot.unavailableCount}.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
