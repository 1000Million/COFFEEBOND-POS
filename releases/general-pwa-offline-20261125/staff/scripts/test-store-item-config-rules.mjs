#!/usr/bin/env node
// G3.2: DYNAMIC authorization proof for storeItemConfig, executed against real
// firestore.rules in the emulator. Demo project only; never touches production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc } from 'firebase/firestore';

const PROJECT_ID = 'demo-coffee-bond-g32-rules';
const [HOST, portText] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const PORT = Number(portText || 8080);
const COLLECTION = 'storeItemConfig';
const DOC_A = 'GOLDEN_I__BOND_FRAPPE';
const DOC_B = 'NOIDA_29__BOND_FRAPPE';

let n = 0;
const record = (m) => { n += 1; console.log(`PASS ${n}. ${m}`); };

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: HOST, port: PORT },
});

// Seed user profiles and existing override docs with rules disabled.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const users = {
    'admin-uid': { uid: 'admin-uid', role: 'ADMIN', isActive: true, storeIds: [] },
    'manager-uid': { uid: 'manager-uid', role: 'STORE_MANAGER', isActive: true, storeIds: ['GOLDEN_I'], assignedStoreIds: ['GOLDEN_I'] },
    'cashier-uid': { uid: 'cashier-uid', role: 'CASHIER', isActive: true, storeIds: ['GOLDEN_I'], assignedStoreIds: ['GOLDEN_I'] },
    'inactive-uid': { uid: 'inactive-uid', role: 'CASHIER', isActive: false, storeIds: ['GOLDEN_I'] },
    'franchise-uid': { uid: 'franchise-uid', role: 'FRANCHISE_VIEWER', isActive: true, storeIds: [] },
    'customer-uid': { uid: 'customer-uid' },
  };
  for (const [uid, data] of Object.entries(users)) await setDoc(doc(db, 'users', uid), data);
  await setDoc(doc(db, COLLECTION, DOC_A), { storeId: 'GOLDEN_I', itemCode: 'BOND_FRAPPE', priceOverride: 375 });
  await setDoc(doc(db, COLLECTION, DOC_B), { storeId: 'NOIDA_29', itemCode: 'BOND_FRAPPE', priceOverride: 360 });
});

const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
const asPublic = () => testEnv.unauthenticatedContext().firestore();
const ref = (db, id = DOC_A) => doc(db, COLLECTION, id);
const payload = { storeId: 'GOLDEN_I', itemCode: 'BOND_FRAPPE', priceOverride: 400 };

// ---- ADMIN: full control ------------------------------------------------------
await assertSucceeds(getDoc(ref(asUser('admin-uid')))); record('ADMIN read ALLOWED');
await assertSucceeds(getDocs(collection(asUser('admin-uid'), COLLECTION))); record('ADMIN list ALLOWED');
await assertSucceeds(setDoc(ref(asUser('admin-uid'), 'GOLDEN_I__NEW_ITEM'), { storeId: 'GOLDEN_I', itemCode: 'NEW_ITEM', priceOverride: 100 })); record('ADMIN create ALLOWED');
await assertSucceeds(setDoc(ref(asUser('admin-uid')), payload, { merge: true })); record('ADMIN update ALLOWED');
await assertSucceeds(deleteDoc(ref(asUser('admin-uid'), 'GOLDEN_I__NEW_ITEM'))); record('ADMIN delete ALLOWED');

// ---- STORE MANAGER: private overrides are hidden and immutable -----------------
await assertFails(getDoc(ref(asUser('manager-uid')))); record('STORE_MANAGER read DENIED');
await assertFails(setDoc(ref(asUser('manager-uid')), payload, { merge: true })); record('STORE_MANAGER update DENIED');
await assertFails(setDoc(ref(asUser('manager-uid'), 'GOLDEN_I__X'), payload)); record('STORE_MANAGER create DENIED');
await assertFails(deleteDoc(ref(asUser('manager-uid')))); record('STORE_MANAGER delete DENIED');

// ---- CASHIER: private overrides are hidden and immutable -----------------------
await assertFails(getDoc(ref(asUser('cashier-uid')))); record('CASHIER read DENIED');
await assertFails(setDoc(ref(asUser('cashier-uid')), payload, { merge: true })); record('CASHIER update DENIED');
await assertFails(setDoc(ref(asUser('cashier-uid'), 'GOLDEN_I__Y'), payload)); record('CASHIER create DENIED');
await assertFails(deleteDoc(ref(asUser('cashier-uid')))); record('CASHIER delete DENIED');

// ---- CROSS-STORE READ: still private to Admin ----------------------------------
await assertFails(getDoc(ref(asUser('manager-uid'), DOC_B))); record('CROSS-STORE: Manager read DENIED');
await assertFails(getDoc(ref(asUser('cashier-uid'), DOC_B))); record('CROSS-STORE: Cashier read DENIED');

// ---- FRANCHISE_VIEWER: not in the isActiveStaff role list ---------------------
await assertFails(getDoc(ref(asUser('franchise-uid')))); record('FRANCHISE_VIEWER read DENIED (not an isActiveStaff role)');
await assertFails(setDoc(ref(asUser('franchise-uid')), payload, { merge: true })); record('FRANCHISE_VIEWER write DENIED');

// ---- INACTIVE STAFF -----------------------------------------------------------
await assertFails(getDoc(ref(asUser('inactive-uid')))); record('INACTIVE staff read DENIED');
await assertFails(setDoc(ref(asUser('inactive-uid')), payload, { merge: true })); record('INACTIVE staff write DENIED');

// ---- SIGNED-IN CUSTOMER (no staff profile) -------------------------------------
await assertFails(getDoc(ref(asUser('customer-uid')))); record('SIGNED-IN CUSTOMER read DENIED');
await assertFails(setDoc(ref(asUser('customer-uid')), payload, { merge: true })); record('SIGNED-IN CUSTOMER write DENIED');

// ---- PUBLIC / SIGNED-OUT --------------------------------------------------------
await assertFails(getDoc(ref(asPublic()))); record('PUBLIC read DENIED');
await assertFails(setDoc(ref(asPublic()), payload, { merge: true })); record('PUBLIC write DENIED');

// ---- the public surface must remain exactly what it was -------------------------
await assertSucceeds(getDoc(doc(asPublic(), 'publicMenuAvailability', 'GOLDEN_I'))); record('PUBLIC still reads publicMenuAvailability (effective values reach customers there)');
await assertFails(getDoc(doc(asPublic(), 'finishedGoods', 'BOND_FRAPPE'))); record('PUBLIC still cannot read finishedGoods');

await testEnv.cleanup();
console.log(`\n${n} dynamic storeItemConfig rules checks passed.`);
