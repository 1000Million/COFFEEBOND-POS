import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accessiblePosStores, assignedStoreIdentifiers } from '../frontend/lib/posStoreAccess';

const kotScreen = readFileSync(resolve('frontend/pages/kot/KOTScreen.tsx'), 'utf8');
const kotSource = readFileSync(resolve('frontend/lib/useKotRealtime.ts'), 'utf8');
assert.match(kotScreen, /useKotRealtime\('ACTIVE', station\)/);
const posSource = readFileSync(resolve('frontend/pages/pos/POSHome.tsx'), 'utf8');
const posWriteSource = readFileSync(resolve('frontend/data/orders/posOrderRepository.ts'), 'utf8');
const runningOrdersSource = readFileSync(resolve('frontend/pages/pos/RunningOrders.tsx'), 'utf8');

const stores = [
  { id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I', isActive: true },
  { id: 'NOIDA_51', code: 'NOIDA_51', name: 'Noida 51', isActive: true },
  { id: 'DRAFT_STORE', code: 'DRAFT_STORE', name: 'Draft', isActive: false, internalPosTestEnabled: true },
] as any[];

assert.deepEqual(
  accessiblePosStores(stores, { role: 'ADMIN' }).map(store => store.id),
  ['GOLDEN_I', 'NOIDA_51', 'DRAFT_STORE'],
  'Admin retains access to active and explicit setup-test stores.',
);
assert.deepEqual(
  accessiblePosStores(stores, { role: 'CASHIER', assignedStoreId: 'GOLDEN_I' }).map(store => store.id),
  ['GOLDEN_I'],
  'Cashier sees only the assigned active Golden I store.',
);
assert.deepEqual(
  accessiblePosStores(stores, { role: 'BARISTA', assignedLocationIds: ['GOLDEN_I'] }).map(store => store.id),
  ['GOLDEN_I'],
  'Barista legacy location assignments resolve to the assigned active store.',
);
assert.deepEqual(
  accessiblePosStores(stores, { role: 'KITCHEN', storeId: 'GOLDEN_I' }).map(store => store.id),
  ['GOLDEN_I'],
  'Kitchen single-store assignments resolve to the assigned active store.',
);
assert.deepEqual(
  accessiblePosStores(stores, { role: 'CASHIER', assignedStoreIds: ['NOIDA_51'] }).map(store => store.id),
  ['NOIDA_51'],
  'Cashier cannot read another active store without assignment.',
);
assert.deepEqual(
  assignedStoreIdentifiers({ assignedStoreIds: [], assignedStoreId: 'GOLDEN_I' }),
  ['GOLDEN_I'],
  'An empty assignment array does not erase a valid single-store assignment.',
);

assert.match(
  kotSource,
  /role === 'ADMIN'[\s\S]*?getDocs\(collection\(db, 'stores'\)\)[\s\S]*?else[\s\S]*?Promise\.allSettled\(/,
  'Only Admin may list the stores collection; staff must load assigned documents directly.',
);
assert.match(
  kotSource,
  /assignedStoreIdentifiers\(staffProfile\)[\s\S]*?assignments\.map\(id => getDoc\(doc\(db, 'stores', id\)\)/,
  'KOT station staff must load only assigned store documents.',
);
assert.doesNotMatch(
  kotSource,
  /getDocs\(query\(collection\(db, 'stores'\), where\('isActive', '==', true\)\)\)/,
  'KOT stations must not issue an all-active-stores query before assignment filtering.',
);
assert.match(
  kotSource,
  /new Set\(stores\.map\(store => store\.id\)\)\]\.sort\(\)/,
  'KOT subscriptions must use the already-authorized store list.',
);
assert.match(
  kotSource,
  /where\('storeId', '==', storeId\)[\s\S]*?where\('station', '==', station\)[\s\S]*?where\('status', 'in', view === 'ACTIVE' \? \['PENDING', 'PREPARING'\]/,
  'Station subscriptions remain store-, department-, and active-status scoped.',
);

assert.match(posWriteSource, /const createKotItem = \(task: CompositeKotTask\)/);
assert.match(posWriteSource, /buildKotTasks\(\{[\s\S]*?prepStation: linePrepStation,[\s\S]*?components,[\s\S]*?\}\)\.forEach\(createKotItem\)/);
assert.match(posWriteSource, /deterministicKotId\(newOrderRef\.id, lineRef\.id, task\.taskKey\)/, 'KOT IDs remain deterministic for ordinary and component tasks.');
assert.doesNotMatch(
  posSource.match(/const holdCurrentBill = \(\) => \{([\s\S]*?)\n  \};/)?.[1] || '',
  /kotItems|createKotItem|runTransaction/,
  'Held bills must not create KOTs or run checkout writes.',
);
assert.match(runningOrdersSource, /collection\(db, 'kotItems'\)/, 'Running Orders and stations continue to use the same KOT collection.');
assert.match(posWriteSource, /deterministicStockMovementId\(newOrderRef\.id, movement\)/, 'Stock movement identity remains deterministic and unchanged.');

console.log('KOT assigned-store access and deterministic routing tests passed.');
