// POS current-store resolution. The POS used to open on `allowedStores[0]`, i.e. the
// authorised store with the lowest Firestore DOCUMENT ID - GOLDEN_I among the production
// stores. These tests pin the replacement behaviour and the security scoping.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  eligiblePosStores, hasNearestResolvableStore, isPersistedStoreStillValid,
  POS_STORE_STORAGE_KEY, resolvePosStore,
} from '../frontend/lib/posStoreResolution';
import { assignedStoreDocumentIds, assignedStoreIdentifiers } from '../frontend/lib/posStoreAccess';
import { closestStoreToPosition, storeCoordinate } from '../frontend/lib/storeGeo';
import type { Store } from '../frontend/types';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

// Real production document ids - the whole point is that these are NOT the codes.
const store = (id: string, code: string, name: string, extra: Partial<Store> = {}): Store => ({
  id, code, storeCode: code, name, address: 'x', isActive: true,
  posEnabled: true, customerOrderingEnabled: false, onlineOrderingEnabled: false,
  publicOrderingEnabled: false, acceptingOrders: false, isAcceptingOrders: false,
  createdAt: null, updatedAt: null, ...extra,
} as Store);

const GOLDEN = store('GOLDEN_I', 'GOLDEN_I', 'Golden I', { latitude: 28.5700, longitude: 77.3210 });
const NOIDA29 = store('cJk69Ti1mveh603L4edw', 'NOIDA_29', 'Noida Sector 29', { latitude: 28.5720, longitude: 77.3260 });
const NOIDA51 = store('L0qB13uuPxHvv089YtGQ', 'NOIDA_51', 'Noida Sector 51', { latitude: 28.5830, longitude: 77.3600 });
const TASTING = store('TASTING_ROOM_29', 'TASTING_ROOM_29', 'The Tasting Room', { isActive: false, latitude: 28.5721, longitude: 77.3261 });
const DRAFT = store('QA_DRAFT', 'QA_DRAFT', 'QA Draft', { isActive: false, status: 'DRAFT' } as Partial<Store>);
const ALL = [GOLDEN, NOIDA29, NOIDA51, TASTING, DRAFT];

const admin = { role: 'ADMIN' };
const managerNoida29 = { role: 'STORE_MANAGER', assignedStoreIds: ['cJk69Ti1mveh603L4edw'], storeIds: ['cJk69Ti1mveh603L4edw'] };
const cashierGolden = { role: 'CASHIER', assignedStoreIds: ['GOLDEN_I'], storeIds: ['GOLDEN_I'] };
const nearNoida29 = { latitude: 28.5721, longitude: 77.3259 };
const nearNoida51 = { latitude: 28.5829, longitude: 77.3599 };

// ---- ADMIN 1: no persisted store, location near Noida 29 -> NOT Golden I -------------------
const a1 = resolvePosStore({ stores: ALL, profile: admin, persistedStoreId: null, coordinate: nearNoida29 });
eq(a1.storeId, NOIDA29.id, 'ADMIN 1: location near Noida 29 resolves Noida 29');
ok(a1.storeId !== GOLDEN.id, 'ADMIN 1: Golden I is NOT selected (the old positional default)');
eq(a1.reason, 'NEAREST', 'ADMIN 1: reason is NEAREST');

// ---- ADMIN 2: location near Golden I -> Golden I (legitimately) ------------------------------
const a2 = resolvePosStore({ stores: ALL, profile: admin, coordinate: { latitude: 28.5701, longitude: 77.3211 } });
eq(a2.storeId, GOLDEN.id, 'ADMIN 2: location near Golden I resolves Golden I on merit');

// ---- ADMIN 3: geolocation unavailable -> explicit choice, no silent Golden I -----------------
const a3 = resolvePosStore({ stores: ALL, profile: admin, persistedStoreId: null, coordinate: null });
eq(a3.storeId, '', 'ADMIN 3: no location and no persisted store -> empty, operator must choose');
eq(a3.reason, 'NEEDS_EXPLICIT_CHOICE', 'ADMIN 3: reason is NEEDS_EXPLICIT_CHOICE');
ok(a3.storeId !== GOLDEN.id, 'ADMIN 3: NO silent Golden I fallback');

// ---- ADMIN 4: valid persisted store is restored and beats location --------------------------
const a4 = resolvePosStore({ stores: ALL, profile: admin, persistedStoreId: NOIDA51.id, coordinate: nearNoida29 });
eq(a4.storeId, NOIDA51.id, 'ADMIN 4: a valid persisted store is restored');
eq(a4.reason, 'PERSISTED', 'ADMIN 4: persisted wins over location');

// ---- ADMIN 5: invalid / inactive persisted store is rejected --------------------------------
eq(resolvePosStore({ stores: ALL, profile: admin, persistedStoreId: TASTING.id, coordinate: null }).storeId, '', 'ADMIN 5a: persisted INACTIVE store rejected');
eq(resolvePosStore({ stores: ALL, profile: admin, persistedStoreId: 'DELETED_STORE', coordinate: null }).storeId, '', 'ADMIN 5b: persisted unknown store rejected');
eq(resolvePosStore({ stores: ALL, profile: admin, persistedStoreId: DRAFT.id, coordinate: null }).storeId, '', 'ADMIN 5c: persisted DRAFT store rejected');
ok(!isPersistedStoreStillValid('  ', eligiblePosStores(ALL, admin)), 'ADMIN 5d: blank persisted id rejected');

