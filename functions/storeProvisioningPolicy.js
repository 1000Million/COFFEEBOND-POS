'use strict';

const { createHash } = require('node:crypto');

const STORE_CODE_PATTERN = /^[A-Z0-9_]+$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{12,120}$/;
const BAKED_BY_BOND_51_STORE_ID = 'BAKED_BY_BOND_51';
const GOLDEN_I_STORE_ID = 'GOLDEN_I';
const PROVISIONED_ONBOARDING_MODE = 'PROVISIONED';
const LEGACY_MIGRATED_ONBOARDING_MODE = 'LEGACY_MIGRATED';

const MODULES = Object.freeze({
  OPERATING: {
    id: 'OPERATING',
    label: 'Store operating configuration',
    recommended: true,
    copyMode: 'STORE_FIELDS',
  },
  MENU: {
    id: 'MENU',
    label: 'Menu configuration',
    recommended: true,
    copyMode: 'STORE_ASSIGNMENTS',
  },
  ADD_ONS: {
    id: 'ADD_ONS',
    label: 'Add-on configuration',
    recommended: true,
    copyMode: 'GLOBAL_FINISHED_GOOD_REFERENCES',
  },
  KOT: {
    id: 'KOT',
    label: 'KOT configuration',
    recommended: true,
    copyMode: 'GLOBAL_FINISHED_GOOD_REFERENCES',
  },
  INVENTORY: {
    id: 'INVENTORY',
    label: 'Inventory structure',
    recommended: true,
    copyMode: 'STORE_DOCUMENTS',
  },
  CUSTOMER_ORDERING: {
    id: 'CUSTOMER_ORDERING',
    label: 'Customer-ordering configuration',
    recommended: true,
    copyMode: 'STORE_FIELDS',
  },
  LEGAL_RECEIPT: {
    id: 'LEGAL_RECEIPT',
    label: 'Legal and receipt configuration',
    recommended: false,
    copyMode: 'STORE_FIELDS',
  },
  ITEM_OVERRIDES: {
    id: 'ITEM_OVERRIDES',
    label: 'Store item overrides',
    recommended: false,
    copyMode: 'STORE_DOCUMENTS',
  },
});

const ALL_MODULE_IDS = Object.freeze(Object.keys(MODULES));
const RECOMMENDED_MODULE_IDS = Object.freeze(
  ALL_MODULE_IDS.filter((moduleId) => MODULES[moduleId].recommended),
);

const INVENTORY_OPTIONS = Object.freeze([
  'STRUCTURE_ONLY',
  'CONFIGURED_OPENING',
  'CURRENT_STOCK_ADVANCED',
]);

const OPERATING_FIELDS = Object.freeze([
  'openingHours',
  'orderTypes',
  'posSettings',
  'receiptSettings',
  'paymentMethods',
  'discountSettings',
  'businessDaySettings',
  'inventoryPolicy',
  'estimatedPrepMinutes',
]);

const KOT_FIELDS = Object.freeze([
  'printerSettings',
  'kotSettings',
  'printerRoutingSettings',
  'ticketConfiguration',
]);

const CUSTOMER_ORDERING_FIELDS = Object.freeze([
  'pickupEnabled',
  'dineInEnabled',
  'deliveryEnabled',
  'orderingHours',
  'customerInstructions',
  'menuPauseSettings',
  'storeVisibilitySettings',
  'onlineOrderingMessage',
]);

const LEGAL_RECEIPT_FIELDS = Object.freeze([
  'legalEntityName',
  'legalName',
  'tradeName',
  'legalAddress',
  'gstin',
  'stateName',
  'stateCode',
  'gstRegistered',
  'gstRate',
  'receiptName',
  'receiptFooter',
  'invoiceNumbering',
]);

const READINESS_KEYS = Object.freeze([
  'basicDetailsComplete',
  'legalGstReviewed',
  'menuCopied',
  'productAvailabilityReviewed',
  'addOnsReviewed',
  'kotRoutingReviewed',
  'inventoryStructureCreated',
  'openingStockReviewed',
  'receiptConfigurationReviewed',
  'staffAssigned',
  'posTestCompleted',
]);

const CUSTOMER_ORDERING_READINESS_KEY = 'customerOrderingTestCompleted';

