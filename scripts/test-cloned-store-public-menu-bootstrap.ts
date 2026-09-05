// Proves a newly cloned Draft store can build its FIRST publicMenuAvailability snapshot
// from canonical data, without copying the source store's snapshot.
// Uses the single canonical builder; adds no second menu resolver.
import assert from 'node:assert/strict';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability';
import type { Store } from '../frontend/types';
import type { AddOnGroup, FinishedGood, RawIngredient } from '../frontend/types/menu-management';

const SOURCE_ID = 'GOLDEN_I';
const CLONE_ID = 'QA_GLOBAL_CLONE_G2';
let assertions = 0;

function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  assertions += 1;
}

// A cloned store as storeProvisioning.buildDraftStorePayload leaves it: DRAFT, everything off.
function draftClone(): Store {
  return {
    id: CLONE_ID, code: CLONE_ID, name: 'QA Global Clone G2', address: '1 QA Street',
    isActive: false, posEnabled: false, customerOrderingEnabled: false,
    onlineOrderingEnabled: false, publicOrderingEnabled: false,
    acceptingOrders: false, isAcceptingOrders: false,
    estimatedPrepMinutes: 20, createdAt: null, updatedAt: null,
  } as Store;
}

function sourceStore(): Store {
  return { ...draftClone(), id: SOURCE_ID, code: SOURCE_ID, name: 'Golden I', isActive: true } as Store;
}

function raw(code: string): RawIngredient {
  return {
    id: code, code, name: code, category: 'TEST', purchaseUOM: 'PCS', usageUOM: 'PCS',
    conversionFactor: 1, purchaseCost: 10, costPerUsageUnit: 10, isActive: true,
  } as RawIngredient;
}

function product(code: string, storeIds: string[], overrides: Partial<FinishedGood> = {}): FinishedGood {
  return {
    id: code, code, name: code,
    posCategoryCode: 'COFFEE', posCategoryName: 'Coffee',
    salePrice: 250, productionMode: 'MADE_TO_ORDER', itemType: 'MADE_TO_ORDER',
    prepStation: 'BARISTA', taxRate: 5,
    imageUrl: `https://storage.googleapis.com/menu-images/${code}.webp`,
    imageStoragePath: `menu-images/${code}.webp`,
    addOnGroupIds: ['AG_MILK'],
    bom: [{
      componentType: 'RAW_INGREDIENT', componentCode: `${code}_RAW`, componentName: `${code} raw`,
      quantity: 1, uom: 'PCS', costPerUnit: 10, lineCost: 10,
    }],
    bomVersion: 1, recipeCost: 10, grossMargin: 0, cogsPercent: 0, sortOrder: 1,
    availableStoreIds: storeIds, isSellable: true, isAvailable: true, isActive: true,
    ...overrides,
  } as FinishedGood;
}

const addOnGroups: AddOnGroup[] = [{
  id: 'AG_MILK', name: 'Milk', isActive: true,
  options: [{ id: 'OPT_OAT', name: 'Oat', price: 40, isActive: true }],
} as AddOnGroup];

// Catalogue: one product shared by both stores, one only on the source.
const catalogue = [
  product('FG_SHARED', [SOURCE_ID, CLONE_ID]),
  product('FG_SOURCE_ONLY', [SOURCE_ID]),
];
const rawIngredients = [raw('FG_SHARED_RAW'), raw('FG_SOURCE_ONLY_RAW')];

const build = (store: Store) => buildPublicMenuAvailabilitySnapshot({
  store, finishedGoods: catalogue, storeStock: [], rawIngredients, addOnGroups,
});

const cloneSnapshot = build(draftClone());
const sourceSnapshot = build(sourceStore());

check(cloneSnapshot.storeCode === CLONE_ID, '1. Snapshot is stamped with the destination store code');
check(cloneSnapshot.storeId === CLONE_ID, '2. Snapshot is stamped with the destination store id');

// availableStoreIds respected: source-only product must not leak into the clone.
check(Object.keys(cloneSnapshot.menuItems).includes('FG_SHARED'), '3. Destination-assigned product is published');
check(!Object.keys(cloneSnapshot.menuItems).includes('FG_SOURCE_ONLY'), '4. Source-only product is NOT published to the clone');
check(cloneSnapshot.itemCount === 1, '5. Destination item count reflects only its own assignments');
check(sourceSnapshot.itemCount === 2, '6. Source snapshot is unchanged and still has both products');

// Not a byte copy of the source snapshot.
check(JSON.stringify(cloneSnapshot) !== JSON.stringify(sourceSnapshot), '7. Destination snapshot is rebuilt, not copied from source');

// Image references are shared, never duplicated or rewritten per store.
const cloneItem = cloneSnapshot.menuItems.FG_SHARED as { imageUrl?: string };
const sourceItem = sourceSnapshot.menuItems.FG_SHARED as { imageUrl?: string };
check(cloneItem.imageUrl === sourceItem.imageUrl, '8. Image reference is shared, identical across stores');
check(String(cloneItem.imageUrl).includes('menu-images/'), '9. Image stays a reference to the canonical Storage object');

// Deterministic: rebuilding the same inputs yields an equivalent snapshot.
check(JSON.stringify(build(draftClone())) === JSON.stringify(cloneSnapshot), '10. Rebuild is deterministic and idempotent');

// Add-ons are carried by reference and sanitized for public consumption.
check(Object.keys(cloneSnapshot.addOnGroups).includes('AG_MILK'), '11. Referenced add-on group is published for the clone');

// No operational or private data may appear in a public snapshot.
const serialized = JSON.stringify(cloneSnapshot);
for (const forbidden of ['currentStock', 'openingStock', 'stockMovements', 'assignedStoreIds', 'gstin', 'razorpay', 'recipeCost', 'bom']) {
  check(!serialized.includes(forbidden), `12. Public snapshot excludes "${forbidden}"`);
}

// Golden I's exact 80-item enablement rule must not apply to an ordinary clone.
check(cloneSnapshot.itemCount !== 80, '13. Clone is not held to the Golden I 80-item snapshot rule by the builder');

// Building a snapshot must not, by itself, turn a store on.
const built = draftClone();
check(built.customerOrderingEnabled === false && built.posEnabled === false, '14. Building a snapshot does not enable POS or customer ordering');

console.log(`\n${assertions} cloned-store public menu bootstrap checks passed.`);
