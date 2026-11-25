'use strict';

/**
 * "My Usual" — one saved basket per customer, held in the customer's own private
 * profile document and reachable ONLY through these three authenticated callables.
 *
 * The profile is the source of truth. There is no client Firestore path:
 * `customerProfiles/{uid}` is denied to every client by firestore.rules, so a
 * customer's usual can only be read or written by a caller who has proved a phone
 * identity through the existing `verifiedCustomerIdentity` helper, and only ever for
 * `request.auth.uid`. A client-supplied uid is never consulted.
 *
 * Only REFERENCES are stored — product id/code, quantities and add-on group/option
 * ids. Names, prices, GST, availability and totals are rebuilt from the live menu on
 * every read by the customer app. Commercial and private fields are rejected outright
 * rather than stripped, so a caller learns its payload was wrong instead of silently
 * saving something different from what it sent.
 *
 * `catalogMarker` survives purely as a non-authoritative change detector. It carries
 * no commercial authority and is never used for pricing.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
// The modular Firestore import, as storeProvisioning.js uses. The legacy
// `admin.firestore.FieldValue` namespace does not survive the Functions emulator's
// patching of firebase-admin, so it cannot be exercised end to end.
const { FieldValue } = require('firebase-admin/firestore');
const { cleanText } = require('./customerCheckoutCanonicalization');
const { CUSTOMER_PROFILE_COLLECTION, verifiedCustomerIdentity } = require('./razorpayPaymentFirst');

const MY_USUAL_FIELD = 'myUsual';
const MY_USUAL_UPDATED_AT_FIELD = 'myUsualUpdatedAt';
const MY_USUAL_SCHEMA_VERSION = 1;
const MY_USUAL_DEFAULT_ID = 'default';
const MY_USUAL_DEFAULT_NAME = 'My Usual';
const SUPPORTED_ORDER_TYPES = ['PICKUP', 'DINE_IN'];

/** Conservative ceilings. A basket larger than this is not a usual, it is an error. */
const MAX_ITEMS = 40;
const MAX_QUANTITY = 50;
const MAX_ADD_ONS_PER_LINE = 40;
const MAX_REFERENCE_LENGTH = 128;

/** Safe reference characters only — no whitespace, quotes, slashes or path traversal. */
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Any key containing one of these fragments is rejected wherever it appears in the
 * payload. Fragment matching (not exact matching) is deliberate: it catches
 * `unitPrice`, `lineGstTotal`, `razorpayOrderId`, `customerUid` and friends without
 * needing to enumerate every variation. No legitimate My Usual key contains any of
 * them — the allowed keys are schemaVersion, id, name, preferredStoreId, orderType,
 * items, lineId, productId, productCode, quantity, addOns, groupId, optionId,
 * catalogMarker and savedAt.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'price', 'subtotal', 'taxable', 'tax', 'gst', 'total', 'amount', 'discount',
  'phone', 'mobile', 'otp', 'token', 'payment', 'razorpay', 'checkoutsession',
  'session', 'tracking', 'uid', 'auth', 'claim', 'audit', 'signature', 'secret',
  'currency', 'invoice', 'receipt', 'refund',
];

function fail(code, message) {
  throw new HttpsError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Walks the whole payload looking for a forbidden key. Runs BEFORE canonicalization so
 * a commercial or private field is refused rather than quietly dropped.
 */
function assertNoForbiddenKeys(value, depth = 0) {
  if (depth > 6) fail('invalid-argument', 'My Usual is nested too deeply.');
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenKeys(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const flattened = key.toLowerCase().replace(/[^a-z]/g, '');
    const hit = FORBIDDEN_KEY_FRAGMENTS.find(fragment => flattened.includes(fragment));
    if (hit) fail('invalid-argument', 'My Usual cannot contain payment, pricing or identity data.');
    assertNoForbiddenKeys(nested, depth + 1);
  }
}

function safeReference(value, label) {
  const text = cleanText(value, MAX_REFERENCE_LENGTH);
  if (!text || !SAFE_REFERENCE_PATTERN.test(text)) fail('invalid-argument', `${label} is not a valid reference.`);
  return text;
}

function boundedQuantity(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_QUANTITY) {
    fail('invalid-argument', `${label} must be a whole number between 1 and ${MAX_QUANTITY}.`);
  }
  return parsed;
}

function canonicalAddOn(raw) {
  if (!isRecord(raw)) fail('invalid-argument', 'Each add-on must be an object.');
  return {
    groupId: safeReference(raw.groupId, 'Add-on group'),
    optionId: safeReference(raw.optionId, 'Add-on option'),
    quantity: boundedQuantity(raw.quantity, 'Add-on quantity'),
  };
}

