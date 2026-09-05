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

/** Separator is doubled so `GOLDEN_I` + `FG_1` cannot collide with `GOLDEN` + `I_FG_1`. */
const ID_SEPARATOR = '__';

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

function sanitizeSegment(value: unknown): string {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Deterministic document id, so a store/item pair can never gain a duplicate override. */
export function storeItemConfigDocId(storeId: string, itemCode: string): string {
  return `${sanitizeSegment(storeId)}${ID_SEPARATOR}${sanitizeSegment(itemCode)}`.slice(0, 400);
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

/**
 * POS-shaped menu row. The POS names its price `price` where the catalogue says `salePrice`;
 * everything else the resolver touches shares a name.
 */
type PosMenuRow = {
  code: string;
  price: number;
  isAvailable?: boolean;
  sortOrder?: number | null;
};

/**
 * Applies a store's overrides to POS menu rows.
 *
 * Delegates to `resolveStoreItem` so POS and the customer public menu share one precedence
 * implementation, then writes the effective price back to the POS `price` field. Menu
 * visibility is deliberately NOT applied: `menuVisibilityOverride` is customer-menu-only,
 * so hiding an item from customers never removes it from the operational POS menu.
 *
 * With no override documents the rows are returned unchanged, by reference.
 */
export function resolvePosMenuItems<T extends PosMenuRow>(
  items: T[],
  storeId: string,
  configs?: StoreItemConfig[] | null,
): T[] {
  const overridesByCode = storeItemConfigByItemCode(storeId, configs);
  if (overridesByCode.size === 0) return items;

  return items.map((item) => {
    const override = overridesByCode.get(item.code);
    if (!override) return item;
    const resolved = resolveStoreItem(
      { ...(item as unknown as FinishedGood), salePrice: item.price },
      override,
    );
    return {
      ...item,
      price: resolved.salePrice,
      isAvailable: resolved.isAvailable,
      sortOrder: resolved.sortOrder,
    };
  });
}
