'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isAuthorizedStaffProfile } = require('./complimentaryAuthorizationPolicy');

const AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
const PROVIDER = 'SERVER_CANONICAL_ADD_ONS';
const MAX_ITEMS = 30;
const MAX_PARENT_QUANTITY = 20;
const MAX_ADD_ON_QUANTITY = 20;
const MAX_ADD_ON_SELECTIONS = 40;
const RETAIL_COFFEE_CODE = 'HOUSE_BLEND_BEANS_250G';
const LEGACY_EXCLUDED_PRODUCT_CODES = new Set(['ALMONDS']);
const DEFERRED_PRODUCT_CODES = new Set([
  'MUSHROOM_MELT',
  'BUTTER_COOKIE',
  'COOKIEE',
  'AMERICANO',
  'PANEER_SANDWICH',
  'BUTTER_CROISSANT',
  'V_C_BURST',
  'ORANGE_ESPRESSO_TONIC',
  'DOUBLE_CHOCOLATE_COOKIE',
  'ALMOND_CROISSANT',
]);
const BEVERAGE_GROUP_ID = 'beverage_add_on';
const EXCLUDED_BEVERAGE_CATEGORIES = new Set([
  'ESPRESSO BAR',
  'ESPESSO BAR',
  'MATCHA',
  'MANUAL BREW',
  'MANUAL BREWS',
  'HERBAL TEA',
  'SPECIALTY DRINKS',
  'SPECALITY DRINKS',
  'SEASONAL JUICES',
  'COLD CRAFTED',
  'ICE CREAM',
  'BBB',
]);
const APP_TAX_RATE_KEYS = [
  'defaultGstRate',
  'gstRate',
  'taxRate',
  'defaultTaxRate',
  'defaultGSTPercent',
  'gstPercent',
  'taxPercent',
];
const STORE_TAX_RATE_KEYS = [
  'gstRate',
  'taxRate',
  'defaultGstRate',
  'defaultTaxRate',
  'gstPercent',
  'taxPercent',
];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveTaxRate(data, keys) {
  if (!data || typeof data !== 'object') return 0;
  for (const key of keys) {
    const rate = finiteNumber(data[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function storeTaxRate(store, gstConfig) {
  const overrides = gstConfig?.storeOverrides;
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const override = finiteNumber(overrides[store.id] || overrides[store.code]);
    if (override > 0) return override;
  }
  return positiveTaxRate(store, STORE_TAX_RATE_KEYS)
    || positiveTaxRate(gstConfig, APP_TAX_RATE_KEYS);
}

function normalizeCategory(value) {
  return cleanText(value, 120)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function uniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map(entry => cleanText(entry, 80))
      .filter(Boolean),
  )];
}

function isAvailableAtStore(product, storeId) {
  return Array.isArray(product.availableStoreIds)
    && product.availableStoreIds.includes(storeId);
}

function isRetailCoffee(product) {
  const code = cleanText(product.code, 80).toUpperCase();
  return code === RETAIL_COFFEE_CODE;
}

function isHardExcludedProduct(product) {
  const code = cleanText(product.code, 80).toUpperCase();
  return isRetailCoffee(product)
    || LEGACY_EXCLUDED_PRODUCT_CODES.has(code)
    || DEFERRED_PRODUCT_CODES.has(code);
}

function isExcludedBeverageCategory(product) {
  const category = normalizeCategory(
    product.posCategoryName
    || product.categoryName
    || product.category
    || product.menuType
    || product.department,
  );
  return EXCLUDED_BEVERAGE_CATEGORIES.has(category);
}

function isExcludedProduct(product) {
  return isHardExcludedProduct(product) || isExcludedBeverageCategory(product);
}

function sanitizeSelections(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ADD_ON_SELECTIONS) {
    fail('invalid-argument', 'One or more selected add-ons are invalid.');
  }
  const merged = new Map();
  for (const selection of value) {
    const groupId = cleanText(selection?.groupId, 80);
    const optionId = cleanText(selection?.optionId, 80);
    const quantity = Number(selection?.quantity);
    if (
      !groupId
      || !optionId
      || !Number.isInteger(quantity)
      || quantity <= 0
      || quantity > MAX_ADD_ON_QUANTITY
    ) {
      fail('invalid-argument', 'One or more selected add-ons are invalid.');
    }
    const key = `${groupId}:${optionId}`;
    const existing = merged.get(key);
    const mergedQuantity = (existing?.quantity || 0) + quantity;
    if (mergedQuantity > MAX_ADD_ON_QUANTITY) {
      fail('invalid-argument', 'One or more selected add-on quantities are invalid.');
    }
    merged.set(key, { groupId, optionId, quantity: mergedQuantity });
  }
  return [...merged.values()].sort((left, right) => (
    left.groupId.localeCompare(right.groupId)
    || left.optionId.localeCompare(right.optionId)
  ));
}

