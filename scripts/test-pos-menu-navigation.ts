import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPosMenuPlacementPatch,
  classifyPosMenuItem,
  classifyPosMenuItemWithCategories,
  finishedGoodTaxonomyFields,
  POS_MENU_CATEGORIES,
  posMenuNavigationCategories,
  posMenuCategorySelection,
  quickPicksInRankOrder,
  searchPosMenuItems,
  shouldShowNeedsClassificationBadge,
  uniqueSortedPosMenuItems,
} from '../frontend/lib/posMenuNavigation';
import {
  activePosMenuCategories,
  committedPosMenuTaxonomy,
  resolvePosMenuTaxonomy,
} from '../frontend/lib/posMenuTaxonomy';
import type { MenuItem } from '../frontend/types';

function item(
  id: string,
  name: string,
  categoryCode: string,
  subcategoryCode: string | null = null,
  sortOrder: number | null = null,
): MenuItem {
  return {
    id,
    code: id,
    name,
    categoryId: categoryCode,
    categoryCode,
    categoryName: categoryCode,
    categorySortOrder: null,
    subcategoryCode,
    subcategoryName: null,
    subcategorySortOrder: null,
    sortOrder,
    description: '',
    price: 100,
    taxRate: 5,
    prepStation: 'BARISTA',
    isActive: true,
    availableStoreIds: ['GOLDEN_I'],
    createdAt: null,
    updatedAt: null,
  };
}

const milk = item('CAPPUCCINO', 'Cappuccino', 'MILK_BASED', null, 20);
const black = item('AMERICANO', 'Americano', 'ESPESSO_BAR', null, 10);
const iced = item('ICED_LATTE', 'Iced Latte', 'ICED_COFFEES', null, 10);
const matcha = item('MATCHA_LATTE', 'Matcha Latte', 'MATCHA', null, 10);
const manual = item('V60', 'V60', 'MANUAL_BREWS', null, 10);

assert.deepEqual(
  POS_MENU_CATEGORIES.map((category) => category.sortOrder),
  [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140],
  'category definitions must retain the approved order',
);

const sortedCategories = uniqueSortedPosMenuItems([manual, iced, milk, matcha, black]);
assert.deepEqual(
  sortedCategories.map((entry) => entry.id),
  ['AMERICANO', 'CAPPUCCINO', 'ICED_LATTE', 'MATCHA_LATTE', 'V60'],
  'items must sort by category, subcategory, product order, then name',
);

const espressoSubcategories = POS_MENU_CATEGORIES
  .find((category) => category.code === 'ESPRESSO_BAR')
  ?.subcategories.map((subcategory) => subcategory.code);
assert.deepEqual(espressoSubcategories, ['BLACK_COFFEE', 'MILK_BASED']);

const icedClassification = classifyPosMenuItem(iced);
assert.equal(icedClassification.category.code, 'ICED_COFFEES');
assert.equal(icedClassification.subcategory, null, 'direct categories must not synthesize a subcategory');

const unclassified = classifyPosMenuItem(item('UNKNOWN', 'Unknown Item', '', null));
assert.equal(unclassified.category.code, 'NEEDS_CLASSIFICATION');
assert.equal(unclassified.isClassified, false);

const invalidParent = classifyPosMenuItem(item('BAD_MATCH', 'Bad Match', 'ESPRESSO_BAR', 'SALADS'));
assert.equal(invalidParent.category.code, 'NEEDS_CLASSIFICATION');
assert.match(invalidParent.reason || '', /not valid/);

const alphabeticalFallback = uniqueSortedPosMenuItems([
  item('ITEM_10', 'Blend 10', 'SMOOTHIES'),
  item('ITEM_2', 'blend 2', 'SMOOTHIES'),
]);
assert.deepEqual(alphabeticalFallback.map((entry) => entry.id), ['ITEM_2', 'ITEM_10']);

const deduplicated = uniqueSortedPosMenuItems([milk, milk, black]);
assert.equal(deduplicated.filter((entry) => entry.id === milk.id).length, 1, 'a product must appear once');

const globalSearch = searchPosMenuItems([milk, iced, manual], 'manual brews');
assert.deepEqual(globalSearch.map((entry) => entry.id), ['V60'], 'search must span category context globally');

