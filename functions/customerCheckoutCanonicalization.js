'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const {
  canonicalizeRequestedCart,
  sanitizeCartItems,
} = require('./posAddOnAuthorization');
const {
  CompositeProductPolicyError,
  collectRequiredComponentFinishedGoodIds,
} = require('./compositeProductPolicy');
const {
  STORE_ITEM_CONFIG_COLLECTION,
  resolveEffectiveProduct,
  storeItemConfigDocId,
} = require('./storeItemConfigPolicy');
const { isDirectlySellableProductRole } = require('./productTypePolicy');

const MAX_NAME_LENGTH = 80;
const MAX_NOTE_LENGTH = 200;
const MAX_TABLE_LENGTH = 20;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function failCompositePolicy(error) {
  if (error instanceof CompositeProductPolicyError) {
    fail('failed-precondition', error.message);
  }
  throw error;
}

function cleanText(value, maxLength = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function isGoldenISalesFirstOrderingStore(store) {
  return store?.id === 'GOLDEN_I'
    && cleanText(store.code || store.storeCode, 80) === 'GOLDEN_I';
}

function isCustomerOrderingEnabledForStore(store) {
  if (!isGoldenISalesFirstOrderingStore(store)) return store?.isActive === true && store.onlineOrderingEnabled !== false;
  return store.isActive === true
    && store.posEnabled === true
    && store.customerOrderingEnabled === true
    && store.onlineOrderingEnabled === true
    && store.publicOrderingEnabled === true
    && store.acceptingOrders === true
    && store.isAcceptingOrders === true;
}

function sanitizeCheckoutRequest(data, sessionId) {
  const storeId = cleanText(data?.storeId, 120);
  const storeCode = cleanText(data?.storeCode, 80);
  const customerName = cleanText(data?.customerName, MAX_NAME_LENGTH);
  const orderType = data?.orderType === 'DINE_IN' ? 'DINE_IN' : 'PICKUP';
  const tableNumber = orderType === 'DINE_IN'
    ? cleanText(data?.tableNumber, MAX_TABLE_LENGTH)
    : null;
  const notes = cleanText(data?.notes, MAX_NOTE_LENGTH);
  if (!storeId && !storeCode) fail('invalid-argument', 'Please select a store.');
  if (!customerName) fail('invalid-argument', 'Please enter your name.');
  if (orderType === 'DINE_IN' && !tableNumber) {
    fail('invalid-argument', 'Please enter your table number.');
  }
  const requestedItems = sanitizeCartItems((data?.items || []).map((item, index) => {
    const productCode = cleanText(
      item?.parentProductCode || item?.itemCode || item?.finishedGoodCode || item?.code,
      80,
    );
    return {
      orderItemId: `${sessionId}_ITEM_${String(index + 1).padStart(2, '0')}`,
      parentProductId: cleanText(item?.parentProductId || productCode, 120),
      parentProductCode: productCode,
      quantity: Number(item?.quantity),
      selectedAddOns: item?.selectedAddOns || item?.addOns || [],
    };
  }));
  return {
    storeId,
    storeCode,
    customerName,
    orderType,
    tableNumber,
    notes,
    requestedItems,
  };
}

async function resolveStore(db, storeId, storeCode) {
  if (storeId) {
    const snapshot = await db.collection('stores').doc(storeId).get();
    if (snapshot.exists) return { id: snapshot.id, ...snapshot.data() };
  }
  if (storeCode) {
    const snapshot = await db.collection('stores')
      .where('code', '==', storeCode)
      .where('isActive', '==', true)
      .limit(2)
      .get();
    if (snapshot.size === 1) return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  }
  fail('failed-precondition', 'The selected store is not available.');
}

async function resolveFinishedGood(db, productId, productCode) {
  const direct = await db.collection('finishedGoods').doc(productId).get();
  if (direct.exists && cleanText(direct.data()?.code, 80) === productCode) {
    return { id: direct.id, ...direct.data() };
  }
  const byCode = await db.collection('finishedGoods').where('code', '==', productCode).limit(2).get();
  if (byCode.size !== 1) {
    fail('failed-precondition', 'One or more products are no longer available.');
  }
  return { id: byCode.docs[0].id, ...byCode.docs[0].data() };
}

/**
 * Verify Pay Online against the same derived public-menu row the customer selected.
 *
 * The supplied product has already been resolved from the private finishedGood and
 * private storeItemConfig source documents. The public snapshot is only a
 * consistency/exposure gate: it must match that source-derived effective state.
 * Requiring both public maps rejects a stale cart after an item is hidden.
 */
function resolvePublicCheckoutProduct({ product, publicAvailability, publicMenuItem, store }) {
  const productCode = cleanText(product?.code || product?.id, 80);
  const menuCode = cleanText(publicMenuItem?.code || publicMenuItem?.id, 80);
  const availabilityCode = cleanText(
    publicAvailability?.itemCode || publicAvailability?.fgCode,
    80,
  );
  const assignedStoreIds = Array.isArray(publicMenuItem?.availableStoreIds)
    ? publicMenuItem.availableStoreIds
    : [];
  const sourceStoreIds = Array.isArray(product?.availableStoreIds)
    ? product.availableStoreIds
    : [];
  const sourceAssigned = sourceStoreIds.length === 0 || sourceStoreIds.includes(store.id);
  const publicPrice = Number(publicMenuItem?.salePrice);
  const effectivePrice = Number(product?.salePrice);
  const setupWarningOnly = isGoldenISalesFirstOrderingStore(store)
    && publicAvailability?.publicStatus === 'SETUP_INCOMPLETE';

  if (
    !productCode
    || !publicMenuItem
    || !publicAvailability
    || menuCode !== productCode
    || availabilityCode !== productCode
    || product.menuVisible === false
    || product.isActive !== true
    || product.isSellable !== true
    || !isDirectlySellableProductRole(product)
    || !sourceAssigned
    || !assignedStoreIds.includes(store.id)
    || publicMenuItem.isActive !== true
    || publicMenuItem.isSellable !== true
    || publicMenuItem.isAvailable !== (product.isAvailable !== false)
    || !Number.isFinite(publicPrice)
    || !Number.isFinite(effectivePrice)
    || publicPrice <= 0
    || publicPrice !== effectivePrice
    || (publicAvailability.available !== true && !setupWarningOnly)
  ) {
    fail('failed-precondition', 'Some items are currently unavailable. Please update your basket.');
  }

  // canonicalizeRequestedCart intentionally keeps the stricter POS assignment
  // contract. Adapt only this customer-checkout copy for the catalogue's legacy
  // empty-list-means-all-stores convention; the POS resolver is untouched.
  return sourceStoreIds.length === 0
    ? { ...product, availableStoreIds: [store.id] }
    : product;
}

async function canonicalizeCustomerCheckout({ db, data, sessionId }) {
  const sanitized = sanitizeCheckoutRequest(data, sessionId);
  const store = await resolveStore(db, sanitized.storeId, sanitized.storeCode);
  if (!isCustomerOrderingEnabledForStore(store)) {
    fail('failed-precondition', 'Online ordering is currently unavailable for this store.');
  }

  const [gstSnapshot, availabilitySnapshot] = await Promise.all([
    db.collection('appSettings').doc('gstConfig').get(),
    db.collection('publicMenuAvailability').doc(store.code).get(),
  ]);
  if (!availabilitySnapshot.exists) {
    fail('failed-precondition', 'Menu availability is being refreshed. Please try again.');
  }
  const availability = availabilitySnapshot.data() || {};
  const availabilityItems = availability.items || {};
  const publicMenuItems = availability.menuItems || {};

  const privateProducts = await Promise.all(sanitized.requestedItems.map(item => (
    resolveFinishedGood(db, item.parentProductId, item.parentProductCode)
  )));
  const configSnapshots = await Promise.all(privateProducts.map(product => (
    db.collection(STORE_ITEM_CONFIG_COLLECTION)
      .doc(storeItemConfigDocId(store.id, product.code))
      .get()
  )));
  const resolvedProducts = privateProducts.map((product, index) => {
    const configSnapshot = configSnapshots[index];
    const config = configSnapshot.exists ? configSnapshot.data() : null;
    if (config && (config.storeId !== store.id || config.itemCode !== product.code)) {
      fail('failed-precondition', 'Menu configuration is being refreshed. Please try again.');
    }
    const effectiveProduct = resolveEffectiveProduct(product, config);
    return resolvePublicCheckoutProduct({
      product: effectiveProduct,
      publicAvailability: availabilityItems[product.code],
      publicMenuItem: publicMenuItems[product.code],
      store,
    });
  });
  const requestedItems = sanitized.requestedItems.map((item, index) => ({
    ...item,
    parentProductId: resolvedProducts[index].id,
    parentProductCode: resolvedProducts[index].code,
  }));

  const productsById = Object.fromEntries(resolvedProducts.map(product => [product.id, product]));
  const groupIds = [...new Set(
    resolvedProducts.flatMap(product => (
      Array.isArray(product.addOnGroupIds) ? product.addOnGroupIds : []
    )),
  )];
  const groupSnapshots = await Promise.all(
    groupIds.map(groupId => db.collection('addOnGroups').doc(groupId).get()),
  );
  const groupsById = Object.fromEntries(
    groupSnapshots
      .filter(snapshot => snapshot.exists)
      .map(snapshot => [snapshot.id, { id: snapshot.id, ...snapshot.data() }]),
  );
  let componentProductIds;
  try {
    componentProductIds = collectRequiredComponentFinishedGoodIds({
      products: productsById,
      groupsById,
    });
  } catch (error) {
    failCompositePolicy(error);
  }
  const missingComponentProductIds = componentProductIds.filter(productId => !productsById[productId]);
  const componentProductSnapshots = await Promise.all(
    missingComponentProductIds.map(productId => db.collection('finishedGoods').doc(productId).get()),
  );
  const componentConfigSnapshots = await Promise.all(
    componentProductSnapshots.map(snapshot => (
      snapshot.exists
        ? db.collection(STORE_ITEM_CONFIG_COLLECTION)
          .doc(storeItemConfigDocId(store.id, snapshot.data()?.code || snapshot.id))
          .get()
        : Promise.resolve(null)
    )),
  );
  const resolvedComponentProducts = componentProductSnapshots
    .map((snapshot, index) => {
      if (!snapshot.exists) return null;
      const product = { id: snapshot.id, ...snapshot.data() };
      const configSnapshot = componentConfigSnapshots[index];
      const config = configSnapshot?.exists ? configSnapshot.data() : null;
      if (config && (config.storeId !== store.id || config.itemCode !== product.code)) {
        fail('failed-precondition', 'Menu configuration is being refreshed. Please try again.');
      }
      return resolveEffectiveProduct(product, config);
    })
    .filter(Boolean);
  const componentProductsById = {
    ...productsById,
    ...Object.fromEntries(
      resolvedComponentProducts.map(product => [product.id, product]),
    ),
  };
  const canonical = canonicalizeRequestedCart({
    storeId: store.id,
    store,
    gstConfig: gstSnapshot.exists ? gstSnapshot.data() : null,
    requestedItems,
    productsById,
    groupsById,
    componentProductsById,
  });

  const items = requestedItems.map(requested => {
    const product = productsById[requested.parentProductId];
    const canonicalItem = canonical.canonicalItems[requested.orderItemId];
    const quantity = requested.quantity;
    const baseSubtotal = canonicalItem.baseUnitPrice * quantity;
    const addOnSubtotal = canonicalItem.addOnTotal * quantity;
    const lineSubtotal = roundMoney(baseSubtotal + addOnSubtotal);
    const lineTax = roundMoney(
      canonicalItem.baseUnitPrice * quantity * canonicalItem.taxRate / 100
      + canonicalItem.addOns.reduce((sum, addOn) => (
        sum + addOn.totalPrice * quantity * addOn.taxRate / 100
      ), 0),
    );
    return {
      lineId: requested.orderItemId,
      finishedGoodId: product.id,
      finishedGoodCode: product.code,
      itemName: product.displayName || product.name || product.code,
      categoryId: product.posCategoryCode || 'MISC',
      categoryName: product.posCategoryName || 'Other',
      quantity,
      baseUnitPrice: canonicalItem.baseUnitPrice,
      unitPrice: canonicalItem.baseUnitPrice + canonicalItem.addOnTotal,
      addOns: canonicalItem.addOns,
      addOnTotal: canonicalItem.addOnTotal,
      unitPriceWithAddOns: canonicalItem.baseUnitPrice + canonicalItem.addOnTotal,
      taxRate: canonicalItem.taxRate,
      lineSubtotal,
      lineTaxable: lineSubtotal,
      lineTax,
      lineTotal: roundMoney(lineSubtotal + lineTax),
      prepStation: product.prepStation || 'NONE',
      itemType: product.itemType,
      productSnapshot: product,
      ...(canonicalItem.components ? { components: canonicalItem.components } : {}),
    };
  });
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineSubtotal, 0));
  const taxableAmount = roundMoney(items.reduce((sum, item) => sum + item.lineTaxable, 0));
  const gstTotal = roundMoney(items.reduce((sum, item) => sum + item.lineTax, 0));
  const grandTotal = roundMoney(taxableAmount + gstTotal);

  return {
    store,
    customerName: sanitized.customerName,
    orderType: sanitized.orderType,
    tableNumber: sanitized.tableNumber,
    notes: sanitized.notes,
    items,
    subtotal,
    discount: 0,
    taxableAmount,
    gstTotal,
    grandTotal,
    canonicalAddOnTotal: canonical.canonicalAddOnTotal,
  };
}

module.exports = {
  canonicalizeCustomerCheckout,
  cleanText,
  isCustomerOrderingEnabledForStore,
  isGoldenISalesFirstOrderingStore,
  resolvePublicCheckoutProduct,
  roundMoney,
  sanitizeCheckoutRequest,
};
