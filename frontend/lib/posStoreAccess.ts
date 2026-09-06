import type { Store } from '../types';

export type StoreAssignmentProfile = {
  role?: string;
  assignedStoreId?: unknown;
  assignedStoreIds?: unknown;
  assignedLocationId?: unknown;
  assignedLocationIds?: unknown;
  storeId?: unknown;
  storeIds?: unknown;
  locationId?: unknown;
};

const ARRAY_ASSIGNMENT_FIELDS = [
  'assignedStoreIds',
  'assignedLocationIds',
  'storeIds',
] as const;

const SINGLE_ASSIGNMENT_FIELDS = [
  'assignedStoreId',
  'assignedLocationId',
  'storeId',
  'locationId',
] as const;

export function normalizeStoreAccessIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function assignedStoreIdentifiers(profile?: StoreAssignmentProfile | null): string[] {
  if (!profile) return [];

  const identifiers = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeStoreAccessIdentifier(value);
    if (normalized) identifiers.add(normalized);
  };

  ARRAY_ASSIGNMENT_FIELDS.forEach((field) => {
    const value = profile[field];
    if (Array.isArray(value)) value.forEach(add);
  });
  SINGLE_ASSIGNMENT_FIELDS.forEach((field) => add(profile[field]));

  return [...identifiers];
}

/**
 * Assignment identifiers with their ORIGINAL case preserved.
 *
 * `assignedStoreIdentifiers` uppercases, which is correct for case-insensitive matching but
 * WRONG when the value is used as a Firestore document path: three production stores use
 * opaque mixed-case document ids (Noida 29 `cJk69Ti1mveh603L4edw`, Noida 51, Uday Park), and
 * firestore.rules gates `stores/{storeId}` on `hasStoreAccess(storeId)` - the document id.
 * Uppercasing an opaque id yields a path that does not exist, so non-admin staff at those
 * stores loaded an empty store list. Use this when addressing a document.
 */
export function assignedStoreDocumentIds(profile?: StoreAssignmentProfile | null): string[] {
  if (!profile) return [];
  const identifiers = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) identifiers.add(trimmed);
  };
  ARRAY_ASSIGNMENT_FIELDS.forEach((field) => {
    const value = profile[field];
    if (Array.isArray(value)) value.forEach(add);
  });
  SINGLE_ASSIGNMENT_FIELDS.forEach((field) => add(profile[field]));
  return [...identifiers];
}

export function storeMatchesAssignment(
  store: Pick<Store, 'id' | 'code' | 'storeCode'>,
  assignments: Iterable<string>,
): boolean {
  const assigned = new Set([...assignments].map(normalizeStoreAccessIdentifier).filter(Boolean));
  return [store.id, store.code, store.storeCode]
    .map(normalizeStoreAccessIdentifier)
    .filter(Boolean)
    .some((identifier) => assigned.has(identifier));
}

export function accessiblePosStores(stores: Store[], profile?: StoreAssignmentProfile | null): Store[] {
  if (!profile) return [];
  if (profile.role === 'ADMIN') {
    return stores.filter((store) => store.isActive === true || store.internalPosTestEnabled === true);
  }

  const assignments = assignedStoreIdentifiers(profile);
  return stores.filter((store) => {
    const canUseStore = store.isActive === true
      || (profile.role === 'STORE_MANAGER' && store.internalPosTestEnabled === true);
    return canUseStore && storeMatchesAssignment(store, assignments);
  });
}
