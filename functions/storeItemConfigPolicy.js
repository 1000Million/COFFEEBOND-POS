'use strict';

const STORE_ITEM_CONFIG_COLLECTION = 'storeItemConfig';
const ID_VERSION = 'v1';
const GLOBAL_ITEM_VERSION_SCHEMA_VERSION = 1;
const { hasValidProductTypeSemantics } = require('./productTypePolicy');

function encodeIdSegment(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required to identify a store item override.`);
  return encodeURIComponent(normalized);
}

function storeItemConfigDocId(storeId, itemCode) {
  const id = `${ID_VERSION}|${encodeIdSegment(storeId, 'Store ID')}|${encodeIdSegment(itemCode, 'Item code')}`;
  if (Buffer.byteLength(id, 'utf8') > 1_500) {
    throw new Error('The store ID and item code are too long for a Firestore document ID.');
  }
  return id;
}

function hasOverride(config, key) {
  return !!config
    && typeof config === 'object'
    && Object.prototype.hasOwnProperty.call(config, key)
    && config[key] !== undefined
    && config[key] !== null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Server mirror of the frontend resolver. A parity test pins both implementations. */
function resolveStoreItem(product, config) {
  const resolved = { ...product };

  if (hasOverride(config, 'priceOverride')) {
    const price = finiteNumber(config.priceOverride);
    if (price !== null) resolved.salePrice = price;
  }
  if (hasOverride(config, 'isAvailableOverride') && typeof config.isAvailableOverride === 'boolean') {
    resolved.isAvailable = config.isAvailableOverride;
  }
  if (hasOverride(config, 'sortOrderOverride')) {
    const sortOrder = finiteNumber(config.sortOrderOverride);
    if (sortOrder !== null) resolved.sortOrder = sortOrder;
  }

  resolved.menuVisible = true;
  if (hasOverride(config, 'menuVisibilityOverride') && typeof config.menuVisibilityOverride === 'boolean') {
    resolved.menuVisible = config.menuVisibilityOverride;
  }
  return resolved;
}

function requiredText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Server mirror of the canonical frontend effective-product policy. */
function publishedStoreProductVersion(product, config) {
  if (!config || config.publishedVersion === undefined || config.publishedVersion === null) return null;

  const version = config.publishedVersion;
  const publishedProduct = version && version.product;
  const baseCode = requiredText(product && product.code);
  const configStoreId = requiredText(config.storeId);
  const configItemCode = requiredText(config.itemCode);
  const versionStoreId = requiredText(version && version.storeId);
  const versionItemCode = requiredText(version && version.itemCode);
  const versionCode = requiredText(publishedProduct && publishedProduct.code);

  if (
    !version
    || version.schemaVersion !== GLOBAL_ITEM_VERSION_SCHEMA_VERSION
    || !baseCode
    || !configStoreId
    || !configItemCode
    || !versionStoreId
    || !versionItemCode
    || !versionCode
    || configStoreId !== versionStoreId
    || baseCode !== configItemCode
    || baseCode !== versionItemCode
    || baseCode !== versionCode
    || !requiredText(version.publishedRevision)
    || !requiredText(version.sourceDraftRevision)
    || !requiredText(version.publishedBy)
    || version.publishedAt === undefined
    || version.publishedAt === null
    || typeof publishedProduct.menuVisible !== 'boolean'
    || !hasValidProductTypeSemantics(publishedProduct)
  ) {
    throw new Error(`Published product version for ${(product && product.code) || 'unknown item'} is invalid.`);
  }

  if (product.id && publishedProduct.id && product.id !== publishedProduct.id) {
    throw new Error(`Published product version for ${product.code} has a different product ID.`);
  }

  return version;
}

function resolveEffectiveProduct(product, config) {
  const published = publishedStoreProductVersion(product, config);
  if (published) return published.product;
  if (!config) return product;
  return resolveStoreItem(product, config);
}

module.exports = {
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  STORE_ITEM_CONFIG_COLLECTION,
  publishedStoreProductVersion,
  resolveEffectiveProduct,
  resolveStoreItem,
  storeItemConfigDocId,
};
