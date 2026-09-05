// G3: per-store item overrides. Proves zero-override equivalence and the override matrix.
import assert from 'node:assert/strict';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability';
import {
  resolveStoreItem, storeItemConfigDocId, storeItemConfigDocPath,
  storeItemConfigByItemCode, STORE_ITEM_CONFIG_COLLECTION, type StoreItemConfig,
} from '../frontend/lib/storeItemConfig';
import type { Store } from '../frontend/types';
import type { AddOnGroup, FinishedGood, RawIngredient } from '../frontend/types/menu-management';

const GOLDEN = 'GOLDEN_I';
const NOIDA = 'NOIDA_29';
let n = 0;
function ok(condition: unknown, message: string) { assert.ok(condition, message); n += 1; console.log(`PASS ${n}. ${message}`); }
function eq(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, `${message} (got ${JSON.stringify(actual)})`); n += 1; console.log(`PASS ${n}. ${message}`); }

function store(id: string): Store {
  return {
    id, code: id, name: id, address: 'a', isActive: true, posEnabled: true,
    customerOrderingEnabled: true, onlineOrderingEnabled: true, publicOrderingEnabled: true,
    acceptingOrders: true, isAcceptingOrders: true, estimatedPrepMinutes: 20,
    createdAt: null, updatedAt: null,
  } as Store;
}
function raw(code: string): RawIngredient {
  return { id: code, code, name: code, category: 'T', purchaseUOM: 'PCS', usageUOM: 'PCS', conversionFactor: 1, purchaseCost: 10, costPerUsageUnit: 10, isActive: true } as RawIngredient;
}
function product(code: string, overrides: Partial<FinishedGood> = {}): FinishedGood {
  return {
    id: code, code, name: code, posCategoryCode: 'COFFEE', posCategoryName: 'Coffee',
    salePrice: 350, productionMode: 'MADE_TO_ORDER', itemType: 'MADE_TO_ORDER',
    prepStation: 'BARISTA', taxRate: 5,
    imageUrl: `https://storage.googleapis.com/menu-images/${code}.webp`,
    imageStoragePath: `menu-images/${code}.webp`,
    addOnGroupIds: ['AG_MILK'],
    bom: [{ componentType: 'RAW_INGREDIENT', componentCode: `${code}_R`, componentName: 'r', quantity: 1, uom: 'PCS', costPerUnit: 10, lineCost: 10 }],
    bomVersion: 1, recipeCost: 10, grossMargin: 0, cogsPercent: 0, sortOrder: 20,
    availableStoreIds: [GOLDEN, NOIDA], isSellable: true, isAvailable: true, isActive: true,
    ...overrides,
  } as FinishedGood;
}
const addOnGroups: AddOnGroup[] = [{ id: 'AG_MILK', name: 'Milk', isActive: true, options: [{ id: 'OPT_OAT', name: 'Oat', price: 40, isActive: true }] } as AddOnGroup];
const catalogue = [product('FG_A'), product('FG_B', { sortOrder: 10 })];
const rawIngredients = [raw('FG_A_R'), raw('FG_B_R')];

const snap = (storeId: string, storeItemConfigs?: StoreItemConfig[]) => buildPublicMenuAvailabilitySnapshot({
  store: store(storeId), finishedGoods: catalogue, storeStock: [], rawIngredients, addOnGroups, storeItemConfigs,
});
const cfg = (storeId: string, itemCode: string, fields: Partial<StoreItemConfig>): StoreItemConfig => ({ storeId, itemCode, ...fields });

// ---- deterministic identity -------------------------------------------------
eq(storeItemConfigDocId(GOLDEN, 'FG_A'), 'GOLDEN_I__FG_A', 'Deterministic override document id');
eq(storeItemConfigDocId(GOLDEN, 'FG_A'), storeItemConfigDocId(GOLDEN, 'FG_A'), 'Document id is stable across calls');
ok(storeItemConfigDocId('GOLDEN_I', 'FG_1') !== storeItemConfigDocId('GOLDEN', 'I_FG_1'), 'Separator prevents store/item id collisions');
eq(storeItemConfigDocPath(GOLDEN, 'FG_A'), `${STORE_ITEM_CONFIG_COLLECTION}/GOLDEN_I__FG_A`, 'Deterministic override document path');
eq(storeItemConfigByItemCode(GOLDEN, [cfg(NOIDA, 'FG_A', { priceOverride: 1 })]).size, 0, 'Another store’s override rows are ignored');

