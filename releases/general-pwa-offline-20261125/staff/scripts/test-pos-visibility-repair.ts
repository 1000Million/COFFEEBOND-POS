import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MenuItem } from '../frontend/types';
import {
  activePosMenuCategories,
  committedPosMenuTaxonomy,
  resolvePosMenuTaxonomy,
} from '../frontend/lib/posMenuTaxonomy';
import { classifyPosMenuItemWithCategories } from '../frontend/lib/posMenuNavigation';
import {
  POS_VISIBILITY_REPAIR_ALLOWED_FIELDS,
  POS_VISIBILITY_REPAIR_PROTECTED_FIELDS,
  assessPosClassificationRecovery,
  assertPosVisibilityRepairPatch,
  planPosVisibilityRepair,
} from '../frontend/lib/posVisibilityRepair';

const fallbackCategories = activePosMenuCategories(committedPosMenuTaxonomy());
const stores = ['golden-i'];

const visibleItem = {
  id: 'espresso-1',
  code: 'DOUBLE_ESPRESSO',
  name: 'Double Espresso',
  posCategoryCode: 'ESPRESSO_BAR',
  posCategoryName: 'Espresso Bar',
  categorySortOrder: 10,
  posSubcategoryCode: 'BLACK_COFFEE',
  posSubcategoryName: 'Black Coffee',
  subcategorySortOrder: 10,
  sortOrder: 7,
  isActive: true,
  isSellable: true,
  isAvailable: true,
  availableStoreIds: stores,
  salePrice: 180,
};

// Canonical category/subcategory placement remains byte-for-byte identical.
const canonicalPlan = planPosVisibilityRepair(visibleItem, stores, fallbackCategories);
assert.deepEqual(canonicalPlan.patch, {});
const placementFields = POS_VISIBILITY_REPAIR_PROTECTED_FIELDS;
for (const field of placementFields) {
  assert.deepEqual(
    { ...visibleItem, ...canonicalPlan.patch }[field],
    visibleItem[field],
    `${field} must survive repair planning`,
  );
}
assert.equal(canonicalPlan.needsClassification, false);

// Effective editable categories, including a new category, survive unchanged.
const editableTaxonomy = committedPosMenuTaxonomy();
editableTaxonomy.categories.push({
  code: 'SOURDOUGH_SANDWICHES',
  name: 'Sourdough Sandwiches',
  sortOrder: 150,
  isActive: true,
  subcategories: [
    { code: 'TOASTED', name: 'Toasted', sortOrder: 10, isActive: true },
  ],
});
const resolvedEditable = resolvePosMenuTaxonomy(editableTaxonomy);
assert.equal(resolvedEditable.source, 'firestore');
const editableCategories = activePosMenuCategories(resolvedEditable.taxonomy);
const editableItem = {
  ...visibleItem,
  id: 'sourdough-1',
  code: 'SOURDOUGH_TEST',
  name: 'Sourdough Test',
  posCategoryCode: 'SOURDOUGH_SANDWICHES',
  posCategoryName: 'Sourdough Sandwiches',
  categorySortOrder: 150,
  posSubcategoryCode: 'TOASTED',
  posSubcategoryName: 'Toasted',
};
const editablePlan = planPosVisibilityRepair(editableItem, stores, editableCategories);
assert.equal(editablePlan.needsClassification, false);
assert.equal('posCategoryCode' in editablePlan.patch, false);
assert.equal('posSubcategoryCode' in editablePlan.patch, false);
assert.equal(({ ...editableItem, ...editablePlan.patch }).posSubcategoryCode, 'TOASTED');

// No protected or heuristic classification value can be emitted by a plan.
for (const plan of [canonicalPlan, editablePlan]) {
  assert.ok(Object.keys(plan.patch).every((key) => (
    POS_VISIBILITY_REPAIR_ALLOWED_FIELDS as readonly string[]
  ).includes(key)));
  assert.ok(Object.keys(plan.patch).every((key) => !(
    POS_VISIBILITY_REPAIR_PROTECTED_FIELDS as readonly string[]
  ).includes(key)));
  assert.doesNotMatch(JSON.stringify(plan.patch), /"(?:ESP|MISC|PAS)"/);
}
assert.throws(
  () => assertPosVisibilityRepairPatch({ posCategoryCode: 'MISC' }),
  /protected field\(s\) present: posCategoryCode/,
);
assert.throws(
  () => assertPosVisibilityRepairPatch({ salePrice: 0 }),
  /unapproved field\(s\) present: salePrice/,
);

// Needs Classification remains Needs Classification after any visibility patch.
const unknownItem = {
  ...visibleItem,
  id: 'unknown-1',
  code: 'UNKNOWN_ITEM',
  name: 'Unknown Item',
  posCategoryCode: 'MISC',
  posCategoryName: 'Misc',
  posSubcategoryCode: '',
  posSubcategoryName: '',
  isActive: 'true',
};
const unknownPlan = planPosVisibilityRepair(unknownItem, stores, editableCategories);
assert.equal(unknownPlan.needsClassification, true);
assert.match(unknownPlan.classificationReason || '', /Unknown category code: MISC/);
assert.equal(
  classifyPosMenuItemWithCategories(
    { ...unknownItem, ...unknownPlan.patch } as unknown as Partial<MenuItem>,
    editableCategories,
  ).isClassified,
  false,
);
assert.equal('posCategoryCode' in unknownPlan.patch, false);

