import type { MenuItem } from '../types';

export type PosMenuSubcategoryDefinition = {
  code: string;
  name: string;
  sortOrder: number;
};

export type PosMenuCategoryDefinition = {
  code: string;
  name: string;
  sortOrder: number;
  subcategories: PosMenuSubcategoryDefinition[];
};

export type PosMenuClassification = {
  category: PosMenuCategoryDefinition;
  subcategory: PosMenuSubcategoryDefinition | null;
  isClassified: boolean;
  reason: string | null;
};

export type PosMenuPlacementInput = {
  posCategoryCode?: unknown;
  posSubcategoryCode?: unknown;
  sortOrder?: unknown;
};

export type PosMenuPlacementPatch = {
  posCategoryCode: string;
  posCategoryName: string;
  categorySortOrder: number;
  posSubcategoryCode: string | null;
  posSubcategoryName: string | null;
  subcategorySortOrder: number | null;
  sortOrder: number | null;
};

export type PosMenuPlacementResult =
  | { ok: true; patch: PosMenuPlacementPatch }
  | { ok: false; error: string };

export const NEEDS_CLASSIFICATION_CATEGORY: PosMenuCategoryDefinition = {
  code: 'NEEDS_CLASSIFICATION',
  name: 'Needs Classification',
  sortOrder: 9999,
  subcategories: [],
};

export const POS_MENU_CATEGORIES: PosMenuCategoryDefinition[] = [
  {
    code: 'ESPRESSO_BAR',
    name: 'Espresso Bar',
    sortOrder: 10,
    subcategories: [
      { code: 'BLACK_COFFEE', name: 'Black Coffee', sortOrder: 10 },
      { code: 'MILK_BASED', name: 'Milk Based', sortOrder: 20 },
    ],
  },
  { code: 'ICED_COFFEES', name: 'Iced Coffees', sortOrder: 20, subcategories: [] },
  {
    code: 'MATCHA_MANUAL_BREWS',
    name: 'Matcha & Manual Brews',
    sortOrder: 30,
    subcategories: [
      { code: 'MATCHA', name: 'Matcha', sortOrder: 10 },
      { code: 'MANUAL_BREWS', name: 'Manual Brews', sortOrder: 20 },
    ],
  },
  {
    code: 'COLD_BREW_VIETNAMESE_STYLE',
    name: 'Cold Brew & Vietnamese Style',
    sortOrder: 40,
    subcategories: [
      { code: 'COLD_BREW_BASED', name: 'Cold Brew Based', sortOrder: 10 },
      { code: 'VIETNAMESE_STYLE', name: 'Vietnamese Style', sortOrder: 20 },
    ],
  },
  { code: 'SMOOTHIES', name: 'Smoothies', sortOrder: 50, subcategories: [] },
  { code: 'SPECIALTY_DRINKS', name: 'Specialty Drinks', sortOrder: 60, subcategories: [] },
  { code: 'COLD_CRAFTED', name: 'Cold Crafted', sortOrder: 70, subcategories: [] },
  { code: 'FRESH_JUICES', name: 'Fresh Juices', sortOrder: 80, subcategories: [] },
  { code: 'HERBAL_TEA', name: 'Herbal Tea', sortOrder: 90, subcategories: [] },
  {
    code: 'ONLY_AT_BOND',
    name: 'Only at Bond',
    sortOrder: 100,
    subcategories: [
      { code: 'NEW_ADDITIONS', name: 'New Additions', sortOrder: 10 },
      { code: 'ALWAYS_AT_BOND', name: 'Always at Bond', sortOrder: 20 },
    ],
  },
  {
    code: 'JAFFLE_BITES_SALADS',
    name: 'Jaffle, Bites & Salads',
    sortOrder: 110,
    subcategories: [
      { code: 'JAFFLE_BITES', name: 'Jaffle & Bites', sortOrder: 10 },
      { code: 'SALADS', name: 'Salads', sortOrder: 20 },
    ],
  },
  {
    code: 'PIZZA_PIDE',
    name: 'Pizza & Pide',
    sortOrder: 120,
    subcategories: [
      { code: 'PIZZA', name: 'Pizza', sortOrder: 10 },
      { code: 'TURKISH_PIDE', name: 'Turkish Pide', sortOrder: 20 },
      { code: 'SIGNATURE_PASTA', name: 'Signature Pasta', sortOrder: 30 },
    ],
  },
  {
    code: 'BAKED_BAKERY_ICE_CREAM',
    name: 'Baked Bakery & Homemade Ice Cream',
    sortOrder: 130,
    subcategories: [
      { code: 'BAKED', name: 'Baked', sortOrder: 10 },
      { code: 'HOUSEMADE_DAIRY_ICE_CREAM', name: 'Housemade Dairy Ice Cream', sortOrder: 20 },
    ],
  },
  { code: 'RETAIL', name: 'Retail', sortOrder: 140, subcategories: [] },
];

