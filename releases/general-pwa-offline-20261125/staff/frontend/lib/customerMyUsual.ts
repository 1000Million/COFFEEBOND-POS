import type { PersistedCheckoutAddOn, PersistedCheckoutLine } from './customerCheckoutPersistence';
import type { OnlineOrderType } from '../types';

/**
 * "My Usual" — one saved customer basket, held in the customer's own Coffee Bond
 * profile.
 *
 * The authenticated profile is the source of truth. This module is the shared schema
 * and its guards: it parses what the backend returns and builds the reference-only
 * payload sent back through `customerMyUsualApi`. It performs no persistence itself —
 * there is no device key, no Firestore access and no Firebase import here, so a signed
 * out customer has no saved usual to show and no way to write one.
 *
 * Only REFERENCES are carried — product id/code, quantities and add-on group/option
 * ids. Names, prices, GST, availability and totals are never stored as authoritative
 * data; they are rebuilt from the live menu at read time via the existing checkout
 * revalidation helper. `catalogMarker` travels purely as a non-authoritative change
 * detector so a catalogue change can be announced.
 *
 * Nothing sensitive is ever carried: no phone number, OTP, Firebase token, profile
 * token, Razorpay id, checkout session, tracking token or payment authorisation. The
 * backend rejects such a field outright rather than stripping it.
 *
 * The schema is versioned and keyed by `id` so multiple saved usuals could be added
 * later without breaking v1 readers; this release exposes exactly one, "default".
 */

/**
 * The Stage 2 device key. It is no longer written or read as a source of truth; it is
 * named here only so a device that ran a pre-release build can be cleaned up once.
 */
export const LEGACY_DEVICE_MY_USUAL_KEY = 'coffeeBondCustomerMyUsual:v1';
export const CUSTOMER_MY_USUAL_VERSION = 1 as const;
export const CUSTOMER_MY_USUAL_DEFAULT_ID = 'default';
export const CUSTOMER_MY_USUAL_DEFAULT_NAME = 'My Usual';

/** Sanity ceilings so a corrupt or hostile payload cannot bloat the ordering screen. */
export const MY_USUAL_MAX_LINES = 40;
export const MY_USUAL_MAX_QUANTITY = 50;
export const MY_USUAL_MAX_ADDONS_PER_LINE = 40;

/** Saved lines reuse the checkout draft's reference shape exactly — no parallel model. */
export type MyUsualLine = PersistedCheckoutLine;

export type CustomerMyUsual = {
  schemaVersion: typeof CUSTOMER_MY_USUAL_VERSION;
  id: string;
  name: string;
  preferredStoreId: string;
  orderType: OnlineOrderType;
  items: MyUsualLine[];
  /** Server write time. Never set from a client clock. */
  savedAt: string;
};

export type CustomerMyUsualInput = {
  preferredStoreId: string;
  orderType: OnlineOrderType;
  items: MyUsualLine[];
};

/** Exactly what `saveCustomerMyUsual` accepts — no id, no name, no savedAt. */
export type CustomerMyUsualPayload = {
  schemaVersion: typeof CUSTOMER_MY_USUAL_VERSION;
  preferredStoreId: string;
  orderType: OnlineOrderType;
  items: MyUsualLine[];
};

export type MyUsualReadStatus = 'VALID' | 'MISSING' | 'CORRUPT' | 'UNSUPPORTED_VERSION' | 'UNAVAILABLE';

export type MyUsualReadResult = {
  usual: CustomerMyUsual | null;
  status: MyUsualReadStatus;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Fields that must never be carried. Enforced on build and asserted in tests. */
const FORBIDDEN_KEYS = [
  'phone', 'customerPhone', 'normalisedPhone', 'otp', 'otpCode', 'idToken', 'token',
  'accessToken', 'refreshToken', 'razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature',
  'checkoutSessionId', 'trackingToken', 'authorizationId', 'price', 'salePrice', 'gst',
  'taxRate', 'total', 'grandTotal', 'amount', 'customerUid', 'uid',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  if (rounded <= 0 || rounded > max) return null;
  return rounded;
}

function parseAddOn(value: unknown): PersistedCheckoutAddOn | null {
  if (!isRecord(value)) return null;
  const groupId = cleanString(value.groupId);
  const optionId = cleanString(value.optionId);
  const quantity = positiveInteger(value.quantity, MY_USUAL_MAX_QUANTITY);
  if (!groupId || !optionId || quantity === null) return null;
  return { groupId, optionId, quantity };
}

function parseLine(value: unknown): MyUsualLine | null {
  if (!isRecord(value)) return null;
  const productId = cleanString(value.productId);
  const productCode = cleanString(value.productCode);
  const quantity = positiveInteger(value.quantity, MY_USUAL_MAX_QUANTITY);
  // A line is only usable if it can be matched back to an authoritative product.
  if ((!productId && !productCode) || quantity === null) return null;

  const rawAddOns = Array.isArray(value.addOns) ? value.addOns : [];
  if (rawAddOns.length > MY_USUAL_MAX_ADDONS_PER_LINE) return null;
  const addOns: PersistedCheckoutAddOn[] = [];
  for (const raw of rawAddOns) {
    const addOn = parseAddOn(raw);
    // A malformed add-on invalidates the line rather than silently dropping an option.
    if (!addOn) return null;
    addOns.push(addOn);
  }

  const lineId = cleanString(value.lineId) || `usual-${productCode || productId}-${addOns.map(a => a.optionId).join('-')}`;
  const catalogMarker = cleanString(value.catalogMarker);

  return {
    lineId,
    productId,
    productCode,
    quantity,
    addOns,
    ...(catalogMarker ? { catalogMarker } : {}),
  };
}

/** Signature of a line's identity: same product + same add-on options. */
function lineSignature(line: MyUsualLine): string {
  const options = line.addOns.map(addOn => `${addOn.groupId}:${addOn.optionId}:${addOn.quantity}`).sort().join('|');
  return `${line.productId}::${line.productCode}::${options}`;
}

/**
 * Merges lines that are identical in product AND add-on selection. Lines differing in
 * any add-on stay separate, because they are genuinely different products to the
 * customer and to pricing.
 */
export function normalizeMyUsualLines(lines: MyUsualLine[]): MyUsualLine[] {
  const merged = new Map<string, MyUsualLine>();
  for (const line of lines) {
    const key = lineSignature(line);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...line });
      continue;
    }
    existing.quantity = Math.min(MY_USUAL_MAX_QUANTITY, existing.quantity + line.quantity);
  }
  return [...merged.values()].slice(0, MY_USUAL_MAX_LINES);
}