// Intentionally disabled visibility is warning-only by default.
const disabledItem = {
  ...visibleItem,
  id: 'disabled-1',
  code: 'DISABLED_ITEM',
  isActive: false,
  isSellable: false,
  isAvailable: false,
};
const disabledPlan = planPosVisibilityRepair(disabledItem, stores, fallbackCategories);
assert.deepEqual(disabledPlan.patch, {});
assert.equal(disabledPlan.visibilityWarnings.length, 3);
const explicitPlan = planPosVisibilityRepair(disabledItem, stores, fallbackCategories, {
  includeExplicitActivation: true,
});
assert.deepEqual(explicitPlan.patch, {
  isActive: true,
  isSellable: true,
  isAvailable: true,
});
assert.ok(explicitPlan.changes.every((change) => change.requiresExplicitActivation));

// Minimal patch: normalize only the malformed approved field.
const minimalPlan = planPosVisibilityRepair(
  { ...visibleItem, id: 'minimal-1', isActive: 'true' },
  stores,
  fallbackCategories,
);
assert.deepEqual(minimalPlan.patch, { isActive: true });

// Duplicate names are independent because plans and writes are document-ID based.
const duplicateA = planPosVisibilityRepair(
  { ...visibleItem, id: 'duplicate-a', code: 'DUP_A', name: 'Same Name', isActive: 'true' },
  stores,
  fallbackCategories,
);
const duplicateB = planPosVisibilityRepair(
  { ...visibleItem, id: 'duplicate-b', code: 'DUP_B', name: 'Same Name', isSellable: 'true' },
  stores,
  fallbackCategories,
);
assert.equal(duplicateA.productName, duplicateB.productName);
assert.notEqual(duplicateA.documentId, duplicateB.documentId);
assert.notDeepEqual(duplicateA.patch, duplicateB.patch);

// Recovery is read-only: deterministic legacy metadata is HIGH, unknown is manual.
const highRecovery = assessPosClassificationRecovery({
  ...unknownItem,
  categoryCode: 'ESP',
  subcategoryCode: 'BLK',
}, fallbackCategories);
assert.equal(highRecovery?.confidence, 'HIGH');
assert.equal(highRecovery?.canConfidentlyRecover, true);
assert.equal(highRecovery?.proposedCategoryCode, 'ESPRESSO_BAR');
assert.equal(highRecovery?.proposedSubcategoryCode, 'BLACK_COFFEE');

const manualRecovery = assessPosClassificationRecovery(unknownItem, fallbackCategories);
assert.equal(manualRecovery?.confidence, 'MANUAL REVIEW');
assert.equal(manualRecovery?.proposedCategoryCode, null);
assert.match(manualRecovery?.reason || '', /No product-name inference/);

const mediumRecovery = assessPosClassificationRecovery({
  ...unknownItem,
  categoryCode: '',
  categoryName: 'Espresso Bar',
}, fallbackCategories);
assert.equal(mediumRecovery?.confidence, 'MEDIUM');
assert.equal(mediumRecovery?.proposedCategoryCode, 'ESPRESSO_BAR');

const repairEraRecovery = assessPosClassificationRecovery({
  ...unknownItem,
  posCategoryCode: 'CBV',
  posCategoryName: 'Cold Brew & Vietnamese',
}, fallbackCategories);
assert.equal(repairEraRecovery?.confidence, 'MEDIUM');
assert.equal(repairEraRecovery?.canConfidentlyRecover, false);
assert.equal(repairEraRecovery?.proposedCategoryCode, 'COLD_BREW_VIETNAMESE_STYLE');
assert.equal(repairEraRecovery?.proposedSubcategoryCode, null);

// Static integration checks keep the UI preview-first and the batch guarded.
const tabSource = readFileSync(
  'frontend/components/admin/menu-management/FinishedGoodsTab.tsx',
  'utf8',
);
assert.doesNotMatch(tabSource, /n\.includes\("espresso"\)/, 'name heuristics must be removed');
assert.doesNotMatch(tabSource, /cCode\s*=\s*"MISC"/, 'repair must not generate MISC');
assert.match(tabSource, /POS category and subcategory placement will not be changed\./);
assert.match(tabSource, /assertPosVisibilityRepairPatch\(plan\.patch\)/);
assert.match(tabSource, /doc\(db, "finishedGoods", plan\.documentId\)/);
assert.match(tabSource, /window\.confirm\(/, 'repair writes require explicit confirmation');
assert.match(tabSource, /Assign a POS Category in the item editor\./);

console.log('POS visibility repair tests passed');