const READINESS_STEP_LABELS = Object.freeze({
  basicDetailsComplete: 'Store details',
  legalGstReviewed: 'Legal and GST',
  menuCopied: 'Menu copy',
  productAvailabilityReviewed: 'Products',
  addOnsReviewed: 'Add-ons',
  kotRoutingReviewed: 'KOT routing',
  inventoryStructureCreated: 'Inventory rows',
  openingStockReviewed: 'Opening stock',
  receiptConfigurationReviewed: 'Receipt',
  staffAssigned: 'Staff',
  posTestCompleted: 'Internal POS test',
  customerOrderingTestCompleted: 'Customer-ordering test',
});

const STORE_ITEM_CONFIG_COLLECTION = 'storeItemConfig';

/** The four override fields. Deliberately excludes GST — see 07-reporting-gst-permissions.md. */
const STORE_ITEM_OVERRIDE_FIELDS = Object.freeze([
  'priceOverride',
  'isAvailableOverride',
  'menuVisibilityOverride',
  'sortOrderOverride',
]);

/**
 * Deterministic override document id.
 *
 * Must stay byte-identical to storeItemConfigDocId() in frontend/lib/storeItemConfig.ts.
 * Functions is CommonJS and cannot import that TypeScript module, so the two are held in
 * lockstep by scripts/test-store-override-clone.mjs, which imports BOTH and asserts they
 * agree. Change one without the other and that test fails.
 */
function storeItemConfigDocId(storeId, itemCode) {
  const sanitize = (value) => String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_');
  return `${sanitize(storeId)}__${sanitize(itemCode)}`.slice(0, 400);
}

/**
 * Copies only explicitly-present override fields, and only for items that are actually
 * assigned to the destination. Presence semantics: a field that is absent inherits the
 * global value, so `0` and `false` must survive the copy untouched.
 */
function planStoreItemOverrideCopies({
  overrideDocs = [],
  assignedItemCodes = [],
  destinationStoreId,
} = {}) {
  const assigned = new Set(assignedItemCodes.filter(Boolean));
  const creates = [];
  const skipped = [];

  [...overrideDocs]
    .sort((left, right) => String(left.itemCode || '').localeCompare(String(right.itemCode || '')))
    .forEach((row) => {
      const itemCode = text(row?.itemCode, 120);
      if (!itemCode) {
        skipped.push({ itemCode: '', reason: 'MISSING_ITEM_CODE' });
        return;
      }
      if (!assigned.has(itemCode)) {
        skipped.push({ itemCode, reason: 'ITEM_NOT_ASSIGNED_TO_DESTINATION' });
        return;
      }
      const fields = {};
      STORE_ITEM_OVERRIDE_FIELDS.forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(row, field)) return;
        const value = row[field];
        if (value === undefined || value === null) return;
        if ((field === 'priceOverride' || field === 'sortOrderOverride') && !Number.isFinite(Number(value))) return;
        if ((field === 'isAvailableOverride' || field === 'menuVisibilityOverride') && typeof value !== 'boolean') return;
        fields[field] = field === 'priceOverride' || field === 'sortOrderOverride' ? Number(value) : value;
      });
      if (Object.keys(fields).length === 0) {
        skipped.push({ itemCode, reason: 'NO_EXPLICIT_OVERRIDE_FIELDS' });
        return;
      }
      creates.push({
        itemCode,
        docId: storeItemConfigDocId(destinationStoreId, itemCode),
        fields,
        fieldNames: Object.keys(fields).sort(),
      });
    });

  return { creates, skipped };
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z][Z][0-9A-Z]$/;

const NEVER_COPY_COLLECTIONS = Object.freeze([
  'orders',
  'orderItems',
  'payments',
  'paymentReversals',
  'kotItems',
  'onlineOrders',
  'heldBills',
  'complimentaryAuthorizations',
  'posAddOnAuthorizations',
  'publicOrderTracking',
  'customers',
  'dayClosings',
  'reportAccessAudit',
  'franchiseAccessAudit',
  'stockMovements',
  'purchaseEntries',
  'purchaseDrafts',
  'supplierInvoiceFiles',
  'voidRecords',
  'pendingInventoryConsumption',
  'users',
  'firebaseAuthUsers',
  'productImageAudit',
  'menuImageFiles',
]);

function storeIdentity(store = {}) {
  return text(store.id || store.code || store.storeCode, 80).toUpperCase();
}

function isLegacyMigratedStore(store = {}) {
  return storeIdentity(store) === GOLDEN_I_STORE_ID
    && store.onboardingMode === LEGACY_MIGRATED_ONBOARDING_MODE;
}

