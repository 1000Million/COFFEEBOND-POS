/**
 * Per-store item overrides for the global `finishedGoods` catalogue.
 *
 * The catalogue stays canonical and global; a store may override only commercial and
 * menu-presentation intent. Structural safety (BOM validity, composite requirements,
 * prep-station configuration) is never overridable.
 *
 * ABSENCE MEANS INHERIT. A missing field inherits the global value; a present field
 * overrides it. `0` and `false` are therefore valid overrides and must never be
 * resolved by truthiness.
 */
import type { FinishedGood } from '../types/menu-management';
import {
  type StoreProductManagementMode,
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  type PublishedStoreProductVersion,
} from '../types/global-items';
import { hasValidProductTypeSemantics } from './productType';

export const STORE_ITEM_CONFIG_COLLECTION = 'storeItemConfig';

const ID_VERSION = 'v1';

export type StoreItemConfig = {
  id?: string;
  storeId: string;
  itemCode: string;
  /** Effective sale price for this store. `0` is a valid, explicit override. */
  priceOverride?: number;
  /** Effective availability for this store. Can only restrict, never bypass structural blocks. */
  isAvailableOverride?: boolean;
  /** Customer-menu exposure only. Does not affect inventory, KOT, POS identity or sales history. */
  menuVisibilityOverride?: boolean;
  /** Presentation order only. Does not change category assignment. */
  sortOrderOverride?: number;
  /**
   * Complete owner-approved product state for this store. When present and valid it
   * supersedes both the live `finishedGoods` fallback and the four legacy overrides.
   */
  publishedVersion?: PublishedStoreProductVersion;
  /** Published version is authoritative; legacy fields remain stored for audit/migration only. */
  managementMode?: StoreProductManagementMode;
  createdAt?: unknown;
  updatedAt?: unknown;
  updatedBy?: string | null;
};

/** A global finished good with this store's effective values applied. */
export type ResolvedStoreItem = FinishedGood & {
  /** Customer-menu exposure for this store. Defaults to true when no override exists. */
  menuVisible: boolean;
  /** Which override fields were actually applied, for audit and preview. */
  appliedOverrides: Array<'priceOverride' | 'isAvailableOverride' | 'menuVisibilityOverride' | 'sortOrderOverride'>;
};

export type EffectiveStoreItem = FinishedGood & {
  menuVisible?: boolean;
};

function encodeIdSegment(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required to identify a store item override.`);
  // encodeURIComponent escapes the `|` delimiter (and Firestore's `/` path separator),
  // making the two segments reversible and collision-free after normalization.
  return encodeURIComponent(normalized);
}

/** Deterministic document id, so a store/item pair can never gain a duplicate override. */
export function storeItemConfigDocId(storeId: string, itemCode: string): string {
  const id = `${ID_VERSION}|${encodeIdSegment(storeId, 'Store ID')}|${encodeIdSegment(itemCode, 'Item code')}`;
  if (new TextEncoder().encode(id).length > 1_500) {
    throw new Error('The store ID and item code are too long for a Firestore document ID.');
  }
  return id;
}

export function storeItemConfigDocPath(storeId: string, itemCode: string): string {
  return `${STORE_ITEM_CONFIG_COLLECTION}/${storeItemConfigDocId(storeId, itemCode)}`;
}

/** Explicit presence check. Never use truthiness: `0` and `false` are real overrides. */
function hasOverride<K extends keyof StoreItemConfig>(
  override: StoreItemConfig | null | undefined,
  key: K,
): boolean {
  if (!override || typeof override !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(override, key)) return false;
  return override[key] !== undefined && override[key] !== null;
}

function finiteNumberOverride(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Applies a store's overrides to a global finished good.
 *
 * With no override document the returned item is field-identical to the input, so every
 * downstream consumer behaves exactly as it does today.
 */
export function resolveStoreItem(
  item: FinishedGood,
  override?: StoreItemConfig | null,
): ResolvedStoreItem {
  const applied: ResolvedStoreItem['appliedOverrides'] = [];
  const resolved = { ...item } as ResolvedStoreItem;

  if (hasOverride(override, 'priceOverride')) {
    const price = finiteNumberOverride(override?.priceOverride);
    if (price !== null) {
      resolved.salePrice = price;
      applied.push('priceOverride');
    }
  }

  if (hasOverride(override, 'isAvailableOverride') && typeof override?.isAvailableOverride === 'boolean') {
    resolved.isAvailable = override.isAvailableOverride;
    applied.push('isAvailableOverride');
  }

  if (hasOverride(override, 'sortOrderOverride')) {
    const sortOrder = finiteNumberOverride(override?.sortOrderOverride);
    if (sortOrder !== null) {
      resolved.sortOrder = sortOrder;
      applied.push('sortOrderOverride');
    }
  }

  let menuVisible = true;
  if (hasOverride(override, 'menuVisibilityOverride') && typeof override?.menuVisibilityOverride === 'boolean') {
    menuVisible = override.menuVisibilityOverride;
    applied.push('menuVisibilityOverride');
  }

  resolved.menuVisible = menuVisible;
  resolved.appliedOverrides = applied;
  return resolved;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Returns the complete published version after validating its immutable identity.
 * A present-but-malformed version fails closed; silently falling back could sell a
 * different product or mix fields from two revisions.
 */
export function publishedStoreProductVersion(
  item: FinishedGood,
  config?: StoreItemConfig | null,
): PublishedStoreProductVersion | null {
  if (!config || config.publishedVersion === undefined || config.publishedVersion === null) return null;

  const version = config.publishedVersion;
  const product = version.product;
  const baseCode = requiredText(item.code);
  const configStoreId = requiredText(config.storeId);
  const configItemCode = requiredText(config.itemCode);
  const versionStoreId = requiredText(version.storeId);
  const versionItemCode = requiredText(version.itemCode);
  const versionCode = requiredText(product?.code);

  if (
    version.schemaVersion !== GLOBAL_ITEM_VERSION_SCHEMA_VERSION
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
    || typeof product.menuVisible !== 'boolean'
    || !hasValidProductTypeSemantics(product)
  ) {
    throw new Error(`Published product version for ${item.code || 'unknown item'} is invalid.`);
  }

  if (item.id && product.id && item.id !== product.id) {
    throw new Error(`Published product version for ${item.code} has a different product ID.`);
  }

  return version;
}

/**
 * Canonical effective-product precedence for Global Items.
 *
 * 1. A complete per-store published version wins as one indivisible product snapshot.
 * 2. Otherwise the existing four-field store override behavior is preserved.
 * 3. With no store config, return the exact original FinishedGood object. This strict
 *    identity fallback is the G8.1 zero-behavior-change guarantee for every existing
 *    store before its first versioned publication.
 */
export function resolveEffectiveProduct(
  item: FinishedGood,
  config?: StoreItemConfig | null,
): EffectiveStoreItem {
  const published = publishedStoreProductVersion(item, config);
  if (published) return published.product;
  if (!config) return item;
  const { appliedOverrides: _auditOnly, ...effectiveProduct } = resolveStoreItem(item, config);
  return effectiveProduct;
}

/** Indexes a store's override documents by item code, ignoring rows for other stores. */
export function storeItemConfigByItemCode(
  storeId: string,
  configs: StoreItemConfig[] | null | undefined,
): Map<string, StoreItemConfig> {
  const rows = Array.isArray(configs) ? configs : [];
  return new Map(
    rows
      .filter((row) => row && typeof row === 'object' && row.storeId === storeId && typeof row.itemCode === 'string')
      .map((row) => [row.itemCode, row]),
  );
}
