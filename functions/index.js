'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { createParseSupplierInvoiceDraft } = require('./invoiceDraft');
const { createComplimentaryAuthorizationFunction } = require('./complimentaryAuthorization');
const { createPosAddOnAuthorizationFunction } = require('./posAddOnAuthorization');
const { createFranchiseSalesFunctions } = require('./franchiseSales');
const { createReportingFunctions } = require('./reporting');
const { createRazorpayPaymentFirstFunctions } = require('./razorpayPaymentFirst');
const { createCustomerMyUsualFunctions } = require('./customerMyUsual');
const { createPosRazorpayFunctions } = require('./posRazorpay');
const { createGetEffectivePosProductsFunction } = require('./effectiveProductCatalog');
const { createStoreProvisioningFunctions } = require('./storeProvisioning');
const { createBondLoyaltyService } = require('./bondLoyalty');
const { createKotStatusAggregationHandler } = require('./kotStatusAggregation');
const {
  customerOrderLineMoney,
  customerOrderTotals,
} = require('./customerOrderMoney');
const {
  CompositeProductPolicyError,
  collectRequiredComponentFinishedGoodIds,
  resolveCanonicalCompositeComponents,
  allowsDeferredComponentBom,
} = require('./compositeProductPolicy');
const { resolvePublicCheckoutProduct } = require('./customerCheckoutCanonicalization');
const {
  STORE_ITEM_CONFIG_COLLECTION,
  resolveEffectiveProduct,
  storeItemConfigDocId,
} = require('./storeItemConfigPolicy');

admin.initializeApp();

const db = admin.firestore();
const REGION = 'us-central1';
const MAX_ITEMS = 30;
const MAX_QUANTITY = 20;
const MAX_NOTE_LENGTH = 200;
const MAX_NAME_LENGTH = 80;
const MAX_TABLE_LENGTH = 20;
const PHONE_PATTERN = /^[6-9][0-9]{9}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

exports.parseSupplierInvoiceDraft = createParseSupplierInvoiceDraft({ admin, db, region: REGION });
exports.createComplimentaryAuthorization = createComplimentaryAuthorizationFunction({ admin, db, region: REGION });
exports.authorizePosAddOns = createPosAddOnAuthorizationFunction({ admin, db, region: REGION });
exports.getEffectivePosProducts = createGetEffectivePosProductsFunction({ db, region: REGION });

const franchiseSalesFunctions = createFranchiseSalesFunctions({ admin, db, region: REGION });
exports.manageFranchiseViewer = franchiseSalesFunctions.manageFranchiseViewer;
exports.getFranchiseDailySales = franchiseSalesFunctions.getFranchiseDailySales;

const reportingFunctions = createReportingFunctions({ admin, db, region: REGION });
exports.getReportingSummary = reportingFunctions.getReportingSummary;
exports.getReportingRows = reportingFunctions.getReportingRows;
exports.exportReportingData = reportingFunctions.exportReportingData;

const storeProvisioningFunctions = createStoreProvisioningFunctions({ admin, db, region: REGION });
exports.previewStoreProvisioning = storeProvisioningFunctions.previewStoreProvisioning;
exports.createStoreFromTemplate = storeProvisioningFunctions.createStoreFromTemplate;
exports.updateStoreConfiguration = storeProvisioningFunctions.updateStoreConfiguration;
exports.enableInternalPosTest = storeProvisioningFunctions.enableInternalPosTest;
exports.markInternalPosTestPassed = storeProvisioningFunctions.markInternalPosTestPassed;
exports.saveLocationOpeningStock = storeProvisioningFunctions.saveLocationOpeningStock;
exports.saveLocationStaffAssignments = storeProvisioningFunctions.saveLocationStaffAssignments;
exports.setPosLaunchException = storeProvisioningFunctions.setPosLaunchException;
exports.activateStore = storeProvisioningFunctions.activateStore;
exports.setStoreCustomerOrdering = storeProvisioningFunctions.setStoreCustomerOrdering;

const posRazorpayFunctions = createPosRazorpayFunctions({ admin, db, region: REGION });
exports.createPosRazorpaySession = posRazorpayFunctions.createPosRazorpaySession;
exports.getPosRazorpayStatus = posRazorpayFunctions.getPosRazorpayStatus;
exports.cancelPosRazorpaySession = posRazorpayFunctions.cancelPosRazorpaySession;
exports.requestPosRazorpayRefund = posRazorpayFunctions.requestPosRazorpayRefund;
exports.posRazorpayWebhook = posRazorpayFunctions.posRazorpayWebhook;