function canonicalLine(raw, index) {
  if (!isRecord(raw)) fail('invalid-argument', 'Each saved line must be an object.');
  const productId = safeReference(raw.productId, 'Product id');
  const productCode = safeReference(raw.productCode, 'Product code');
  const quantity = boundedQuantity(raw.quantity, 'Quantity');

  const rawAddOns = raw.addOns === undefined ? [] : raw.addOns;
  if (!Array.isArray(rawAddOns)) fail('invalid-argument', 'Add-ons must be a list.');
  if (rawAddOns.length > MAX_ADD_ONS_PER_LINE) fail('invalid-argument', 'Too many add-ons on one line.');
  const addOns = rawAddOns.map(canonicalAddOn);

  const line = {
    // A saved line is identified by position and product, never by a client-chosen id
    // that could collide with another customer's data.
    lineId: `usual-${index + 1}-${productCode}`,
    productId,
    productCode,
    quantity,
    addOns,
  };
  // Change-detection only. Never authoritative, never priced against.
  const catalogMarker = cleanText(raw.catalogMarker, 64);
  if (catalogMarker) {
    if (!SAFE_REFERENCE_PATTERN.test(catalogMarker)) fail('invalid-argument', 'Catalog marker is not a valid reference.');
    line.catalogMarker = catalogMarker;
  }
  return line;
}

/**
 * Rebuilds the payload field by field. Nothing the caller sent survives unless it is
 * named here, so an unknown field can never reach Firestore.
 */
function canonicalizeMyUsual(data) {
  if (!isRecord(data)) fail('invalid-argument', 'My Usual details are required.');
  assertNoForbiddenKeys(data);

  if (data.schemaVersion !== MY_USUAL_SCHEMA_VERSION) {
    fail('invalid-argument', `My Usual must use schema version ${MY_USUAL_SCHEMA_VERSION}.`);
  }
  if (data.id !== undefined && data.id !== MY_USUAL_DEFAULT_ID) {
    fail('invalid-argument', 'Only the default My Usual can be saved.');
  }
  if (data.name !== undefined && cleanText(data.name, 40) !== MY_USUAL_DEFAULT_NAME) {
    fail('invalid-argument', 'My Usual cannot be renamed.');
  }
  const preferredStoreId = safeReference(data.preferredStoreId, 'Preferred store');
  const orderType = cleanText(data.orderType, 20);
  if (!SUPPORTED_ORDER_TYPES.includes(orderType)) fail('invalid-argument', 'Choose Pickup or Dine-in.');

  if (!Array.isArray(data.items) || data.items.length === 0) {
    fail('invalid-argument', 'My Usual needs at least one item.');
  }
  if (data.items.length > MAX_ITEMS) {
    fail('invalid-argument', `My Usual cannot hold more than ${MAX_ITEMS} lines.`);
  }
  const items = data.items.map(canonicalLine);

  // `savedAt` is deliberately absent: a client clock is never trusted as the saved
  // time. `myUsualUpdatedAt` carries the server timestamp instead.
  return {
    schemaVersion: MY_USUAL_SCHEMA_VERSION,
    id: MY_USUAL_DEFAULT_ID,
    name: MY_USUAL_DEFAULT_NAME,
    preferredStoreId,
    orderType,
    items,
  };
}

/**
 * Order-independent serialization. Firestore does not promise to return map keys in
 * the order they were written, so an identical payload must be recognised by value.
 */
function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function timestampIso(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  return null;
}

/**
 * Shapes the stored usual for the client, adding the server-owned saved time and
 * nothing else. The rest of the profile — phone, display name, audit fields — never
 * leaves the backend.
 */
function sanitizedMyUsualResponse(profileData) {
  const stored = profileData?.[MY_USUAL_FIELD];
  const updatedAt = timestampIso(profileData?.[MY_USUAL_UPDATED_AT_FIELD]);
  if (!isRecord(stored)) return { myUsual: null, schemaVersion: MY_USUAL_SCHEMA_VERSION, updatedAt: null };
  return {
    myUsual: {
      schemaVersion: MY_USUAL_SCHEMA_VERSION,
      id: MY_USUAL_DEFAULT_ID,
      name: MY_USUAL_DEFAULT_NAME,
      preferredStoreId: cleanText(stored.preferredStoreId, MAX_REFERENCE_LENGTH),
      orderType: SUPPORTED_ORDER_TYPES.includes(stored.orderType) ? stored.orderType : 'PICKUP',
      items: Array.isArray(stored.items) ? stored.items.map(line => ({
        lineId: cleanText(line?.lineId, MAX_REFERENCE_LENGTH),
        productId: cleanText(line?.productId, MAX_REFERENCE_LENGTH),
        productCode: cleanText(line?.productCode, MAX_REFERENCE_LENGTH),
        quantity: Number(line?.quantity) || 0,
        addOns: Array.isArray(line?.addOns) ? line.addOns.map(addOn => ({
          groupId: cleanText(addOn?.groupId, MAX_REFERENCE_LENGTH),
          optionId: cleanText(addOn?.optionId, MAX_REFERENCE_LENGTH),
          quantity: Number(addOn?.quantity) || 0,
        })) : [],
        ...(cleanText(line?.catalogMarker, 64) ? { catalogMarker: cleanText(line.catalogMarker, 64) } : {}),
      })) : [],
      // Server-owned. A client-supplied savedAt was discarded on write.
      savedAt: updatedAt || new Date(0).toISOString(),
    },
    schemaVersion: MY_USUAL_SCHEMA_VERSION,
    updatedAt,
  };
}

