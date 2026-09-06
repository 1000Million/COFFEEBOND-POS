/**
 * Shared store-geography helpers.
 *
 * Extracted VERBATIM from pages/customer/CustomerOrder.tsx so the staff POS can reuse the
 * customer app's established nearest-store behaviour instead of implementing a second
 * algorithm. CustomerOrder now imports these; its behaviour is unchanged.
 */
import type { Store } from '../types';

export type StoreCoordinate = { latitude: number; longitude: number };

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function storeCoordinate(store: Store): StoreCoordinate | null {
  const record = store as Store & Record<string, unknown>;
  const nested = record.location || record.geoPoint || record.coordinates;
  const nestedRecord = nested && typeof nested === 'object' ? nested as Record<string, unknown> : {};
  const latitude = numberOrNull(record.latitude)
    ?? numberOrNull(record.lat)
    ?? numberOrNull(nestedRecord.latitude)
    ?? numberOrNull(nestedRecord.lat);
  const longitude = numberOrNull(record.longitude)
    ?? numberOrNull(record.lng)
    ?? numberOrNull(nestedRecord.longitude)
    ?? numberOrNull(nestedRecord.lng);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export function distanceKm(a: StoreCoordinate, b: StoreCoordinate): number {
  const earthRadiusKm = 6371;
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const deltaLat = (b.latitude - a.latitude) * Math.PI / 180;
  const deltaLon = (b.longitude - a.longitude) * Math.PI / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function closestStoreToPosition(stores: Store[], position: StoreCoordinate): { store: Store; distanceKm: number } | null {
  return stores.reduce<{ store: Store; distanceKm: number } | null>((closest, store) => {
    if (store.excludeFromNearestSelection === true) return closest;
    const coordinate = storeCoordinate(store);
    if (!coordinate) return closest;
    const distance = distanceKm(position, coordinate);
    if (!closest || distance < closest.distanceKm) return { store, distanceKm: distance };
    return closest;
  }, null);
}
