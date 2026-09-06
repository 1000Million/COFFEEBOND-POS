/**
 * Which store the POS should open on.
 *
 * Replaces the previous `allowedStores[0].id`, which selected whichever authorised store had
 * the lexicographically lowest Firestore DOCUMENT ID. Among the production stores that is
 * `GOLDEN_I`, which is why the POS always opened on Golden I - nothing intentional.
 *
 * Precedence, mirroring the customer app's established chain but scoped to what the signed-in
 * staff member is authorised for:
 *
 *   1. a previously selected store, if it is STILL authorised and POS-eligible
 *   2. the single authorised store, when there is exactly one
 *   3. the nearest authorised store, when a device coordinate is available
 *   4. nothing - the operator picks explicitly
 *
 * There is deliberately no positional fallback: step 4 returns '' so the UI asks rather than
 * silently choosing a store the operator may not be standing in.
 */
import { accessiblePosStores, type StoreAssignmentProfile } from './posStoreAccess';
import { closestStoreToPosition, storeCoordinate, type StoreCoordinate } from './storeGeo';
import type { Store } from '../types';

export const POS_STORE_STORAGE_KEY = 'coffeeBondPos:selectedStoreId:v1';

export type PosStoreResolutionReason =
  | 'PERSISTED'
  | 'ONLY_AUTHORIZED_STORE'
  | 'NEAREST'
  | 'NEEDS_EXPLICIT_CHOICE';

export type PosStoreResolution = {
  storeId: string;
  reason: PosStoreResolutionReason;
  eligibleStores: Store[];
};

/** POS eligibility is `accessiblePosStores` - the single canonical predicate. */
export function eligiblePosStores(stores: Store[], profile?: StoreAssignmentProfile | null): Store[] {
  return accessiblePosStores(stores, profile);
}

/** A persisted id is only honoured while it remains authorised AND POS-eligible. */
export function isPersistedStoreStillValid(
  persistedStoreId: string | null | undefined,
  eligible: Store[],
): boolean {
  const id = typeof persistedStoreId === 'string' ? persistedStoreId.trim() : '';
  if (!id) return false;
  return eligible.some((store) => store.id === id);
}

export function resolvePosStore(input: {
  stores: Store[];
  profile?: StoreAssignmentProfile | null;
  persistedStoreId?: string | null;
  coordinate?: StoreCoordinate | null;
}): PosStoreResolution {
  const eligibleStores = eligiblePosStores(input.stores, input.profile);

  if (isPersistedStoreStillValid(input.persistedStoreId, eligibleStores)) {
    return { storeId: (input.persistedStoreId as string).trim(), reason: 'PERSISTED', eligibleStores };
  }

  if (eligibleStores.length === 1) {
    return { storeId: eligibleStores[0].id, reason: 'ONLY_AUTHORIZED_STORE', eligibleStores };
  }

  if (input.coordinate && eligibleStores.length > 1) {
    // Nearest is resolved ONLY within the authorised set, so an unauthorised store that
    // happens to be closer can never be selected.
    const nearest = closestStoreToPosition(eligibleStores, input.coordinate);
    if (nearest) return { storeId: nearest.store.id, reason: 'NEAREST', eligibleStores };
  }

  return { storeId: '', reason: 'NEEDS_EXPLICIT_CHOICE', eligibleStores };
}

/** True when at least one authorised store could ever be resolved by location. */
export function hasNearestResolvableStore(eligible: Store[]): boolean {
  return eligible.some((store) => store.excludeFromNearestSelection !== true && storeCoordinate(store));
}
