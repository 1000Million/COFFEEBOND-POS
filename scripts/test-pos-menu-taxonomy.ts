import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  categoryReferenceCount,
  committedPosMenuTaxonomy,
  normalizeTaxonomyCode,
  normalizeTaxonomyName,
  resolvePosMenuTaxonomy,
  taxonomyReferenceProtection,
  taxonomyUsage,
  validatePosMenuTaxonomy,
} from '../frontend/lib/posMenuTaxonomy';

const fallback = committedPosMenuTaxonomy();
assert.equal(resolvePosMenuTaxonomy(null).source, 'fallback');
assert.equal(resolvePosMenuTaxonomy({ categories: [] }).source, 'fallback');
assert.notStrictEqual(committedPosMenuTaxonomy().categories, committedPosMenuTaxonomy().categories);

const saved = { schemaVersion: 1, categories: [{ code: 'DRINKS', name: 'Drinks', sortOrder: 10, isActive: true, subcategories: [] }] };
assert.equal(resolvePosMenuTaxonomy(saved).source, 'firestore');
assert.equal(resolvePosMenuTaxonomy(saved).taxonomy.categories[0].code, 'DRINKS');
assert.equal(resolvePosMenuTaxonomy({ categories: [{ code: '', name: 'Bad', sortOrder: 10, subcategories: [] }] }).source, 'fallback');

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

const managerSource = readFileSync('frontend/components/admin/menu-management/PosCategoryManagerTab.tsx', 'utf8');
assert.match(managerSource, /if \(!protection\.canHardDelete\)/, 'referenced entities must block hard delete');
assert.match(managerSource, /protection\.requiresDeactivationConfirmation && !window\.confirm/, 'referenced deactivation must require confirmation');

console.log('POS menu taxonomy tests passed');