const ranked = quickPicksInRankOrder([milk, iced, matcha], [matcha.id, milk.id, iced.id], [], 3);
assert.deepEqual(ranked.map((entry) => entry.id), [matcha.id, milk.id, iced.id]);

const goldenILegacyFixtures = [
  { code: 'CAPPUCCINO', name: 'Cappuccino', categoryCode: 'MILK_BASED', categoryName: 'Milk Based' },
  { code: 'COLD_COFFEE', name: 'Cold Coffee', categoryId: 'ICED_COFFEES', categoryName: 'Iced Coffees' },
  { code: 'SHROOM_JAFFLE', name: 'Shroom Jaffle', category: 'ZAFFLE_AND_BITES', categoryName: 'Zaffle & Bites' },
  { code: 'TIRAMISU', name: 'Tiramisu', categoryCode: 'BAKED_BAKERY', categoryName: 'Baked Bakery' },
  { code: 'UNKNOWN', name: 'Unknown Item', categoryCode: 'UNSUPPORTED_LEGACY_CATEGORY' },
].map((source) => ({
  ...item(source.code, source.name, ''),
  ...finishedGoodTaxonomyFields(source),
}));

const legacyClassifications = goldenILegacyFixtures.map(classifyPosMenuItem);
assert.deepEqual(
  legacyClassifications.map((classification) => classification.category.code),
  [
    'ESPRESSO_BAR',
    'ICED_COFFEES',
    'JAFFLE_BITES_SALADS',
    'BAKED_BAKERY_ICE_CREAM',
    'NEEDS_CLASSIFICATION',
  ],
  'runtime Finished Good mapping must retain legacy category metadata',
);
assert.equal(legacyClassifications[0].subcategory?.code, 'MILK_BASED');
assert.equal(legacyClassifications[2].subcategory?.code, 'JAFFLE_BITES');
assert.equal(legacyClassifications[3].subcategory?.code, 'BAKED');
assert.equal(legacyClassifications[4].isClassified, false);

const explicitPosMetadata = {
  ...item('EXPLICIT', 'Explicit taxonomy wins', ''),
  ...finishedGoodTaxonomyFields({
    code: 'EXPLICIT',
    posCategoryCode: 'MATCHA_MANUAL_BREWS',
    posSubcategoryCode: 'MATCHA',
    categoryCode: 'MILK_BASED',
  }),
};
assert.equal(classifyPosMenuItem(explicitPosMetadata).category.code, 'MATCHA_MANUAL_BREWS');
assert.equal(classifyPosMenuItem(explicitPosMetadata).subcategory?.code, 'MATCHA');

assert.equal(
  uniqueSortedPosMenuItems(goldenILegacyFixtures).length,
  goldenILegacyFixtures.length,
  'runtime mapping must neither drop nor duplicate products',
);

const directPlacement = buildPosMenuPlacementPatch({
  posCategoryCode: 'SMOOTHIES',
  posSubcategoryCode: null,
  sortOrder: '',
});
assert.equal(directPlacement.ok, true, 'a direct category must be editable without a subcategory');
if (directPlacement.ok) {
  assert.equal(directPlacement.patch.posSubcategoryCode, null);
  assert.equal(directPlacement.patch.posSubcategoryName, null);
  assert.equal(directPlacement.patch.subcategorySortOrder, null);
  assert.equal(directPlacement.patch.sortOrder, null);
}

const nestedPlacement = buildPosMenuPlacementPatch({
  posCategoryCode: 'ESPRESSO_BAR',
  posSubcategoryCode: 'MILK_BASED',
  sortOrder: 25,
});
assert.equal(nestedPlacement.ok, true, 'an approved parent/subcategory pair must be editable');
if (nestedPlacement.ok) {
  assert.deepEqual(nestedPlacement.patch, {
    posCategoryCode: 'ESPRESSO_BAR',
    posCategoryName: 'Espresso Bar',
    categorySortOrder: 10,
    posSubcategoryCode: 'MILK_BASED',
    posSubcategoryName: 'Milk Based',
    subcategorySortOrder: 20,
    sortOrder: 25,
  });
}