type LegacyCategoryMapping = {
  categoryCode: string;
  subcategoryCode: string | null;
};

// Existing Finished Goods use these stable category codes. This compatibility
// map promotes those codes into the approved hierarchy without inspecting names.
const LEGACY_CATEGORY_MAPPINGS: Record<string, LegacyCategoryMapping> = {
  BLACK_COFFEE: { categoryCode: 'ESPRESSO_BAR', subcategoryCode: 'BLACK_COFFEE' },
  ESP: { categoryCode: 'ESPRESSO_BAR', subcategoryCode: null },
  ESPESSO_BAR: { categoryCode: 'ESPRESSO_BAR', subcategoryCode: 'BLACK_COFFEE' },
  MILK_BASED: { categoryCode: 'ESPRESSO_BAR', subcategoryCode: 'MILK_BASED' },
  MATCHA: { categoryCode: 'MATCHA_MANUAL_BREWS', subcategoryCode: 'MATCHA' },
  MANUAL_BREW: { categoryCode: 'MATCHA_MANUAL_BREWS', subcategoryCode: 'MANUAL_BREWS' },
  MANUAL_BREWS: { categoryCode: 'MATCHA_MANUAL_BREWS', subcategoryCode: 'MANUAL_BREWS' },
  COLD_BREW_BASED: { categoryCode: 'COLD_BREW_VIETNAMESE_STYLE', subcategoryCode: 'COLD_BREW_BASED' },
  VIETNAMESE_STYLE: { categoryCode: 'COLD_BREW_VIETNAMESE_STYLE', subcategoryCode: 'VIETNAMESE_STYLE' },
  ONLY_AT_BOND_NEW: { categoryCode: 'ONLY_AT_BOND', subcategoryCode: 'NEW_ADDITIONS' },
  NEW_ADDITIONS: { categoryCode: 'ONLY_AT_BOND', subcategoryCode: 'NEW_ADDITIONS' },
  ALWAYS_AT_BOND: { categoryCode: 'ONLY_AT_BOND', subcategoryCode: 'ALWAYS_AT_BOND' },
  ZAFFLE_AND_BITES: { categoryCode: 'JAFFLE_BITES_SALADS', subcategoryCode: 'JAFFLE_BITES' },
  JAFFLE_BITES: { categoryCode: 'JAFFLE_BITES_SALADS', subcategoryCode: 'JAFFLE_BITES' },
  SALADS: { categoryCode: 'JAFFLE_BITES_SALADS', subcategoryCode: 'SALADS' },
  PIZZA: { categoryCode: 'PIZZA_PIDE', subcategoryCode: 'PIZZA' },
  TURKISH_PIDE: { categoryCode: 'PIZZA_PIDE', subcategoryCode: 'TURKISH_PIDE' },
  SIGNATURE_PASTA: { categoryCode: 'PIZZA_PIDE', subcategoryCode: 'SIGNATURE_PASTA' },
  BAKED: { categoryCode: 'BAKED_BAKERY_ICE_CREAM', subcategoryCode: 'BAKED' },
  BAKED_BAKERY: { categoryCode: 'BAKED_BAKERY_ICE_CREAM', subcategoryCode: 'BAKED' },
  HOMEMADE_ICE_CREAM: { categoryCode: 'BAKED_BAKERY_ICE_CREAM', subcategoryCode: 'HOUSEMADE_DAIRY_ICE_CREAM' },
  HOUSEMADE_DAIRY_ICE_CREAM: { categoryCode: 'BAKED_BAKERY_ICE_CREAM', subcategoryCode: 'HOUSEMADE_DAIRY_ICE_CREAM' },
  SEASONAL_JUICES: { categoryCode: 'FRESH_JUICES', subcategoryCode: null },
  SPECALITY_DRINKS: { categoryCode: 'SPECIALTY_DRINKS', subcategoryCode: null },
  RETAIL_COFFEE: { categoryCode: 'RETAIL', subcategoryCode: null },
  BAK: { categoryCode: 'BAKED_BAKERY_ICE_CREAM', subcategoryCode: 'BAKED' },
  SAL: { categoryCode: 'JAFFLE_BITES_SALADS', subcategoryCode: 'SALADS' },
  SMO: { categoryCode: 'SMOOTHIES', subcategoryCode: null },
  PIZ: { categoryCode: 'PIZZA_PIDE', subcategoryCode: 'PIZZA' },
  ZAF: { categoryCode: 'JAFFLE_BITES_SALADS', subcategoryCode: 'JAFFLE_BITES' },
  CCF: { categoryCode: 'COLD_CRAFTED', subcategoryCode: null },
  JUI: { categoryCode: 'FRESH_JUICES', subcategoryCode: null },
  ICE: { categoryCode: 'BAKED_BAKERY_ICE_CREAM', subcategoryCode: 'HOUSEMADE_DAIRY_ICE_CREAM' },
};

