'use strict';

const FINISHED_GOOD_PRODUCT_TYPES = new Set([
  'NORMAL_SELLABLE',
  'INTERNAL_COMPONENT',
  'COMPOSITE_PARENT',
]);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitProductType(product) {
  return Object.prototype.hasOwnProperty.call(product || {}, 'productType')
    && product.productType !== undefined
    && product.productType !== null;
}

function resolveFinishedGoodProductType(product) {
  if (hasExplicitProductType(product)) {
    const value = String(product.productType || '').trim().toUpperCase();
    return FINISHED_GOOD_PRODUCT_TYPES.has(value) ? value : null;
  }
  return isRecord(product?.composite) ? 'COMPOSITE_PARENT' : 'NORMAL_SELLABLE';
}

function productTypeSemanticIssues(product) {
  const type = resolveFinishedGoodProductType(product || {});
  if (!type) return ['Product type is invalid.'];
  const composite = isRecord(product?.composite);
  if (type === 'INTERNAL_COMPONENT') {
    return [
      ...(composite ? ['Internal components cannot be composite parents.'] : []),
      ...(product?.isSellable === true ? ['Internal components cannot be directly sellable.'] : []),
      ...(product?.menuVisible === true ? ['Internal components cannot be customer-menu visible.'] : []),
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

function hasValidProductTypeSemantics(product) {
  return productTypeSemanticIssues(product).length === 0;
}

function isDirectlySellableProductRole(product) {
  return hasValidProductTypeSemantics(product)
    && resolveFinishedGoodProductType(product) !== 'INTERNAL_COMPONENT';
}

function isCompositeParentProduct(product) {
  return hasValidProductTypeSemantics(product)
    && resolveFinishedGoodProductType(product) === 'COMPOSITE_PARENT';
}

module.exports = {
  FINISHED_GOOD_PRODUCT_TYPES,
  hasValidProductTypeSemantics,
  isCompositeParentProduct,
  isDirectlySellableProductRole,
  productTypeSemanticIssues,
  resolveFinishedGoodProductType,
};
