import type { FinishedGood } from './menu-management';

/**
 * Schema foundation for the owner-controlled Global Items publishing workflow.
 *
 * `FinishedGood` remains the only product schema. Draft and published versions wrap a
 * complete FinishedGood snapshot instead of defining a second list of product fields.
 * `menuVisible` is the existing resolved customer-menu field and is versioned alongside
 * the canonical product because it has no top-level FinishedGood equivalent today.
 */
export const GLOBAL_ITEM_VERSION_SCHEMA_VERSION = 1 as const;
export const GLOBAL_ITEM_MASTER_DRAFT_COLLECTION = 'globalItemMasterDrafts';

export type GlobalItemProductVersion = FinishedGood & {
  menuVisible: boolean;
};

/** Unpublished Admin work. No POS, customer, KOT, checkout, or inventory consumer reads it. */
export type GlobalItemMasterDraft = {
  schemaVersion: typeof GLOBAL_ITEM_VERSION_SCHEMA_VERSION;
  itemCode: string;
  draftRevision: string;
  /** Exact finishedGoods document used as the identity/fallback source. */
  baseProductId?: string;
  baseProductToken: string;
  product: GlobalItemProductVersion;
  savedAt: unknown;
  savedBy: string;
  savedByName?: string | null;
};

/**
 * The complete product version approved for one store.
 *
 * The effective-product policy treats this snapshot as a unit: fields are never mixed
 * with a newer master or with legacy field overrides. `previousPublishedRevision` leaves
 * an explicit lineage hook for the future rollback/history milestone without building a
 * CMS in G8.1.
 */
export type PublishedStoreProductVersion = {
  schemaVersion: typeof GLOBAL_ITEM_VERSION_SCHEMA_VERSION;
  storeId: string;
  itemCode: string;
  publishedRevision: string;
  sourceDraftRevision: string;
  previousPublishedRevision?: string | null;
  product: GlobalItemProductVersion;
  publishedAt: unknown;
  publishedBy: string;
  publishedByName?: string | null;
};

/** Explicitly removes the legacy four-field editor from the authority chain. */
export const FULL_VERSION_MANAGEMENT_MODE = 'FULL_VERSION_MANAGED' as const;
export type StoreProductManagementMode = typeof FULL_VERSION_MANAGEMENT_MODE;

function encodedDocumentSegment(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  const encoded = encodeURIComponent(normalized);
  if (new TextEncoder().encode(encoded).length > 1_500) {
    throw new Error(`${label} is too long for a Firestore document ID.`);
  }
  return encoded;
}

export function globalItemMasterDraftDocId(itemCode: string): string {
  return encodedDocumentSegment(itemCode, 'Item code');
}

export function globalItemMasterDraftDocPath(itemCode: string): string {
  return `${GLOBAL_ITEM_MASTER_DRAFT_COLLECTION}/${globalItemMasterDraftDocId(itemCode)}`;
}