function sanitizeCartItems(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    fail('invalid-argument', 'Please submit between 1 and 30 cart items.');
  }
  const orderItemIds = new Set();
  return value.map(item => {
    const orderItemId = cleanText(item?.orderItemId, 120);
    const parentProductId = cleanText(item?.parentProductId, 120);
    const parentProductCode = cleanText(item?.parentProductCode, 80);
    const quantity = Number(item?.quantity);
    if (
      !orderItemId
      || orderItemIds.has(orderItemId)
      || !parentProductId
      || !parentProductCode
      || !Number.isInteger(quantity)
      || quantity <= 0
      || quantity > MAX_PARENT_QUANTITY
    ) {
      fail('invalid-argument', 'One or more cart items are invalid.');
    }
    orderItemIds.add(orderItemId);
    return {
      orderItemId,
      parentProductId,
      parentProductCode,
      quantity,
      selectedAddOns: sanitizeSelections(item?.selectedAddOns),
    };
  });
}

function optionInventorySnapshot(option) {
  const inventoryItemType = cleanText(option.inventoryItemType, 40);
  const inventoryItemCode = cleanText(option.inventoryItemCode, 80);
  const consumptionQuantity = finiteNumber(option.consumptionQuantity);
  const consumptionUnit = cleanText(option.consumptionUnit, 20);
  const configured = ['RAW_INGREDIENT', 'PREP_ITEM', 'PACKAGING'].includes(inventoryItemType)
    && inventoryItemCode
    && consumptionQuantity > 0
    && consumptionUnit;
  return configured ? {
    inventoryTrackingStatus: 'CONFIGURED',
    inventoryItemType,
    inventoryItemCode,
    consumptionQuantity,
    consumptionUnit,
  } : {
    inventoryTrackingStatus: 'NOT_CONFIGURED',
  };
}

function canonicalizeRequestedCart({
  storeId,
  store,
  gstConfig,
  requestedItems,
  productsById,
  groupsById,
}) {
  const fallbackTaxRate = storeTaxRate({ id: storeId, ...store }, gstConfig);
  const canonicalItems = {};
  let canonicalAddOnTotal = 0;

  for (const requestedItem of requestedItems) {
    const product = productsById[requestedItem.parentProductId];
    if (!product) fail('failed-precondition', 'One or more products are no longer available.');
    const productCode = cleanText(product.code || requestedItem.parentProductId, 80);
    if (productCode !== requestedItem.parentProductCode) {
      fail('failed-precondition', 'One or more product references changed. Refresh the menu and try again.');
    }
    if (
      product.isActive !== true
      || product.isSellable !== true
      || product.isAvailable === false
      || !isAvailableAtStore(product, storeId)
    ) {
      fail('failed-precondition', 'One or more products are no longer available at this store.');
    }

    const configuredGroupIds = uniqueStrings(product.addOnGroupIds);
    const selectedGroupIds = new Set(requestedItem.selectedAddOns.map(selection => selection.groupId));
    if (requestedItem.selectedAddOns.length > 0 && isHardExcludedProduct(product)) {
      fail('failed-precondition', 'Add-ons are not available for this product.');
    }
    for (const selectedGroupId of selectedGroupIds) {
      if (!configuredGroupIds.includes(selectedGroupId)) {
        if (
          selectedGroupId === BEVERAGE_GROUP_ID
          && isExcludedBeverageCategory(product)
        ) {
          fail('failed-precondition', 'Beverage add-ons are not available for this product category.');
        }
        fail('failed-precondition', 'One or more selected add-on groups do not belong to this product.');
      }
    }

    const selectionsByGroup = new Map();
    for (const selection of requestedItem.selectedAddOns) {
      if (!selectionsByGroup.has(selection.groupId)) selectionsByGroup.set(selection.groupId, []);
      selectionsByGroup.get(selection.groupId).push(selection);
    }

    const canonicalAddOns = [];
    if (!isHardExcludedProduct(product)) {
      for (const groupId of configuredGroupIds) {
        const group = groupsById[groupId];
        const requestedForGroup = selectionsByGroup.get(groupId) || [];
        if (!group || group.isActive !== true) {
          if (requestedForGroup.length > 0) {
            fail('failed-precondition', 'One or more selected add-on groups are inactive.');
          }
          continue;
        }

        const selectionCount = requestedForGroup.reduce((sum, selection) => sum + selection.quantity, 0);
        const minimum = Math.max(0, finiteNumber(group.minimumSelections));
        const maximum = group.maximumSelections === null || group.maximumSelections === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(minimum, finiteNumber(group.maximumSelections));
        if (selectionCount < minimum || selectionCount > maximum) {
          fail('failed-precondition', `Selected add-ons for ${cleanText(group.name, 120) || 'this item'} are invalid.`);
        }

        const optionsById = new Map(
          (Array.isArray(group.options) ? group.options : [])
            .map(option => [cleanText(option?.id, 80), option])
            .filter(([optionId]) => optionId),
        );
        for (const selection of requestedForGroup) {
          const option = optionsById.get(selection.optionId);
          if (!option || option.isActive !== true) {
            fail('failed-precondition', 'One or more selected add-on options are inactive or unavailable.');
          }
          const unitPrice = Math.max(0, finiteNumber(option.price));
          const optionTaxRate = positiveTaxRate(option, ITEM_TAX_RATE_KEYS)
            || positiveTaxRate(product, ITEM_TAX_RATE_KEYS)
            || fallbackTaxRate;
          canonicalAddOns.push({
            groupId,
            groupName: cleanText(group.name, 120),
            optionId: cleanText(option.id, 80),
            optionName: cleanText(option.name, 120),
            quantity: selection.quantity,
            unitPrice,
            totalPrice: unitPrice * selection.quantity,
            taxRate: optionTaxRate,
            ...optionInventorySnapshot(option),
          });
        }
      }
    }

    canonicalAddOns.sort((left, right) => (
      left.groupId.localeCompare(right.groupId)
      || left.optionId.localeCompare(right.optionId)
    ));
    const addOnTotal = canonicalAddOns.reduce((sum, addOn) => sum + addOn.totalPrice, 0);
    canonicalAddOnTotal += addOnTotal * requestedItem.quantity;
    canonicalItems[requestedItem.orderItemId] = {
      orderItemId: requestedItem.orderItemId,
      parentProductId: requestedItem.parentProductId,
      parentProductCode: productCode,
      quantity: requestedItem.quantity,
      baseUnitPrice: Math.max(0, finiteNumber(product.salePrice)),
      taxRate: positiveTaxRate(product, ITEM_TAX_RATE_KEYS) || fallbackTaxRate,
      addOns: canonicalAddOns,
      addOnTotal,
    };
  }

  return { canonicalItems, canonicalAddOnTotal };
}

