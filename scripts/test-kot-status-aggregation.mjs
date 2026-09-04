#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createKotStatusAggregationHandler,
  effectiveKotTasks,
  summarizeKotOrder,
  summarizeKotOrderItem,
} = require('../functions/kotStatusAggregation');

const task = (id, status, orderItemId = 'LINE_1', extra = {}) => ({
  id,
  status,
  orderId: 'ORDER_1',
  orderItemId,
  storeId: 'STORE_1',
  onlineOrderTrackingToken: 'tracking_token_0123456789abcdef0123456789abcdef',
  ...extra,
});

assert.deepEqual(summarizeKotOrderItem([task('A', 'PENDING')]), {
  orderItemStatus: 'PENDING', needsAttention: false, blockingStatuses: [],
});
assert.equal(summarizeKotOrderItem([task('A', 'SERVED'), task('B', 'PREPARING')]).orderItemStatus, 'PREPARING');
assert.equal(summarizeKotOrderItem([task('A', 'SERVED'), task('B', 'READY')]).orderItemStatus, 'READY');
assert.equal(summarizeKotOrderItem([task('A', 'SERVED'), task('B', 'SERVED')]).orderItemStatus, 'SERVED');

for (const blockingStatus of ['CANCELLED', 'RETURNED', 'WASTAGE_RECORDED']) {
  const summary = summarizeKotOrderItem([task('A', 'SERVED'), task('B', blockingStatus)]);
  assert.equal(summary.orderItemStatus, 'CANCELLED', `${blockingStatus} must not count as successful readiness`);
  assert.equal(summary.needsAttention, true);
  assert.deepEqual(summary.blockingStatuses, [blockingStatus]);
  assert.equal(
    summarizeKotOrder([task('A', 'SERVED'), task('B', blockingStatus)]).publicStatus,
    'NEEDS_ATTENTION',
  );
}

const cancelledComposite = [task('A', 'CANCELLED'), task('B', 'SERVED')];
assert.equal(summarizeKotOrderItem(cancelledComposite).orderItemStatus, 'CANCELLED');
assert.equal(
  summarizeKotOrder([...cancelledComposite, task('C', 'READY', 'LINE_2')]).publicStatus,
  'NEEDS_ATTENTION',
  'a later sibling READY event cannot overwrite a cancellation',
);
assert.equal(
  summarizeKotOrder([...cancelledComposite, task('C', 'SERVED', 'LINE_2')]).publicStatus,
  'NEEDS_ATTENTION',
  'a later sibling SERVED event cannot overwrite a cancellation',
);

const remakeRequested = task('ORIGINAL', 'REMAKE_REQUESTED');
assert.equal(summarizeKotOrderItem([remakeRequested]).needsAttention, true);
const activeRemake = task('REMAKE_1', 'PENDING', 'LINE_1', { remakeOfKotItemId: 'ORIGINAL' });
assert.deepEqual(effectiveKotTasks([remakeRequested, activeRemake]).map(({ id }) => id), ['REMAKE_1']);
assert.equal(summarizeKotOrderItem([remakeRequested, activeRemake]).orderItemStatus, 'PENDING');
assert.equal(summarizeKotOrderItem([
  remakeRequested,
  { ...activeRemake, status: 'SERVED' },
]).orderItemStatus, 'SERVED');

assert.equal(summarizeKotOrder([
  task('A', 'SERVED', 'LINE_1'),
  task('B', 'READY', 'LINE_2'),
]).publicStatus, 'READY');
assert.equal(summarizeKotOrder([
  task('A', 'SERVED', 'LINE_1'),
  task('B', 'SERVED', 'LINE_2'),
]).publicStatus, 'SERVED');
assert.equal(summarizeKotOrder([
  task('A', 'SERVED', 'LINE_1'),
  task('B', 'PENDING', 'LINE_2'),
]).publicStatus, 'PREPARING');

let transactionCalled = false;
const noOpHandler = createKotStatusAggregationHandler({
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } } },
  db: { runTransaction: async () => { transactionCalled = true; } },
  logger: { error: () => {} },
});
assert.deepEqual(
  await noOpHandler({ kotId: 'A', before: { status: 'READY' }, after: { status: 'READY' } }),
  { skipped: 'STATUS_UNCHANGED' },
);
assert.equal(transactionCalled, false, 'metadata-only KOT updates must not retrigger aggregation writes');

const indexSource = readFileSync(resolve('functions/index.js'), 'utf8');
const aggregationSource = readFileSync(resolve('functions/kotStatusAggregation.js'), 'utf8');
const kotScreenSource = readFileSync(resolve('frontend/pages/kot/KOTScreen.tsx'), 'utf8');
const readySource = readFileSync(resolve('frontend/pages/kot/ReadyToServe.tsx'), 'utf8');

assert.match(indexSource, /exports\.aggregateKotOrderStatus = onDocumentUpdated/);
assert.match(indexSource, /document: 'kotItems\/\{kotId\}'/);
assert.match(indexSource, /retry: true/);
assert.match(aggregationSource, /db\.runTransaction/);
assert.match(aggregationSource, /collection\('kotItems'\)\.where\('orderId', '==', orderId\)/);
assert.match(aggregationSource, /transaction\.update\(orderItemRef, \{ status: itemSummary\.orderItemStatus \}\)/);
assert.match(aggregationSource, /transaction\.update\(trackingRef, update\)/);
assert.doesNotMatch(kotScreenSource, /updatePublicOrderTracking|syncPublicTrackingFromKotStatus|aggregateKotTaskStatus/);
assert.doesNotMatch(readySource, /updatePublicOrderTracking|aggregateKotTaskStatus/);
assert.match(readySource, /where\('station', '==', stationScope\)/);
assert.match(readySource, /staffProfile\?\.role === 'ADMIN' \|\| staffProfile\?\.role === 'STORE_MANAGER'/);
assert.match(readySource, /canManageReturns && returnModalItem/);

console.log('KOT status aggregation tests passed: cancellation/return/wastage dominance, remake recovery, idempotence, and server-only sibling aggregation.');
