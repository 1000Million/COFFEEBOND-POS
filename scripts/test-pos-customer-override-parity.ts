// G3.1: POS and customer surfaces must resolve the SAME effective store values.
// Mirrors the POS pipeline: resolvePosMenuItems -> availability filter -> display / checkout.
import assert from 'node:assert/strict';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability';
import { resolvePosMenuItems, resolveStoreItem, type StoreItemConfig } from '../frontend/lib/storeItemConfig';
import type { Store } from '../frontend/types';
import type { FinishedGood, RawIngredient } from '../frontend/types/menu-management';

const GOLDEN = 'GOLDEN_I';
const NOIDA = 'NOIDA_29';
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

function store(id: string): Store {
  return { id, code: id, name: id, address: 'a', isActive: true, posEnabled: true, customerOrderingEnabled: true, onlineOrderingEnabled: true, publicOrderingEnabled: true, acceptingOrders: true, isAcceptingOrders: true, estimatedPrepMinutes: 20, createdAt: null, updatedAt: null } as Store;
}
const raw = (code: string) => ({ id: code, code, name: code, category: 'T', purchaseUOM: 'PCS', usageUOM: 'PCS', conversionFactor: 1, purchaseCost: 10, costPerUsageUnit: 10, isActive: true } as RawIngredient);

// The brief's fixture: Bond Frappe, global 350, available.
const BOND_FRAPPE: FinishedGood = {
  id: 'BOND_FRAPPE', code: 'BOND_FRAPPE', name: 'Bond Frappe',
  posCategoryCode: 'COFFEE', posCategoryName: 'Coffee',
  salePrice: 350, productionMode: 'MADE_TO_ORDER', itemType: 'MADE_TO_ORDER',
  prepStation: 'BARISTA', taxRate: 5,
  imageUrl: 'https://storage.googleapis.com/menu-images/BOND_FRAPPE.webp',
  bom: [{ componentType: 'RAW_INGREDIENT', componentCode: 'MILK', componentName: 'Milk', quantity: 100, uom: 'PCS', costPerUnit: 1, lineCost: 100 }],
  bomVersion: 1, recipeCost: 100, grossMargin: 0, cogsPercent: 0, sortOrder: 20,
  availableStoreIds: [GOLDEN, NOIDA], isSellable: true, isAvailable: true, isActive: true,
} as FinishedGood;
const catalogue = [BOND_FRAPPE];
const rawIngredients = [raw('MILK')];

// POS-shaped row, exactly as POSHome maps a finishedGood.
const posRow = (fg: FinishedGood) => ({
  id: fg.code, code: fg.code, name: fg.name, price: fg.salePrice,
  isAvailable: fg.isAvailable !== false, isActive: fg.isActive !== false,
  sortOrder: fg.sortOrder, availableStoreIds: fg.availableStoreIds,
});
/** Mirrors POSHome: resolve overrides, then apply the availability filter. */
const posMenu = (storeId: string, configs: StoreItemConfig[]) =>
  resolvePosMenuItems(catalogue.map(posRow), storeId, configs)
    .filter(item => item.isAvailable !== false)
    .filter(item => item.isActive && item.availableStoreIds.includes(storeId));
const customerSnap = (storeId: string, configs: StoreItemConfig[]) =>
  buildPublicMenuAvailabilitySnapshot({ store: store(storeId), finishedGoods: catalogue, storeStock: [], rawIngredients, addOnGroups: [], storeItemConfigs: configs });

const OVERRIDES: StoreItemConfig[] = [
  { storeId: GOLDEN, itemCode: 'BOND_FRAPPE', priceOverride: 375, isAvailableOverride: false },
];

// ---- zero-override POS compatibility -------------------------------------------
const posRows = catalogue.map(posRow);
ok(resolvePosMenuItems(posRows, GOLDEN, []) === posRows, 'Zero overrides returns the POS array by reference (identical behaviour)');
ok(resolvePosMenuItems(posRows, GOLDEN, undefined) === posRows, 'Undefined overrides returns the POS array by reference');
eq(posMenu(GOLDEN, [])[0].price, 350, 'Zero overrides: POS price is the global price');
eq(customerSnap(GOLDEN, []).menuItems.BOND_FRAPPE.salePrice, 350, 'Zero overrides: customer price is the global price');