const bondLoyaltyService = createBondLoyaltyService({ admin, db });
const handleKotStatusAggregation = createKotStatusAggregationHandler({ admin, db });

// KOT users can read only their assigned station. Aggregate sibling component
// tickets with server authority after the station-scoped status write commits.
exports.aggregateKotOrderStatus = onDocumentUpdated({
  document: 'kotItems/{kotId}',
  region: REGION,
  retry: true,
}, event => handleKotStatusAggregation({
  kotId: event.params.kotId,
  before: event.data.before.data(),
  after: event.data.after.data(),
}));

// Loyalty observes authoritative records only after the order/KOT transactions have
// committed. Trigger failure therefore cannot roll back payment, KOT, stock or reports.
exports.processBondOrderLoyalty = onDocumentWritten({
  document: 'orders/{orderId}',
  region: REGION,
  retry: true,
}, event => bondLoyaltyService.handleOrderWrite({
  orderId: event.params.orderId,
  before: event.data?.before?.exists ? event.data.before.data() : null,
  after: event.data?.after?.exists ? event.data.after.data() : null,
}));

exports.processBondPickupLoyalty = onDocumentUpdated({
  document: 'kotItems/{kotId}',
  region: REGION,
  retry: true,
}, event => bondLoyaltyService.processKotFulfillment({
  kotId: event.params.kotId,
  before: event.data.before.data(),
  after: event.data.after.data(),
}));

exports.getCustomerBondSummary = onCall({ region: REGION }, async request => {
  try {
    return await bondLoyaltyService.getCustomerLoyaltySummaryHandler(request);
  } catch (error) {
    if (error?.code === 'unauthenticated') throw new HttpsError('unauthenticated', error.message);
    throw error;
  }
});

const razorpayCheckoutFunctions = createRazorpayPaymentFirstFunctions({ admin, db, region: REGION });
exports.resolveCustomerProfile = razorpayCheckoutFunctions.resolveCustomerProfile;
exports.updateCustomerProfile = razorpayCheckoutFunctions.updateCustomerProfile;
exports.createCustomerCheckoutSession = razorpayCheckoutFunctions.createCustomerCheckoutSession;
exports.verifyCustomerRazorpayPayment = razorpayCheckoutFunctions.verifyCustomerRazorpayPayment;
exports.listMyCustomerOrders = razorpayCheckoutFunctions.listMyCustomerOrders;
exports.acceptPaidRazorpayOrder = razorpayCheckoutFunctions.acceptPaidRazorpayOrder;
exports.cancelAndRefundRazorpayOrder = razorpayCheckoutFunctions.cancelAndRefundRazorpayOrder;
exports.razorpayWebhook = razorpayCheckoutFunctions.razorpayWebhook;

// "My Usual" lives in the customer's own private profile. These three callables are
// the only path to it — customerProfiles is closed to every client in firestore.rules.
const customerMyUsualFunctions = createCustomerMyUsualFunctions({ admin, db, region: REGION });
exports.getCustomerMyUsual = customerMyUsualFunctions.getCustomerMyUsual;
exports.saveCustomerMyUsual = customerMyUsualFunctions.saveCustomerMyUsual;
exports.deleteCustomerMyUsual = customerMyUsualFunctions.deleteCustomerMyUsual;

function publicStatusMessage(status) {
  if (status === 'PENDING') return 'Your order request has been received. The store will confirm shortly.';
  if (status === 'ACCEPTED_AWAITING_PAYMENT') return 'Your order is accepted. Complete payment to begin preparation.';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment was received, but the store must review fulfilment before preparation.';
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Your order has been accepted and is being prepared.';
  if (status === 'PREPARING') return 'Your order is being prepared.';
  if (status === 'READY') return 'Your order is ready for pickup.';
  if (status === 'SERVED') return 'Your order has been completed.';
  if (status === 'REJECTED') return 'Sorry, the store could not accept this order.';
  if (status === 'CANCELLED') return 'Sorry, this order could not be completed.';
  if (status === 'NEEDS_ATTENTION') return 'The store is reviewing your order.';
  return 'We are checking your order status.';
}