/**
 * Loads the caller's own profile. The uid comes from the verified token only; a uid in
 * `request.data` is never read. An absent profile means the customer has not completed
 * the existing sign-in that provisions it, so there is nothing to operate on.
 */
async function loadActiveCustomerProfile({ db, identity }) {
  const profileRef = db.collection(CUSTOMER_PROFILE_COLLECTION).doc(identity.uid);
  const snapshot = await profileRef.get();
  if (!snapshot.exists) fail('failed-precondition', 'Finish setting up your Coffee Bond profile first.');
  const data = snapshot.data() || {};
  if (data.isActive === false || data.disabled === true) {
    fail('permission-denied', 'This Coffee Bond profile is not active.');
  }
  if (cleanText(data.customerUid, 128) && cleanText(data.customerUid, 128) !== identity.uid) {
    fail('permission-denied', 'This profile belongs to another customer.');
  }
  return { profileRef, data };
}

async function getMyUsualHandler({ request, db }) {
  const identity = verifiedCustomerIdentity(request);
  const { data } = await loadActiveCustomerProfile({ db, identity });
  return sanitizedMyUsualResponse(data);
}

async function saveMyUsualHandler({ request, db }) {
  const identity = verifiedCustomerIdentity(request);
  const canonical = canonicalizeMyUsual(request.data);
  const { profileRef, data } = await loadActiveCustomerProfile({ db, identity });

  // An identical save is a no-op: the stored document and its server timestamp are
  // left exactly as they were, so repeating the call cannot churn the profile.
  const unchanged = stableSerialize(data?.[MY_USUAL_FIELD] ?? null) === stableSerialize(canonical);
  if (!unchanged) {
    // Merge, and only these two fields — every unrelated profile field is untouched.
    await profileRef.set({
      [MY_USUAL_FIELD]: canonical,
      [MY_USUAL_UPDATED_AT_FIELD]: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const saved = await profileRef.get();
  return { ...sanitizedMyUsualResponse(saved.data()), saved: true, unchanged };
}

async function deleteMyUsualHandler({ request, db }) {
  const identity = verifiedCustomerIdentity(request);
  const { profileRef, data } = await loadActiveCustomerProfile({ db, identity });
  const existed = data?.[MY_USUAL_FIELD] !== undefined;
  if (existed) {
    // Only the usual and its own metadata are removed. The profile document itself,
    // and every other field on it, survives.
    await profileRef.set({
      [MY_USUAL_FIELD]: FieldValue.delete(),
      [MY_USUAL_UPDATED_AT_FIELD]: FieldValue.delete(),
    }, { merge: true });
  }
  return { deleted: true, existed, myUsual: null, schemaVersion: MY_USUAL_SCHEMA_VERSION, updatedAt: null };
}

/** `admin` is accepted for symmetry with the other factories; timestamps come from
 *  the modular `FieldValue` import so the callables work under the emulator too. */
function createCustomerMyUsualFunctions({ db, region }) {
  const getCustomerMyUsual = onCall({ region }, request => getMyUsualHandler({ request, db }));
  const saveCustomerMyUsual = onCall({ region }, request => saveMyUsualHandler({ request, db }));
  const deleteCustomerMyUsual = onCall({ region }, request => deleteMyUsualHandler({ request, db }));
  return { getCustomerMyUsual, saveCustomerMyUsual, deleteCustomerMyUsual };
}

module.exports = {
  CUSTOMER_PROFILE_COLLECTION,
  FORBIDDEN_KEY_FRAGMENTS,
  MAX_ADD_ONS_PER_LINE,
  MAX_ITEMS,
  MAX_QUANTITY,
  MY_USUAL_DEFAULT_ID,
  MY_USUAL_DEFAULT_NAME,
  MY_USUAL_FIELD,
  MY_USUAL_SCHEMA_VERSION,
  MY_USUAL_UPDATED_AT_FIELD,
  assertNoForbiddenKeys,
  canonicalizeMyUsual,
  createCustomerMyUsualFunctions,
  deleteMyUsualHandler,
  getMyUsualHandler,
  loadActiveCustomerProfile,
  sanitizedMyUsualResponse,
  saveMyUsualHandler,
  stableSerialize,
};
