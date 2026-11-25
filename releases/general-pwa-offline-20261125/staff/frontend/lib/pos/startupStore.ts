import type { Store } from '../../types';
import { draftKey, sanitizeDraft } from '../tables/drafts';
import { assignedStoreIdentifiers, storeMatchesAssignment, type StoreAssignmentProfile } from '../posStoreAccess';

type StoreIdentity = Pick<Store, 'id'>;
type AssignedStore = Pick<Store, 'id' | 'code' | 'storeCode'>;
type DraftStorage = Pick<Storage, 'getItem' | 'key' | 'length'>;
type Coordinates = Pick<GeolocationCoordinates, 'latitude' | 'longitude'>;
type CoordinatesStore = StoreIdentity & Partial<Coordinates> & Pick<Store, 'lat' | 'lng' | 'physicalParentStoreId'>
  & { location?: unknown; geoPoint?: unknown; coordinates?: unknown };
type LocationStore = CoordinatesStore & Pick<Store, 'isActive' | 'posEnabled' | 'setupTestMode' | 'excludeFromNearestSelection'>;
export type PosLocation = Coordinates & Pick<GeolocationCoordinates, 'accuracy'>;

const preferenceKey = (uid: string) => `coffeeBondPos:lastExplicitStore:v1:${encodeURIComponent(uid)}`;
const NEARBY_RADIUS_METRES = 500;
const MAX_ACCURACY_METRES = 150;
const EARTH_RADIUS_METRES = 6_371_000;

export function rememberedPosStore(uid: string, stores: readonly StoreIdentity[], storage?: Pick<Storage, 'getItem'>): string | null {
  if (!uid) return null;
  try {
    const saved = (storage ?? window.localStorage).getItem(preferenceKey(uid));
    return stores.some(store => store.id === saved) ? saved : null;
  } catch {
    return null;
  }
}

export function rememberPosStore(uid: string, storeId: string, storage?: Pick<Storage, 'setItem'>): boolean {
  if (!uid || !storeId) return false;
  try {
    (storage ?? window.localStorage).setItem(preferenceKey(uid), storeId);
    return true;
  } catch {
    return false;
  }
}

export function findStartupDraftStoreIds(uid: string, storage?: DraftStorage): string[] {
  if (!uid) return [];
  const target = storage ?? window.localStorage;
  const userPrefix = draftKey(uid, '', null).slice(0, -':counter'.length);
  const matched = new Set<string>();
  for (let index = 0; index < target.length; index++) {
    const key = target.key(index);
    if (!key?.startsWith(userPrefix)) continue;
    const [encodedStore, session, extra] = key.slice(userPrefix.length).split(':');
    if (!encodedStore || !session || extra !== undefined) continue;
    const raw = target.getItem(key);
    if (!raw) continue;
    try {
      const storeId = decodeURIComponent(encodedStore);
      if (!storeId || storeId.includes('/') || matched.has(storeId)) continue;
      const draft = sanitizeDraft(JSON.parse(raw));
      const lines = session === 'counter' ? draft.cart : draft.items;
      if (lines?.length) matched.add(storeId);
    } catch {
      // Startup selection leaves unreadable drafts available for recovery.
    }
  }
  return [...matched];
}

export function soleAssignedPosStore(stores: readonly AssignedStore[], profile?: StoreAssignmentProfile | null): string | null {
  const assignments = assignedStoreIdentifiers(profile);
  if (!assignments.length) return null;
  const matches = new Set(stores.filter(store => profile?.staffAccessVersion === 1
    ? assignments.includes(store.id)
    : storeMatchesAssignment(store, assignments)).map(store => store.id));
  return matches.size === 1 ? [...matches][0] : null;
}

function validCoordinates({ latitude, longitude }: Coordinates): boolean {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function ownCoordinates(store: CoordinatesStore): Coordinates | null | undefined {
  const containers = [store, store.location, store.geoPoint, store.coordinates];
  for (const value of containers) {
    if (!value || typeof value !== 'object') continue;
    const fields = value as Record<string, unknown>;
    const latitude = fields.latitude ?? fields.lat;
    const longitude = fields.longitude ?? fields.lng;
    if (latitude == null && longitude == null) continue;
    const numeric = (part: unknown) => typeof part === 'number' ? part
      : typeof part === 'string' && part.trim() ? Number(part) : NaN;
    const result = { latitude: numeric(latitude), longitude: numeric(longitude) };
    return validCoordinates(result) ? result : null;
  }
  return undefined;
}

function distanceMetres(start: Coordinates, end: Coordinates): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitude = radians(end.latitude - start.latitude);
  const longitude = radians(end.longitude - start.longitude);
  const square = Math.sin(latitude / 2) ** 2
    + Math.cos(radians(start.latitude)) * Math.cos(radians(end.latitude)) * Math.sin(longitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(Math.min(1, Math.max(0, square))));
}

export function nearbyPosStore(
  stores: readonly LocationStore[], position: PosLocation | null, locationStores: readonly CoordinatesStore[] = stores,
): string | null {
  if (!position || !validCoordinates(position) || !Number.isFinite(position.accuracy)
    || position.accuracy < 0 || position.accuracy > MAX_ACCURACY_METRES) return null;

  const byId = new Map([...locationStores, ...stores].map(store => [store.id, store]));
  const eligible = stores.filter(store => store.isActive === true && store.posEnabled !== false && store.setupTestMode !== true);
  let possibleStore: string | null = null;
  let definite = false;
  for (const store of eligible) {
    let coordinates = ownCoordinates(store);
    if (coordinates === undefined && store.physicalParentStoreId && store.physicalParentStoreId !== store.id) {
      const parent = byId.get(store.physicalParentStoreId);
      if (parent) coordinates = ownCoordinates(parent);
    }
    if (!coordinates) return null;
    const distance = distanceMetres(position, coordinates);
    if (distance - position.accuracy <= NEARBY_RADIUS_METRES) {
      if (possibleStore) return null;
      possibleStore = store.id;
      // A co-located logical store can make the choice ambiguous even when it cannot be auto-selected.
      definite = store.excludeFromNearestSelection !== true
        && distance + position.accuracy <= NEARBY_RADIUS_METRES;
    }
  }
  return definite ? possibleStore : null;
}

export function requestPosLocation(): Promise<PosLocation | null> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (position: PosLocation | null) => {
      globalThis.clearTimeout(timer);
      resolve(position);
    };
    try {
      const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation;
      if (!geolocation) { finish(null); return; }
      timer = globalThis.setTimeout(() => finish(null), 6000);
      geolocation.getCurrentPosition(({ coords }) => finish({
        latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy,
      }), () => finish(null), { timeout: 5000, maximumAge: 0, enableHighAccuracy: true });
    } catch {
      finish(null);
    }
  });
}
