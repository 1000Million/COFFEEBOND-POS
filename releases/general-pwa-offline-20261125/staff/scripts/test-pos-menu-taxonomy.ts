import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activePosMenuCategories,
  allPosMenuCategories,
  categoryReferenceCount,
  committedPosMenuTaxonomy,
  normalizeTaxonomyCode,
  normalizeTaxonomyName,
  resolvePosMenuTaxonomy,
  taxonomyReferenceProtection,
  taxonomyUsage,
  validatePosMenuTaxonomy,
} from '../frontend/lib/posMenuTaxonomy';
import {
  buildPosMenuPlacementPatch,
  classifyPosMenuItemWithCategories,
} from '../frontend/lib/posMenuNavigation';

const fallback = committedPosMenuTaxonomy();
assert.equal(resolvePosMenuTaxonomy(null).source, 'fallback');
assert.equal(resolvePosMenuTaxonomy({ categories: [] }).source, 'fallback');
assert.notStrictEqual(committedPosMenuTaxonomy().categories, committedPosMenuTaxonomy().categories);

const saved = { schemaVersion: 1, categories: [{ code: 'DRINKS', name: 'Drinks', sortOrder: 10, isActive: true, subcategories: [] }] };
assert.equal(resolvePosMenuTaxonomy(saved).source, 'firestore');
assert.equal(resolvePosMenuTaxonomy(saved).taxonomy.categories[0].code, 'DRINKS');
assert.equal(resolvePosMenuTaxonomy({ categories: [{ code: '', name: 'Bad', sortOrder: 10, subcategories: [] }] }).source, 'fallback');

const editable = committedPosMenuTaxonomy();
editable.categories[0].name = 'Espresso & Coffee';
editable.categories[0].sortOrder = 15;
editable.categories.push(
  {
    code: 'SOURDOUGH_SANDWICHES',
    name: 'Sourdough Sandwiches',
    sortOrder: 150,
    isActive: true,
    subcategories: [],
  },
  {
    code: 'PASTA',
    name: 'Pasta',
    sortOrder: 160,
    isActive: true,
    subcategories: [
      { code: 'FRESH_PASTA', name: 'Fresh Pasta', sortOrder: 10, isActive: true },
      { code: 'PASTA_ARCHIVE', name: 'Archived Pasta', sortOrder: 20, isActive: false },
    ],
  },
  {
    code: 'INACTIVE_ADDITION',
    name: 'Inactive Addition',
    sortOrder: 170,
    isActive: false,
    subcategories: [],
  },
);

const resolvedEditable = resolvePosMenuTaxonomy(editable);
assert.equal(resolvedEditable.source, 'firestore');
const editableOptions = activePosMenuCategories(resolvedEditable.taxonomy);
assert.ok(editableOptions.some((category) => category.code === 'SOURDOUGH_SANDWICHES'));
assert.ok(editableOptions.some((category) => category.code === 'PASTA'));
assert.ok(!editableOptions.some((category) => category.code === 'INACTIVE_ADDITION'));
assert.deepEqual(
  editableOptions.find((category) => category.code === 'PASTA')?.subcategories.map((entry) => entry.code),
  ['FRESH_PASTA'],
);
assert.ok(
  !editableOptions.find((category) => category.code === 'SOURDOUGH_SANDWICHES')
    ?.subcategories.some((entry) => entry.code === 'FRESH_PASTA'),
);
assert.equal(editableOptions.find((category) => category.code === 'ESPRESSO_BAR')?.name, 'Espresso & Coffee');

