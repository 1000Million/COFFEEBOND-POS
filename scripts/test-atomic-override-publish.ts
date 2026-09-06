// G4.1: one Admin save must make the private override and complete customer-menu snapshot visible
// together. Pure planner tests — no Firestore, no network.
import assert from 'node:assert/strict';
import {
  buildOverridePublishPlan, emptyDraft, projectStoreConfigsAfterPlan, buildOverrideWritePlan,
} from '../frontend/lib/storeItemConfigAdmin';
import { type StoreItemConfig } from '../frontend/lib/storeItemConfig';
import type { Store } from '../frontend/types';
import type { FinishedGood, RawIngredient } from '../frontend/types/menu-management';

const GOLDEN = 'GOLDEN_I';
const NOIDA = 'NOIDA_29';
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

const store = (id: string): Store & { id: string } => ({
  id, code: id, name: id, address: 'a', isActive: true, posEnabled: true,
  customerOrderingEnabled: true, onlineOrderingEnabled: true, publicOrderingEnabled: true,
  acceptingOrders: true, isAcceptingOrders: true,
} as Store & { id: string });

const raw = (code: string) => ({ id: code, code, name: code, category: 'T', purchaseUOM: 'PCS', usageUOM: 'PCS', conversionFactor: 1, purchaseCost: 1, costPerUsageUnit: 1, isActive: true } as RawIngredient);

const fg = (code: string, extra: Partial<FinishedGood> = {}): FinishedGood => ({
  id: code, code, name: code, posCategoryCode: 'COFFEE', posCategoryName: 'Coffee',
  salePrice: 350, productionMode: 'MADE_TO_ORDER', itemType: 'MADE_TO_ORDER',
  prepStation: 'BARISTA', taxRate: 5,
  imageUrl: `https://storage.googleapis.com/menu-images/${code}.webp`,
  imageStoragePath: `menu-images/${code}.webp`,
  addOnGroupIds: [],
  bom: [{ componentType: 'RAW_INGREDIENT', componentCode: `${code}_R`, componentName: 'r', quantity: 1, uom: 'PCS', costPerUnit: 1, lineCost: 1 }],
  bomVersion: 1, recipeCost: 1, grossMargin: 0, cogsPercent: 0, sortOrder: 20,
  availableStoreIds: [GOLDEN, NOIDA], isSellable: true, isAvailable: true, isActive: true,
  ...extra,
} as FinishedGood);

const CATALOGUE = [fg('BOND_FRAPPE')];
const RAWS = [raw('BOND_FRAPPE_R')];

const publish = (opts: {
  storeId?: string; draft: ReturnType<typeof emptyDraft>;
  existing?: StoreItemConfig | null; storeConfigs?: StoreItemConfig[];
  catalogue?: FinishedGood[];
}) => buildOverridePublishPlan({
  store: store(opts.storeId || GOLDEN),
  itemCode: 'BOND_FRAPPE',
  draft: opts.draft,
  existing: opts.existing ?? null,
  storeConfigs: opts.storeConfigs || [],
  finishedGoods: opts.catalogue || CATALOGUE,
  rawIngredients: RAWS,
  updatedBy: 'admin-uid',
});


// ---- PRICE OVERRIDE: one plan carries override + full snapshot -------------------------------
const dPrice = emptyDraft(); dPrice.price = { mode: 'OVERRIDE', value: '375' };
const pubPrice = publish({ draft: dPrice });
eq(pubPrice.overridePlan.action, 'SET', 'A1. Price override plans a SET on storeItemConfig');
eq(pubPrice.snapshotDocId, GOLDEN, 'A2. Snapshot is keyed by store CODE');
eq(pubPrice.snapshot.menuItems.BOND_FRAPPE.salePrice, 375, 'A3. Snapshot built in the SAME plan already carries 375');
eq(pubPrice.snapshot.storeCode, GOLDEN, 'A6. Snapshot is stamped with the destination store');

// ---- INHERIT: delete + snapshot back to global, atomically -------------------------
const existing: StoreItemConfig = { storeId: GOLDEN, itemCode: 'BOND_FRAPPE', priceOverride: 375 };
const pubInherit = publish({ draft: emptyDraft(), existing, storeConfigs: [existing] });
eq(pubInherit.overridePlan.action, 'DELETE', 'B1. Returning to Inherit plans a DELETE');
eq(pubInherit.projectedConfigs.length, 0, 'B2. Projected state has no override row');
eq(pubInherit.snapshot.menuItems.BOND_FRAPPE.salePrice, 350, 'B3. Snapshot in the same plan is already back to the global 350');

// ---- AVAILABILITY --------------------------------------------------------------------
const dAvail = emptyDraft(); dAvail.availability = { mode: 'OVERRIDE', value: false };
const pubAvail = publish({ draft: dAvail });
eq(pubAvail.snapshot.items.BOND_FRAPPE.available, false, 'C1. Customer snapshot marks the item unavailable in the same save');

