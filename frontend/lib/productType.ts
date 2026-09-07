import type { FinishedGood, FinishedGoodProductType } from '../types/menu-management';

export const FINISHED_GOOD_PRODUCT_TYPES = [
  'NORMAL_SELLABLE',
  'INTERNAL_COMPONENT',
  'COMPOSITE_PARENT',
] as const satisfies readonly FinishedGoodProductType[];

const PRODUCT_TYPE_SET = new Set<string>(FINISHED_GOOD_PRODUCT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitProductType(product: Partial<FinishedGood>): boolean {
  return Object.prototype.hasOwnProperty.call(product, 'productType')
    && product.productType !== undefined
    && product.productType !== null;
}

/** Legacy-compatible role resolution. Unknown explicit values fail closed. */
export function resolveFinishedGoodProductType(
  product: Partial<FinishedGood>,
): FinishedGoodProductType | null {
  if (hasExplicitProductType(product)) {
    const value = String(product.productType || '').trim().toUpperCase();
    return PRODUCT_TYPE_SET.has(value) ? value as FinishedGoodProductType : null;
  }
  return isRecord(product.composite) ? 'COMPOSITE_PARENT' : 'NORMAL_SELLABLE';
}

export function productTypeSemanticIssues(
  product: Partial<FinishedGood> & { menuVisible?: boolean },
): string[] {
  const type = resolveFinishedGoodProductType(product);
  if (!type) return ['Product type is invalid.'];
  const composite = isRecord(product.composite);
  if (type === 'INTERNAL_COMPONENT') {
    return [
      ...(composite ? ['Internal components cannot be composite parents.'] : []),
      ...(product.isSellable === true ? ['Internal components cannot be directly sellable.'] : []),
      ...(product.menuVisible === true ? ['Internal components cannot be customer-menu visible.'] : []),
    ];
  }
  if (type === 'COMPOSITE_PARENT' && !composite) {
    return ['Composite parents require a composite definition.'];
  }
  if (type === 'NORMAL_SELLABLE' && composite) {
    return ['Normal sellable products cannot carry a composite definition.'];
  }
  return [];
}

export function hasValidProductTypeSemantics(
  product: Partial<FinishedGood> & { menuVisible?: boolean },
): boolean {
  return productTypeSemanticIssues(product).length === 0;
}

export function isDirectlySellableProductRole(
  product: Partial<FinishedGood> & { menuVisible?: boolean },
): boolean {
  return hasValidProductTypeSemantics(product)
    && resolveFinishedGoodProductType(product) !== 'INTERNAL_COMPONENT';
}

export function isCompositeParentProduct(
  product: Partial<FinishedGood> & { menuVisible?: boolean },
): boolean {
  return hasValidProductTypeSemantics(product)
    && resolveFinishedGoodProductType(product) === 'COMPOSITE_PARENT';
}