const invalidPlacement = buildPosMenuPlacementPatch({
  posCategoryCode: 'ONLY_AT_BOND',
  posSubcategoryCode: 'MILK_BASED',
  sortOrder: 10,
});
assert.equal(invalidPlacement.ok, false, 'invalid parent/subcategory pairs must be rejected');
if (!invalidPlacement.ok) assert.match(invalidPlacement.error, /not valid/);

const changedCategory = posMenuCategorySelection('FRESH_JUICES');
assert.equal(changedCategory?.posCategoryCode, 'FRESH_JUICES');
assert.equal(changedCategory?.posSubcategoryCode, null, 'changing category must clear an old subcategory');
assert.equal(changedCategory?.subcategorySortOrder, null);

const invalidSortOrder = buildPosMenuPlacementPatch({
  posCategoryCode: 'RETAIL',
  posSubcategoryCode: null,
  sortOrder: Number.NaN,
});
assert.equal(invalidSortOrder.ok, false, 'non-finite sort order must be rejected');
if (!invalidSortOrder.ok) assert.match(invalidSortOrder.error, /finite number/);

assert.equal(
  shouldShowNeedsClassificationBadge(item('MIS_ITEM', 'Misc Item', 'MIS')),
  true,
  'unresolved metadata must show the Needs Classification badge',
);
assert.equal(
  shouldShowNeedsClassificationBadge(item('SMOOTHIE_ITEM', 'Smoothie', 'SMOOTHIES')),
  false,
  'approved metadata must not show the Needs Classification badge',
);

if (nestedPlacement.ok) {
  const originalOperationalFields = {
    salePrice: 225,
    taxRate: 5,
    prepStation: 'BARISTA',
    bom: [{ componentCode: 'COFFEE', quantity: 18 }],
    itemType: 'MADE_TO_ORDER',
  };
  const updated = { ...originalOperationalFields, ...nestedPlacement.patch };
  assert.equal(updated.salePrice, originalOperationalFields.salePrice);
  assert.equal(updated.taxRate, originalOperationalFields.taxRate);
  assert.equal(updated.prepStation, originalOperationalFields.prepStation);
  assert.deepEqual(updated.bom, originalOperationalFields.bom);
  assert.deepEqual(
    Object.keys(nestedPlacement.patch).sort(),
    [
      'categorySortOrder',
      'posCategoryCode',
      'posCategoryName',
      'posSubcategoryCode',
      'posSubcategoryName',
      'sortOrder',
      'subcategorySortOrder',
    ],
    'taxonomy save payload must contain only the approved placement fields',
  );
}

const compactTaxonomyCases = [
  ['ESP_MILK', 'ESP', 'MILK', 'ESPRESSO_BAR', 'MILK_BASED'],
  ['ESP_BLK', 'ESP', 'BLK', 'ESPRESSO_BAR', 'BLACK_COFFEE'],
  ['ESP_ICE', 'ESP', 'ICE', 'ICED_COFFEES', null],
  ['BAK', 'BAK', null, 'BAKED_BAKERY_ICE_CREAM', 'BAKED'],
  ['SAL', 'SAL', null, 'JAFFLE_BITES_SALADS', 'SALADS'],
  ['SMO', 'SMO', null, 'SMOOTHIES', null],
  ['PIZ', 'PIZ', null, 'PIZZA_PIDE', 'PIZZA'],
  ['ZAF', 'ZAF', null, 'JAFFLE_BITES_SALADS', 'JAFFLE_BITES'],
  ['CCF', 'CCF', null, 'COLD_CRAFTED', null],
  ['JUI', 'JUI', null, 'FRESH_JUICES', null],
  ['ICE', 'ICE', null, 'BAKED_BAKERY_ICE_CREAM', 'HOUSEMADE_DAIRY_ICE_CREAM'],
] as const;

for (const [id, categoryCode, subcategoryCode, expectedCategory, expectedSubcategory] of compactTaxonomyCases) {
  const classification = classifyPosMenuItem(item(id, id, categoryCode, subcategoryCode));
  assert.equal(classification.isClassified, true, `${id} must be deterministically classified`);
  assert.equal(classification.category.code, expectedCategory, `${id} must use the approved parent category`);
  assert.equal(
    classification.subcategory?.code || null,
    expectedSubcategory,
    `${id} must use only its approved subcategory`,
  );
}

