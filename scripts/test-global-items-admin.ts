// G4: Global Items admin logic — write plan, inherit/override semantics, resolved preview,
// atomic full-snapshot safety, and route/permission wiring. Pure + static; no Firestore, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assignedStoreCount, canonicalDataToken,
  buildOverrideWritePlan, buildResolvedComparison,
  draftFromConfig, emptyDraft, overrideIntentToken, snapshotRevisionToken, validateOverrideDraft,
} from '../frontend/lib/storeItemConfigAdmin';
import { resolveStoreItem, storeItemConfigDocId, type StoreItemConfig } from '../frontend/lib/storeItemConfig';
import type { FinishedGood } from '../frontend/types/menu-management';

const GOLDEN = 'GOLDEN_I';
const NOIDA = 'NOIDA_29';
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

const ITEM: FinishedGood = {
  id: 'BOND_FRAPPE', code: 'BOND_FRAPPE', name: 'Bond Frappe',
  posCategoryCode: 'COFFEE', posCategoryName: 'Iced Coffee',
  salePrice: 350, productionMode: 'MADE_TO_ORDER', itemType: 'MADE_TO_ORDER',
  prepStation: 'BARISTA', taxRate: 5,
  imageUrl: 'https://storage.googleapis.com/menu-images/BOND_FRAPPE.webp',
  imageStoragePath: 'menu-images/BOND_FRAPPE.webp',
  addOnGroupIds: ['AG_MILK'],
  bom: [{ componentType: 'RAW_INGREDIENT', componentCode: 'MILK', componentName: 'Milk', quantity: 100, uom: 'ML', costPerUnit: 1, lineCost: 100 }],
  bomVersion: 1, recipeCost: 100, grossMargin: 0, cogsPercent: 0, sortOrder: 20,
  availableStoreIds: [GOLDEN, NOIDA], isSellable: true, isAvailable: true, isActive: true,
} as FinishedGood;

const plan = (draft: ReturnType<typeof emptyDraft>, existing: StoreItemConfig | null = null, storeId = GOLDEN) =>
  buildOverrideWritePlan({ storeId, itemCode: ITEM.code, draft, existing, updatedBy: 'admin-uid' });

// ---- G. price inherit -> override ------------------------------------------------
const d1 = emptyDraft();
eq(plan(d1).action, 'NONE', 'G1. All-inherit draft with no existing doc writes nothing');
d1.price = { mode: 'OVERRIDE', value: '375' };
const p1 = plan(d1);
eq(p1.action, 'SET', 'G2. Switching price to Override produces a SET');
eq((p1 as any).data.priceOverride, 375, 'G3. Price override value is stored');
eq((p1 as any).overriddenFields, ['priceOverride'], 'G4. Only the price field is overridden');
ok(!('isAvailableOverride' in (p1 as any).data), 'G5. Inherited availability is ABSENT from the document, not null');
ok(!('menuVisibilityOverride' in (p1 as any).data), 'G6. Inherited visibility is absent');
ok(!('sortOrderOverride' in (p1 as any).data), 'G7. Inherited display order is absent');
eq((p1 as any).docId, storeItemConfigDocId(GOLDEN, 'BOND_FRAPPE'), 'G8. Deterministic document id is reused, not re-derived');

// ---- H. override -> inherit removes the field --------------------------------------
const existing: StoreItemConfig = { storeId: GOLDEN, itemCode: 'BOND_FRAPPE', priceOverride: 375, isAvailableOverride: false };
const d2 = draftFromConfig(existing);
eq(d2.price.mode, 'OVERRIDE', 'H1. Stored price override rehydrates as Override mode');
eq(d2.price.value, '375', 'H2. Stored price value rehydrates');
eq(d2.availability.mode, 'OVERRIDE', 'H3. Stored availability override rehydrates');
eq(d2.menuVisibility.mode, 'INHERIT', 'H4. Absent field rehydrates as Inherit global');
d2.price = { mode: 'INHERIT', value: '375' };
const p2 = plan(d2, existing);
eq((p2 as any).overriddenFields, ['isAvailableOverride'], 'H5. Switching price back to Inherit drops priceOverride');
ok(!('priceOverride' in (p2 as any).data), 'H6. priceOverride is removed from the written document');

// ---- I/J/K. availability, visibility, sort order incl 0 --------------------------------
const d3 = emptyDraft(); d3.availability = { mode: 'OVERRIDE', value: false };
eq((plan(d3) as any).data.isAvailableOverride, false, 'I. Availability override false is written (presence, not truthiness)');
const d4 = emptyDraft(); d4.menuVisibility = { mode: 'OVERRIDE', value: false };
eq((plan(d4) as any).data.menuVisibilityOverride, false, 'J. Customer menu visibility false is written');
const d5 = emptyDraft(); d5.sortOrder = { mode: 'OVERRIDE', value: '0' };
eq((plan(d5) as any).data.sortOrderOverride, 0, 'K1. Display order override of 0 is written');
const d5b = emptyDraft(); d5b.price = { mode: 'OVERRIDE', value: '0' };
eq((plan(d5b) as any).data.priceOverride, 0, 'K2. Price override of 0 is written');

