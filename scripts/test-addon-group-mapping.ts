import assert from 'node:assert/strict';
import {
  BEVERAGE_ADD_ON_GROUP_ID,
  BEVERAGE_ADD_ON_OPTIONS,
  BEVERAGE_EXCLUDED_CATEGORY_NAMES,
  BEVERAGE_ADD_ON_GROUP_NAME,
  BEVERAGE_EXCLUDED_CATEGORY_ALIASES,
  FOOD_ADD_ON_GROUP_ID,
  FOOD_ADD_ON_OPTIONS,
  FOOD_ADD_ON_GROUP_NAME,
  buildProposedAddOnGroupDocuments,
  buildAddonAssignment,
  classifyProduct,
  getCategoryApprovalGap,
  isBeverageExcludedCategory,
  isRetailCoffeeExempt,
  mergeAddonGroupIds,
  normalizeLabel,
  plannedGroupIds,
  resolveGroupByName,
} from '../frontend/lib/addOnGroupMapping';

const groups = [
  { id: 'food-1', name: FOOD_ADD_ON_GROUP_NAME, code: 'FOOD_ADD_ON', isActive: true },
  { id: 'bev-1', name: BEVERAGE_ADD_ON_GROUP_NAME, code: 'BEV_ADD_ON', isActive: true },
] as const;

assert.equal(normalizeLabel(' Espresso Bar '), 'espresso bar');
assert.equal(classifyProduct({ code: 'A', name: 'A', menuType: 'Food' }), 'FOOD');
assert.equal(classifyProduct({ code: 'B', name: 'B', department: 'BEVERAGE' }), 'BEVERAGE');
assert.equal(classifyProduct({ code: 'E', name: 'E', categoryName: 'Sandwiches' }), 'FOOD');
assert.equal(classifyProduct({ code: 'F', name: 'F', categoryName: 'Hot Coffee' }), 'BEVERAGE');
assert.equal(classifyProduct({ code: 'C', name: 'C', posCategoryName: 'Specialty Drinks' }), 'BEVERAGE');
assert.equal(classifyProduct({ code: 'C2', name: 'C2', posCategoryName: 'Specality drinks' }), 'BEVERAGE');
assert.equal(classifyProduct({ code: 'C3', name: 'C3', posCategoryName: 'Espesso bar' }), 'BEVERAGE');
assert.equal(classifyProduct({ code: 'C4', name: 'C4', posCategoryName: 'Manual Brews' }), 'BEVERAGE');
assert.equal(classifyProduct({ code: 'D', name: 'D', categoryName: 'Mystery' }), 'REVIEW');
assert.equal(classifyProduct({ code: 'HOUSE_BLEND_BEANS_250G', name: 'House Blend Beans', categoryName: 'Retail Coffee' }), 'REVIEW');
assert.equal(isRetailCoffeeExempt({ code: 'HOUSE_BLEND_BEANS_250G', name: 'House Blend Beans', categoryName: 'Retail Coffee' }), true);
assert.equal(isRetailCoffeeExempt({ code: 'OTHER_RETAIL', name: 'Other Beans', categoryName: 'Retail Coffee' }), false);
assert.ok(BEVERAGE_EXCLUDED_CATEGORY_NAMES.includes('BBB'));
assert.equal(getCategoryApprovalGap('Espesso bar'), 'Espresso Bar');
assert.equal(getCategoryApprovalGap('Manual Brews'), 'Manual Brew');
assert.equal(getCategoryApprovalGap('Specality drinks'), 'Specialty Drinks');
for (const [alias] of BEVERAGE_EXCLUDED_CATEGORY_ALIASES) {
  assert.equal(isBeverageExcludedCategory(alias), true);
}

const expectedFoodOptions = [
  ['EXTRA_VEGGIES', 'Extra Veggies', 80, 'VEG'],
  ['EXTRA_BREAD_2_SLICES', 'Extra Bread Portion (2 Slices)', 70, 'VEG'],
  ['EXTRA_MOZZARELLA', 'Extra Cheese (Mozzarella)', 80, 'VEG'],
  ['EGG_3', 'Egg (3)', 160, 'EGG'],
  ['PITA_BREAD', 'Pita Bread', 70, 'VEG'],
  ['ICE_CREAM_2_SCOOPS', 'Ice Cream (2 Scoops)', 140, 'VEG'],
  ['HUMMUS', 'Hummus', 70, 'VEG'],
  ['TZATZIKI', 'Tzatziki', 70, 'VEG'],
  ['PESTO', 'Pesto', 70, 'VEG'],
  ['SOUR_CREAM', 'Sour Cream', 70, 'VEG'],
  ['RICOTTA_CHEESE', 'Ricotta Cheese', 80, 'VEG'],
  ['GARLIC_AIOLI', 'Garlic Aioli', 70, 'EGG'],
  ['HONEY', 'Honey', 50, 'VEG'],
  ['TOMATO_RELISH', 'Tomato Relish', 70, 'VEG'],
  ['FALAFEL', 'Falafel', 50, 'VEG'],
] as const;

const expectedBeverageOptions = [
  ['ALMOND_MILK', 'Almond Milk', 60, 'VEG'],
  ['OAT_MILK', 'Oat Milk', 50, 'VEG'],
  ['SOY_MILK', 'Soy Milk', 50, 'VEG'],
  ['COLD_FOAM', 'Cold Foam', 75, 'VEG'],
  ['MILK_ON_SIDE', 'Milk on Side', 50, 'VEG'],
  ['HAZELNUT_FLAVOUR', 'Hazelnut Flavour', 75, 'VEG'],
  ['CARAMEL_FLAVOUR', 'Caramel Flavour', 75, 'VEG'],
  ['SMOKED_JAGGERY_FLAVOUR', 'Smoked Jaggery Flavour', 75, 'VEG'],
  ['VANILLA_FLAVOUR', 'Vanilla Flavour', 75, 'VEG'],
  ['HONEY_AND_CINNAMON', 'Honey & Cinnamon', 75, 'VEG'],
  ['VANILLA_ICE_CREAM_2_SCOOPS', 'Vanilla Ice Cream (2 Scoops)', 140, 'VEG'],
  ['MOCHA', 'Mocha', 75, 'VEG'],
] as const;