function fail(code, message) {
  throw new HttpsError(code, message);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickTaxRate(data, keys) {
  if (!data || typeof data !== 'object') return 0;
  for (const key of keys) {
    const rate = toNumber(data[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function normalizeStoreOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [key, rawRate]) => {
    const rate = toNumber(rawRate);
    if (rate > 0) acc[key] = rate;
    return acc;
  }, {});
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function verifiedCustomerUidForPhone(request, customerPhone) {
  const uid = cleanText(request.auth?.uid, 128);
  const provider = cleanText(request.auth?.token?.firebase?.sign_in_provider, 80);
  const verifiedPhone = normalizePhone(request.auth?.token?.phone_number);
  return uid && provider === 'phone' && verifiedPhone === normalizePhone(customerPhone) ? uid : null;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function generateTrackingToken() {
  const token = randomBytes(24).toString('base64url');
  if (!TOKEN_PATTERN.test(token)) fail('internal', 'Could not generate secure tracking token.');
  return token;
}

function buildPublicOrderReference(trackingToken) {
  return `CBWEB-${trackingToken.slice(0, 10).toUpperCase()}`;
}

function hashId(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requestHash(payload) {
  return hashId(JSON.stringify(payload));
}

function isStoreAvailable(item, storeId) {
  return Array.isArray(item.availableStoreIds) && item.availableStoreIds.includes(storeId);
}

function isGoldenISalesFirstOrderingStore(store) {
  return store?.id === 'GOLDEN_I'
    && String(store.code || store.storeCode || '').trim() === 'GOLDEN_I';
}

function isCustomerOrderingEnabledForStore(store) {
  if (!isGoldenISalesFirstOrderingStore(store)) return store?.onlineOrderingEnabled !== false;
  return store.isActive === true
    && store.posEnabled === true
    && store.customerOrderingEnabled === true
    && store.onlineOrderingEnabled === true
    && store.publicOrderingEnabled === true
    && store.acceptingOrders === true
    && store.isAcceptingOrders === true;
}

function isItemPubliclyOrderable(item, store, availability) {
  if (!item || typeof item !== 'object') return false;
  if (!isStoreAvailable(item, store.id)) return false;
  if (!item.isActive || !item.isSellable || item.isAvailable === false) return false;
  if (item.onlineOrderingEnabled === false || item.customerOrderingEnabled === false) return false;
  if (toNumber(item.salePrice) <= 0) return false;
  if (!['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) return false;
  if (
    availability?.available === false
    && !(isGoldenISalesFirstOrderingStore(store) && availability.publicStatus === 'SETUP_INCOMPLETE')
  ) return false;
  return true;
}

function prepWindowLabel(minutes) {
  const safeMinutes = minutes && minutes > 0 ? minutes : 20;
  const min = Math.max(5, safeMinutes - 5);
  return `${min}-${safeMinutes} min`;
}

function storeOnlineMessage(store) {
  if (store.onlineOrderingMessage && String(store.onlineOrderingMessage).trim()) {
    return String(store.onlineOrderingMessage).trim();
  }
  if (store.estimatedPrepMinutes && store.estimatedPrepMinutes > 0) {
    return `Pickup available in ${prepWindowLabel(store.estimatedPrepMinutes)}`;
  }
  return 'Pickup available soon after store confirmation.';
}

function calculateStoreTaxRate(store, gstConfig) {
  const overrides = normalizeStoreOverrides(gstConfig?.storeOverrides);
  const override = overrides[store.id] || overrides[store.code];
  if (override > 0) return override;
  const storeRate = pickTaxRate(store, STORE_TAX_RATE_KEYS);
  if (storeRate > 0) return storeRate;
  return pickTaxRate(gstConfig, APP_TAX_RATE_KEYS);
}

function itemTaxRate(item, fallbackRate) {
  return pickTaxRate(item, ITEM_TAX_RATE_KEYS) || fallbackRate;
}

function sanitizeRequestedAddOns(addOns) {
  if (addOns === undefined) return [];
  if (!Array.isArray(addOns) || addOns.length > 40) {
    fail('invalid-argument', 'One or more selected add-ons are invalid.');
  }
  const merged = new Map();
  addOns.forEach((addOn) => {
    const groupId = cleanText(addOn?.groupId, 80);
    const optionId = cleanText(addOn?.optionId, 80);
    const quantity = Number(addOn?.quantity);
    if (!groupId || !optionId || !Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
      fail('invalid-argument', 'One or more selected add-ons are invalid.');
    }
    const key = `${groupId}:${optionId}`;
    const existing = merged.get(key);
    merged.set(key, {
      groupId,
      optionId,
      quantity: (existing?.quantity || 0) + quantity,
    });
  });
  return [...merged.values()].sort((a, b) => (
    a.groupId.localeCompare(b.groupId) || a.optionId.localeCompare(b.optionId)
  ));
}

function sanitizeItemRequest(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    fail('invalid-argument', 'Please add between 1 and 30 items.');
  }

  const merged = new Map();
  items.forEach((item) => {
    const itemCode = cleanText(item?.itemCode || item?.finishedGoodCode || item?.code, 80);
    const quantity = Number(item?.quantity);
    if (!itemCode) fail('invalid-argument', 'One or more items are invalid.');
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
      fail('invalid-argument', 'Item quantity is invalid.');
    }
    const addOns = sanitizeRequestedAddOns(item?.addOns);
    const key = `${itemCode}:${JSON.stringify(addOns)}`;
    const existing = merged.get(key);
    merged.set(key, {
      itemCode,
      addOns,
      quantity: (existing?.quantity || 0) + quantity,
    });
  });

  return [...merged.values()];
}

function canonicalAddOnsForItem(item, requestedAddOns, publicGroups, privateGroups, fallbackTaxRate) {
  const allowedGroupIds = new Set(Array.isArray(item.addOnGroupIds) ? item.addOnGroupIds : []);
  const optionIdsByGroup = item.addOnOptionIdsByGroup
    && typeof item.addOnOptionIdsByGroup === 'object'
    && !Array.isArray(item.addOnOptionIdsByGroup)
    ? item.addOnOptionIdsByGroup
    : {};
  const requestedByGroup = new Map();
  requestedAddOns.forEach((requested) => {
    if (!allowedGroupIds.has(requested.groupId)) {
      fail('failed-precondition', 'One or more selected add-ons are unavailable.');
    }
    const allowedOptionIds = new Set(
      Array.isArray(optionIdsByGroup[requested.groupId])
        ? optionIdsByGroup[requested.groupId].filter((optionId) => typeof optionId === 'string')
        : [],
    );
    if (!allowedOptionIds.has(requested.optionId)) {
      fail('failed-precondition', 'One or more selected add-ons are unavailable for this product.');
    }
    if (!requestedByGroup.has(requested.groupId)) requestedByGroup.set(requested.groupId, []);
    requestedByGroup.get(requested.groupId).push(requested);
  });

  const result = [];
  for (const groupId of allowedGroupIds) {
    const allowedOptionIds = new Set(
      Array.isArray(optionIdsByGroup[groupId])
        ? optionIdsByGroup[groupId].filter((optionId) => typeof optionId === 'string')
        : [],
    );
    if (allowedOptionIds.size === 0) {
      if (requestedByGroup.has(groupId)) fail('failed-precondition', 'One or more selected add-ons are unavailable.');
      continue;
    }
    const publicGroup = publicGroups[groupId];
    const privateGroup = privateGroups[groupId];
    if (!publicGroup || publicGroup.isActive === false || !privateGroup || privateGroup.isActive === false) {
      if (requestedByGroup.has(groupId)) fail('failed-precondition', 'One or more selected add-ons are unavailable.');
      continue;
    }
    const requestedForGroup = requestedByGroup.get(groupId) || [];
    const selectionCount = requestedForGroup.reduce((sum, selected) => sum + selected.quantity, 0);
    const minimum = Math.max(0, toNumber(privateGroup.minimumSelections));
    const maximum = privateGroup.maximumSelections === null || privateGroup.maximumSelections === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(minimum, toNumber(privateGroup.maximumSelections));
    if (
      privateGroup.selectionMode === 'EXACT_DISTINCT'
      && (requestedForGroup.some((selected) => selected.quantity !== 1)
        || new Set(requestedForGroup.map((selected) => selected.optionId)).size !== requestedForGroup.length)
    ) {
      fail('failed-precondition', `Select ${minimum} different options for ${privateGroup.name || 'this item'}.`);
    }
    if (selectionCount < minimum || selectionCount > maximum) {
      fail('failed-precondition', `Selected add-ons for ${privateGroup.name || 'this item'} are invalid.`);
    }
    const publicOptions = new Map((publicGroup.options || []).map((option) => [option.id, option]));
    const privateOptions = new Map((privateGroup.options || []).map((option) => [option.id, option]));
    requestedForGroup.forEach((requested) => {
      const publicOption = publicOptions.get(requested.optionId);
      const option = privateOptions.get(requested.optionId);
      if (!publicOption || publicOption.isActive === false || !option || option.isActive === false) {
        fail('failed-precondition', 'One or more selected add-ons are unavailable.');
      }
      const unitPrice = Math.max(0, toNumber(option.price));
      if (unitPrice !== Math.max(0, toNumber(publicOption.price))) {
        fail('failed-precondition', 'Add-on pricing is being refreshed. Please update your basket.');
      }
      const taxRate = itemTaxRate(option, fallbackTaxRate);
      const inventoryConfigured = ['RAW_INGREDIENT', 'PREP_ITEM', 'PACKAGING'].includes(option.inventoryItemType)
        && cleanText(option.inventoryItemCode, 80)
        && toNumber(option.consumptionQuantity) > 0
        && cleanText(option.consumptionUnit, 20);
      result.push({
        groupId,
        groupName: privateGroup.name,
        optionId: option.id,
        optionName: option.name,
        quantity: requested.quantity,
        unitPrice,
        totalPrice: unitPrice * requested.quantity,
        taxRate,
        inventoryTrackingStatus: inventoryConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
        ...(inventoryConfigured ? {
          inventoryItemType: option.inventoryItemType,
          inventoryItemCode: cleanText(option.inventoryItemCode, 80),
          consumptionQuantity: toNumber(option.consumptionQuantity),
          consumptionUnit: cleanText(option.consumptionUnit, 20),
        } : {}),
      });
    });
  }
  return result;
}

function buildOnlineOrderPayload(args) {
  const {
    store,
    orderType,
    tableNumber,
    customerName,
    customerPhone,
    notes,
    items,
    totals,
    trackingToken,
    publicOrderReference,
    paymentProvider,
    customerUid,
    customerOrderSubmissionId,
  } = args;

  return {
    storeId: store.id,
    storeName: store.name,
    customerName,
    customerPhone,
    orderType,
    ...(orderType === 'DINE_IN' ? { tableNumber } : {}),
    notes,
    items,
    subtotal: totals.subtotal,
    taxableAmount: totals.taxableAmount,
    gstTotal: totals.gstTotal,
    grandTotal: totals.grandTotal,
    status: 'PENDING',
    source: 'CUSTOMER_WEB',
    ...(customerUid ? { customerUid } : {}),
    customerOrderSubmissionId,
    paymentProvider,
    paymentMethod: paymentProvider === 'RAZORPAY' ? 'ONLINE' : 'PAY_AT_COUNTER',
    paymentStatus: 'NOT_STARTED',
    trackingToken,
    publicOrderReference,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function buildPublicTrackingPayload(args) {
  const { onlineOrder, trackingToken, publicOrderReference } = args;
  return {
    trackingToken,
    publicOrderReference,
    storeName: onlineOrder.storeName,
    orderType: onlineOrder.orderType,
    ...(onlineOrder.orderType === 'DINE_IN' && onlineOrder.tableNumber ? { tableNumber: onlineOrder.tableNumber } : {}),
    items: onlineOrder.items.map((item) => ({
      itemName: item.itemName,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
      addOns: (item.addOns || []).map((addOn) => ({
        groupName: addOn.groupName,
        optionName: addOn.optionName,
        quantity: addOn.quantity,
        unitPrice: addOn.unitPrice,
        totalPrice: addOn.totalPrice,
      })),
    })),
    subtotal: onlineOrder.subtotal,
    gstTotal: onlineOrder.gstTotal,
    total: onlineOrder.grandTotal,
    publicStatus: 'PENDING',
    paymentProvider: onlineOrder.paymentProvider,
    paymentStatus: onlineOrder.paymentStatus,
    submittedAt: FieldValue.serverTimestamp(),
    customerStatusMessage: publicStatusMessage('PENDING'),
  };
}

function responseFromPublicPayload(payload) {
  return {
    trackingToken: payload.trackingToken,
    publicOrderReference: payload.publicOrderReference,
    storeName: payload.storeName,
    orderType: payload.orderType,
    tableNumber: payload.tableNumber || null,
    items: payload.items,
    subtotal: payload.subtotal,
    gstTotal: payload.gstTotal,
    total: payload.total,
    status: payload.publicStatus,
    paymentProvider: payload.paymentProvider,
    paymentStatus: payload.paymentStatus,
    customerStatusMessage: payload.customerStatusMessage,
  };
}

exports.submitCustomerOrder = onCall({ region: REGION }, async (request) => {
  const data = request.data || {};
  const storeCode = cleanText(data.storeCode, 40);
  const customerName = cleanText(data.customerName, MAX_NAME_LENGTH);
  const customerPhone = normalizePhone(data.customerPhone);
  const orderType = data.orderType === 'DINE_IN' ? 'DINE_IN' : 'PICKUP';
  const tableNumber = orderType === 'DINE_IN' ? cleanText(data.tableNumber, MAX_TABLE_LENGTH) : '';
  const notes = cleanText(data.notes, MAX_NOTE_LENGTH);
  const clientIdempotencyKey = cleanText(data.clientIdempotencyKey, 200);
  if (data.paymentProvider === 'RAZORPAY') {
    fail('failed-precondition', 'Pay Online must use verified mobile checkout.');
  }
  const paymentProvider = 'PAY_AT_COUNTER';
  const customerUid = verifiedCustomerUidForPhone(request, customerPhone);
  const requestedItems = sanitizeItemRequest(data.items);

  if (!storeCode) fail('invalid-argument', 'Please select a store.');
  if (!customerName) fail('invalid-argument', 'Please enter your name.');
  if (!PHONE_PATTERN.test(customerPhone)) fail('invalid-argument', 'Please enter a valid 10-digit Indian mobile number.');
  if (orderType === 'DINE_IN' && !tableNumber) fail('invalid-argument', 'Please enter your table number.');
  if (!clientIdempotencyKey || clientIdempotencyKey.length < 12) fail('invalid-argument', 'Please retry this order request.');

  const canonicalRequest = {
    storeCode,
    customerName,
    customerPhone,
    orderType,
    tableNumber: orderType === 'DINE_IN' ? tableNumber : null,
    notes,
    items: requestedItems,
    paymentProvider,
  };
  const canonicalRequestHash = requestHash(canonicalRequest);
  const submissionId = hashId(`${storeCode}:${customerPhone}:${clientIdempotencyKey}`);
  const submissionRef = db.collection('customerOrderSubmissions').doc(submissionId);

  return db.runTransaction(async (transaction) => {
    const existingSubmission = await transaction.get(submissionRef);
    if (existingSubmission.exists) {
      const existing = existingSubmission.data();
      if (existing.requestHash !== canonicalRequestHash) {
        fail('already-exists', 'This order submission key was already used. Please refresh and try again.');
      }
      return existing.response;
    }

    const storeQuery = await transaction.get(db.collection('stores').where('code', '==', storeCode).where('isActive', '==', true).limit(1));
    if (storeQuery.empty) fail('failed-precondition', 'Selected store is not available.');
    const storeDoc = storeQuery.docs[0];
    const store = { id: storeDoc.id, ...storeDoc.data() };
    if (!isCustomerOrderingEnabledForStore(store)) fail('failed-precondition', 'Online ordering is currently unavailable for this store.');

    const availabilityRef = db.collection('publicMenuAvailability').doc(store.code);
    const gstRef = db.collection('appSettings').doc('gstConfig');
    const [availabilitySnap, gstSnap] = await Promise.all([
      transaction.get(availabilityRef),
      transaction.get(gstRef),
    ]);
    if (!availabilitySnap.exists) fail('failed-precondition', 'Menu availability is being refreshed. Please try again.');

    const availability = availabilitySnap.data() || {};
    const availabilityItems = availability.items || {};
    const menuItems = availability.menuItems || {};
    const publicAddOnGroups = availability.addOnGroups || {};
    const gstConfig = gstSnap.exists ? gstSnap.data() : null;
    const storeTaxRate = calculateStoreTaxRate(store, gstConfig);
    const requestedProductCodes = [...new Set(requestedItems.map((item) => item.itemCode))];
    const privateProductSnaps = await Promise.all(
      requestedProductCodes.map((productCode) => (
        transaction.get(db.collection('finishedGoods').doc(productCode))
      )),
    );
    if (privateProductSnaps.some((snapshot) => !snapshot.exists)) {
      fail('failed-precondition', 'One or more products are no longer available. Please update your basket.');
    }
    const privateProductsByCode = Object.fromEntries(privateProductSnaps.map((snapshot) => {
      const product = { id: snapshot.id, ...snapshot.data() };
      const productCode = cleanText(product.code || snapshot.id, 80);
      if (!requestedProductCodes.includes(productCode)) {
        fail('failed-precondition', 'One or more product references changed. Please update your basket.');
      }
      return [productCode, product];
    }));
    const storeItemConfigSnaps = await Promise.all(
      requestedProductCodes.map((productCode) => transaction.get(
        db.collection(STORE_ITEM_CONFIG_COLLECTION)
          .doc(storeItemConfigDocId(store.id, productCode)),
      )),
    );
    const checkoutProductsByCode = Object.fromEntries(requestedProductCodes.map((productCode, index) => {
      const configSnapshot = storeItemConfigSnaps[index];
      const config = configSnapshot.exists ? configSnapshot.data() : null;
      if (config && (config.storeId !== store.id || config.itemCode !== productCode)) {
        fail('failed-precondition', 'Menu configuration is being refreshed. Please try again.');
      }
      const effectiveProduct = resolveEffectiveProduct(privateProductsByCode[productCode], config);
      return [productCode, resolvePublicCheckoutProduct({
        product: effectiveProduct,
        publicAvailability: availabilityItems[productCode],
        publicMenuItem: menuItems[productCode],
        store,
      })];
    }));
    const privateProductsById = Object.fromEntries(
      Object.values(checkoutProductsByCode).map((product) => [product.id, product]),
    );
    const requestedGroupIds = [...new Set(requestedItems.flatMap((requestedItem) => [
      ...(Array.isArray(menuItems[requestedItem.itemCode]?.addOnGroupIds)
        ? menuItems[requestedItem.itemCode].addOnGroupIds
        : []),
      ...(Array.isArray(checkoutProductsByCode[requestedItem.itemCode]?.addOnGroupIds)
        ? checkoutProductsByCode[requestedItem.itemCode].addOnGroupIds
        : []),
      ...requestedItem.addOns.map((addOn) => addOn.groupId),
    ]))];
    const privateGroupSnaps = await Promise.all(
      requestedGroupIds.map((groupId) => transaction.get(db.collection('addOnGroups').doc(groupId))),
    );
    const privateAddOnGroups = privateGroupSnaps.reduce((acc, snap) => {
      if (snap.exists) acc[snap.id] = { id: snap.id, ...snap.data() };
      return acc;
    }, {});

    let componentProductIds;
    try {
      componentProductIds = collectRequiredComponentFinishedGoodIds({
        products: privateProductsById,
        groupsById: privateAddOnGroups,
      });
    } catch (error) {
      if (error instanceof CompositeProductPolicyError) {
        fail('failed-precondition', error.message);
      }
      throw error;
    }
    const missingComponentProductIds = componentProductIds.filter(
      (productId) => !privateProductsById[productId],
    );
    const componentProductSnaps = await Promise.all(
      missingComponentProductIds.map((productId) => (
        transaction.get(db.collection('finishedGoods').doc(productId))
      )),
    );
    const componentConfigSnaps = await Promise.all(componentProductSnaps.map((snapshot) => (
      snapshot.exists
        ? transaction.get(db.collection(STORE_ITEM_CONFIG_COLLECTION).doc(
          storeItemConfigDocId(store.id, snapshot.data()?.code || snapshot.id),
        ))
        : Promise.resolve(null)
    )));
    const resolvedComponentProducts = componentProductSnaps
      .map((snapshot, index) => {
        if (!snapshot.exists) return null;
        const product = { id: snapshot.id, ...snapshot.data() };
        const configSnapshot = componentConfigSnaps[index];
        const config = configSnapshot?.exists ? configSnapshot.data() : null;
        if (config && (config.storeId !== store.id || config.itemCode !== product.code)) {
          fail('failed-precondition', 'Menu configuration is being refreshed. Please try again.');
        }
        return resolveEffectiveProduct(product, config);
      })
      .filter(Boolean);
    const componentProductsById = {
      ...privateProductsById,
      ...Object.fromEntries(resolvedComponentProducts
        .map((product) => [product.id, product])),
    };
    let componentsByRequestedIndex;
    try {
      componentsByRequestedIndex = requestedItems.map((requested) => (
        resolveCanonicalCompositeComponents({
          parentProduct: checkoutProductsByCode[requested.itemCode],
          requestedSelections: requested.addOns,
          groupsById: privateAddOnGroups,
          componentProductsById,
          storeId: store.id,
          allowDeferredComponentBom: allowsDeferredComponentBom(store),
        })
      ));
    } catch (error) {
      if (error instanceof CompositeProductPolicyError) {
        fail('failed-precondition', error.message);
      }
      throw error;
    }

    const onlineItems = requestedItems.map((requested, index) => {
      // The private catalogue plus private store override is authoritative. The
      // public row was already required above as an exact exposure/price gate;
      // never copy tax, names, KOT fields, or add-on assignments back from it.
      const item = checkoutProductsByCode[requested.itemCode];
      const itemAvailability = availabilityItems[requested.itemCode];
      if (!isItemPubliclyOrderable(item, store, itemAvailability)) {
        fail('failed-precondition', 'Some items are currently unavailable. Please update your basket.');
      }

      const rate = itemTaxRate(item, storeTaxRate);
      const baseUnitPrice = toNumber(item.salePrice);
      const addOns = canonicalAddOnsForItem(
        item,
        requested.addOns,
        publicAddOnGroups,
        privateAddOnGroups,
        rate,
      );
      const addOnUnitTotal = addOns.reduce((sum, addOn) => sum + addOn.totalPrice, 0);
      const money = customerOrderLineMoney({
        baseUnitPrice,
        addOnUnitTotal,
        quantity: requested.quantity,
        taxRate: rate,
        addOns,
      });
      const components = componentsByRequestedIndex[index];
      return {
        finishedGoodCode: item.code || requested.itemCode,
        itemName: item.displayName || item.name || requested.itemCode,
        categoryId: item.posCategoryCode || 'MISC',
        categoryName: item.posCategoryName || 'Other',
        quantity: requested.quantity,
        unitPrice: money.unitPrice,
        baseUnitPrice,
        addOns,
        addOnTotal: addOnUnitTotal,
        unitPriceWithAddOns: money.unitPrice,
        taxRate: rate,
        lineSubtotal: money.lineSubtotal,
        lineTaxable: money.lineTaxable,
        lineTax: money.lineTax,
        lineTotal: money.lineTotal,
        prepStation: item.prepStation || 'NONE',
        itemType: item.itemType,
        productSnapshot: item,
        ...(components.length > 0 ? { components } : {}),
      };
    });

    const { subtotal, taxableAmount, gstTotal, grandTotal } = customerOrderTotals(onlineItems);
    const trackingToken = generateTrackingToken();
    const publicOrderReference = buildPublicOrderReference(trackingToken);
    const onlineOrderRef = db.collection('onlineOrders').doc();
    const publicTrackingRef = db.collection('publicOrderTracking').doc(trackingToken);

    const totals = { subtotal, taxableAmount, gstTotal, grandTotal };
    const onlineOrder = buildOnlineOrderPayload({
      store,
      orderType,
      tableNumber,
      customerName,
      customerPhone,
      notes,
      items: onlineItems,
      totals,
      trackingToken,
      publicOrderReference,
      paymentProvider,
      customerUid,
      customerOrderSubmissionId: submissionId,
    });
    const publicTracking = buildPublicTrackingPayload({
      onlineOrder,
      trackingToken,
      publicOrderReference,
    });
    const response = {
      ...responseFromPublicPayload(publicTracking),
      estimatedPrepMinutes: store.estimatedPrepMinutes || 20,
      storeMessage: storeOnlineMessage(store),
    };

    transaction.set(onlineOrderRef, onlineOrder);
    transaction.set(publicTrackingRef, publicTracking);
    transaction.set(submissionRef, {
      requestHash: canonicalRequestHash,
      storeCode,
      storeId: store.id,
      onlineOrderId: onlineOrderRef.id,
      ...(customerUid ? { customerUid } : {}),
      trackingToken,
      publicOrderReference,
      response,
      createdAt: FieldValue.serverTimestamp(),
    });

    return response;
  });
});