// ---- A. zero-override equivalence -------------------------------------------
const baselineGolden = snap(GOLDEN);
eq(JSON.stringify(snap(GOLDEN, [])), JSON.stringify(baselineGolden), 'A1. Empty override list produces a byte-identical snapshot');
eq(JSON.stringify(snap(GOLDEN, undefined)), JSON.stringify(baselineGolden), 'A2. Undefined override list produces a byte-identical snapshot');
const untouched = resolveStoreItem(catalogue[0], undefined);
eq(untouched.salePrice, 350, 'A3. No override inherits the global sale price');
eq(untouched.appliedOverrides, [], 'A4. No override records no applied overrides');
eq(JSON.stringify({ ...untouched, menuVisible: undefined, appliedOverrides: undefined }), JSON.stringify({ ...catalogue[0], menuVisible: undefined, appliedOverrides: undefined }), 'A5. Resolved item is field-identical to the global item');

// ---- B/C. price ---------------------------------------------------------------
eq(resolveStoreItem(catalogue[0], cfg(GOLDEN, 'FG_A', { priceOverride: 375 })).salePrice, 375, 'B. Price override applies');
eq(resolveStoreItem(catalogue[0], cfg(GOLDEN, 'FG_A', { priceOverride: 0 })).salePrice, 0, 'C1. Price override of 0 applies (presence, not truthiness)');
const zeroPriceSnap = snap(GOLDEN, [cfg(GOLDEN, 'FG_A', { priceOverride: 0 })]);
eq(zeroPriceSnap.items.FG_A.publicStatus, 'SETUP_INCOMPLETE', 'C2. A zero price is still structurally unsellable, not silently offered');

// ---- D/E. availability ---------------------------------------------------------
eq(resolveStoreItem(catalogue[0], cfg(GOLDEN, 'FG_A', { isAvailableOverride: false })).isAvailable, false, 'D1. Availability override false applies (presence, not truthiness)');
eq(snap(GOLDEN, [cfg(GOLDEN, 'FG_A', { isAvailableOverride: false })]).items.FG_A.available, false, 'D2. Snapshot marks the item unavailable for this store');
// Uses an ordinary store: GOLDEN_I is a sales-first store whose exception short-circuits
// BOM validation, so it cannot prove anything about structural gates.
const globallyOff = [product('FG_A', { isAvailable: false }), catalogue[1]];
const forcedOn = buildPublicMenuAvailabilitySnapshot({ store: store(NOIDA), finishedGoods: globallyOff, storeStock: [], rawIngredients, addOnGroups, storeItemConfigs: [cfg(NOIDA, 'FG_A', { isAvailableOverride: true })] });
eq(forcedOn.items.FG_A.available, true, 'E. Availability override true re-enables an item, still passing every structural gate');

