#!/usr/bin/env node
// G7.1 REGRESSION for the G7 defect: POS displayed the store override price but charged the
// GLOBAL price, because the server's canonical item price ignored storeItemConfig.
// This drives the REAL server function (createPosAddOnAuthorizationFunction -> the same
// canonicalizeRequestedCart that POS Razorpay also uses) against the Firestore emulator.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const PROJECT_ID = 'demo-coffee-bond-g71';
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('BLOCKED: FIRESTORE_EMULATOR_HOST is required.'); process.exit(1); }
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { createPosAddOnAuthorizationFunction } = require('../functions/posAddOnAuthorization.js');
const { storeItemConfigDocId } = require('../functions/storeItemConfig.js');

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c, m) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

const GOLDEN = 'GOLDEN_I', NOIDA = 'NOIDA_29', CODE = 'BOND_FRAPPE';
const store = (id) => ({ id, code: id, storeCode: id, name: id, isActive: true, posEnabled: true, inventoryMode: 'FINISHED_GOODS', gstRegistered: true, gstRate: 5 });
const fg = (code, price, storeIds) => ({
  code, name: code, posCategoryCode: 'COFFEE', posCategoryName: 'Coffee', salePrice: price,
  itemType: 'MADE_TO_ORDER', productionMode: 'MADE_TO_ORDER', prepStation: 'BARISTA', taxRate: 5,
  bom: [{ componentType: 'RAW_INGREDIENT', componentCode: 'MILK', componentName: 'Milk', quantity: 100, uom: 'ML', costPerUnit: 0.06, lineCost: 6 }],
  bomVersion: 1, sortOrder: 20, availableStoreIds: storeIds,
  isSellable: true, isAvailable: true, isActive: true, addOnGroupIds: [], addOnOptionIdsByGroup: {},
});

await db.collection('stores').doc(GOLDEN).set(store(GOLDEN));
await db.collection('stores').doc(NOIDA).set(store(NOIDA));
await db.collection('finishedGoods').doc(CODE).set(fg(CODE, 350, [GOLDEN, NOIDA]));
await db.collection('appSettings').doc('gstConfig').set({ defaultGstRate: 5 });
for (const [uid, role, stores] of [
  ['g71-admin', 'ADMIN', []],
  ['g71-cashier-golden', 'CASHIER', [GOLDEN]],
]) {
  await db.collection('users').doc(uid).set({ uid, role, isActive: true, displayName: role, email: `${uid}@cb.test`, storeIds: stores, assignedStoreIds: stores });
}

const fns = createPosAddOnAuthorizationFunction({ admin, db, region: 'us-central1' });
const authorize = (uid, storeId, orderId) => fns.run({
  auth: { uid, token: { name: 'QA' } },
  data: {
    storeId, orderId, orderNumber: null, checkoutMode: 'STANDARD_POS', checkoutSource: 'POS',
    paymentMethod: 'CASH',
    items: [{ orderItemId: 'line-1', parentProductId: CODE, parentProductCode: CODE, quantity: 1, selectedAddOns: [] }],
  },
});
const priceFor = async (uid, storeId, orderId) => {
  const res = await authorize(uid, storeId, orderId);
  return res.canonicalItems['line-1'].baseUnitPrice;
};

// ---- 1. no override -> global price ------------------------------------------------------
eq(await priceFor('g71-admin', GOLDEN, 'g71-o1'), 350, 'No override: server canonical price is the global 350');

// ---- 2. THE DEFECT: override must reach the server canonical price ----------------------
await db.collection('storeItemConfig').doc(storeItemConfigDocId(GOLDEN, CODE)).set({ storeId: GOLDEN, itemCode: CODE, priceOverride: 375, updatedBy: 'g71' });
const golden = await priceFor('g71-admin', GOLDEN, 'g71-o2');
eq(golden, 375, 'REGRESSION: server canonical price is the STORE OVERRIDE 375, not the global 350');
ok(golden !== 350, 'REGRESSION: the G7 defect (charging 350 while displaying 375) is gone');

// ---- 3. two-store isolation --------------------------------------------------------------
eq(await priceFor('g71-admin', NOIDA, 'g71-o3'), 350, 'Two-store isolation: the un-overridden store still gets 350');

// ---- 4. the POS replacement step now carries the override forward -----------------------
const res = await authorize('g71-admin', GOLDEN, 'g71-o4');
const canonicalItem = res.canonicalItems['line-1'];
// Mirrors POSHome.tsx:2087-2091 exactly.
const liveItem = { id: CODE, code: CODE, price: 375, taxRate: 5 };
const replaced = { ...liveItem, price: canonicalItem.baseUnitPrice, taxRate: canonicalItem.taxRate };
eq(replaced.price, 375, 'POS post-authorization replacement keeps the effective 375');
const { calculateTotals } = require('/tmp/g71-pricing.cjs');
const totals = calculateTotals([{ price: replaced.price, quantity: 1, addOns: [], taxRate: replaced.taxRate }], 10, 5);
eq(totals.subtotal, 375, 'Checkout totals compute from 375 (a global-price charge would be 350)');
eq(totals.grandTotal, 354.375, 'Checkout grandTotal is 354.375 — the override reaches the money pipeline');

// ---- 5. explicit zero override ------------------------------------------------------------
await db.collection('storeItemConfig').doc(storeItemConfigDocId(GOLDEN, CODE)).set({ storeId: GOLDEN, itemCode: CODE, priceOverride: 0, updatedBy: 'g71' });
eq(await priceFor('g71-admin', GOLDEN, 'g71-o5'), 0, 'Explicit priceOverride 0 is honoured (presence, not truthiness)');

// ---- 6. store authorization is not weakened ----------------------------------------------
await db.collection('storeItemConfig').doc(storeItemConfigDocId(GOLDEN, CODE)).set({ storeId: GOLDEN, itemCode: CODE, priceOverride: 375, updatedBy: 'g71' });
eq(await priceFor('g71-cashier-golden', GOLDEN, 'g71-o6'), 375, 'Cashier assigned to Golden I is allowed and gets 375');
let denied = null;
try { await priceFor('g71-cashier-golden', NOIDA, 'g71-o7'); }
catch (error) { denied = String(error && error.message || error); }
ok(denied !== null, `Cashier requesting an unassigned store is DENIED (${denied})`);
ok(/cannot authorize add-ons|permission/i.test(denied || ''), 'Denial is the existing permission error, not a new code path');

// ---- 7. an override row for another store cannot leak ------------------------------------
await db.collection('storeItemConfig').doc(storeItemConfigDocId(NOIDA, CODE)).set({ storeId: NOIDA, itemCode: CODE, priceOverride: 999, updatedBy: 'g71' });
eq(await priceFor('g71-admin', GOLDEN, 'g71-o8'), 375, 'Golden I is unaffected by the Noida override row');
eq(await priceFor('g71-admin', NOIDA, 'g71-o9'), 999, 'Noida resolves its own override');

// ---- 8. a tampered row claiming another store is ignored ---------------------------------
await db.collection('storeItemConfig').doc(storeItemConfigDocId(GOLDEN, CODE)).set({ storeId: NOIDA, itemCode: CODE, priceOverride: 1, updatedBy: 'g71' });
eq(await priceFor('g71-admin', GOLDEN, 'g71-o10'), 350, 'A row whose storeId does not match the doc id is ignored (falls back to global)');

// ---- 9. the global document is never mutated ---------------------------------------------
eq((await db.collection('finishedGoods').doc(CODE).get()).data().salePrice, 350, 'Global finishedGood still 350 throughout');

console.log(`\n${n} authoritative store price checks passed.`);
