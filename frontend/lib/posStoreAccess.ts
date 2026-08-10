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