const COMPACT_SUBCATEGORY_MAPPINGS: Record<string, Record<string, LegacyCategoryMapping>> = {
  ESP: {
    MILK: { categoryCode: 'ESPRESSO_BAR', subcategoryCode: 'MILK_BASED' },
    BLK: { categoryCode: 'ESPRESSO_BAR', subcategoryCode: 'BLACK_COFFEE' },
    ICE: { categoryCode: 'ICED_COFFEES', subcategoryCode: null },
  },
};

const nameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function categoriesByCode(categories: PosMenuCategoryDefinition[]): Map<string, PosMenuCategoryDefinition> {
  return new Map(categories.map((category) => [category.code, category]));
}

function taxonomyReferenceValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  if (value && typeof value === 'object') {
    const reference = value as Record<string, unknown>;
    return taxonomyReferenceValue(reference.code || reference.id || reference.name);
  }
  return '';
}

function firstTaxonomyValue(...values: unknown[]): string {
  for (const value of values) {
    const candidate = taxonomyReferenceValue(value);
    if (candidate) return candidate;
  }
  return '';
}

function normalizedCode(value: unknown): string {
  return taxonomyReferenceValue(value).toUpperCase().replace(/[\s-]+/g, '_');
}

function optionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function posMenuCategorySelection(
  categoryCode: string,
  categories: PosMenuCategoryDefinition[] = POS_MENU_CATEGORIES,
): Omit<PosMenuPlacementPatch, 'sortOrder'> | null {
  const category = categoriesByCode(categories).get(normalizedCode(categoryCode));
  if (!category) return null;

  return {
    posCategoryCode: category.code,
    posCategoryName: category.name,
    categorySortOrder: category.sortOrder,
    posSubcategoryCode: null,
    posSubcategoryName: null,
    subcategorySortOrder: null,
  };
}