// ---- CUSTOMER VISIBILITY removes the public item ---------------------------------------------
const dVis = emptyDraft(); dVis.menuVisibility = { mode: 'OVERRIDE', value: false };
const pubVis = publish({ draft: dVis });
ok(!Object.keys(pubVis.snapshot.menuItems).includes('BOND_FRAPPE'), 'D1. Hidden item is absent from the customer snapshot');

// ---- SORT ORDER ----------------------------------------------------------------------------
const dSort = emptyDraft(); dSort.sortOrder = { mode: 'OVERRIDE', value: '0' };
const pubSort = publish({ draft: dSort });
eq(pubSort.snapshot.menuItems.BOND_FRAPPE.sortOrder, 0, 'E. Sort order 0 reaches the snapshot in the same save');

// ---- TWO-STORE ISOLATION ------------------------------------------------------------------------
const goldenCfg = (pubPrice.overridePlan as any).data as StoreItemConfig;
const pubNoida = publish({ storeId: NOIDA, draft: emptyDraft(), storeConfigs: [] });
eq(pubNoida.snapshot.menuItems.BOND_FRAPPE.salePrice, 350, 'F1. Noida snapshot stays on the global 350');
eq(pubNoida.snapshotDocId, NOIDA, 'F3. Each store publishes to its own snapshot document');
eq(CATALOGUE[0].salePrice, 350, 'F4. The global finishedGood is never mutated');

// ---- projection helper --------------------------------------------------------------------------
const other: StoreItemConfig = { storeId: GOLDEN, itemCode: 'OTHER_ITEM', priceOverride: 99 };
const setPlan = buildOverrideWritePlan({ storeId: GOLDEN, itemCode: 'BOND_FRAPPE', draft: dPrice, existing: null, updatedBy: 'x' });
eq(projectStoreConfigsAfterPlan([other], 'BOND_FRAPPE', setPlan).length, 2, 'G1. Projection keeps other items’ overrides');
const delPlan = buildOverrideWritePlan({ storeId: GOLDEN, itemCode: 'BOND_FRAPPE', draft: emptyDraft(), existing, updatedBy: 'x' });
eq(projectStoreConfigsAfterPlan([other, existing], 'BOND_FRAPPE', delPlan).map(c => c.itemCode), ['OTHER_ITEM'], 'G2. Projection removes only the edited item');

// ---- STRUCTURAL BLOCKING still wins inside the same transaction ---------------------------------------
const brokenCatalogue = [fg('BOND_FRAPPE', { bom: [] })];
const dForce = emptyDraft();
dForce.availability = { mode: 'OVERRIDE', value: true };
dForce.price = { mode: 'OVERRIDE', value: '500' };
const pubBroken = buildOverridePublishPlan({
  store: store(NOIDA), itemCode: 'BOND_FRAPPE', draft: dForce, existing: null,
  storeConfigs: [], finishedGoods: brokenCatalogue, rawIngredients: RAWS, updatedBy: 'admin-uid',
});
eq(pubBroken.snapshot.items.BOND_FRAPPE.publicStatus, 'SETUP_INCOMPLETE', 'H. An override cannot publish a BOM-invalid item as sellable');

// ---- BUILDER FAILURE => NOTHING TO WRITE -----------------------------------------------------------------
let threw = false;
try {
  buildOverridePublishPlan({
    store: { ...store(GOLDEN), code: '' } as Store & { id: string },
    itemCode: 'BOND_FRAPPE', draft: dPrice, existing: null, storeConfigs: [],
    finishedGoods: CATALOGUE, rawIngredients: RAWS, updatedBy: 'admin-uid',
  });
} catch (e) { threw = true; ok(/store code/.test(String((e as Error).message)), 'I1. A store with no code fails loudly before any write is attempted'); }
ok(threw, 'I2. Planning throws rather than returning a half-built publish');

// ---- snapshot preserves global references ---------------------------------------------------------------------
const item = pubPrice.snapshot.menuItems.BOND_FRAPPE as { imageUrl?: string; taxRate?: number };
eq(item.imageUrl, CATALOGUE[0].imageUrl, 'J1. Image reference preserved in the published snapshot');
eq(item.taxRate, 5, 'J2. GST item rate preserved in the published snapshot');
ok(!('priceOverride' in (pubPrice.snapshot.menuItems.BOND_FRAPPE as object)), 'J3. Snapshot carries resolved values, not override plumbing');
for (const forbidden of ['customerOrderingEnabled', 'posEnabled', 'isLive', 'readiness']) {
  ok(!(forbidden in (pubPrice.snapshot as unknown as Record<string, unknown>)), `K. Publish never carries a ${forbidden} field`);
}

console.log(`\n${n} atomic override publish checks passed.`);