const editablePlacement = buildPosMenuPlacementPatch({
  posCategoryCode: 'PASTA',
  posSubcategoryCode: 'FRESH_PASTA',
  sortOrder: 7,
}, editableOptions);
assert.deepEqual(editablePlacement, {
  ok: true,
  patch: {
    posCategoryCode: 'PASTA',
    posCategoryName: 'Pasta',
    categorySortOrder: 160,
    posSubcategoryCode: 'FRESH_PASTA',
    posSubcategoryName: 'Fresh Pasta',
    subcategorySortOrder: 10,
    sortOrder: 7,
  },
});
if (editablePlacement.ok) {
  assert.deepEqual(Object.keys(editablePlacement.patch).sort(), [
    'categorySortOrder',
    'posCategoryCode',
    'posCategoryName',
    'posSubcategoryCode',
    'posSubcategoryName',
    'sortOrder',
    'subcategorySortOrder',
  ]);
}
assert.equal(classifyPosMenuItemWithCategories({ posCategoryCode: 'PASTA', posSubcategoryCode: 'FRESH_PASTA' }, editableOptions).isClassified, true);
assert.equal(classifyPosMenuItemWithCategories({ posCategoryCode: 'INACTIVE_ADDITION' }, editableOptions).isClassified, false);

const missingOptions = activePosMenuCategories(resolvePosMenuTaxonomy(null).taxonomy);
assert.ok(missingOptions.some((category) => category.code === 'ESPRESSO_BAR'));
const invalidEditable = committedPosMenuTaxonomy();
invalidEditable.categories[1].code = invalidEditable.categories[0].code;
const invalidOptions = activePosMenuCategories(resolvePosMenuTaxonomy(invalidEditable).taxonomy);
assert.deepEqual(
  invalidOptions.map((category) => category.code),
  activePosMenuCategories(committedPosMenuTaxonomy()).map((category) => category.code),
);

assert.equal(normalizeTaxonomyCode(' New drinks & more '), 'NEW_DRINKS_MORE');
assert.equal(normalizeTaxonomyName(' Espresso   Bar '), 'espresso bar');

const duplicateCode = committedPosMenuTaxonomy();
duplicateCode.categories[1].code = duplicateCode.categories[0].code;
assert.deepEqual(validatePosMenuTaxonomy(duplicateCode), {
  ok: false,
  error: 'Every category needs a unique code.',
});

for (const duplicateName of ['Espresso Bar', ' espresso   bar ', 'ESPRESSO BAR']) {
  const duplicateCategoryName = committedPosMenuTaxonomy();
  duplicateCategoryName.categories[1].name = duplicateName;
  assert.deepEqual(validatePosMenuTaxonomy(duplicateCategoryName), {
    ok: false,
    error: 'Duplicate category name is not allowed.',
  });
}

const duplicateSubcategoryName = committedPosMenuTaxonomy();
duplicateSubcategoryName.categories[0].subcategories[1].name = ' black   coffee ';
assert.deepEqual(validatePosMenuTaxonomy(duplicateSubcategoryName), {
  ok: false,
  error: 'Duplicate subcategory name is not allowed within Espresso Bar.',
});

const sameSubcategoryNameUnderDifferentParent = committedPosMenuTaxonomy();
sameSubcategoryNameUnderDifferentParent.categories[2].subcategories[0].name = 'Black Coffee';
assert.deepEqual(validatePosMenuTaxonomy(sameSubcategoryNameUnderDifferentParent), { ok: true });

const usage = taxonomyUsage([
  { posCategoryCode: 'ESPRESSO_BAR', posSubcategoryCode: 'MILK_BASED', isActive: true, isSellable: true },
  { categoryCode: 'ESP', subcategoryCode: 'MILK', isActive: true, isSellable: true },
  { categoryCode: 'ESP', subcategoryCode: 'BLK', isActive: true, isSellable: true },
  { categoryCode: 'ESP', subcategoryCode: 'ICE', isActive: true, isSellable: true },
  { categoryCode: 'BAK', isActive: true, isSellable: true },
  { categoryCode: 'ZAF', isActive: true, isSellable: true },
  { categoryCode: 'SAL', isActive: true, isSellable: true },
  { categoryCode: 'PIZ', isActive: true, isSellable: true },
  { categoryCode: 'CCF', isActive: true, isSellable: true },
  { categoryCode: 'JUI', isActive: true, isSellable: true },
  { categoryCode: 'UNKNOWN', isActive: true, isSellable: true },
  { categoryCode: 'PIZ', isActive: false, isSellable: true },
  { categoryCode: 'PIZ', isActive: true, isSellable: false },
]);
assert.equal(usage.categoryCounts.ESPRESSO_BAR, 3);
assert.equal(usage.subcategoryCounts.MILK_BASED, 2);
assert.equal(usage.subcategoryCounts.BLACK_COFFEE, 1);
assert.equal(usage.categoryCounts.ICED_COFFEES, 1);
assert.equal(usage.categoryCounts.BAKED_BAKERY_ICE_CREAM, 1);
assert.equal(usage.subcategoryCounts.BAKED, 1);
assert.equal(usage.categoryCounts.JAFFLE_BITES_SALADS, 2);
assert.equal(usage.subcategoryCounts.JAFFLE_BITES, 1);
assert.equal(usage.subcategoryCounts.SALADS, 1);
assert.equal(usage.categoryCounts.PIZZA_PIDE, 1);
assert.equal(usage.categoryCounts.COLD_CRAFTED, 1);
assert.equal(usage.categoryCounts.FRESH_JUICES, 1);
assert.equal(usage.categoryCounts.NEEDS_CLASSIFICATION, undefined);

