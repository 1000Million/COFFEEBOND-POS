import assert from 'node:assert/strict';
import {
  classifyPosMenuItem,
  finishedGoodTaxonomyFields,
  POS_MENU_CATEGORIES,
  quickPicksInRankOrder,
  searchPosMenuItems,
  uniqueSortedPosMenuItems,
} from '../frontend/lib/posMenuNavigation';
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

console.log('POS menu navigation tests passed.');
