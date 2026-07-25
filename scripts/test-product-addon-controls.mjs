import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildProductAddOnControlsPlan } from './product-addon-controls-plan.mjs';

const groupDocs = [{
  id: 'beverage_add_on',
  data: {
    name: 'Beverage Add On',
    isActive: true,
    options: [
      { id: 'OAT_MILK', isActive: true },
      { id: 'COLD_FOAM', isActive: true },
      { id: 'INACTIVE_OPTION', isActive: false },
    ],
  },
}];
const finishedGoodDocs = [
  {
    id: 'CAPPUCCINO',
    data: {
      code: 'CAPPUCCINO',
      name: 'Cappuccino',
      addOnGroupIds: ['beverage_add_on'],
    },
  },
  {
    id: 'HOT_LATTE',
    data: {
      code: 'HOT_LATTE',
      name: 'Hot Latte',
      addOnGroupIds: ['beverage_add_on'],
      addOnOptionIdsByGroup: { beverage_add_on: ['OAT_MILK'] },
    },
  },
  {
    id: 'AMERICANO',
    data: {
      code: 'AMERICANO',
      name: 'Americano',
      addOnGroupIds: ['beverage_add_on'],
      addOnOptionIdsByGroup: { beverage_add_on: [] },
    },
  },
];

const plan = buildProductAddOnControlsPlan({ finishedGoodDocs, addOnGroupDocs: groupDocs });
assert.equal(plan.applyReadiness, 'READY');
assert.equal(plan.counts.assignedProductsReviewed, 3);
assert.equal(plan.counts.productsToUpdate, 1);
assert.equal(plan.counts.allowlistsToBackfill, 1);
assert.deepEqual(
  plan.documentUpdates[0].afterAddOnOptionIdsByGroup.beverage_add_on,
  ['COLD_FOAM', 'OAT_MILK'],
);
assert.equal(
  plan.rows.find(row => row.productCode === 'HOT_LATTE').action,
  'KEEP_EXPLICIT_ALLOWLIST',
);
assert.deepEqual(
  plan.rows.find(row => row.productCode === 'AMERICANO').proposedOptionIds,
  [],
);

const migratedDocs = finishedGoodDocs.map(document => document.id === 'CAPPUCCINO'
  ? {
      ...document,
      data: {
        ...document.data,
        addOnOptionIdsByGroup: plan.documentUpdates[0].afterAddOnOptionIdsByGroup,
      },
    }
  : document);
const repeatedPlan = buildProductAddOnControlsPlan({
  finishedGoodDocs: migratedDocs,
  addOnGroupDocs: groupDocs,
});
assert.equal(repeatedPlan.counts.productsToUpdate, 0);
assert.equal(repeatedPlan.counts.firstApplyFirestoreWrites, 0);

const blockedPlan = buildProductAddOnControlsPlan({
  finishedGoodDocs: [{
    id: 'BROKEN',
    data: { code: 'BROKEN', name: 'Broken', addOnGroupIds: ['missing_group'] },
  }],
  addOnGroupDocs: groupDocs,
});
assert.equal(blockedPlan.applyReadiness, 'BLOCKED');
assert.equal(blockedPlan.blockers[0].reason, 'ASSIGNED_ADD_ON_GROUP_NOT_FOUND');

const adminSource = fs.readFileSync('frontend/components/admin/menu-management/ProductAddOnControls.tsx', 'utf8');
const posSource = fs.readFileSync('frontend/pages/pos/POSHome.tsx', 'utf8');
const customerSource = fs.readFileSync('frontend/pages/customer/CustomerOrder.tsx', 'utf8');
const publicSnapshotSource = fs.readFileSync('frontend/lib/publicMenuAvailability.ts', 'utf8');
const publicRefreshSource = fs.readFileSync('scripts/refresh-public-menu-availability.mjs', 'utf8');
const posAuthorizationSource = fs.readFileSync('functions/posAddOnAuthorization.js', 'utf8');
const customerAuthorizationSource = fs.readFileSync('functions/index.js', 'utf8');

assert.ok(adminSource.includes('Product Add-on Controls'));
assert.ok(adminSource.includes('productAddOnAudit'));
assert.ok(adminSource.includes('Reason for change'));
assert.ok(adminSource.includes('Select all') && adminSource.includes('Clear all'));
assert.ok(adminSource.includes('Fully enabled') && adminSource.includes('Partially enabled') && adminSource.includes('No options'));
assert.ok(posSource.includes('item?.addOnOptionIdsByGroup'));
assert.ok(customerSource.includes('item.addOnOptionIdsByGroup'));
assert.ok(publicSnapshotSource.includes('addOnOptionIdsByGroup'));
assert.ok(publicRefreshSource.includes('addOnOptionIdsByGroup'));
assert.ok(posAuthorizationSource.includes('not enabled for this product'));
assert.ok(customerAuthorizationSource.includes('unavailable for this product'));

for (const source of [publicSnapshotSource, publicRefreshSource]) {
  const nearby = source.slice(
    Math.max(0, source.indexOf('addOnOptionIdsByGroup') - 500),
    source.indexOf('addOnOptionIdsByGroup') + 700,
  );
  assert.equal(/inventoryItemCode|consumptionQuantity|costPerUnit/.test(nearby), false);
}

console.log('Product add-on controls tests passed:');
console.log('- missing allowlists backfill all active options without including inactive options');
console.log('- explicit partial and empty allowlists are preserved');
console.log('- repeated migration execution is idempotent');
console.log('- Admin controls, public snapshots, POS, customer ordering, and server enforcement use the option allowlist');