// ---- L. all cleared -> delete the document ------------------------------------------------
const p6 = plan(emptyDraft(), existing);
eq(p6.action, 'DELETE', 'L1. Clearing every field deletes the override document');
ok((p6 as any).reason.includes('inherits'), 'L2. Delete carries an explanation');

// ---- F. unassigned store cannot be overridden -----------------------------------------------
eq(validateOverrideDraft(emptyDraft(), { isAssigned: true }), [], 'F1. Assigned store passes validation');
const unassigned = validateOverrideDraft(emptyDraft(), { isAssigned: false });
eq(unassigned.length, 1, 'F2. Unassigned store is rejected');
ok(unassigned[0].message.includes('not assigned'), 'F3. Rejection explains the item is not assigned');
const fullManagedConfig = {
  storeId: GOLDEN,
  itemCode: ITEM.code,
  managementMode: 'FULL_VERSION_MANAGED',
  publishedVersion: { schemaVersion: 1 },
} as unknown as StoreItemConfig;
const fullManagedIssues = validateOverrideDraft(emptyDraft(), { isAssigned: true, isFullVersionManaged: true });
eq(fullManagedIssues[0].field, 'managementMode', 'F3a. Legacy editor reports the full-version authority lock');
assert.throws(() => plan(emptyDraft(), fullManagedConfig), /FULL_VERSION_MANAGED/);
n += 1;
console.log(`PASS ${n}. F3b. Legacy write planner cannot alter a full-version-managed store`);
const storeRows = [{ id: GOLDEN }, { id: NOIDA }, { id: 'NOIDA_51' }];
eq(assignedStoreCount(ITEM, storeRows), 2, 'F4. Explicit assignments display their real store count');
eq(
  assignedStoreCount({ ...ITEM, availableStoreIds: [] }, storeRows),
  3,
  'F5. Empty legacy assignment displays all loaded stores, never zero',
);

// ---- validation ------------------------------------------------------------------------------
const bad = emptyDraft(); bad.price = { mode: 'OVERRIDE', value: '-1' };
ok(validateOverrideDraft(bad, { isAssigned: true }).some(i => i.field === 'price'), 'VALID1. Negative price rejected');
const badSort = emptyDraft(); badSort.sortOrder = { mode: 'OVERRIDE', value: '2.5' };
ok(validateOverrideDraft(badSort, { isAssigned: true }).some(i => i.field === 'sortOrder'), 'VALID2. Non-integer display order rejected');
const emptyPrice = emptyDraft(); emptyPrice.price = { mode: 'OVERRIDE', value: '' };
ok(validateOverrideDraft(emptyPrice, { isAssigned: true }).some(i => i.field === 'price'), 'VALID3. Override mode with an empty value is rejected, never treated as inherit');
eq(
  overrideIntentToken({ ...existing, updatedAt: 'later audit timestamp' }),
  overrideIntentToken(existing),
  'VALID4. Audit timestamps do not create a false edit conflict',
);
ok(
  overrideIntentToken({ ...existing, priceOverride: 376 }) !== overrideIntentToken(existing),
  'VALID5. A concurrent override value change is detected',
);
ok(
  snapshotRevisionToken({ publicationRevision: 'one', updatedAt: 't1' })
    !== snapshotRevisionToken({ publicationRevision: 'two', updatedAt: 't2' }),
  'VALID6. A concurrent complete-snapshot publication changes the precondition token',
);
ok(
  canonicalDataToken(ITEM) !== canonicalDataToken({ ...ITEM, salePrice: 351 }),
  'VALID7. A concurrent global item change is detected',
);

// ---- resolved preview uses the shared resolver -------------------------------------------------
const d7 = emptyDraft(); d7.price = { mode: 'OVERRIDE', value: '375' };
const cmp = buildResolvedComparison(ITEM, null, d7, GOLDEN);
const priceRow = cmp.find(r => r.field === 'price')!;
eq(priceRow.globalValue, '₹350.00', 'PREVIEW1. Global column shows the catalogue price');
eq(priceRow.currentValue, '₹350.00', 'PREVIEW2. Now column shows the currently resolved price');
eq(priceRow.nextValue, '₹375.00', 'PREVIEW3. After column shows the overridden price');
ok(priceRow.changed && priceRow.overridden, 'PREVIEW4. Row is flagged changed and overridden');
const visRow = cmp.find(r => r.field === 'menuVisibility')!;
ok(!visRow.changed, 'PREVIEW5. Untouched fields are not flagged as changed');

