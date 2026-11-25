import type { MenuItem } from '../types';
import {
  classifyPosMenuItemWithCategories,
  type PosMenuCategoryDefinition,
} from './posMenuNavigation';

export const POS_VISIBILITY_REPAIR_ALLOWED_FIELDS = [
  'isActive',
  'isSellable',
  'isAvailable',
  'availableStoreIds',
] as const;

export const POS_VISIBILITY_REPAIR_PROTECTED_FIELDS = [
  'posCategoryCode',
  'posCategoryName',
  'categorySortOrder',
  'posSubcategoryCode',
  'posSubcategoryName',
  'subcategorySortOrder',
  'sortOrder',
] as const;

export type PosVisibilityRepairField = typeof POS_VISIBILITY_REPAIR_ALLOWED_FIELDS[number];
export type PosVisibilityRepairPatch = Partial<{
  isActive: boolean;
  isSellable: boolean;
  isAvailable: boolean;
  availableStoreIds: string[];
}>;

export type PosVisibilityRepairChange = {
  field: PosVisibilityRepairField;
  currentValue: unknown;
  proposedValue: boolean | string[];
  reason: string;
  requiresExplicitActivation: boolean;
};

export type PosVisibilityRepairPlan = {
  documentId: string;
  productCode: string;
  productName: string;
  patch: PosVisibilityRepairPatch;
  changes: PosVisibilityRepairChange[];
  visibilityWarnings: string[];
  needsClassification: boolean;
  classificationReason: string | null;
  requiresAdminConfirmation: boolean;
};

export type PosClassificationRecoveryAssessment = {
  documentId: string;
  productCode: string;
  productName: string;
  currentPosCategoryCode: string;
  currentPosCategoryName: string;
  currentPosSubcategoryCode: string;
  currentPosSubcategoryName: string;
  legacyCategory: string;
  legacyCategoryCode: string;
  canConfidentlyRecover: boolean;
  proposedCategoryCode: string | null;
  proposedCategoryName: string | null;
  proposedSubcategoryCode: string | null;
  proposedSubcategoryName: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'MANUAL REVIEW';
  reason: string;
};

type RepairableItem = Record<string, unknown>;

// These compact values were written by the removed destructive repair. They
// identify a category but not its required subcategory, so they are recovery
// evidence only and never participate in visibility repair patches.
const REPAIR_ERA_CATEGORY_RECOVERY: Record<string, string> = {
  MAT: 'MATCHA_MANUAL_BREWS',
  CBV: 'COLD_BREW_VIETNAMESE_STYLE',
};

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return text(record.code || record.id || record.name);
  }
  return '';
}

function normalizedCode(value: unknown): string {
  return text(value).toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizedName(value: unknown): string {
  return text(value).toLocaleLowerCase('en').replace(/\s+/g, ' ');
}

function parsedBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en');
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return null;
}