assert.equal(FOOD_ADD_ON_OPTIONS.length, 15);
assert.equal(BEVERAGE_ADD_ON_OPTIONS.length, 12);
assert.deepEqual(
  FOOD_ADD_ON_OPTIONS.map(({ code, name, price, attribute }) => [code, name, price, attribute]),
  expectedFoodOptions,
);
assert.deepEqual(
  BEVERAGE_ADD_ON_OPTIONS.map(({ code, name, price, attribute }) => [code, name, price, attribute]),
  expectedBeverageOptions,
);

const proposedGroups = buildProposedAddOnGroupDocuments();
assert.deepEqual(Object.keys(proposedGroups).sort(), [BEVERAGE_ADD_ON_GROUP_ID, FOOD_ADD_ON_GROUP_ID].sort());
assert.equal(proposedGroups[FOOD_ADD_ON_GROUP_ID].options.length, 15);
assert.equal(proposedGroups[BEVERAGE_ADD_ON_GROUP_ID].options.length, 12);
for (const group of Object.values(proposedGroups)) {
  assert.equal(group.isActive, true);
  assert.equal(group.isRequired, false);
  assert.equal(group.minimumSelections, 0);
  assert.equal(group.selectionMode, 'MULTIPLE');
  for (const option of group.options) {
    assert.equal(option.id, option.code);
    assert.equal(option.isActive, true);
    assert.equal('productId' in option, false);
    assert.equal('productPath' in option, false);
    assert.equal('linkedExistingAddOnItemIds' in option, false);
  }
}
assert.deepEqual(buildProposedAddOnGroupDocuments(), proposedGroups);

const foodGroup = resolveGroupByName(groups as any, FOOD_ADD_ON_GROUP_NAME);
const beverageGroup = resolveGroupByName(groups as any, BEVERAGE_ADD_ON_GROUP_NAME);
assert.equal(foodGroup?.id, 'food-1');
assert.equal(beverageGroup?.id, 'bev-1');
assert.deepEqual(plannedGroupIds('FOOD', foodGroup?.id || null, beverageGroup?.id || null), ['food-1']);
assert.deepEqual(plannedGroupIds('BEVERAGE', foodGroup?.id || null, beverageGroup?.id || null), ['bev-1']);

const foodAssignment = buildAddonAssignment(
  { code: 'F1', name: 'Food Item', categoryName: 'Food', addOnGroupIds: [] },
  foodGroup?.id || null,
  'FOOD',
  'Food',
);
assert.equal(foodAssignment.action, 'ADD');
assert.deepEqual(foodAssignment.proposedAddOnGroupIds, ['food-1']);

const foodKeep = buildAddonAssignment(
  { code: 'F1', name: 'Food Item', categoryName: 'Food', addOnGroupIds: ['food-1'] },
  foodGroup?.id || null,
  'FOOD',
  'Food',
);
assert.equal(foodKeep.action, 'KEEP');
assert.deepEqual(foodKeep.proposedAddOnGroupIds, ['food-1']);

const bevAllowed = buildAddonAssignment(
  { code: 'B1', name: 'Latte', categoryName: 'Coffee', addOnGroupIds: [] },
  beverageGroup?.id || null,
  'BEVERAGE',
  'Coffee',
);
assert.equal(bevAllowed.action, 'ADD');
assert.deepEqual(bevAllowed.proposedAddOnGroupIds, ['bev-1']);

for (const excluded of BEVERAGE_EXCLUDED_CATEGORY_NAMES) {
  const assignment = buildAddonAssignment(
    { code: excluded.replace(/\s+/g, '_'), name: excluded, categoryName: excluded, addOnGroupIds: ['bev-1'] },
    beverageGroup?.id || null,
    'BEVERAGE',
    excluded,
  );
  assert.equal(assignment.action, 'REMOVE');
  assert.deepEqual(assignment.proposedAddOnGroupIds, []);
}

const reviewAssignment = buildAddonAssignment(
  { code: 'R1', name: 'Mystery', categoryName: 'Mystery', addOnGroupIds: ['extra-1'] },
  foodGroup?.id || null,
  'REVIEW',
  'Mystery',
);
assert.equal(reviewAssignment.action, 'REVIEW');
assert.deepEqual(reviewAssignment.proposedAddOnGroupIds, ['extra-1']);

const retailCoffeeAssignment = buildAddonAssignment(
  { code: 'HOUSE_BLEND_BEANS_250G', name: 'House Blend Beans', categoryName: 'Retail Coffee', addOnGroupIds: ['unrelated'] },
  null,
  'REVIEW',
  'Retail Coffee',
);
assert.equal(retailCoffeeAssignment.action, 'REVIEW');
assert.deepEqual(retailCoffeeAssignment.proposedAddOnGroupIds, ['unrelated']);

const merged = mergeAddonGroupIds(['extra-1'], 'food-1');
assert.equal(merged.action, 'ADD');
assert.deepEqual(merged.ids, ['extra-1', 'food-1']);

const unchanged = mergeAddonGroupIds(['food-1'], 'food-1');
assert.equal(unchanged.action, 'KEEP');

console.log('addon group mapping tests passed');