// ---- F/G. menu visibility --------------------------------------------------------
const hidden = snap(GOLDEN, [cfg(GOLDEN, 'FG_A', { menuVisibilityOverride: false })]);
ok(!Object.keys(hidden.menuItems).includes('FG_A'), 'F1. Visibility override false removes the item from the customer menu');
ok(Object.keys(hidden.menuItems).includes('FG_B'), 'F2. Other items remain on the customer menu');
eq(hidden.itemCount, 1, 'F3. Item count reflects the hidden item');
const brokenBom = [product('FG_A', { bom: [] }), catalogue[1]];
const forcedVisible = buildPublicMenuAvailabilitySnapshot({ store: store(NOIDA), finishedGoods: brokenBom, storeStock: [], rawIngredients, addOnGroups, storeItemConfigs: [cfg(NOIDA, 'FG_A', { menuVisibilityOverride: true, isAvailableOverride: true })] });
eq(forcedVisible.items.FG_A.publicStatus, 'SETUP_INCOMPLETE', 'G1. Overrides cannot make a BOM-invalid item sellable');
const malformedBom = [product('FG_A', { bom: [{ componentType: 'RAW_INGREDIENT', componentCode: 'FG_A_R', componentName: 'r', quantity: 0, uom: 'PCS', costPerUnit: 10, lineCost: 0 }] }), catalogue[1]];
const forcedMalformed = buildPublicMenuAvailabilitySnapshot({ store: store(NOIDA), finishedGoods: malformedBom, storeStock: [], rawIngredients, addOnGroups, storeItemConfigs: [cfg(NOIDA, 'FG_A', { isAvailableOverride: true, priceOverride: 500 })] });
eq(forcedMalformed.items.FG_A.publicStatus, 'SETUP_INCOMPLETE', 'G2. Overrides cannot make a malformed-BOM item sellable');
const badStation = [product('FG_A', { prepStation: 'INVALID' as FinishedGood['prepStation'] }), catalogue[1]];
const forcedStation = buildPublicMenuAvailabilitySnapshot({ store: store(NOIDA), finishedGoods: badStation, storeStock: [], rawIngredients, addOnGroups, storeItemConfigs: [cfg(NOIDA, 'FG_A', { isAvailableOverride: true })] });
eq(forcedStation.items.FG_A.publicStatus, 'SETUP_INCOMPLETE', 'G3. Overrides cannot bypass an invalid prep-station configuration');
// Golden I's sales-first exception still short-circuits BOM validation, unchanged by G3.
const goldenBroken = buildPublicMenuAvailabilitySnapshot({ store: store(GOLDEN), finishedGoods: brokenBom, storeStock: [], rawIngredients, addOnGroups });
eq(goldenBroken.items.FG_A.publicStatus, 'AVAILABLE', 'G4. Golden I sales-first exception preserved exactly (no override involved)');

// ---- H. sort order -----------------------------------------------------------------
eq(resolveStoreItem(catalogue[0], cfg(GOLDEN, 'FG_A', { sortOrderOverride: 3 })).sortOrder, 3, 'H1. Sort-order override applies');
eq(resolveStoreItem(catalogue[0], cfg(GOLDEN, 'FG_A', { sortOrderOverride: 0 })).sortOrder, 0, 'H2. Sort-order override of 0 applies');
eq(Object.keys(snap(GOLDEN, [cfg(GOLDEN, 'FG_A', { sortOrderOverride: 1 })]).menuItems), ['FG_A', 'FG_B'], 'H3. Sort-order override reorders the customer menu');
eq(Object.keys(baselineGolden.menuItems), ['FG_B', 'FG_A'], 'H4. Baseline order follows the global sortOrder');
eq(resolveStoreItem(catalogue[0], cfg(GOLDEN, 'FG_A', { sortOrderOverride: 3 })).posCategoryCode, 'COFFEE', 'H5. Sort-order override does not change category assignment');

// ---- I. two-store isolation ----------------------------------------------------------
const overrides = [cfg(GOLDEN, 'FG_A', { priceOverride: 375 })];
eq(snap(GOLDEN, overrides).menuItems.FG_A.salePrice, 375, 'I1. Golden I sees its overridden price');
eq(snap(NOIDA, overrides).menuItems.FG_A.salePrice, 350, 'I2. Noida 29 still inherits the global price');
eq(catalogue[0].salePrice, 350, 'I3. The global catalogue document is never mutated');

// ---- J/K/L. global references unchanged ------------------------------------------------
const g = snap(GOLDEN, overrides).menuItems.FG_A;
const nItem = snap(NOIDA, overrides).menuItems.FG_A;
eq(g.imageUrl, nItem.imageUrl, 'J. Image reference identical across both stores');
eq(g.addOnGroupIds, nItem.addOnGroupIds, 'K. Add-on group references identical across both stores');
eq(resolveStoreItem(catalogue[0], overrides[0]).bom, catalogue[0].bom, 'L. BOM definition identical after override');
eq(resolveStoreItem(catalogue[0], overrides[0]).prepStation, 'BARISTA', 'L2. KOT prepStation unchanged by override');
eq(g.taxRate, nItem.taxRate, 'GST. Item tax rate identical across both stores; no GST override introduced');

console.log(`\n${n} store item override checks passed.`);
