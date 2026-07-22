export const FOOD_ADD_ON_GROUP_NAME = 'Food Add On';
export const BEVERAGE_ADD_ON_GROUP_NAME = 'Beverage Add On';
export const FOOD_ADD_ON_GROUP_ID = 'food_add_on';
export const BEVERAGE_ADD_ON_GROUP_ID = 'beverage_add_on';

function createOption(code, name, price, attribute, sortOrder) {
  return { id: code, code, name, price, attribute, isActive: true, sortOrder };
}

export const FOOD_ADD_ON_OPTIONS = [
  createOption('EXTRA_VEGGIES', 'Extra Veggies', 80, 'VEG', 1),
  createOption('EXTRA_BREAD_2_SLICES', 'Extra Bread Portion (2 Slices)', 70, 'VEG', 2),
  createOption('EXTRA_MOZZARELLA', 'Extra Cheese (Mozzarella)', 80, 'VEG', 3),
  createOption('EGG_3', 'Egg (3)', 160, 'EGG', 4),
  createOption('PITA_BREAD', 'Pita Bread', 70, 'VEG', 5),
  createOption('ICE_CREAM_2_SCOOPS', 'Ice Cream (2 Scoops)', 140, 'VEG', 6),
  createOption('HUMMUS', 'Hummus', 70, 'VEG', 7),
  createOption('TZATZIKI', 'Tzatziki', 70, 'VEG', 8),
  createOption('PESTO', 'Pesto', 70, 'VEG', 9),
  createOption('SOUR_CREAM', 'Sour Cream', 70, 'VEG', 10),
  createOption('RICOTTA_CHEESE', 'Ricotta Cheese', 80, 'VEG', 11),
  createOption('GARLIC_AIOLI', 'Garlic Aioli', 70, 'EGG', 12),
  createOption('HONEY', 'Honey', 50, 'VEG', 13),
  createOption('TOMATO_RELISH', 'Tomato Relish', 70, 'VEG', 14),
  createOption('FALAFEL', 'Falafel', 50, 'VEG', 15),
];

export const BEVERAGE_ADD_ON_OPTIONS = [
  createOption('ALMOND_MILK', 'Almond Milk', 60, 'VEG', 1),
  createOption('OAT_MILK', 'Oat Milk', 50, 'VEG', 2),
  createOption('SOY_MILK', 'Soy Milk', 50, 'VEG', 3),
  createOption('COLD_FOAM', 'Cold Foam', 75, 'VEG', 4),
  createOption('MILK_ON_SIDE', 'Milk on Side', 50, 'VEG', 5),
  createOption('HAZELNUT_FLAVOUR', 'Hazelnut Flavour', 75, 'VEG', 6),
  createOption('CARAMEL_FLAVOUR', 'Caramel Flavour', 75, 'VEG', 7),
  createOption('SMOKED_JAGGERY_FLAVOUR', 'Smoked Jaggery Flavour', 75, 'VEG', 8),
  createOption('VANILLA_FLAVOUR', 'Vanilla Flavour', 75, 'VEG', 9),
  createOption('HONEY_AND_CINNAMON', 'Honey & Cinnamon', 75, 'VEG', 10),
  createOption('VANILLA_ICE_CREAM_2_SCOOPS', 'Vanilla Ice Cream (2 Scoops)', 140, 'VEG', 11),
  createOption('MOCHA', 'Mocha', 75, 'VEG', 12),
];

export function buildProposedAddOnGroupDocuments() {
  return {
    [FOOD_ADD_ON_GROUP_ID]: {
      id: FOOD_ADD_ON_GROUP_ID,
      name: FOOD_ADD_ON_GROUP_NAME,
      isActive: true,
      isRequired: false,
      minimumSelections: 0,
      selectionMode: 'MULTIPLE',
      options: FOOD_ADD_ON_OPTIONS.map((option) => ({ ...option })),
    },
    [BEVERAGE_ADD_ON_GROUP_ID]: {
      id: BEVERAGE_ADD_ON_GROUP_ID,
      name: BEVERAGE_ADD_ON_GROUP_NAME,
      isActive: true,
      isRequired: false,
      minimumSelections: 0,
      selectionMode: 'MULTIPLE',
      options: BEVERAGE_ADD_ON_OPTIONS.map((option) => ({ ...option })),
    },
  };
}

