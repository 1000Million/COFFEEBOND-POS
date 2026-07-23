import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EXPECTED_PHASE_1_DEFERRED_PRODUCTS,
  EXPECTED_PHASE_1_SOURCE_ASSIGNMENTS,
  PHASE_1_PROJECT_ID,
  buildPhase1Plan,
} from './addon-group-phase-1.mjs';

const deferredCodes = [
  'MUSHROOM_MELT',
  'BUTTER_COOKIE',
  'COOKIEE',
  'AMERICANO',
  'PANEER_SANDWICH',
  'BUTTER_CROISSANT',
  'V_C_BURST',
  'ORANGE_ESPRESSO_TONIC',
  'DOUBLE_CHOCOLATE_COOKIE',
  'ALMOND_CROISSANT',
];
const proposedGroups = {
  food_add_on: {
    id: 'food_add_on',
    name: 'Food Add On',
    options: Array.from({ length: 15 }, (_, index) => ({
      id: `FOOD_${index + 1}`,
      name: `Food ${index + 1}`,
      price: index + 1,
      isActive: true,
    })),
  },
  beverage_add_on: {
    id: 'beverage_add_on',
    name: 'Beverage Add On',
    options: Array.from({ length: 12 }, (_, index) => ({
      id: `BEVERAGE_${index + 1}`,
      name: `Beverage ${index + 1}`,
      price: index + 1,
      isActive: true,
    })),
  },
};
const assignedRows = Array.from({ length: 54 }, (_, index) => {
  const uniqueTargetIndex = index < 48 ? index : index - 48;
  const classification = uniqueTargetIndex < 30 ? 'BEVERAGE' : 'FOOD';
  const groupId = classification === 'BEVERAGE' ? 'beverage_add_on' : 'food_add_on';
  return {
    sourcePath: `menuItems/SOURCE_${index + 1}`,
    targetPath: `finishedGoods/TARGET_${uniqueTargetIndex + 1}`,
    productCode: `SOURCE_${index + 1}`,
    productName: `Source ${index + 1}`,
    category: classification === 'BEVERAGE' ? 'Coffee' : 'Food',
    classification,
    existingAddOnGroupIds: [],
    proposedAddOnGroupIds: [groupId],
    targetResolution: 'EXACT_CODE',
    ownerApprovedAction: null,
    ownerApprovedAt: null,
    ownerApprovalNote: null,
    action: 'UPDATE',
    reason: 'Phase 1 assignment fixture.',
  };
});
const deferredRows = deferredCodes.map((productCode, index) => ({
  sourcePath: `menuItems/${productCode}`,
  targetPath: null,
  productCode,
  productName: productCode,
  category: index % 2 ? 'Food' : 'Coffee',
  classification: index % 2 ? 'FOOD' : 'BEVERAGE',
  existingAddOnGroupIds: [],
  proposedAddOnGroupIds: [index % 2 ? 'food_add_on' : 'beverage_add_on'],
  targetResolution: 'NONE',
  ownerApprovedAction: 'REQUIRE_DEDICATED_FINISHED_GOOD',
  ownerApprovedAt: '2026-07-23T08:18:37Z',
  ownerApprovalNote: 'Explicit Phase 1 deferral.',
  action: 'DEFERRED_MISSING_FINISHED_GOOD_DATA',
  reason: 'Deferred pending dedicated Finished Good data.',
}));
const excludedRows = [
  {
    sourcePath: 'menuItems/ALMONDS',
    targetPath: null,
    productCode: 'ALMONDS',
    productName: 'Almonds',
    category: 'Ice Cream',
    classification: 'FOOD',
    existingAddOnGroupIds: [],
    proposedAddOnGroupIds: [],
    targetResolution: 'OWNER_EXCLUDED_LEGACY',
    ownerApprovedAction: 'EXCLUDE_LEGACY',
    action: 'EXCLUDE_LEGACY',
    reason: 'Legacy non-sellable menu record.',
  },
  {
    sourcePath: 'menuItems/HOUSE_BLEND_BEANS_250G',
    targetPath: null,
    productCode: 'HOUSE_BLEND_BEANS_250G',
    productName: 'House Blend Beans 250g',
    category: 'Retail Coffee',
    classification: 'REVIEW',
    existingAddOnGroupIds: [],
    proposedAddOnGroupIds: [],
    targetResolution: 'NONE',
    ownerApprovedAction: null,
    action: 'SKIP_NO_TARGET_NO_ADD_ON',
    reason: 'Approved Retail Coffee exemption.',
  },
];
const inventoryAudit = [
  ...proposedGroups.food_add_on.options.map((option) => ({
    groupId: 'food_add_on',
    optionId: option.id,
    inventoryMappingStatus: 'NOT_CONFIGURED',
    readinessResult: 'PRICING_ONLY',
  })),
  ...proposedGroups.beverage_add_on.options.map((option) => ({
    groupId: 'beverage_add_on',
    optionId: option.id,
    inventoryMappingStatus: 'NOT_CONFIGURED',
    readinessResult: 'PRICING_ONLY',
  })),
];
const report = {
  summary: {
    zeroWritesPerformed: true,
    groupCreatesOrUpdates: [
      { path: 'addOnGroups/food_add_on', action: 'CREATE' },
      { path: 'addOnGroups/beverage_add_on', action: 'CREATE' },
    ],
    inventoryConfiguredOptionCount: 0,
    inventoryNotConfiguredOptionCount: 27,
    fuzzyProductMatchingUsed: false,
  },
  proposedGroups,
  productUpdates: [...assignedRows, ...deferredRows, ...excludedRows],
  inventoryAudit,
};
const approvalManifest = {
  manifestVersion: 1,
  phase1: {
    projectId: PHASE_1_PROJECT_ID,
    approved: true,
    expectedSourceAssignments: 54,
    expectedDeferredProducts: 10,
  },
  entries: [],
};