function text(value, maxLength = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1000000);
  }
  return 0;
}

function isBakedByBond51(store = {}) {
  return [store.id, store.code, store.storeCode].some((value) => text(value, 80) === BAKED_BY_BOND_51_STORE_ID);
}

function isActivePosLaunchException(store = {}, nowMs = Date.now()) {
  const exception = store.posLaunchException && typeof store.posLaunchException === 'object'
    ? store.posLaunchException
    : null;
  if (!exception || exception.enabled !== true) return false;
  if (!isBakedByBond51(store)) return false;
  const expiresAtMs = timestampMillis(exception.expiresAt);
  return expiresAtMs > nowMs;
}

function normalizeStoreCode(value) {
  return text(value, 40).toUpperCase();
}

function normalizeStoreName(value) {
  return text(value, 100).toLocaleLowerCase('en-IN');
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => text(value, 80)).filter(Boolean))];
}

function sanitizeModules(values) {
  const selected = uniqueStrings(values);
  const invalid = selected.filter((moduleId) => !ALL_MODULE_IDS.includes(moduleId));
  if (invalid.length > 0) {
    throw new Error(`Unsupported copy modules: ${invalid.join(', ')}`);
  }
  return selected;
}

function isValidJobId(value) {
  return JOB_ID_PATTERN.test(text(value, 120));
}

