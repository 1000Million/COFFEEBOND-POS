'use strict';

/**
 * Server-side resolution of per-store item overrides.
 *
 * This is the functions-side twin of frontend/lib/storeItemConfig.ts. Functions is CommonJS
 * and cannot import the frontend TypeScript module, so the two implementations are kept
 * deliberately equivalent and are held in lockstep by
 * scripts/test-store-item-config-parity.mjs.
 *
 * ABSENCE MEANS INHERIT. A missing field inherits the global value; a present field overrides
 * it. `0` and `false` are therefore valid overrides and must never be resolved by truthiness.
 *
 * The server is authoritative: POS may display a resolved price, but the price that is charged
 * comes from here, resolved against a storeId the caller has already been authorized for.
 */

const STORE_ITEM_CONFIG_COLLECTION = 'storeItemConfig';

/** Separator is doubled so `GOLDEN_I` + `FG_1` cannot collide with `GOLDEN` + `I_FG_1`. */
const ID_SEPARATOR = '__';

function sanitizeSegment(value) {
  return String(value === null || value === undefined ? '' : value)
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Deterministic document id. Must stay byte-identical to the frontend helper. */
function storeItemConfigDocId(storeId, itemCode) {
  return `${sanitizeSegment(storeId)}${ID_SEPARATOR}${sanitizeSegment(itemCode)}`.slice(0, 400);
}

function storeItemConfigDocPath(storeId, itemCode) {
  return `${STORE_ITEM_CONFIG_COLLECTION}/${storeItemConfigDocId(storeId, itemCode)}`;
}

/** Explicit presence check. Never use truthiness: `0` and `false` are real overrides. */
function hasOverride(override, key) {
  if (!override || typeof override !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(override, key)) return false;
  return override[key] !== undefined && override[key] !== null;
}

function finiteNumberOverride(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Resolves the effective sale price for a store.
 *
 * Returns the global `salePrice` when no explicit `priceOverride` is present. A
 * `priceOverride` of 0 is honoured — downstream structural checks (positive-price
 * validation) then apply exactly as they do for a global price of 0.
 */
function resolveEffectiveSalePrice(product, override) {
  const globalPrice = finiteNumberOverride(Number(product && product.salePrice));
  const base = globalPrice === null ? 0 : globalPrice;
  if (!hasOverride(override, 'priceOverride')) return base;
  const price = finiteNumberOverride(override.priceOverride);
  return price === null ? base : price;
}

/** Resolves effective availability. Commercial intent only; structural checks still apply. */
function resolveEffectiveIsAvailable(product, override) {
  const globalAvailable = !(product && product.isAvailable === false);
  if (!hasOverride(override, 'isAvailableOverride')) return globalAvailable;
  return typeof override.isAvailableOverride === 'boolean'
    ? override.isAvailableOverride
    : globalAvailable;
}

/** Indexes a store's override documents by item code, ignoring rows for other stores. */
function storeItemConfigByItemCode(storeId, configs) {
  const rows = Array.isArray(configs) ? configs : [];
  const map = {};
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    if (row.storeId !== storeId) return;
    if (typeof row.itemCode !== 'string') return;
    map[row.itemCode] = row;
  });
  return map;
}

/**
 * Loads the override documents for one authorized store and the given item codes.
 *
 * Reads by deterministic document id, so it cannot be steered to another store's rows: the
 * storeId is supplied by the caller only after that caller has authorized staff access to it.
 * `getter` allows a Firestore transaction to be threaded through.
 */
async function loadStoreItemOverrides(db, storeId, itemCodes, getter) {
  const codes = [...new Set((Array.isArray(itemCodes) ? itemCodes : [])
    .filter((code) => typeof code === 'string' && code.trim()))];
  if (!storeId || codes.length === 0) return {};
  const read = typeof getter === 'function'
    ? getter
    : (ref) => ref.get();
  const snapshots = await Promise.all(codes.map((code) => read(
    db.collection(STORE_ITEM_CONFIG_COLLECTION).doc(storeItemConfigDocId(storeId, code)),
  )));
  const overrides = {};
  snapshots.forEach((snapshot, index) => {
    if (!snapshot || !snapshot.exists) return;
    const data = snapshot.data() || {};
    if (data.storeId !== storeId) return;
    overrides[codes[index]] = { id: snapshot.id, ...data };
  });
  return overrides;
}

module.exports = {
  STORE_ITEM_CONFIG_COLLECTION,
  storeItemConfigDocId,
  storeItemConfigDocPath,
  hasOverride,
  resolveEffectiveSalePrice,
  resolveEffectiveIsAvailable,
  storeItemConfigByItemCode,
  loadStoreItemOverrides,
};
