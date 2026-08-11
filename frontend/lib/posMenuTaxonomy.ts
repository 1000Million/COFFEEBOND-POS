import {
  classifyPosMenuItem,
  classifyPosMenuItemWithCategories,
  POS_MENU_CATEGORIES,
  type PosMenuCategoryDefinition,
  type PosMenuSubcategoryDefinition,
} from './posMenuNavigation';

export const POS_MENU_TAXONOMY_DOCUMENT_PATH = 'appSettings/posMenuTaxonomy';
export const POS_MENU_TAXONOMY_SCHEMA_VERSION = 1;

export type ManagedPosMenuSubcategory = PosMenuSubcategoryDefinition & { isActive: boolean };
export type ManagedPosMenuCategory = Omit<PosMenuCategoryDefinition, 'subcategories'> & {
  isActive: boolean;
  subcategories: ManagedPosMenuSubcategory[];
};

export type PosMenuTaxonomy = {
  schemaVersion: number;
  categories: ManagedPosMenuCategory[];
};

export type TaxonomyUsage = {
  categoryCounts: Record<string, number>;
  subcategoryCounts: Record<string, number>;
};

export type PosMenuTaxonomyValidation =
  | { ok: true }
  | { ok: false; error: string };

export type TaxonomyReferenceProtection = {
  canHardDelete: boolean;
  requiresDeactivationConfirmation: boolean;
};

export type ResolvedPosMenuTaxonomy = {
  taxonomy: PosMenuTaxonomy;
  source: 'firestore' | 'fallback';
};

function cloneFallbackCategories(): ManagedPosMenuCategory[] {
  return POS_MENU_CATEGORIES.map((category) => ({
    ...category,
    isActive: true,
    subcategories: category.subcategories.map((subcategory) => ({ ...subcategory, isActive: true })),
  }));
}

export function committedPosMenuTaxonomy(): PosMenuTaxonomy {
  return { schemaVersion: POS_MENU_TAXONOMY_SCHEMA_VERSION, categories: cloneFallbackCategories() };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteOrder(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSubcategory(value: unknown): ManagedPosMenuSubcategory | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const code = text(data.code);
  const name = text(data.name);
  const sortOrder = finiteOrder(data.sortOrder);
  if (!code || !name || sortOrder === null) return null;
  return { code, name, sortOrder, isActive: data.isActive !== false };
}

function parseCategory(value: unknown): ManagedPosMenuCategory | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const code = text(data.code);
  const name = text(data.name);
  const sortOrder = finiteOrder(data.sortOrder);
  if (!code || !name || sortOrder === null || !Array.isArray(data.subcategories)) return null;
  const subcategories = data.subcategories.map(parseSubcategory);
  if (subcategories.some((entry) => entry === null)) return null;
  return {
    code,
    name,
    sortOrder,
    isActive: data.isActive !== false,
    subcategories: subcategories as ManagedPosMenuSubcategory[],
  };
}

export function resolvePosMenuTaxonomy(value: unknown): ResolvedPosMenuTaxonomy {
  if (!value || typeof value !== 'object') return { taxonomy: committedPosMenuTaxonomy(), source: 'fallback' };
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    return { taxonomy: committedPosMenuTaxonomy(), source: 'fallback' };
  }
  const categories = data.categories.map(parseCategory);
  const categoryCodes = categories.map((entry) => entry?.code);
  const valid = categories.every(Boolean)
    && new Set(categoryCodes).size === categoryCodes.length
    && categories.every((category) => {
      const codes = category?.subcategories.map((entry) => entry.code) || [];
      return new Set(codes).size === codes.length;
    });
  if (!valid) return { taxonomy: committedPosMenuTaxonomy(), source: 'fallback' };
  const taxonomy: PosMenuTaxonomy = {
    schemaVersion: finiteOrder(data.schemaVersion) || POS_MENU_TAXONOMY_SCHEMA_VERSION,
    categories: categories as ManagedPosMenuCategory[],
  };
  if (!validatePosMenuTaxonomy(taxonomy).ok) {
    return { taxonomy: committedPosMenuTaxonomy(), source: 'fallback' };
  }
  return { taxonomy, source: 'firestore' };
}

