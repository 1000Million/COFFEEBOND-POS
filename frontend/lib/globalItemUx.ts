import type { Store } from '../types';
import type { FinishedGood, FinishedGoodProductType } from '../types/menu-management';
import type { GlobalItemMasterDraft, GlobalItemProductVersion } from '../types/global-items';
import { canonicalDataToken } from './storeItemConfigAdmin';
import { resolveEffectiveProduct, resolveStoreItem, type StoreItemConfig } from './storeItemConfig';
import { resolveFinishedGoodProductType } from './productType';

export type PublishedStoreState = 'CURRENT' | 'OLDER_VERSION' | 'NOT_PUBLISHED';

export type PublishReviewChange = {
  key: string;
  label: string;
  before: string;
  after: string;
};

export function eligibleGlobalItemStores<T extends Pick<Store, 'id' | 'code' | 'name' | 'isActive'>>(
  stores: T[],
): T[] {
  return stores
    .filter((store) => store.isActive === true && String(store.code || '').trim().length > 0)
    .sort((left, right) => String(left.name || left.code).localeCompare(String(right.name || right.code)));
}

export function initialMasterProduct(
  item: FinishedGood,
  draft?: GlobalItemMasterDraft | null,
): GlobalItemProductVersion {
  if (draft?.itemCode === item.code && draft.product?.code === item.code) {
    return structuredClone(draft.product);
  }
  const productType = resolveFinishedGoodProductType(item) || 'NORMAL_SELLABLE';
  return {
    ...structuredClone(item),
    productType,
    isSellable: productType === 'INTERNAL_COMPONENT' ? false : item.isSellable,
    menuVisible: productType === 'INTERNAL_COMPONENT' ? false : true,
  };
}

export function productWithType(
  product: GlobalItemProductVersion,
  productType: FinishedGoodProductType,
): GlobalItemProductVersion {
  if (productType === 'INTERNAL_COMPONENT') {
    const { composite: _composite, unresolvedCompositeRequirements: _unresolved, ...ordinary } = product;
    return {
      ...ordinary,
      productType,
      isSellable: false,
      menuVisible: false,
    };
  }
  if (productType === 'NORMAL_SELLABLE') {
    const { composite: _composite, unresolvedCompositeRequirements: _unresolved, ...ordinary } = product;
    return {
      ...ordinary,
      productType,
      isSellable: true,
    };
  }
  return {
    ...product,
    productType,
    isSellable: true,
    composite: product.composite || { schemaVersion: 1, staticComponents: [], choiceGroupIds: [] },
  };
}

export function masterProductToken(product: GlobalItemProductVersion): string {
  return canonicalDataToken(product);
}

export function selectedStoreIdsAfterToggle(
  selectedStoreIds: string[],
  storeId: string,
): string[] {
  return selectedStoreIds.includes(storeId)
    ? selectedStoreIds.filter((id) => id !== storeId)
    : [...selectedStoreIds, storeId];
}

export function selectedStoreIdsAfterSelectAll(
  selectedStoreIds: string[],
  eligibleStoreIds: string[],
): string[] {
  return eligibleStoreIds.length > 0 && eligibleStoreIds.every((id) => selectedStoreIds.includes(id))
    ? []
    : [...eligibleStoreIds];
}

export function publishedStoreState(
  config: StoreItemConfig | null | undefined,
  currentDraftRevision: string | null | undefined,
): PublishedStoreState {
  const version = config?.publishedVersion;
  if (!version) return 'NOT_PUBLISHED';
  return currentDraftRevision && version.sourceDraftRevision === currentDraftRevision
    ? 'CURRENT'
    : 'OLDER_VERSION';
}

function comparableProduct(product: FinishedGood & { menuVisible?: boolean }): Record<string, unknown> {
  const { availableStoreIds: _assignment, ...comparable } = product;
  return comparable;
}

export function publishedProductDiffersFromMaster(
  config: StoreItemConfig | null | undefined,
  masterProduct: GlobalItemProductVersion,
): boolean | null {
  if (!config?.publishedVersion) return null;
  return canonicalDataToken(comparableProduct(config.publishedVersion.product))
    !== canonicalDataToken(comparableProduct(masterProduct));
}

export function effectiveStoreProduct(
  item: FinishedGood,
  config: StoreItemConfig | null | undefined,
): FinishedGood & { menuVisible?: boolean } {
  try {
    return resolveEffectiveProduct(item, config);
  } catch {
    return resolveStoreItem(item, null);
  }
}

function money(value: unknown): string {
  const number = Number(value || 0);
  return `₹${number.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function visibility(value: unknown): string {
  return value === false ? 'Hidden' : 'Visible';
}

function availability(value: unknown): string {
  return value === false ? 'Unavailable' : 'Available';
}

type ReviewField = {
  key: string;
  label: string;
  value: (product: FinishedGood & { menuVisible?: boolean }) => unknown;
  display: (value: unknown) => string;
};

const REVIEW_FIELDS: ReviewField[] = [
  { key: 'name', label: 'Name', value: (product) => product.displayName || product.name, display: text },
  { key: 'description', label: 'Description', value: (product) => product.description || '', display: (value) => text(value) || 'None' },
  { key: 'image', label: 'Image', value: (product) => product.imageUrl || '', display: (value) => text(value) ? 'Updated image' : 'No image' },
  { key: 'category', label: 'Category', value: (product) => product.posCategoryCode, display: text },
  { key: 'price', label: 'Price', value: (product) => product.salePrice, display: money },
  { key: 'availability', label: 'Availability', value: (product) => product.isAvailable, display: availability },
  { key: 'visibility', label: 'Customer menu', value: (product) => product.menuVisible !== false, display: visibility },
  { key: 'sortOrder', label: 'Display order', value: (product) => product.sortOrder, display: text },
  { key: 'taxRate', label: 'GST / tax', value: (product) => product.taxRate, display: (value) => `${Number(value || 0)}%` },
  { key: 'productType', label: 'Product type', value: (product) => resolveFinishedGoodProductType(product), display: text },
  { key: 'prepStation', label: 'Prep / KOT station', value: (product) => product.prepStation, display: text },
  { key: 'addOns', label: 'Add-ons', value: (product) => ({ groups: product.addOnGroupIds || [], options: product.addOnOptionIdsByGroup || {} }), display: () => 'Configuration updated' },
  { key: 'bom', label: 'Recipe / BOM', value: (product) => product.bom || [], display: () => 'Recipe updated' },
  { key: 'composite', label: 'Child configuration', value: (product) => product.composite || null, display: () => 'Child configuration updated' },
];

export function publishReviewChanges(
  item: FinishedGood,
  masterProduct: GlobalItemProductVersion,
  selectedStoreIds: string[],
  configsByStoreId: Map<string, StoreItemConfig | null>,
): PublishReviewChange[] {
  const currentProducts = selectedStoreIds.map((storeId) => (
    effectiveStoreProduct(item, configsByStoreId.get(storeId))
  ));
  return REVIEW_FIELDS.flatMap((field) => {
    const next = field.value(masterProduct);
    const changedFrom = currentProducts
      .map((product) => field.value(product))
      .filter((value) => canonicalDataToken(value) !== canonicalDataToken(next));
    if (changedFrom.length === 0) return [];
    const uniqueBefore = [...new Set(changedFrom.map((value) => field.display(value)))];
    return [{
      key: field.key,
      label: field.label,
      before: uniqueBefore.length === 1 ? uniqueBefore[0] : 'Varies by store',
      after: field.display(next),
    }];
  });
}