const referencedCategoryCount = categoryReferenceCount(fallback.categories[0], usage);
assert.equal(referencedCategoryCount, 3);
assert.deepEqual(taxonomyReferenceProtection(referencedCategoryCount), {
  canHardDelete: false,
  requiresDeactivationConfirmation: true,
});
assert.deepEqual(taxonomyReferenceProtection(usage.subcategoryCounts.MILK_BASED), {
  canHardDelete: false,
  requiresDeactivationConfirmation: true,
});
assert.deepEqual(taxonomyReferenceProtection(0), {
  canHardDelete: true,
  requiresDeactivationConfirmation: false,
});

const storeUnavailableButAssigned = taxonomyUsage([{
  categoryCode: 'PIZ',
  isActive: true,
  isSellable: true,
  isAvailable: false,
  availableStoreIds: [],
}]);
assert.equal(storeUnavailableButAssigned.categoryCounts.PIZZA_PIDE, 1);

const editableUsage = taxonomyUsage([
  { posCategoryCode: 'SOURDOUGH_SANDWICHES', isActive: true, isSellable: true },
  { posCategoryCode: 'PASTA', posSubcategoryCode: 'FRESH_PASTA', isActive: true, isSellable: true },
], allPosMenuCategories(editable));
assert.equal(editableUsage.categoryCounts.SOURDOUGH_SANDWICHES, 1);
assert.equal(editableUsage.categoryCounts.PASTA, 1);
assert.equal(editableUsage.subcategoryCounts.FRESH_PASTA, 1);
assert.equal(
  categoryReferenceCount(
    editable.categories.find((category) => category.code === 'PASTA')!,
    editableUsage,
  ),
  1,
);

const managerSource = readFileSync('frontend/components/admin/menu-management/PosCategoryManagerTab.tsx', 'utf8');
assert.match(managerSource, /if \(!protection\.canHardDelete\)/, 'referenced entities must block hard delete');
assert.match(managerSource, /protection\.requiresDeactivationConfirmation && !window\.confirm/, 'referenced deactivation must require confirmation');

const modalSource = readFileSync('frontend/components/admin/menu-management/FinishedGoodModal.tsx', 'utf8');
assert.doesNotMatch(modalSource, /POS_MENU_CATEGORIES/, 'Finished Good placement must not use the committed array directly');
assert.match(modalSource, /posMenuCategories\.map/, 'Finished Good placement must render shared effective categories');
assert.match(modalSource, /buildPosMenuPlacementPatch\(placementDraft, posMenuCategories\)/, 'placement payload must use effective categories');

const hubSource = readFileSync('frontend/pages/admin/MenuManagementHub.tsx', 'utf8');
assert.match(hubSource, /usePosMenuTaxonomy\(\)/, 'Menu Management must share the effective taxonomy');
assert.match(hubSource, /posMenuCategories=\{posMenuTaxonomy\.categories\}/, 'Finished Goods must receive effective category options');

console.log('POS menu taxonomy tests passed');
