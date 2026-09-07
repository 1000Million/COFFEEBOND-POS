'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isAuthorizedStaffProfile } = require('./complimentaryAuthorizationPolicy');
const {
  STORE_ITEM_CONFIG_COLLECTION,
  resolveEffectiveProduct,
  storeItemConfigDocId,
} = require('./storeItemConfigPolicy');
const { isDirectlySellableProductRole } = require('./productTypePolicy');

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function assertStoreConfigIdentity(config, storeId, itemCode) {
  if (!config) return;
  if (config.storeId !== storeId || config.itemCode !== itemCode) {
    fail('failed-precondition', 'The store product catalogue is being refreshed. Please try again.');
  }
}

/** Resolve already-loaded product documents with deterministic per-store config reads. */
async function resolveEffectiveProductSnapshots({ db, storeId, productSnapshots, readSnapshot }) {
  const products = productSnapshots.map(snapshot => {
    if (!snapshot?.exists) return null;
    const data = snapshot.data() || {};
    const code = cleanText(data.code || snapshot.id, 80);
    if (!code) fail('failed-precondition', 'A finished-good product has no stable code.');
    return { ...data, id: snapshot.id, code };
  }).filter(Boolean);
  const configSnapshots = await Promise.all(products.map(product => readSnapshot(
    db.collection(STORE_ITEM_CONFIG_COLLECTION).doc(storeItemConfigDocId(storeId, product.code)),
  )));

  return products.map((product, index) => {
    const configSnapshot = configSnapshots[index];
    const config = configSnapshot?.exists ? configSnapshot.data() : null;
    assertStoreConfigIdentity(config, storeId, product.code);
    try {
      return resolveEffectiveProduct(product, config);
    } catch (_error) {
      fail('failed-precondition', 'A published store product is invalid. Ask an Admin to republish it.');
    }
  });
}

function isDraftSetupCatalogueAllowed(store, staff) {
  return store?.id === 'BAKED_BY_BOND_51'
    && store?.status === 'DRAFT'
    && store?.isActive !== true
    && store?.internalPosTestEnabled === true
    && store?.setupTestMode === true
    && store?.posEnabled === true
    && staff?.isActive === true
    && staff?.role === 'ADMIN';
}

/**
 * Cashiers and Managers cannot read private storeItemConfig documents directly.
 * This callable exposes only the resolved product catalogue they are already allowed
 * to sell, never the private draft/publish metadata that produced it.
 */
function createGetEffectivePosProductsFunction({ db, region }) {
  return onCall({ region }, async request => {
    const staffUid = request.auth?.uid;
    const storeId = cleanText(request.data?.storeId, 120);
    if (!staffUid) fail('unauthenticated', 'Staff sign-in is required.');
    if (!storeId) fail('invalid-argument', 'Store is required.');

    const [staffSnapshot, storeSnapshot] = await Promise.all([
      db.collection('users').doc(staffUid).get(),
      db.collection('stores').doc(storeId).get(),
    ]);
    if (!staffSnapshot.exists) fail('permission-denied', 'Active staff profile is required.');
    if (!storeSnapshot.exists) fail('not-found', 'The selected store was not found.');
    const staff = staffSnapshot.data() || {};
    const store = { ...storeSnapshot.data(), id: storeSnapshot.id };
    if (!isAuthorizedStaffProfile(staff, storeId)) {
      fail('permission-denied', 'This staff account cannot access the selected store catalogue.');
    }
    if ((store.isActive !== true || store.posEnabled === false) && !isDraftSetupCatalogueAllowed(store, staff)) {
      fail('failed-precondition', 'The selected store is not active for staff POS.');
    }

    const productQuery = await db.collection('finishedGoods').get();
    const products = await resolveEffectiveProductSnapshots({
      db,
      storeId,
      productSnapshots: productQuery.docs,
      readSnapshot: reference => reference.get(),
    });
    return { storeId, products: products.filter(isDirectlySellableProductRole) };
  });
}

module.exports = {
  assertStoreConfigIdentity,
  createGetEffectivePosProductsFunction,
  isDraftSetupCatalogueAllowed,
  resolveEffectiveProductSnapshots,
};