function uniqueStoreIds(value: string[]): string[] {
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

export function assertPosVisibilityRepairPatch(
  patch: Record<string, unknown>,
): asserts patch is PosVisibilityRepairPatch {
  const keys = Object.keys(patch);
  const protectedFields = keys.filter((key) => (
    POS_VISIBILITY_REPAIR_PROTECTED_FIELDS as readonly string[]
  ).includes(key));
  if (protectedFields.length > 0) {
    throw new Error(`Visibility repair aborted: protected field(s) present: ${protectedFields.join(', ')}`);
  }

  const unapprovedFields = keys.filter((key) => !(
    POS_VISIBILITY_REPAIR_ALLOWED_FIELDS as readonly string[]
  ).includes(key));
  if (unapprovedFields.length > 0) {
    throw new Error(`Visibility repair aborted: unapproved field(s) present: ${unapprovedFields.join(', ')}`);
  }
}

export function planPosVisibilityRepair(
  item: RepairableItem,
  allStoreIds: string[],
  categories: PosMenuCategoryDefinition[],
  options: { includeExplicitActivation?: boolean } = {},
): PosVisibilityRepairPlan {
  const changes: PosVisibilityRepairChange[] = [];
  const visibilityWarnings: string[] = [];
  const includeExplicitActivation = options.includeExplicitActivation === true;

  const addChange = (
    field: PosVisibilityRepairField,
    currentValue: unknown,
    proposedValue: boolean | string[],
    reason: string,
    requiresExplicitActivation = false,
  ) => {
    changes.push({ field, currentValue, proposedValue, reason, requiresExplicitActivation });
  };

  for (const field of ['isActive', 'isSellable', 'isAvailable'] as const) {
    const currentValue = item[field];
    const parsed = parsedBoolean(currentValue);

    if (parsed === true && typeof currentValue === 'string') {
      addChange(field, currentValue, true, `${field} is stored as text and will be normalized to true.`);
      continue;
    }

    if (parsed === false) {
      visibilityWarnings.push(`${field} is false; the item will remain hidden unless activation is explicitly included.`);
      if (includeExplicitActivation) {
        addChange(field, currentValue, true, `${field} will be explicitly activated by the Admin.`, true);
      } else if (typeof currentValue === 'string') {
        addChange(field, currentValue, false, `${field} is stored as text and will be normalized without activating the item.`);
      }
      continue;
    }

    if (currentValue === undefined || currentValue === null || currentValue === '') {
      visibilityWarnings.push(`${field} is missing; no activation is proposed without explicit Admin approval.`);
      if (includeExplicitActivation) {
        addChange(field, currentValue, true, `${field} will be explicitly activated by the Admin.`, true);
      }
      continue;
    }

    if (parsed === null) {
      visibilityWarnings.push(`${field} has an unrecognized value and must be reviewed manually.`);
    }
  }

  const availableStoreIds = item.availableStoreIds;
  const configuredStoreIds = uniqueStoreIds(allStoreIds);
  if (typeof availableStoreIds === 'string') {
    const parsedStoreIds = availableStoreIds.trim().toUpperCase() === 'ALL'
      ? configuredStoreIds
      : uniqueStoreIds(availableStoreIds.split(','));
    if (parsedStoreIds.length > 0) {
      addChange(
        'availableStoreIds',
        availableStoreIds,
        parsedStoreIds,
        'availableStoreIds is stored as text and will be normalized to a store ID list.',
      );
    } else {
      visibilityWarnings.push('No valid store assignment can be inferred; store visibility must be reviewed manually.');
    }
  } else if (!Array.isArray(availableStoreIds) || availableStoreIds.length === 0) {
    visibilityWarnings.push('The item is not assigned to any store; no assignment is proposed without explicit Admin approval.');
    if (includeExplicitActivation && configuredStoreIds.length > 0) {
      addChange(
        'availableStoreIds',
        availableStoreIds,
        configuredStoreIds,
        'The item will be explicitly assigned to all configured stores by the Admin.',
        true,
      );
    }
  } else if (availableStoreIds.some((storeId) => typeof storeId !== 'string' || !storeId.trim())) {
    visibilityWarnings.push('availableStoreIds contains an invalid value and must be reviewed manually.');
  }

  if (item.salePrice === undefined || item.salePrice === null || !Number.isFinite(Number(item.salePrice))) {
    visibilityWarnings.push('Sale price is missing or invalid; visibility repair will not change pricing.');
  }
  if (item.itemType === 'MADE_TO_ORDER' && (!item.prepStation || item.prepStation === 'NONE')) {
    visibilityWarnings.push('Made-to-order item has no prep station; visibility repair will not change routing.');
  }

  const classification = classifyPosMenuItemWithCategories(
    item as Partial<MenuItem>,
    categories,
  );
  const patch = Object.fromEntries(
    changes.map((change) => [change.field, change.proposedValue]),
  ) as PosVisibilityRepairPatch;
  assertPosVisibilityRepairPatch(patch);

  return {
    documentId: text(item.id),
    productCode: text(item.code),
    productName: text(item.name || item.displayName),
    patch,
    changes,
    visibilityWarnings,
    needsClassification: !classification.isClassified,
    classificationReason: classification.reason,
    requiresAdminConfirmation: changes.length > 0,
  };
}

function recoveryRecord(
  item: RepairableItem,
  assessment: Omit<PosClassificationRecoveryAssessment,
    | 'documentId'
    | 'productCode'
    | 'productName'
    | 'currentPosCategoryCode'
    | 'currentPosCategoryName'
    | 'currentPosSubcategoryCode'
    | 'currentPosSubcategoryName'
    | 'legacyCategory'
    | 'legacyCategoryCode'>,
): PosClassificationRecoveryAssessment {
  return {
    documentId: text(item.id),
    productCode: text(item.code),
    productName: text(item.name || item.displayName),
    currentPosCategoryCode: text(item.posCategoryCode),
    currentPosCategoryName: text(item.posCategoryName),
    currentPosSubcategoryCode: text(item.posSubcategoryCode),
    currentPosSubcategoryName: text(item.posSubcategoryName),
    legacyCategory: text(item.category),
    legacyCategoryCode: text(item.categoryCode),
    ...assessment,
  };
}

export function assessPosClassificationRecovery(
  item: RepairableItem,
  categories: PosMenuCategoryDefinition[],
): PosClassificationRecoveryAssessment | null {
  const current = classifyPosMenuItemWithCategories(item as Partial<MenuItem>, categories);
  if (current.isClassified) return null;

  const legacyOnly = {
    categoryId: item.categoryId,
    categoryCode: item.categoryCode,
    category: item.category,
    subcategoryId: item.subcategoryId,
    subcategoryCode: item.subcategoryCode,
    subcategory: item.subcategory,
  } as Partial<MenuItem>;
  const legacy = classifyPosMenuItemWithCategories(legacyOnly, categories);
  if (legacy.isClassified) {
    return recoveryRecord(item, {
      canConfidentlyRecover: true,
      proposedCategoryCode: legacy.category.code,
      proposedCategoryName: legacy.category.name,
      proposedSubcategoryCode: legacy.subcategory?.code || null,
      proposedSubcategoryName: legacy.subcategory?.name || null,
      confidence: 'HIGH',
      reason: 'Known canonical/legacy category metadata resolves deterministically.',
    });
  }

  const repairEraCategoryCode = REPAIR_ERA_CATEGORY_RECOVERY[
    normalizedCode(item.posCategoryCode)
  ];
  const repairEraCategory = categories.find(
    (entry) => entry.code === repairEraCategoryCode,
  );
  if (repairEraCategory) {
    const currentSubcategoryCode = normalizedCode(item.posSubcategoryCode);
    const repairEraSubcategory = repairEraCategory.subcategories.find(
      (entry) => normalizedCode(entry.code) === currentSubcategoryCode,
    ) || null;
    const isComplete = repairEraCategory.subcategories.length === 0
      || repairEraSubcategory !== null;
    return recoveryRecord(item, {
      canConfidentlyRecover: isComplete,
      proposedCategoryCode: repairEraCategory.code,
      proposedCategoryName: repairEraCategory.name,
      proposedSubcategoryCode: repairEraSubcategory?.code || null,
      proposedSubcategoryName: repairEraSubcategory?.name || null,
      confidence: isComplete ? 'HIGH' : 'MEDIUM',
      reason: isComplete
        ? 'Known repair-era category metadata resolves deterministically.'
        : 'Known repair-era code identifies the category, but its required subcategory needs confirmation.',
    });
  }

  const categoryReferences = [item.categoryCode, item.categoryId, item.categoryName, item.category];
  const category = categories.find((entry) => categoryReferences.some((reference) => (
    normalizedCode(reference) === normalizedCode(entry.code)
    || normalizedName(reference) === normalizedName(entry.name)
  )));
  if (category) {
    const subcategoryReferences = [
      item.subcategoryCode,
      item.subcategoryId,
      item.subcategoryName,
      item.subcategory,
    ];
    const subcategory = category.subcategories.find((entry) => subcategoryReferences.some((reference) => (
      normalizedCode(reference) === normalizedCode(entry.code)
      || normalizedName(reference) === normalizedName(entry.name)
    ))) || null;
    return recoveryRecord(item, {
      canConfidentlyRecover: false,
      proposedCategoryCode: category.code,
      proposedCategoryName: category.name,
      proposedSubcategoryCode: subcategory?.code || null,
      proposedSubcategoryName: subcategory?.name || null,
      confidence: 'MEDIUM',
      reason: subcategory || category.subcategories.length === 0
        ? 'Previous metadata matches the effective taxonomy by exact code/name; confirm before recovery.'
        : 'Previous metadata identifies a category, but its required subcategory needs confirmation.',
    });
  }

  return recoveryRecord(item, {
    canConfidentlyRecover: false,
    proposedCategoryCode: null,
    proposedCategoryName: null,
    proposedSubcategoryCode: null,
    proposedSubcategoryName: null,
    confidence: 'MANUAL REVIEW',
    reason: 'No reliable canonical or legacy taxonomy mapping exists. No product-name inference was used.',
  });
}