// ---- MANAGER 6: exactly one assigned store -> selected automatically ------------------------
const m6 = resolvePosStore({ stores: ALL, profile: managerNoida29, persistedStoreId: null, coordinate: null });
eq(m6.storeId, NOIDA29.id, 'MANAGER 6: single assigned store selected automatically without location');
eq(m6.reason, 'ONLY_AUTHORIZED_STORE', 'MANAGER 6: reason is ONLY_AUTHORIZED_STORE');

// ---- MANAGER 7: standing next to an unauthorised store -------------------------------------
const m7 = resolvePosStore({ stores: ALL, profile: managerNoida29, coordinate: nearNoida51 });
eq(m7.storeId, NOIDA29.id, 'MANAGER 7: nearby UNAUTHORISED Noida 51 is not selected; own store wins');
ok(m7.storeId !== NOIDA51.id, 'MANAGER 7: unauthorised nearby store never selected');

// ---- CASHIER 8 ------------------------------------------------------------------------------
const c8 = resolvePosStore({ stores: ALL, profile: cashierGolden, coordinate: nearNoida29 });
eq(c8.storeId, GOLDEN.id, 'CASHIER 8: assigned store selected even when standing elsewhere');

// ---- SECURITY 9 -----------------------------------------------------------------------------
eq(eligiblePosStores(ALL, managerNoida29).map(s => s.id), [NOIDA29.id], 'SECURITY 9a: manager sees only the assigned store');
eq(eligiblePosStores(ALL, cashierGolden).map(s => s.id), [GOLDEN.id], 'SECURITY 9b: cashier sees only the assigned store');
eq(resolvePosStore({ stores: ALL, profile: managerNoida29, persistedStoreId: NOIDA51.id }).storeId, NOIDA29.id, 'SECURITY 9c: a persisted UNAUTHORISED store is rejected, not restored');
eq(eligiblePosStores(ALL, null).length, 0, 'SECURITY 9d: no profile -> no eligible stores');

// ---- ELIGIBILITY 10 --------------------------------------------------------------------------
const adminEligible = eligiblePosStores(ALL, admin).map(s => s.id);
ok(!adminEligible.includes(TASTING.id), 'ELIGIBILITY 10a: inactive Tasting Room cannot become the POS store');
ok(!adminEligible.includes(DRAFT.id), 'ELIGIBILITY 10b: DRAFT store cannot become the POS store');
eq(resolvePosStore({ stores: ALL, profile: admin, coordinate: { latitude: 28.5721, longitude: 77.3261 } }).storeId, NOIDA29.id, 'ELIGIBILITY 10c: standing AT the Tasting Room resolves the nearest ELIGIBLE store instead');
ok(!hasNearestResolvableStore([DRAFT]), 'ELIGIBILITY 10d: a store with no coordinates is not nearest-resolvable');
ok(!closestStoreToPosition([store('X', 'X', 'X', { excludeFromNearestSelection: true, latitude: 28.57, longitude: 77.32 })], nearNoida29), 'ELIGIBILITY 10e: excludeFromNearestSelection is honoured (shared customer helper)');

// ---- CART SAFETY 11 (guard is asserted in POSHome source) -----------------------------------
const pos = fs.readFileSync('frontend/pages/pos/POSHome.tsx', 'utf8');
ok(/if \(cart\.length > 0\) return;/.test(pos), 'CART 11a: the location pass returns early when the cart has items');
ok(/setSelectedStoreId\(prev => prev \|\| resolution\.storeId\)/.test(pos), 'CART 11b: initial resolution cannot clobber a live selection (prev || guard)');
ok(/setSelectedStoreId\(prev => \(prev \? prev : resolution\.storeId\)\)/.test(pos), 'CART 11c: the async location callback re-checks before setting');
ok(!/allowedStores\[0\]/.test(pos), 'CART 11d: the positional default is gone entirely');
ok(/Cancel the active Razorpay payment request before changing stores/.test(pos), 'CART 11e: the existing Razorpay lock on store change is preserved');
ok(/Changing store will clear your current cart/.test(pos), 'CART 11f: the existing cart-clear confirmation is preserved');

// ---- the opaque-document-id defect ------------------------------------------------------------
eq(assignedStoreIdentifiers(managerNoida29), ['CJK69TI1MVEH603L4EDW'], 'DOC ID: the matching helper still uppercases (unchanged)');
eq(assignedStoreDocumentIds(managerNoida29), ['cJk69Ti1mveh603L4edw'], 'DOC ID: the path helper preserves original case');
ok(/assignedStoreDocumentIds\(staffProfile\)/.test(pos), 'DOC ID: POSHome fetches stores using original-case document ids');
ok(!/assignedStoreIdentifiers\(staffProfile\)\s*\n\s*\.map\(\(storeId\) => getDoc/.test(pos), 'DOC ID: the uppercased identifier is no longer used as a Firestore path');
eq(POS_STORE_STORAGE_KEY, 'coffeeBondPos:selectedStoreId:v1', 'PERSISTENCE: POS uses its own namespaced key, not the customer key');
ok(storeCoordinate(NOIDA29) !== null, 'GEO: the shared customer coordinate reader parses a store');

console.log(`\n${n} POS store resolution checks passed.`);