function validateLocationDetails(input = {}) {
  const details = {
    displayName: text(input.displayName || input.name, 100),
    storeCode: normalizeStoreCode(input.storeCode || input.code),
    legalEntityName: text(input.legalEntityName, 140),
    address: text(input.address, 240),
    city: text(input.city, 80),
    state: text(input.state, 80),
    pinCode: text(input.pinCode, 10),
    phone: text(input.phone, 20),
    email: text(input.email, 160).toLowerCase(),
    gstRegistered: input.gstRegistered === true,
    gstin: text(input.gstin, 20).toUpperCase(),
    gstRate: Number.isFinite(Number(input.gstRate)) ? Number(input.gstRate) : 0,
    receiptName: text(input.receiptName, 100),
    receiptFooter: text(input.receiptFooter, 240),
    timezone: text(input.timezone || 'Asia/Kolkata', 60),
    inventoryMode: 'FINISHED_GOODS',
    gstDecisionReviewed: input.gstDecisionReviewed === true,
    receiptReviewComplete: input.receiptReviewComplete === true,
  };
  const issues = [];
  const addIssue = (field, code, message) => issues.push({ field, code, message });

  if (details.displayName.length < 2) {
    addIssue('displayName', 'DISPLAY_NAME_REQUIRED', 'Location display name is required.');
  }
  if (!STORE_CODE_PATTERN.test(details.storeCode)) {
    addIssue('storeCode', 'INVALID_STORE_CODE', 'Store code must use uppercase letters, numbers, and underscores only.');
  }
  if (!details.address) addIssue('address', 'ADDRESS_REQUIRED', 'Address is required.');
  if (!details.city) addIssue('city', 'CITY_REQUIRED', 'City is required.');
  if (!details.state) addIssue('state', 'STATE_REQUIRED', 'State is required.');
  if (!/^[1-9][0-9]{5}$/.test(details.pinCode)) {
    addIssue('pinCode', 'INVALID_PIN_CODE', 'A valid six-digit PIN code is required.');
  }
  if (!/^[0-9+() -]{8,20}$/.test(details.phone)) {
    addIssue('phone', 'INVALID_PHONE', 'A valid store phone is required.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
    addIssue('email', 'INVALID_EMAIL', 'A valid store email is required.');
  }
  if (!details.timezone) addIssue('timezone', 'TIMEZONE_REQUIRED', 'Business timezone is required.');
  if (!details.gstDecisionReviewed) {
    addIssue('gstDecisionReviewed', 'GST_DECISION_REQUIRED', 'Confirm whether this location is GST registered.');
  }
  if (details.gstRegistered && !GSTIN_PATTERN.test(details.gstin)) {
    addIssue('gstin', 'INVALID_GSTIN', 'A valid GSTIN is required for a GST-registered location.');
  }
  if (details.gstRegistered && details.gstRate <= 0) {
    addIssue('gstRate', 'GST_RATE_REQUIRED', 'A positive GST rate is required for a GST-registered location.');
  }
  if (!details.receiptReviewComplete) {
    addIssue('receiptReviewComplete', 'RECEIPT_REVIEW_REQUIRED', 'Confirm that receipt name and footer have been reviewed.');
  }

  const errors = issues.map((issue) => issue.message);
  return { details, issues, errors, valid: issues.length === 0 };
}

function validateInventoryOption({
  inventoryOption,
  destinationStoreCode,
  confirmationStoreCode,
  reason,
} = {}) {
  const option = INVENTORY_OPTIONS.includes(inventoryOption)
    ? inventoryOption
    : 'STRUCTURE_ONLY';
  const errors = [];

  if (option === 'CURRENT_STOCK_ADVANCED') {
    if (normalizeStoreCode(confirmationStoreCode) !== normalizeStoreCode(destinationStoreCode)) {
      errors.push('Current-stock copying requires the exact destination store code confirmation.');
    }
    if (text(reason, 300).length < 10) {
      errors.push('A reason of at least 10 characters is required for current-stock copying.');
    }
  }

  return { option, errors, valid: errors.length === 0 };
}

function validateModuleCompatibility({ templateMode, selectedModules } = {}) {
  const modules = sanitizeModules(selectedModules);
  const errors = [];
  if (templateMode === 'COPY' && modules.includes('MENU')) {
    if (!modules.includes('ADD_ONS')) {
      errors.push('Add-on configuration must remain selected when copying Menu because add-on assignments are global Finished Good fields.');
    }
    if (!modules.includes('KOT')) {
      errors.push('KOT configuration must remain selected when copying Menu because station routing is a global Finished Good field.');
    }
  }
  return { errors, valid: errors.length === 0 };
}

function copyAllowedFields(source = {}, fieldNames = []) {
  return fieldNames.reduce((result, fieldName) => {
    if (Object.prototype.hasOwnProperty.call(source, fieldName)) {
      result[fieldName] = source[fieldName];
    }
    return result;
  }, {});
}

function buildDraftStorePayload({
  details,
  sourceStore = null,
  selectedModules = [],
  createdBy,
  provisioningJobId,
  timestamp,
} = {}) {
  const modules = sanitizeModules(selectedModules);
  const source = sourceStore || {};
  const copied = {
    ...(modules.includes('OPERATING') ? copyAllowedFields(source, OPERATING_FIELDS) : {}),
    ...(modules.includes('KOT') ? copyAllowedFields(source, KOT_FIELDS) : {}),
    ...(modules.includes('CUSTOMER_ORDERING') ? copyAllowedFields(source, CUSTOMER_ORDERING_FIELDS) : {}),
    ...(modules.includes('LEGAL_RECEIPT') ? copyAllowedFields(source, LEGAL_RECEIPT_FIELDS) : {}),
  };
  const copyLegal = modules.includes('LEGAL_RECEIPT');
  const sourceHas = (fieldName) => Object.prototype.hasOwnProperty.call(source, fieldName);
  const gstRegistered = copyLegal && sourceHas('gstRegistered')
    ? source.gstRegistered === true
    : details.gstRegistered;
  const gstin = copyLegal && sourceHas('gstin') ? text(source.gstin, 20).toUpperCase() : details.gstin;
  const gstRate = copyLegal && sourceHas('gstRate') ? Number(source.gstRate) || 0 : details.gstRate;
  const receiptName = copyLegal && sourceHas('receiptName') ? text(source.receiptName, 100) : details.receiptName;
  const receiptFooter = copyLegal && sourceHas('receiptFooter') ? text(source.receiptFooter, 240) : details.receiptFooter;
  const legalEntityName = copyLegal && sourceHas('legalEntityName')
    ? text(source.legalEntityName, 140)
    : details.legalEntityName;

  return {
    ...copied,
    name: details.displayName,
    displayName: details.displayName,
    code: details.storeCode,
    storeCode: details.storeCode,
    legalEntityName: legalEntityName || '',
    address: details.address,
    city: details.city,
    state: details.state,
    pinCode: details.pinCode,
    phone: details.phone,
    email: details.email,
    gstRegistered,
    ...(gstRegistered ? { gstin } : { gstin: '' }),
    gstRate: gstRegistered ? gstRate : 0,
    receiptName,
    receiptFooter,
    timezone: details.timezone,
    inventoryMode: 'FINISHED_GOODS',
    onboardingMode: PROVISIONED_ONBOARDING_MODE,
    status: 'DRAFT',
    isActive: false,
    posEnabled: false,
    onlineOrderingEnabled: false,
    customerOrderingEnabled: false,
    publicOrderingEnabled: false,
    acceptingOrders: false,
    isAcceptingOrders: false,
    onlineOrderingPaused: true,
    isLive: false,
    setupStatus: 'SETUP',
    operationalStatus: 'DRAFT',
    assignedStaffCount: 0,
    sourceTemplateStoreId: sourceStore?.id || null,
    provisioningJobId,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    readiness: Object.fromEntries([
      ...READINESS_KEYS.map((key) => [key, false]),
      [CUSTOMER_ORDERING_READINESS_KEY, false],
    ]),
  };
}

function readinessResult(store = {}, counts = {}) {
  const configured = store.readiness && typeof store.readiness === 'object' ? store.readiness : {};
  const legacyMigrated = isLegacyMigratedStore(store);
  const strictBasicDetailsComplete = Boolean(
    text(store.name || store.displayName)
    && text(store.code || store.storeCode)
    && text(store.address)
    && text(store.city)
    && text(store.state)
    && /^[1-9][0-9]{5}$/.test(text(store.pinCode)),
  );
  const basicDetailsComplete = legacyMigrated
    ? Boolean(text(store.name || store.displayName) && text(store.code || store.storeCode) && text(store.address))
    : strictBasicDetailsComplete;
  const gstRegistered = store.gstRegistered === true;
  const legalGstReviewed = gstRegistered
    ? GSTIN_PATTERN.test(text(store.gstin, 20).toUpperCase()) && Number(store.gstRate || counts.gstRate || 0) > 0
    : (store.gstin ? false : true);
  const receiptConfigurationReviewed = Boolean(text(store.receiptName || store.tradeName || store.name || store.displayName));
  const menuProductCount = Number(counts.menuProductCount || 0);
  const inventoryRowCount = Number(counts.inventoryRowCount || 0);
  const invalidProductAvailabilityCount = Number(counts.invalidProductAvailabilityCount || 0);
  const invalidAddOnReferenceCount = Number(counts.invalidAddOnReferenceCount || 0);
  const invalidKotRoutingCount = Number(counts.invalidKotRoutingCount || 0);
  const resolved = {
    basicDetailsComplete,
    legalGstReviewed,
    menuCopied: menuProductCount > 0,
    productAvailabilityReviewed: menuProductCount > 0 && invalidProductAvailabilityCount === 0,
    addOnsReviewed: invalidAddOnReferenceCount === 0,
    kotRoutingReviewed: invalidKotRoutingCount === 0,
    inventoryStructureCreated: legacyMigrated
      ? inventoryRowCount > 0
      : configured.inventoryStructureCreated === true && inventoryRowCount > 0,
    openingStockReviewed: configured.openingStockReviewed === true || store.openingStockConfirmed === true,
    receiptConfigurationReviewed,
    staffAssigned: Number(counts.staffCount || 0) > 0,
    posTestCompleted: configured.posTestCompleted === true || store.posTestCompleted === true,
    customerOrderingTestCompleted: configured.customerOrderingTestCompleted === true,
  };
  const compatibilityExemptions = legacyMigrated
    ? ['openingStockReviewed', 'posTestCompleted']
    : [];
  const customerOrderingTestExempt = legacyMigrated;
  const blockingKeys = READINESS_KEYS.filter((key) => (
    resolved[key] !== true && !compatibilityExemptions.includes(key)
  ));
  const openingStockPending = resolved.openingStockReviewed !== true;
  const launchExceptionActive = openingStockPending && isActivePosLaunchException(store);
  const posBlockingKeys = launchExceptionActive
    ? blockingKeys.filter((key) => key !== 'openingStockReviewed')
    : blockingKeys;
  const warnings = [];
  if (legacyMigrated) {
    if (!strictBasicDetailsComplete) warnings.push('Legacy store uses a single address field; structured city, state or PIN details remain unrecorded.');
    if (resolved.openingStockReviewed !== true) warnings.push('Opening stock has not been reviewed in the new onboarding workflow.');
    if (resolved.posTestCompleted !== true) warnings.push('The new internal POS setup test is not recorded for this migrated store.');
    if (resolved.customerOrderingTestCompleted !== true) warnings.push('The new customer-ordering setup test is not recorded for this migrated store.');
    if (!store.openingHours && !store.orderingHours) warnings.push('Store and ordering hours are not configured.');
    if (!(store.legalName || store.legalEntityName) || !store.stateName || !store.stateCode || !store.receiptSettings) {
      warnings.push('Legal or receipt fields are incomplete; existing tax fallback remains in effect.');
    }
  }
  return {
    checks: resolved,
    onboardingMode: legacyMigrated ? LEGACY_MIGRATED_ONBOARDING_MODE : PROVISIONED_ONBOARDING_MODE,
    compatibilityExemptions,
    customerOrderingTestExempt,
    warnings,
    blockingKeys,
    friendlyBlockingSteps: blockingKeys.map((key) => READINESS_STEP_LABELS[key] || key),
    posBlockingKeys,
    friendlyPosBlockingSteps: posBlockingKeys.map((key) => READINESS_STEP_LABELS[key] || key),
    openingStockPending,
    launchExceptionActive,
    posReady: posBlockingKeys.length === 0,
    customerOrderingReady: blockingKeys.length === 0
      && (resolved.customerOrderingTestCompleted || customerOrderingTestExempt)
      && store.status === 'ACTIVE'
      && store.posEnabled === true,
  };
}

function buildSafeJobRecord({
  jobId,
  sourceStoreId,
  destinationStoreId,
  selectedModules,
  inventoryOption,
  reason,
  adminUid,
  status,
  counts,
  requestChecksum,
  error,
  timestamp,
} = {}) {
  return {
    jobId: text(jobId, 120),
    sourceStoreId: sourceStoreId ? text(sourceStoreId, 80) : null,
    destinationStoreId: text(destinationStoreId, 80),
    selectedModules: sanitizeModules(selectedModules),
    inventoryOption: INVENTORY_OPTIONS.includes(inventoryOption) ? inventoryOption : 'STRUCTURE_ONLY',
    reason: text(reason, 300),
    adminUid: text(adminUid, 128),
    status: text(status, 40),
    counts: counts && typeof counts === 'object' ? counts : {},
    requestChecksum: text(requestChecksum, 64),
    error: error ? text(error, 300) : null,
    updatedAt: timestamp,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function provisioningRequestChecksum(input = {}) {
  const safeInput = {
    location: input.location || {},
    templateMode: input.templateMode || 'BLANK',
    sourceStoreId: input.sourceStoreId || '',
    selectedModules: [...(input.selectedModules || [])].sort(),
    staffAssignmentUids: [...(input.staffAssignmentUids || [])].sort(),
    inventoryOption: input.inventoryOption || 'STRUCTURE_ONLY',
    inventoryReason: input.inventoryReason || '',
    confirmDuplicateName: input.confirmDuplicateName === true,
  };
  return createHash('sha256')
    .update(JSON.stringify(stableValue(safeInput)))
    .digest('hex');
}

function valueChecksum(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

module.exports = {
  ALL_MODULE_IDS,
  STORE_ITEM_CONFIG_COLLECTION,
  STORE_ITEM_OVERRIDE_FIELDS,
  planStoreItemOverrideCopies,
  storeItemConfigDocId,
  CUSTOMER_ORDERING_FIELDS,
  CUSTOMER_ORDERING_READINESS_KEY,
  BAKED_BY_BOND_51_STORE_ID,
  GOLDEN_I_STORE_ID,
  PROVISIONED_ONBOARDING_MODE,
  LEGACY_MIGRATED_ONBOARDING_MODE,
  INVENTORY_OPTIONS,
  JOB_ID_PATTERN,
  KOT_FIELDS,
  LEGAL_RECEIPT_FIELDS,
  MODULES,
  NEVER_COPY_COLLECTIONS,
  OPERATING_FIELDS,
  READINESS_KEYS,
  READINESS_STEP_LABELS,
  RECOMMENDED_MODULE_IDS,
  STORE_CODE_PATTERN,
  buildDraftStorePayload,
  buildSafeJobRecord,
  isActivePosLaunchException,
  isLegacyMigratedStore,
  copyAllowedFields,
  isValidJobId,
  normalizeStoreCode,
  normalizeStoreName,
  provisioningRequestChecksum,
  readinessResult,
  sanitizeModules,
  validateInventoryOption,
  validateLocationDetails,
  validateModuleCompatibility,
  valueChecksum,
};