export function buildPosMenuPlacementPatch(
  input: PosMenuPlacementInput,
  categories: PosMenuCategoryDefinition[] = POS_MENU_CATEGORIES,
): PosMenuPlacementResult {
  const categoryCode = normalizedCode(input.posCategoryCode);
  const category = categoriesByCode(categories).get(categoryCode);
  if (!category) {
    return { ok: false, error: 'Choose an approved POS category.' };
  }

  const subcategoryCode = normalizedCode(input.posSubcategoryCode);
  let subcategory: PosMenuSubcategoryDefinition | null = null;

  if (category.subcategories.length === 0) {
    if (subcategoryCode) {
      return {
        ok: false,
        error: `${subcategoryCode} is not valid under ${category.name}.`,
      };
    }
  } else {
    if (!subcategoryCode) {
      return { ok: false, error: `Choose a POS subcategory for ${category.name}.` };
    }
    subcategory = category.subcategories.find((entry) => entry.code === subcategoryCode) || null;
    if (!subcategory) {
      return {
        ok: false,
        error: `${subcategoryCode} is not valid under ${category.name}.`,
      };
    }
  }

  const sortOrder = optionalFiniteNumber(input.sortOrder);
  if (sortOrder === undefined) {
    return { ok: false, error: 'POS sort order must be empty or a finite number.' };
  }

  return {
    ok: true,
    patch: {
      posCategoryCode: category.code,
      posCategoryName: category.name,
      categorySortOrder: category.sortOrder,
      posSubcategoryCode: subcategory?.code || null,
      posSubcategoryName: subcategory?.name || null,
      subcategorySortOrder: subcategory?.sortOrder ?? null,
      sortOrder,
    },
  };
}

export function shouldShowNeedsClassificationBadge(
  item: Partial<MenuItem>,
  categories: PosMenuCategoryDefinition[] = POS_MENU_CATEGORIES,
): boolean {
  return !classifyPosMenuItemWithCategories(item, categories).isClassified;
}

export function finishedGoodTaxonomyFields(data: Record<string, unknown>): Pick<
  MenuItem,
  | 'categoryId'
  | 'categoryCode'
  | 'categoryName'
  | 'category'
  | 'posCategoryCode'
  | 'posCategoryName'
  | 'subcategoryId'
  | 'subcategoryCode'
  | 'subcategoryName'
  | 'subcategory'
  | 'posSubcategoryCode'
  | 'posSubcategoryName'
> {
  const posCategoryCode = taxonomyReferenceValue(data.posCategoryCode);
  const posSubcategoryCode = taxonomyReferenceValue(data.posSubcategoryCode);

  return {
    categoryId: firstTaxonomyValue(posCategoryCode, data.categoryId, data.categoryCode, data.category),
    categoryCode: firstTaxonomyValue(posCategoryCode, data.categoryCode, data.categoryId, data.category),
    categoryName: firstTaxonomyValue(data.posCategoryName, data.categoryName, data.category),
    category: (data.category as MenuItem['category']) ?? null,
    posCategoryCode: posCategoryCode || null,
    posCategoryName: taxonomyReferenceValue(data.posCategoryName) || null,
    subcategoryId: firstTaxonomyValue(posSubcategoryCode, data.subcategoryId, data.subcategoryCode, data.subcategory) || null,
    subcategoryCode: firstTaxonomyValue(posSubcategoryCode, data.subcategoryCode, data.subcategoryId, data.subcategory) || null,
    subcategoryName: firstTaxonomyValue(data.posSubcategoryName, data.subcategoryName, data.subcategory) || null,
    subcategory: (data.subcategory as MenuItem['subcategory']) ?? null,
    posSubcategoryCode: posSubcategoryCode || null,
    posSubcategoryName: taxonomyReferenceValue(data.posSubcategoryName) || null,
  };
}

function needsClassification(reason: string): PosMenuClassification {
  return {
    category: NEEDS_CLASSIFICATION_CATEGORY,
    subcategory: null,
    isClassified: false,
    reason,
  };
}

export function classifyPosMenuItem(item: Partial<MenuItem>): PosMenuClassification {
  return classifyPosMenuItemWithCategories(item, POS_MENU_CATEGORIES);
}

