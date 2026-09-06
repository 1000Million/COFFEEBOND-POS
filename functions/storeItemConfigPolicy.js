'use strict';

const STORE_ITEM_CONFIG_COLLECTION = 'storeItemConfig';
const ID_VERSION = 'v1';

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

module.exports = {
  STORE_ITEM_CONFIG_COLLECTION,
  resolveStoreItem,
  storeItemConfigDocId,
};
