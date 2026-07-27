'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const {
  canonicalizeRequestedCart,
  sanitizeCartItems,
} = require('./posAddOnAuthorization');

const MAX_NAME_LENGTH = 80;
const MAX_NOTE_LENGTH = 200;
const MAX_TABLE_LENGTH = 20;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
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

async function canonicalizeCustomerCheckout({ db, data, sessionId }) {
  const sanitized = sanitizeCheckoutRequest(data, sessionId);
  const store = await resolveStore(db, sanitized.storeId, sanitized.storeCode);
  if (store.isActive !== true || store.onlineOrderingEnabled === false) {
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

  const resolvedProducts = await Promise.all(sanitized.requestedItems.map(item => (
    resolveFinishedGood(db, item.parentProductId, item.parentProductCode)
  )));
  const requestedItems = sanitized.requestedItems.map((item, index) => ({
    ...item,
    parentProductId: resolvedProducts[index].id,
    parentProductCode: resolvedProducts[index].code,
  }));
  for (const item of requestedItems) {
    const publicAvailability = availabilityItems[item.parentProductCode];
    if (publicAvailability?.available === false) {
      fail('failed-precondition', 'Some items are currently unavailable. Please update your basket.');
    }
  }

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
  const canonical = canonicalizeRequestedCart({
    storeId: store.id,
    store,
    gstConfig: gstSnapshot.exists ? gstSnapshot.data() : null,
    requestedItems,
    productsById,
    groupsById,
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
  roundMoney,
  sanitizeCheckoutRequest,
};