export function classifyPosMenuItemWithCategories(
  item: Partial<MenuItem>,
  categories: PosMenuCategoryDefinition[],
): PosMenuClassification {
  const rawCategoryCode = normalizedCode(
    item.posCategoryCode || item.categoryCode || item.categoryId || item.category,
  );
  const rawSubcategoryCode = normalizedCode(
    item.posSubcategoryCode || item.subcategoryCode || item.subcategoryId || item.subcategory,
  );
  const compactSubcategoryMapping = COMPACT_SUBCATEGORY_MAPPINGS[rawCategoryCode]?.[rawSubcategoryCode];
  const legacyMapping = compactSubcategoryMapping || LEGACY_CATEGORY_MAPPINGS[rawCategoryCode];
  const categoryCode = legacyMapping?.categoryCode || rawCategoryCode;
  const subcategoryCode = compactSubcategoryMapping
    ? compactSubcategoryMapping.subcategoryCode || ''
    : rawSubcategoryCode || legacyMapping?.subcategoryCode || '';
  const category = categoriesByCode(categories).get(categoryCode);

  if (!category) {
    return needsClassification(rawCategoryCode ? `Unknown category code: ${rawCategoryCode}` : 'Category metadata is missing');
  }

  if (category.subcategories.length === 0) {
    if (subcategoryCode) {
      return needsClassification(`${subcategoryCode} is not valid under ${category.code}`);
    }
    return { category, subcategory: null, isClassified: true, reason: null };
  }

  const subcategory = category.subcategories.find((entry) => entry.code === subcategoryCode) || null;
  if (!subcategory) {
    return needsClassification(
      subcategoryCode
        ? `${subcategoryCode} is not valid under ${category.code}`
        : `${category.code} requires a subcategory`,
    );
  }

  return { category, subcategory, isClassified: true, reason: null };
}

function productSortOrder(item: Partial<MenuItem>): number {
  if (item.sortOrder === null || item.sortOrder === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  const value = Number(item.sortOrder);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function comparePosMenuItems(left: MenuItem, right: MenuItem): number {
  const leftClassification = classifyPosMenuItem(left);
  const rightClassification = classifyPosMenuItem(right);

  return leftClassification.category.sortOrder - rightClassification.category.sortOrder
    || (leftClassification.subcategory?.sortOrder ?? Number.MAX_SAFE_INTEGER)
      - (rightClassification.subcategory?.sortOrder ?? Number.MAX_SAFE_INTEGER)
    || productSortOrder(left) - productSortOrder(right)
    || nameCollator.compare(left.name || '', right.name || '');
}

export function uniqueSortedPosMenuItems(items: MenuItem[]): MenuItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = String(item.id || item.code || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(comparePosMenuItems);
}

export function searchPosMenuItems(items: MenuItem[], query: string): MenuItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return uniqueSortedPosMenuItems([...items]);

  return uniqueSortedPosMenuItems(items.filter((item) => {
    const classification = classifyPosMenuItem(item);
    const record = item as MenuItem & Record<string, unknown>;
    const aliases = [record.aliases, record.searchAliases, record.skus]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter(Boolean);
    const haystack = [
      item.name,
      item.code,
      record.finishedGoodCode,
      record.sku,
      item.description,
      classification.category.name,
      classification.subcategory?.name,
      ...aliases,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();

    return haystack.includes(normalizedQuery);
  }));
}

export function quickPicksInRankOrder(
  items: MenuItem[],
  rankedItemIds: string[],
  fallbackItems: MenuItem[] = [],
  limit = 4,
): MenuItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ranked = rankedItemIds
    .map((id) => byId.get(id))
    .filter((item): item is MenuItem => Boolean(item))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

  const source = ranked.length > 0 ? ranked : fallbackItems;
  return source.filter((item) => {
    if (ranked.length > 0) return true;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, limit);
}