const intentionallyUnmappedCases = [
  ['MIS', 'MIS', null],
  ['CBV', 'CBV', null],
  ['MAT', 'MAT', null],
  ['ADD', 'ADD', null],
  ['INVALID_MEZZE', 'ALWAYS_AT_BOND', 'MILK'],
] as const;

for (const [id, categoryCode, subcategoryCode] of intentionallyUnmappedCases) {
  const classification = classifyPosMenuItem(item(id, id, categoryCode, subcategoryCode));
  assert.equal(classification.isClassified, false, `${id} must remain in Needs Classification`);
  assert.equal(classification.category.code, 'NEEDS_CLASSIFICATION');
}

const goldenICompactFixture = [
  ...Array.from({ length: 9 }, (_, index) => item(`ESP_MILK_${index}`, `ESP Milk ${index}`, 'ESP', 'MILK')),
  ...Array.from({ length: 2 }, (_, index) => item(`ESP_BLK_${index}`, `ESP Black ${index}`, 'ESP', 'BLK')),
  ...Array.from({ length: 5 }, (_, index) => item(`ESP_ICE_${index}`, `ESP Iced ${index}`, 'ESP', 'ICE')),
  ...Array.from({ length: 5 }, (_, index) => item(`BAK_${index}`, `Baked ${index}`, 'BAK')),
  ...Array.from({ length: 2 }, (_, index) => item(`SAL_${index}`, `Salad ${index}`, 'SAL')),
  ...Array.from({ length: 2 }, (_, index) => item(`SMO_${index}`, `Smoothie ${index}`, 'SMO')),
  ...Array.from({ length: 3 }, (_, index) => item(`PIZ_${index}`, `Pizza ${index}`, 'PIZ')),
  ...Array.from({ length: 8 }, (_, index) => item(`ZAF_${index}`, `Jaffle ${index}`, 'ZAF')),
  ...Array.from({ length: 5 }, (_, index) => item(`CCF_${index}`, `Cold Crafted ${index}`, 'CCF')),
  item('JUI_0', 'Fresh Juice', 'JUI'),
  ...Array.from({ length: 4 }, (_, index) => item(`ICE_${index}`, `Ice Cream ${index}`, 'ICE')),
  ...Array.from({ length: 40 }, (_, index) => item(`MIS_${index}`, `Misc ${index}`, 'MIS')),
  ...Array.from({ length: 4 }, (_, index) => item(`CBV_${index}`, `Cold Brew ${index}`, 'CBV')),
  ...Array.from({ length: 2 }, (_, index) => item(`MAT_${index}`, `Matcha ${index}`, 'MAT')),
  item('ADD_0', 'Add On', 'ADD'),
  item('INVALID_MEZZE_0', 'Mediterranean Mezze', 'ALWAYS_AT_BOND', 'MILK'),
];
const goldenICompactClassifications = goldenICompactFixture.map(classifyPosMenuItem);
assert.equal(goldenICompactFixture.length, 94, 'Golden I fixture must represent all loaded products');
assert.equal(
  goldenICompactClassifications.filter((classification) => classification.isClassified).length,
  46,
  'only deterministic compact mappings may be classified',
);
assert.equal(
  goldenICompactClassifications.filter((classification) => !classification.isClassified).length,
  48,
  'ambiguous compact codes must remain in Needs Classification',
);
assert.equal(
  uniqueSortedPosMenuItems(goldenICompactFixture).length,
  94,
  'compact classification must neither drop nor duplicate Golden I products',
);

const editableTaxonomy = committedPosMenuTaxonomy();
editableTaxonomy.categories.push(
  {
    code: 'BRUNCH_CUSTOM',
    name: 'Newly Saved Brunch',
    sortOrder: 15,
    isActive: true,
    subcategories: [
      {
        code: 'HIDDEN_DISHES',
        name: 'Hidden Dishes',
        sortOrder: 10,
        isActive: false,
      },
      {
        code: 'NEW_DISHES',
        name: 'New Dishes',
        sortOrder: 20,
        isActive: true,
      },
    ],
  },
  {
    code: 'INACTIVE_CATEGORY',
    name: 'Inactive Category',
    sortOrder: 5,
    isActive: false,
    subcategories: [],
  },
);

