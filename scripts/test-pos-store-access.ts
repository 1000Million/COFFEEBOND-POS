import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  accessiblePosStores,
  assignedStoreIdentifiers,
  storeMatchesAssignment,
} from '../frontend/lib/posStoreAccess';
import type { Store } from '../frontend/types';

const goldenI: Store = {
  id: 'GOLDEN_I',
  code: 'GOLDEN_I',
  name: 'Golden I',
  address: '',
  isActive: true,
  createdAt: null,
  updatedAt: null,
};
const noida51: Store = {
  id: 'L0qB13uuPxHvv089YtGQ',
  code: 'NOIDA_51',
  storeCode: 'NOIDA_51',
  name: 'Noida Sector 51',
  address: '',
  isActive: true,
  createdAt: null,
  updatedAt: null,
};
const inactiveStore: Store = {
  id: 'INACTIVE_STORE',
  code: 'INACTIVE_STORE',
  name: 'Inactive Store',
  address: '',
  isActive: false,
  createdAt: null,
  updatedAt: null,
};
const setupTestStore: Store = {
  ...inactiveStore,
  id: 'SETUP_TEST_STORE',
  code: 'SETUP_TEST_STORE',
  name: 'Setup Test Store',
  internalPosTestEnabled: true,
};

assert.deepEqual(
  accessiblePosStores([goldenI, noida51, inactiveStore], { role: 'ADMIN' }),
  [goldenI, noida51],
  'Admin must retain access to active stores',
);
assert.deepEqual(
  accessiblePosStores([goldenI, setupTestStore], { role: 'ADMIN' }),
  [goldenI, setupTestStore],
  'Admin must retain access to internal POS setup-test stores',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'CASHIER', assignedStoreId: 'GOLDEN_I' }),
  [goldenI],
  'a Cashier assigned with assignedStoreId must see Golden I only',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'CASHIER', assignedStoreIds: ['GOLDEN_I'] }),
  [goldenI],
  'a Cashier assigned with assignedStoreIds must see Golden I only',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'CASHIER', assignedStoreIds: [], assignedStoreId: 'GOLDEN_I' }),
  [goldenI],
  'an empty assignedStoreIds array must not override a valid single assignment',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'CASHIER', assignedLocationId: ' golden_i ' }),
  [goldenI],
  'a legacy single location assignment must be normalized safely',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'CASHIER', assignedLocationIds: ['GOLDEN_I'] }),
  [goldenI],
  'a legacy location assignment array must be supported',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'CASHIER' }),
  [],
  'an unassigned Cashier must not receive store access',
);
assert.deepEqual(
  accessiblePosStores([goldenI, noida51], { role: 'STORE_MANAGER', storeIds: ['GOLDEN_I'] }),
  [goldenI],
  'a Store Manager must remain limited to explicitly assigned stores',
);
assert.deepEqual(
  accessiblePosStores([goldenI, setupTestStore], {
    role: 'STORE_MANAGER',
    storeIds: ['SETUP_TEST_STORE'],
  }),
  [setupTestStore],
  'an assigned Store Manager may access an internal POS setup-test store',
);
assert.deepEqual(
  accessiblePosStores([goldenI, setupTestStore], {
    role: 'STORE_MANAGER',
    storeIds: ['GOLDEN_I'],
  }),
  [goldenI],
  'an unrelated Store Manager must not gain setup-test access from the store flag alone',
);
assert.deepEqual(
  accessiblePosStores([goldenI, setupTestStore], {
    role: 'CASHIER',
    storeIds: ['GOLDEN_I', 'SETUP_TEST_STORE'],
  }),
  [goldenI],
  'a Cashier may use an assigned active store but not an assigned setup-test store',
);
assert.equal(
  storeMatchesAssignment(noida51, [' noida_51 ']),
  true,
  'historical store-code assignments must compare case-insensitively after trimming',
);
assert.deepEqual(
  assignedStoreIdentifiers({
    assignedStoreIds: [],
    storeIds: ['GOLDEN_I'],
    assignedStoreId: 'GOLDEN_I',
  }),
  ['GOLDEN_I'],
  'all assignment fields must be unioned and deduplicated',
);

const posSource = readFileSync(resolve('frontend/pages/pos/POSHome.tsx'), 'utf8');
assert.doesNotMatch(
  posSource,
  /query\(collection\(db, ['"]stores['"]\), where\(['"]isActive['"], ['"]==['"], true\)\)/,
  'non-Admin POS access must not list every active store through a query rejected by store-scoped rules',
);
// The intent is unchanged: non-Admins must read ONLY their assigned store documents and must
// never list the whole collection. The helper changed because `assignedStoreIdentifiers`
// uppercases, and three production stores use opaque mixed-case document ids
// (Noida 29 `cJk69Ti1mveh603L4edw`), so an uppercased id is a path that does not exist.
assert.match(
  posSource,
  /assignedStoreDocumentIds\(staffProfile\)/,
  'POS must read only assigned store documents for non-Admins, addressed by original-case id',
);
assert.doesNotMatch(
  posSource,
  /assignedStoreIdentifiers\(staffProfile\)\s*\n\s*\.map\(\(storeId\) => getDoc/,
  'POS must not use the uppercased matching identifier as a Firestore document path',
);

console.log('POS store-access regression tests passed.');
