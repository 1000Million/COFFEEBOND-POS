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
