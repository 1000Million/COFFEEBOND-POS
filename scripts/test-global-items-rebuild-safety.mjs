#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const globalItems = read('frontend/pages/admin/GlobalItems.tsx');
const publishEngine = read('frontend/lib/globalItemPublish.ts');
const availability = read('frontend/lib/publicMenuAvailability.ts');
const productImages = read('frontend/pages/admin/ProductImages.tsx');
const posReadiness = read('frontend/pages/admin/POSReadiness.tsx');
const legacyRefresh = read('scripts/refresh-public-menu-availability.mjs');

let checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
}

ok(
  globalItems.includes("getDocs(collection(db, 'finishedGoods'))")
    && !globalItems.includes("orderBy('name'")
    && !globalItems.includes('orderBy("name"')
    && globalItems.includes('name: String(data.name || data.displayName || data.code || row.id)'),
  'Global Items reads the complete catalogue, including legacy rows without a name field',
);
ok(
  availability.includes('name: item.name || item.displayName || item.code'),
  'Public snapshots never write an undefined legacy item name',
);
ok(
  publishEngine.includes("snapshotRef = doc(firestore, 'publicMenuAvailability', store.code)")
    && publishEngine.includes('runTransaction(firestore, async (transaction) =>')
    && publishEngine.includes('snapshotRevisionToken(')
    && publishEngine.includes('transaction.set(plan.snapshotRef')
    && !publishEngine.includes('{ merge: true }'),
  'Global Items engine transactionally replaces every selected complete snapshot behind a concurrency revision gate',
);
ok(
  publishEngine.includes("getDocs(collection(firestore, 'finishedGoods'))")
    && publishEngine.includes("getDocs(collection(firestore, STORE_ITEM_CONFIG_COLLECTION))")
    && publishEngine.includes('canonicalDataToken(liveBase.data()) !== expectedBaseToken')
    && publishEngine.includes('liveSnapshotToken !== plan.expectedSnapshotRevision'),
  'Global Items engine re-reads catalogue, config, base, and snapshot sources instead of publishing cached page state',
);
ok(
  availability.includes('storeItemConfigs?: StoreItemConfig[]')
    && availability.includes('storeItemConfigByItemCode(store.id, input.storeItemConfigs)'),
  'The canonical snapshot builder accepts and resolves the selected store overrides',
);
ok(
  productImages.includes("getDocs(collection(db, 'finishedGoods'))")
    && productImages.includes('setStoreItemConfigs(')
    && productImages.includes('storeItemConfigs,')
    && productImages.includes('String(a.displayName || a.name || a.code).localeCompare')
    && productImages.includes('name: String(data.name || data.displayName || data.code || snap.id)'),
  'Product Images keeps full-store rebuilds complete and override-aware',
);
ok(
  posReadiness.includes('storeItemConfigs: StoreItemConfig[]')
    && posReadiness.includes('storeItemConfigs: freshData.storeItemConfigs')
    && posReadiness.includes('const freshData = await loadReadinessData(true)')
    && posReadiness.includes('snapshotRevisionToken(')
    && posReadiness.includes('runTransaction(db, async (transaction) =>')
    && /transaction\.set\(snapshotRef, \{[\s\S]*?updatedByName: staffName,[\s\S]*?\}\);/.test(posReadiness)
    && !/transaction\.set\(snapshotRef,[\s\S]{0,300}\{\s*merge:\s*true\s*\}/.test(posReadiness),
  'POS Readiness re-reads sources, resolves overrides, and transactionally replaces the complete snapshot behind a revision gate',
);
ok(
  legacyRefresh.includes("firestore.collection('storeItemConfig').where('storeId', '==', targetStore.id).limit(1).get()")
    && legacyRefresh.includes('has Global Items overrides')
    && legacyRefresh.includes("canonicalJson(current?.items || {}) !== canonicalJson(next.items || {})")
    && legacyRefresh.includes("canonicalJson(current?.menuItems || {}) !== canonicalJson(next.menuItems || {})")
    && !/updatedByName: 'Public menu refresh script',[\s\S]{0,80}\}, \{ merge: true \}\);/.test(legacyRefresh),
  'The legacy refresh script detects complete map changes, fully replaces snapshots, and refuses stores with overrides',
);

console.log(`\n${checks} Global Items rebuild-safety checks passed.`);