export const BEVERAGE_EXCLUDED_CATEGORY_NAMES = [
  'Espresso Bar',
  'Matcha',
  'Manual Brew',
  'Herbal Tea',
  'Specialty Drinks',
  'Seasonal Juices',
  'Cold Crafted',
  'Ice Cream',
  'BBB',
];

export const BEVERAGE_EXCLUDED_CATEGORY_ALIASES = [
  ['Espesso bar', 'Espresso Bar'],
  ['Manual Brews', 'Manual Brew'],
  ['Specality drinks', 'Specialty Drinks'],
];

const NORMALIZER = /[^a-z0-9]+/g;

const FOOD_CATEGORY_NAMES = new Set([
  'Always at Bond',
  'Baked Bakery',
  'Bread',
  'Cookies',
  'Croissants',
  'Homemade Ice cream',
  'Pizza',
  'Salads',
  'Sandwiches',
  'Signature Pasta',
  'Turkish Pide',
  'Only at Bond -New',
  'Zaffle & Bites',
].map(normalizeLabel));

const BEVERAGE_CATEGORY_NAMES = new Set([
  'Cold Brew Based',
  'Cold Coffee',
  'Cold Crafted',
  'Herbal Tea',
  'Hot Coffee',
  'Iced Coffees',
  'Manual Brews',
  'Matcha',
  'Milk Based',
  'Seasonal juices',
  'Smoothies',
  'Specality drinks',
  'Specialty drinks',
  'Vietnamese Style',
  'Espesso bar',
].map(normalizeLabel));

const CATEGORY_CONFIRMATION_GAPS = new Map(
  BEVERAGE_EXCLUDED_CATEGORY_ALIASES.map(([alias, approved]) => [normalizeLabel(alias), approved]),
);

export function normalizeLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(NORMALIZER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizedCategoryCandidates(product) {
  return [
    product.categoryName,
    product.category,
    product.menuType,
    product.productDepartment,
    product.department,
    product.categoryHierarchy,
    product.posCategoryName,
    product.posSubcategoryName,
  ]
    .filter(Boolean)
    .map((value) => String(value || '').split(/[>\\/|]/).map((part) => part.trim()).filter(Boolean))
    .flat();
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())));
}

export function existingAddOnGroupIds(product) {
  return uniqueStrings(product.addOnGroupIds || product.addonGroupIds);
}

export function classifyProduct(product, categoryNameOverride) {
  const department = normalizeLabel(product.productDepartment || product.department || product.menuType);
  if (department === 'food' || department === 'beverage') return department.toUpperCase();

  const categoryCandidates = normalizedCategoryCandidates(product).map(normalizeLabel);
  const categoryName = normalizeLabel(categoryNameOverride || product.categoryName || product.posCategoryName || '');

  if (BEVERAGE_EXCLUDED_CATEGORY_NAMES.some((name) => normalizeLabel(name) === categoryName)) return 'BEVERAGE';
  if (FOOD_CATEGORY_NAMES.has(categoryName)) return 'FOOD';
  if (BEVERAGE_CATEGORY_NAMES.has(categoryName)) return 'BEVERAGE';
  if (CATEGORY_CONFIRMATION_GAPS.has(categoryName)) return 'BEVERAGE';

  const beverageHints = new Set([
    'coffee',
    'cold coffee',
    'matcha',
    'tea',
    'manual brew',
    'herbal tea',
    'specialty drinks',
    'seasonal juices',
    'cold crafted',
    'ice cream',
    'bbb',
    'espresso bar',
  ].map(normalizeLabel));
  const foodHints = new Set([
    'food',
    'dessert',
    'desserts',
    'pizza',
    'pasta',
    'salad',
    'bites',
    'bakery',
    'sandwich',
    'breakfast',
    'waffle',
    'bowl',
    'cake',
    'bread',
    'retail',
    'merch',
    'add ons',
  ].map(normalizeLabel));

  if (categoryCandidates.some((candidate) => beverageHints.has(candidate))) return 'BEVERAGE';
  if (categoryCandidates.some((candidate) => foodHints.has(candidate))) return 'FOOD';

  return 'REVIEW';
}