const editableResolved = resolvePosMenuTaxonomy(editableTaxonomy);
assert.equal(editableResolved.source, 'firestore', 'valid editable taxonomy must be accepted');
const editableCategories = activePosMenuCategories(editableResolved.taxonomy);
assert.equal(editableCategories[0].code, 'ESPRESSO_BAR');
assert.equal(editableCategories[1].code, 'BRUNCH_CUSTOM', 'active category ordering must be respected');
assert.equal(
  editableCategories.some((category) => category.code === 'INACTIVE_CATEGORY'),
  false,
  'inactive categories must not render',
);
assert.deepEqual(
  editableCategories.find((category) => category.code === 'BRUNCH_CUSTOM')?.subcategories
    .map((subcategory) => subcategory.code),
  ['NEW_DISHES'],
  'only active subcategories may render under their saved parent',
);

const editableProduct = {
  ...item('NEW_BRUNCH_ITEM', 'New Brunch Item', ''),
  posCategoryCode: 'BRUNCH_CUSTOM',
  posCategoryName: 'Newly Saved Brunch',
  posSubcategoryCode: 'NEW_DISHES',
  posSubcategoryName: 'New Dishes',
};
const editableClassification = classifyPosMenuItemWithCategories(editableProduct, editableCategories);
assert.equal(editableClassification.category.code, 'BRUNCH_CUSTOM');
assert.equal(editableClassification.subcategory?.code, 'NEW_DISHES');
assert.equal(editableClassification.isClassified, true, 'saved placement must not fall into Needs Classification');

const editableSearch = searchPosMenuItems(
  [editableProduct, item('ESPRESSO_CONTROL', 'Espresso Control', 'ESPRESSO_BAR', 'BLACK_COFFEE')],
  'newly saved brunch',
  editableCategories,
);
assert.deepEqual(
  editableSearch.map((entry) => entry.id),
  ['NEW_BRUNCH_ITEM'],
  'search must use effective category and subcategory context',
);

const navigationWithFallback = posMenuNavigationCategories(
  [...editableCategories, ...posMenuNavigationCategories([], 1)],
  1,
);
assert.equal(
  navigationWithFallback.filter((category) => category.code === 'NEEDS_CLASSIFICATION').length,
  1,
  'effective navigation must contain exactly one synthetic Needs Classification bucket',
);
assert.equal(
  navigationWithFallback.some((category) => category.code === 'BRUNCH_CUSTOM'),
  true,
  'new editable categories must appear in POS navigation',
);

const invalidEditableTaxonomy = resolvePosMenuTaxonomy({
  schemaVersion: 1,
  categories: [
    { code: 'DUPLICATE', name: 'First', sortOrder: 10, isActive: true, subcategories: [] },
    { code: 'DUPLICATE', name: 'Second', sortOrder: 20, isActive: true, subcategories: [] },
  ],
});
assert.equal(invalidEditableTaxonomy.source, 'fallback', 'invalid editable taxonomy must fall back safely');
assert.deepEqual(
  activePosMenuCategories(invalidEditableTaxonomy.taxonomy),
  POS_MENU_CATEGORIES,
  'invalid editable taxonomy must retain the committed runtime categories',
);

const editableEligibilityFixture = [
  editableProduct,
  item('ESPRESSO_CONTROL', 'Espresso Control', 'ESPRESSO_BAR', 'BLACK_COFFEE'),
];
assert.equal(
  uniqueSortedPosMenuItems(editableEligibilityFixture, editableCategories).length,
  editableEligibilityFixture.length,
  'effective taxonomy sorting and filtering must not change product eligibility or count',
);

const posHomeSource = readFileSync('frontend/pages/pos/POSHome.tsx', 'utf8');
assert.match(posHomeSource, /usePosMenuTaxonomy\(\)/, 'POSHome must consume the shared effective taxonomy hook');
assert.doesNotMatch(
  posHomeSource,
  /\bPOS_MENU_CATEGORIES\b/,
  'POSHome must not build its category rail from the static committed categories',
);
assert.match(
  posHomeSource,
  /searchPosMenuItems\(availableMenuItems, searchQuery, posMenuCategories\)/,
  'POS search must receive the effective taxonomy',
);

console.log('POS menu navigation tests passed.');