/** Guards whatever the profile callable returned before any of it is rendered. */
export function parseCustomerMyUsual(raw: unknown): MyUsualReadResult {
  if (!isRecord(raw)) return { usual: null, status: 'CORRUPT' };
  if (raw.schemaVersion !== CUSTOMER_MY_USUAL_VERSION) {
    // A future or unknown version is ignored, never guessed at.
    return { usual: null, status: 'UNSUPPORTED_VERSION' };
  }

  const preferredStoreId = cleanString(raw.preferredStoreId);
  const orderType = cleanString(raw.orderType);
  if (!preferredStoreId || !orderType) return { usual: null, status: 'CORRUPT' };

  const rawItems = Array.isArray(raw.items) ? raw.items : null;
  if (!rawItems || rawItems.length === 0 || rawItems.length > MY_USUAL_MAX_LINES) {
    return { usual: null, status: 'CORRUPT' };
  }

  const items: MyUsualLine[] = [];
  for (const rawItem of rawItems) {
    const line = parseLine(rawItem);
    // One bad line invalidates the whole usual — never present a partial usual.
    if (!line) return { usual: null, status: 'CORRUPT' };
    items.push(line);
  }

  return {
    usual: {
      schemaVersion: CUSTOMER_MY_USUAL_VERSION,
      id: cleanString(raw.id) || CUSTOMER_MY_USUAL_DEFAULT_ID,
      name: cleanString(raw.name) || CUSTOMER_MY_USUAL_DEFAULT_NAME,
      preferredStoreId,
      orderType: orderType as OnlineOrderType,
      items: normalizeMyUsualLines(items),
      savedAt: cleanString(raw.savedAt) || new Date(0).toISOString(),
    },
    status: 'VALID',
  };
}

/**
 * Strips anything not part of the reference schema before the payload leaves the
 * device, so a caller can never accidentally send a price, a phone number or a token.
 * The backend validates the same rules again and rejects a payload that breaks them.
 */
export function buildMyUsualPayload(input: CustomerMyUsualInput): CustomerMyUsualPayload {
  return {
    schemaVersion: CUSTOMER_MY_USUAL_VERSION,
    preferredStoreId: input.preferredStoreId,
    orderType: input.orderType,
    items: normalizeMyUsualLines(input.items.map(line => ({
      lineId: line.lineId,
      productId: line.productId,
      productCode: line.productCode,
      quantity: line.quantity,
      addOns: line.addOns.map(addOn => ({
        groupId: addOn.groupId,
        optionId: addOn.optionId,
        quantity: addOn.quantity,
      })),
      ...(line.catalogMarker ? { catalogMarker: line.catalogMarker } : {}),
    }))),
  };
}

/**
 * One-time cleanup of the pre-release device key. A usual is a profile record now, so
 * anything left on the device is stale and must not survive to be shown to whoever
 * signs in next.
 */
export function purgeLegacyDeviceMyUsual(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(LEGACY_DEVICE_MY_USUAL_KEY);
    return true;
  } catch {
    // Private browsing or a blocked storage partition must never break ordering.
    return false;
  }
}

/**
 * Test/guard helper: proves a payload carries no commercial or sensitive field. Used by
 * the My Usual suite and safe to call anywhere.
 */
export function containsForbiddenMyUsualField(usual: unknown): string | null {
  const text = JSON.stringify(usual ?? {});
  for (const key of FORBIDDEN_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(text)) return key;
  }
  return null;
}