const plan = buildPhase1Plan({ report, approvalManifest });
const repeatedPlan = buildPhase1Plan({ report, approvalManifest });

assert.equal(plan.projectId, 'coffee-bond-pos');
assert.equal(plan.applyReadiness, 'READY_PHASE_1');
assert.deepEqual(plan.phase1Blockers, []);
assert.equal(plan.counts.sourceProductAssignments, EXPECTED_PHASE_1_SOURCE_ASSIGNMENTS);
assert.equal(plan.counts.uniqueFinishedGoodDocuments, 48);
assert.equal(plan.counts.finishedGoodDocumentsToUpdate, 48);
assert.equal(plan.counts.duplicateSourceAssignmentsConsolidated, 6);
assert.equal(plan.counts.deferredProducts, EXPECTED_PHASE_1_DEFERRED_PRODUCTS);
assert.equal(plan.counts.legacyExclusions, 1);
assert.equal(plan.counts.inventoryConfiguredOptions, 0);
assert.equal(plan.counts.inventoryNotConfiguredOptions, 27);
assert.equal(plan.counts.firstApplyFirestoreWrites, 51);
assert.equal(plan.dryRunChecksum, repeatedPlan.dryRunChecksum);
assert.equal(plan.deferredProducts.every((product) => (
  product.status === 'DEFERRED_MISSING_FINISHED_GOOD_DATA'
  && product.phase1AddOnGroupIds.length === 0
)), true);
assert.equal(plan.assignedProducts.some((product) => product.productCode === 'ALMONDS'), false);
assert.equal(plan.assignedProducts.some((product) => product.productCode === 'HOUSE_BLEND_BEANS_250G'), false);
assert.equal(plan.inventoryLimitation.inventoryTrackingStatus, 'NOT_CONFIGURED');
assert.equal(plan.inventoryLimitation.checkoutBlocked, false);
assert.equal(plan.inventoryLimitation.assumedStockMovementsCreated, false);

const applySource = fs.readFileSync('scripts/apply-addon-group-deployment.mjs', 'utf8');
const phase1Source = fs.readFileSync('scripts/addon-group-phase-1.mjs', 'utf8');
assert.match(phase1Source, /--confirm-phase-1/);
assert.match(phase1Source, /coffee-bond-pos/);
assert.match(applySource, /requestedProjectId !== PHASE_1_PROJECT_ID/);
assert.match(applySource, /--operator-uid=<ACTIVE_ADMIN_UID>/);
assert.match(applySource, /phase1ApplyReadiness !== 'READY_PHASE_1'/);
assert.match(applySource, /dry-run checksum mismatch/i);
assert.match(applySource, /operator\.isActive !== true \|\| operator\.role !== 'ADMIN'/);
assert.match(applySource, /batch\.create\(auditRef/);

console.log('Phase 1 add-on deployment contract tests passed:');
console.log('- 54 source product assignments consolidate into 48 canonical Finished Good writes');
console.log('- 10 products remain explicitly deferred without Phase 1 add-on mappings');
console.log('- ALMONDS and Retail Coffee remain excluded');
console.log('- all 27 options remain pricing-only with no assumed inventory movement');
console.log('- dry-run checksum is deterministic');