// ---- STORE A: Golden I, price 375, availability false ----------------------------
const goldenPos = posMenu(GOLDEN, OVERRIDES);
const goldenCustomer = customerSnap(GOLDEN, OVERRIDES);
eq(resolvePosMenuItems(catalogue.map(posRow), GOLDEN, OVERRIDES)[0].price, 375, 'STORE A: POS display price is 375');
eq(goldenCustomer.menuItems.BOND_FRAPPE.salePrice, 375, 'STORE A: customer price is 375');
eq(goldenPos.length, 0, 'STORE A: POS excludes the item (availability override false)');
eq(goldenCustomer.items.BOND_FRAPPE.available, false, 'STORE A: customer marks the item unavailable');
ok(goldenPos.find(i => i.code === 'BOND_FRAPPE') === undefined, 'STORE A: POS checkout lookup cannot find the disabled item');

// ---- STORE B: Noida 29, no override ------------------------------------------------
const noidaPos = posMenu(NOIDA, OVERRIDES);
const noidaCustomer = customerSnap(NOIDA, OVERRIDES);
eq(noidaPos[0].price, 350, 'STORE B: POS price stays global 350');
eq(noidaCustomer.menuItems.BOND_FRAPPE.salePrice, 350, 'STORE B: customer price stays global 350');
eq(noidaCustomer.items.BOND_FRAPPE.available, true, 'STORE B: customer availability unaffected by the other store');
eq(noidaPos.length, 1, 'STORE B: POS still offers the item');

// ---- parity assertions --------------------------------------------------------------
for (const [label, storeId] of [['Golden I', GOLDEN], ['Noida 29', NOIDA]] as const) {
  const pos = resolvePosMenuItems(catalogue.map(posRow), storeId, OVERRIDES)[0];
  const cust = customerSnap(storeId, OVERRIDES).menuItems.BOND_FRAPPE;
  eq(pos.price, cust.salePrice, `PARITY (${label}): POS price === customer price`);
  eq(pos.isAvailable, cust.isAvailable, `PARITY (${label}): POS availability === customer availability`);
}

// ---- authoritative checkout price ------------------------------------------------------
const checkoutItem = resolvePosMenuItems(catalogue.map(posRow), GOLDEN, OVERRIDES)
  .filter(i => i.isAvailable !== false)
  .find(i => i.code === 'BOND_FRAPPE');
eq(checkoutItem, undefined, 'CHECKOUT: a store-disabled item is rejected by the authoritative lookup');
const priceOnly: StoreItemConfig[] = [{ storeId: GOLDEN, itemCode: 'BOND_FRAPPE', priceOverride: 375 }];
const payable = resolvePosMenuItems(catalogue.map(posRow), GOLDEN, priceOnly).filter(i => i.isAvailable !== false).find(i => i.code === 'BOND_FRAPPE');
eq(payable?.price, 375, 'CHECKOUT: authoritative price is the overridden 375, not the global 350');
eq(customerSnap(GOLDEN, priceOnly).menuItems.BOND_FRAPPE.salePrice, 375, 'CHECKOUT: customer advertises the same 375');

// ---- visibility is customer-only -----------------------------------------------------------
const visOnly: StoreItemConfig[] = [{ storeId: GOLDEN, itemCode: 'BOND_FRAPPE', menuVisibilityOverride: false }];
eq(posMenu(GOLDEN, visOnly).length, 1, 'SCOPE: menuVisibilityOverride does NOT remove the item from POS');
ok(!Object.keys(customerSnap(GOLDEN, visOnly).menuItems).includes('BOND_FRAPPE'), 'SCOPE: menuVisibilityOverride hides the item from the customer menu only');

// ---- structural blocking still wins ----------------------------------------------------------
const brokenCatalogue = [{ ...BOND_FRAPPE, bom: [] } as FinishedGood];
const forced: StoreItemConfig[] = [{ storeId: NOIDA, itemCode: 'BOND_FRAPPE', isAvailableOverride: true, priceOverride: 500 }];
const brokenSnap = buildPublicMenuAvailabilitySnapshot({ store: store(NOIDA), finishedGoods: brokenCatalogue, storeStock: [], rawIngredients, addOnGroups: [], storeItemConfigs: forced });
eq(brokenSnap.items.BOND_FRAPPE.publicStatus, 'SETUP_INCOMPLETE', 'STRUCTURAL: an override cannot make a BOM-invalid item sellable');

// ---- deleting the override restores global behaviour --------------------------------------------
eq(posMenu(GOLDEN, [])[0].price, 350, 'DELETE: removing the override restores the global POS price');
eq(customerSnap(GOLDEN, []).menuItems.BOND_FRAPPE.salePrice, 350, 'DELETE: removing the override restores the global customer price');
eq(BOND_FRAPPE.salePrice, 350, 'The global catalogue document was never mutated');
eq(resolveStoreItem(BOND_FRAPPE, OVERRIDES[0]).prepStation, 'BARISTA', 'KOT prepStation unchanged');

console.log(`\n${n} POS/customer override parity checks passed.`);