// ---- M. two-store isolation ----------------------------------------------------------------------
const goldenCfg = (plan(d7) as any).data as StoreItemConfig;
eq(resolveStoreItem(ITEM, goldenCfg).salePrice, 375, 'M1. Golden I resolves to the override');
eq(resolveStoreItem(ITEM, null).salePrice, 350, 'M2. A store with no override resolves to global');
eq((plan(d7, null, NOIDA) as any).docId, storeItemConfigDocId(NOIDA, 'BOND_FRAPPE'), 'M3. Each store writes its own document id');

// ---- N/O. global item and image untouched ------------------------------------------------------------
eq(ITEM.salePrice, 350, 'N. The global finishedGood object is never mutated');
eq(resolveStoreItem(ITEM, goldenCfg).imageUrl, ITEM.imageUrl, 'O1. Image reference is unchanged by an override');
eq(resolveStoreItem(ITEM, goldenCfg).imageStoragePath, ITEM.imageStoragePath, 'O2. Image storage path is unchanged');
ok(!('imageUrl' in goldenCfg), 'O3. No image field is ever written into an override document');

// ---- routing / permission wiring (static) ----------------------------------------------------------------
const app = fs.readFileSync('frontend/App.tsx', 'utf8');
ok(app.includes("const GlobalItems = lazy(() => import('./pages/admin/GlobalItems'));"), 'ROUTE1. Page is lazy-imported like every other admin page');
ok(app.includes('<Route path="/admin/global-items" element={<GlobalItems />} />'), 'ROUTE2. Route is registered (an unregistered path would silently redirect to /)');
const adminBlock = app.slice(app.indexOf("<Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>"), app.indexOf("<Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER']} />}>"));
ok(adminBlock.includes('/admin/global-items'), 'ROUTE3. Route sits in the ADMIN-only guard block, so Manager and Cashier are redirected away');
const page = fs.readFileSync('frontend/pages/admin/GlobalItems.tsx', 'utf8');
ok(/staffProfile\?\.role === 'ADMIN' && staffProfile\?\.isActive === true/.test(page), 'PERM1. Page self-guards on active ADMIN as well as the route guard');
ok(page.includes('if (!isAdmin) { setLoading(false); return; }'), 'PERM2. A non-admin triggers no Firestore reads');
ok(page.includes('Admin access required'), 'PERM3. Non-admin sees an explicit denied card');
ok(page.includes('runTransaction(db, async (transaction) =>'), 'MASTER1. Master save uses one conflict-safe Firestore transaction');
ok(page.includes('GLOBAL_ITEM_MASTER_DRAFT_COLLECTION'), 'MASTER2. Master save targets the protected non-live draft collection');
ok(page.includes('globalItemBaseProductToken(freshItem) !== globalItemBaseProductToken(selectedItem)'), 'MASTER3. Master save fails closed if the live source changed');
ok(page.includes('currentRevision !== expectedDraftRevision'), 'MASTER4. Master save rejects a concurrent newer draft');
ok(page.includes('MASTER SAVED — NOT YET PUBLISHED'), 'MASTER5. Save success explicitly confirms that live stores did not change');
ok(page.includes('publishGlobalItemToStores(db'), 'PUBLISH1. Final publish delegates to the canonical atomic multi-store engine');
ok(page.includes('expectedMasterRevision: savedDraft.draftRevision'), 'PUBLISH2. Publish pins the reviewed saved master revision');
ok(page.includes('targetStoreIds: selectedStoreIds'), 'PUBLISH3. Only the selected stores are sent to the engine');
ok(page.includes('Review & publish to'), 'PUBLISH4. Publish requires an explicit review step');
ok(!/collection\(db, 'finishedGoods'\)[\s\S]{0,400}batch\.set|batch\.set\([\s\S]{0,80}finishedGoods/.test(page), 'SAFETY1. Page never writes to finishedGoods');
const writes = page.match(/transaction\.set\(|transaction\.delete\(|setDoc\(|deleteDoc\(|updateDoc\(|addDoc\(/g) || [];
eq(writes.length, 1, 'SAFETY2. The page has one direct write call site and it saves only the master draft');
for (const forbidden of ['customerOrderingEnabled', 'posEnabled', 'isLive', 'readiness', 'setupStatus', 'onlineOrderingEnabled', 'acceptingOrders']) {
  // written as an object field, e.g. `readiness: {...}` — a /admin/pos-readiness link is fine
  ok(!new RegExp(`\\b${forbidden}\\s*:`).test(page), `SAFETY3. Page never writes a ${forbidden} field`);
}
ok(!/batch\.set\(\s*doc\(db,\s*'stores'/.test(page), 'SAFETY4. Page never writes to the stores collection');

console.log(`\n${n} Global Items admin checks passed.`);