export function activePosMenuCategories(taxonomy: PosMenuTaxonomy): PosMenuCategoryDefinition[] {
  return taxonomy.categories
    .filter((category) => category.isActive)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((category) => ({
      code: category.code,
      name: category.name,
      sortOrder: category.sortOrder,
      subcategories: category.subcategories
        .filter((subcategory) => subcategory.isActive)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map(({ code, name, sortOrder }) => ({ code, name, sortOrder })),
    }));
}

export function allPosMenuCategories(taxonomy: PosMenuTaxonomy): PosMenuCategoryDefinition[] {
  return [...taxonomy.categories]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((category) => ({
      code: category.code,
      name: category.name,
      sortOrder: category.sortOrder,
      subcategories: [...category.subcategories]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map(({ code, name, sortOrder }) => ({ code, name, sortOrder })),
    }));
}

export function normalizeTaxonomyCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function normalizeTaxonomyDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeTaxonomyName(value: string): string {
  return normalizeTaxonomyDisplayName(value).toLocaleLowerCase('en');
}

export function validatePosMenuTaxonomy(taxonomy: PosMenuTaxonomy): PosMenuTaxonomyValidation {
  const categoryCodes = taxonomy.categories.map((entry) => normalizeTaxonomyCode(entry.code));
  if (categoryCodes.some((code) => !code) || new Set(categoryCodes).size !== categoryCodes.length) {
    return { ok: false, error: 'Every category needs a unique code.' };
  }

  const categoryNames = taxonomy.categories.map((entry) => normalizeTaxonomyName(entry.name));
  if (categoryNames.some((name) => !name)
    || taxonomy.categories.some((entry) => !Number.isFinite(Number(entry.sortOrder)))) {
    return { ok: false, error: 'Every category needs a name and finite sort order.' };
  }
  if (new Set(categoryNames).size !== categoryNames.length) {
    return { ok: false, error: 'Duplicate category name is not allowed.' };
  }

  for (const category of taxonomy.categories) {
    const subcategoryCodes = category.subcategories.map((entry) => normalizeTaxonomyCode(entry.code));
    if (subcategoryCodes.some((code) => !code)
      || new Set(subcategoryCodes).size !== subcategoryCodes.length
      || category.subcategories.some((entry) => !normalizeTaxonomyName(entry.name)
        || !Number.isFinite(Number(entry.sortOrder)))) {
      return {
        ok: false,
        error: 'Every subcategory needs a unique code within its category, a name, and a finite sort order.',
      };
    }
    const subcategoryNames = category.subcategories.map((entry) => normalizeTaxonomyName(entry.name));
    if (new Set(subcategoryNames).size !== subcategoryNames.length) {
      return {
        ok: false,
        error: `Duplicate subcategory name is not allowed within ${normalizeTaxonomyDisplayName(category.name)}.`,
      };
    }
  }

  return { ok: true };
}

export function taxonomyUsage(
  items: Array<Record<string, unknown>>,
  categories: PosMenuCategoryDefinition[] = POS_MENU_CATEGORIES,
): TaxonomyUsage {
  const usage: TaxonomyUsage = { categoryCounts: {}, subcategoryCounts: {} };
  for (const item of items) {
    if (item.isActive !== true || item.isSellable !== true) continue;
    const classification = classifyPosMenuItemWithCategories(
      item as Parameters<typeof classifyPosMenuItem>[0],
      categories,
    );
    if (!classification.isClassified) continue;
    const category = classification.category.code;
    const subcategory = classification.subcategory?.code || '';
    usage.categoryCounts[category] = (usage.categoryCounts[category] || 0) + 1;
    if (subcategory) usage.subcategoryCounts[subcategory] = (usage.subcategoryCounts[subcategory] || 0) + 1;
  }
  return usage;
}

export function categoryReferenceCount(category: ManagedPosMenuCategory, usage: TaxonomyUsage): number {
  const directReferences = usage.categoryCounts[category.code] || 0;
  const nestedReferences = category.subcategories.reduce((total, entry) => total + (usage.subcategoryCounts[entry.code] || 0), 0);
  return Math.max(directReferences, nestedReferences);
}

export function taxonomyReferenceProtection(referenceCount: number): TaxonomyReferenceProtection {
  const isReferenced = Number.isFinite(referenceCount) && referenceCount > 0;
  return {
    canHardDelete: !isReferenced,
    requiresDeactivationConfirmation: isReferenced,
  };
}