function createPosAddOnAuthorizationFunction({ admin, db, region }) {
  return onCall({ region }, async request => {
    const staffUid = request.auth?.uid;
    if (!staffUid) fail('unauthenticated', 'Staff sign-in is required.');

    const storeId = cleanText(request.data?.storeId, 80);
    const orderId = cleanText(request.data?.orderId, 120);
    const requestedOrderNumber = cleanText(request.data?.orderNumber, 120) || null;
    const requestedItems = sanitizeCartItems(request.data?.items);
    if (!storeId || !orderId) fail('invalid-argument', 'Store and order references are required.');

    const [staffSnapshot, storeSnapshot, gstSnapshot] = await Promise.all([
      db.collection('users').doc(staffUid).get(),
      db.collection('stores').doc(storeId).get(),
      db.collection('appSettings').doc('gstConfig').get(),
    ]);
    if (!staffSnapshot.exists) fail('permission-denied', 'Active staff profile is required.');
    const staff = staffSnapshot.data() || {};
    if (!isAuthorizedStaffProfile(staff, storeId)) {
      fail('permission-denied', 'This staff account cannot authorize add-ons at the selected store.');
    }
    if (!storeSnapshot.exists || storeSnapshot.data()?.isActive !== true) {
      fail('failed-precondition', 'The selected store is not active.');
    }

    const productIds = [...new Set(requestedItems.map(item => item.parentProductId))];
    const productSnapshots = await Promise.all(
      productIds.map(productId => db.collection('finishedGoods').doc(productId).get()),
    );
    const productsById = Object.fromEntries(
      productSnapshots.filter(snapshot => snapshot.exists).map(snapshot => [
        snapshot.id,
        { id: snapshot.id, ...snapshot.data() },
      ]),
    );
    const groupIds = [...new Set(
      Object.values(productsById).flatMap(product => uniqueStrings(product.addOnGroupIds)),
    )];
    const groupSnapshots = await Promise.all(
      groupIds.map(groupId => db.collection('addOnGroups').doc(groupId).get()),
    );
    const groupsById = Object.fromEntries(
      groupSnapshots.filter(snapshot => snapshot.exists).map(snapshot => [
        snapshot.id,
        { id: snapshot.id, ...snapshot.data() },
      ]),
    );

    const { canonicalItems, canonicalAddOnTotal } = canonicalizeRequestedCart({
      storeId,
      store: { id: storeSnapshot.id, ...storeSnapshot.data() },
      gstConfig: gstSnapshot.exists ? gstSnapshot.data() : null,
      requestedItems,
      productsById,
      groupsById,
    });
    const createdAt = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(createdAt.toMillis() + AUTHORIZATION_TTL_MS);
    const authorizationRef = db.collection('posAddOnAuthorizations').doc();
    const staffName = cleanText(
      staff.displayName || staff.name || request.auth.token?.name || 'Staff',
      120,
    );
    await authorizationRef.create({
      staffUid,
      staffName,
      storeId,
      orderId,
      orderNumber: requestedOrderNumber,
      canonicalItems,
      canonicalAddOnTotal,
      provider: PROVIDER,
      createdAt,
      expiresAt,
      used: false,
    });

    return {
      authorizationId: authorizationRef.id,
      canonicalItems,
      canonicalAddOnTotal,
      expiresAt: expiresAt.toDate().toISOString(),
    };
  });
}

module.exports = {
  AUTHORIZATION_TTL_MS,
  PROVIDER,
  canonicalizeRequestedCart,
  createPosAddOnAuthorizationFunction,
  isExcludedBeverageCategory,
  isExcludedProduct,
  isHardExcludedProduct,
  isRetailCoffee,
  normalizeCategory,
  sanitizeCartItems,
};