export function getCategoryApprovalGap(categoryName) {
  return CATEGORY_CONFIRMATION_GAPS.get(normalizeLabel(categoryName)) || null;
}

export function isBeverageExcludedCategory(categoryName) {
  const normalized = normalizeLabel(categoryName);
  return BEVERAGE_EXCLUDED_CATEGORY_NAMES.some((name) => normalizeLabel(name) === normalized)
    || BEVERAGE_EXCLUDED_CATEGORY_ALIASES.some(([alias]) => normalizeLabel(alias) === normalized);
}

export function isRetailCoffeeExempt(product, categoryName) {
  return product.code === 'HOUSE_BLEND_BEANS_250G'
    && normalizeLabel(categoryName || product.categoryName || product.posCategoryName) === 'retail coffee';
}

export function resolveGroupByName(groups, wantedName) {
  const normalizedWanted = normalizeLabel(wantedName);
  const exact = groups.find((group) => normalizeLabel(group.name) === normalizedWanted);
  if (exact) return exact;
  return null;
}

export function plannedGroupIds(classification, foodGroupId, beverageGroupId) {
  if (classification === 'FOOD') return foodGroupId ? [foodGroupId] : [];
  if (classification === 'BEVERAGE') return beverageGroupId ? [beverageGroupId] : [];
  return [];
}

export function mergeAddonGroupIds(existing, targetGroupId) {
  const normalizedExisting = uniqueStrings(existing);
  if (!targetGroupId) return { action: 'REVIEW', ids: normalizedExisting };
  if (normalizedExisting.includes(targetGroupId)) return { action: 'KEEP', ids: normalizedExisting };
  return { action: 'ADD', ids: [...normalizedExisting, targetGroupId] };
}

export function removeAddonGroupId(existing, targetGroupId) {
  const normalizedExisting = uniqueStrings(existing);
  if (!targetGroupId) return { action: 'REVIEW', ids: normalizedExisting };
  if (!normalizedExisting.includes(targetGroupId)) return { action: 'KEEP', ids: normalizedExisting };
  return { action: 'REMOVE', ids: normalizedExisting.filter((id) => id !== targetGroupId) };
}

export function buildAddonAssignment(product, targetGroupId, classification, categoryName) {
  const existingIds = existingAddOnGroupIds(product);
  const actionResult = classification === 'REVIEW'
    ? { action: 'REVIEW', ids: existingIds }
    : classification === 'FOOD'
      ? mergeAddonGroupIds(existingIds, targetGroupId)
      : isBeverageExcludedCategory(categoryName)
        ? removeAddonGroupId(existingIds, targetGroupId)
        : mergeAddonGroupIds(existingIds, targetGroupId);

  const reason = classification === 'REVIEW'
    ? 'Cannot confidently classify from current department/menu/category fields.'
    : classification === 'FOOD'
      ? 'Active food product should receive Food Add On.'
      : isBeverageExcludedCategory(categoryName)
        ? `Beverage category "${categoryName}" is excluded from Beverage Add On.`
        : `Active beverage product and category "${categoryName}" is not excluded from Beverage Add On.`;

  return {
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    category: categoryName,
    classification,
    existingAddOnGroupIds: existingIds,
    proposedAddOnGroupIds: actionResult.ids,
    action: actionResult.action,
    reason,
  };
}
