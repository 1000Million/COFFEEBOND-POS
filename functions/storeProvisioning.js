'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  ALL_MODULE_IDS,
  BAKED_BY_BOND_51_STORE_ID,
  GOLDEN_I_STORE_ID,
  LEGACY_MIGRATED_ONBOARDING_MODE,
  NEVER_COPY_COLLECTIONS,
  READINESS_STEP_LABELS,
  RECOMMENDED_MODULE_IDS,
  buildDraftStorePayload,
  buildSafeJobRecord,
  isLegacyMigratedStore,
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
} = require('./storeProvisioningPolicy');

const REGION = 'us-central1';
const BATCH_SIZE = 350;
const POS_LAUNCH_EXCEPTION_MAX_MS = 48 * 60 * 60 * 1000;
const POS_LAUNCH_EXCEPTION_MESSAGE = 'Baked by Bond 51 POS launch exception keeps customer ordering disabled and opening stock pending.';
const MENU_COLLECTIONS = ['finishedGoods', 'menuItems', 'categories'];
const INVENTORY_COLLECTIONS = ['storeStock'];
const COUNTED_EXCLUDED_COLLECTIONS = [
  'orders',
  'paymentReversals',
  'kotItems',
  'onlineOrders',
  'heldBills',
  'complimentaryAuthorizations',
  'posAddOnAuthorizations',
  'dayClosings',
  'reportAccessAudit',
  'franchiseAccessAudit',
  'stockMovements',
  'purchaseEntries',
  'purchaseDrafts',
  'voidRecords',
  'pendingInventoryConsumption',
];
const SAFE_EDIT_FIELDS = new Set([
  'displayName',
  'name',
  'legalEntityName',
  'address',
  'city',
  'state',
  'pinCode',
  'phone',
  'email',
  'gstRegistered',
  'gstin',
  'legalName',
  'tradeName',
  'legalAddress',
  'stateName',
  'stateCode',
  'receiptName',
  'receiptFooter',
  'timezone',
  'openingHours',
  'orderTypes',
  'posSettings',
  'receiptSettings',
  'printerSettings',
  'kotSettings',
  'paymentMethods',
  'discountSettings',
  'businessDaySettings',
  'inventoryPolicy',
  'estimatedPrepMinutes',
  'pickupEnabled',
  'dineInEnabled',
  'deliveryEnabled',
  'orderingHours',
  'customerInstructions',
  'menuPauseSettings',
  'storeVisibilitySettings',
  'onlineOrderingMessage',
  'gstRate',
]);
const SETUP_LEAD_ROLES = new Set(['ADMIN', 'STORE_MANAGER']);
const POS_CAPABLE_ROLES = new Set(['ADMIN', 'STORE_MANAGER', 'CASHIER']);
const DECIMAL_UNITS = new Set(['G', 'KG', 'ML', 'L']);
const INTEGER_UNITS = new Set(['PCS', 'SLICE', 'PACK', 'BOX', 'BOTTLE', 'BAG', 'TRAY']);
const UNIT_ALIASES = {
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  SLICES: 'SLICE',
};
const SYSTEM_MANAGED_OPENING_STOCK_READINESS_MESSAGE = 'Opening-stock readiness is system-managed and can only be changed through saveLocationOpeningStock.';

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function safeError(error) {
  return cleanText(error?.message || String(error || 'Store provisioning failed.'), 300)
    .replace(/token|password|secret|credential/gi, '[REDACTED]');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function normalizeUnit(value) {
  const rawUnit = cleanText(value, 20).toUpperCase();
  return UNIT_ALIASES[rawUnit] || rawUnit;
}

function isSupportedInventoryUnit(unit) {
  const normalized = normalizeUnit(unit);
  return DECIMAL_UNITS.has(normalized) || INTEGER_UNITS.has(normalized);
}

function unitAllowsDecimal(unit) {
  const normalized = normalizeUnit(unit);
  if (DECIMAL_UNITS.has(normalized)) return true;
  if (INTEGER_UNITS.has(normalized)) return false;
  return false;
}

function setupNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

function roundedQuantity(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
}

function sameQuantity(left, right) {
  return roundedQuantity(number(left)) === roundedQuantity(number(right));
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

function customerOrderingIsDisabled(store = {}) {
  return store.onlineOrderingEnabled !== true
    && store.customerOrderingEnabled !== true
    && store.publicOrderingEnabled !== true
    && store.acceptingOrders !== true
    && store.isAcceptingOrders !== true;
}

function openingStockIsPending(store = {}) {
  const readiness = store.readiness && typeof store.readiness === 'object' ? store.readiness : {};
  return readiness.openingStockReviewed !== true && store.openingStockConfirmed !== true;
}

function assertNoSystemManagedStoreConfigPatch(rawPatch = {}) {
  const patch = rawPatch && typeof rawPatch === 'object' && !Array.isArray(rawPatch) ? rawPatch : {};
  const blocked = Object.keys(patch).some((key) => (
    key === 'readiness'
    || key === 'openingStockConfirmed'
    || key === 'posLaunchException'
    || key === 'readiness.openingStockReviewed'
    || key === 'readiness.openingStockConfirmed'
    || key.startsWith('readiness.')
    || key.startsWith('posLaunchException.')
  ));
  if (blocked) fail('failed-precondition', SYSTEM_MANAGED_OPENING_STOCK_READINESS_MESSAGE);
}

function openingMovementId(storeId, stockId, provisioningJobId) {
  return `${cleanText(provisioningJobId || storeId, 140)}_${stockId}_OPENING_STOCK`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 400);
}

async function requireActiveAdmin(db, request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in as an active Admin.');
  const profileSnap = await db.collection('users').doc(request.auth.uid).get();
  if (!profileSnap.exists) fail('permission-denied', 'An active Admin profile is required.');
  const profile = profileSnap.data() || {};
  if (profile.isActive !== true || profile.role !== 'ADMIN') {
    fail('permission-denied', 'Only an active Admin can manage locations.');
  }
  return {
    uid: request.auth.uid,
    name: cleanText(profile.displayName || profile.name || profile.email || 'Admin', 100),
  };
}

async function getDuplicateStores(db, destinationCode, destinationName) {
  const [codeSnap, storeCodeSnap, allStoresSnap] = await Promise.all([
    db.collection('stores').where('code', '==', destinationCode).get(),
    db.collection('stores').where('storeCode', '==', destinationCode).get(),
    db.collection('stores').get(),
  ]);
  const codeMatches = new Map();
  [...codeSnap.docs, ...storeCodeSnap.docs].forEach((storeDoc) => codeMatches.set(storeDoc.id, storeDoc));
  const normalizedName = normalizeStoreName(destinationName);
  const nameMatches = allStoresSnap.docs.filter((storeDoc) => {
    const data = storeDoc.data() || {};
    return normalizeStoreName(data.name || data.displayName) === normalizedName;
  });
  return {
    codeMatches: [...codeMatches.values()],
    nameMatches,
  };
}

async function resolveSourceStore(db, templateMode, sourceStoreId) {
  if (templateMode === 'BLANK') return null;
  if (templateMode !== 'COPY') fail('invalid-argument', 'Template mode must be BLANK or COPY.');
  const cleanSourceId = cleanText(sourceStoreId, 80);
  if (!cleanSourceId) fail('invalid-argument', 'Select a source location.');
  const sourceSnap = await db.collection('stores').doc(cleanSourceId).get();
  if (!sourceSnap.exists) fail('not-found', 'The selected source location does not exist.');
  return { id: sourceSnap.id, ...(sourceSnap.data() || {}) };
}

function validateProvisioningInput(data = {}, { mode = 'CREATE' } = {}) {
  const locationValidation = validateLocationDetails(data.location || {});
  const hardLocationIssues = locationValidation.issues.filter((issue) => (
    issue.field === 'displayName' || issue.field === 'storeCode'
  ));
  if (hardLocationIssues.length > 0) {
    fail('invalid-argument', hardLocationIssues.map((issue) => issue.message).join(' '));
  }
  if (mode === 'CREATE' && !locationValidation.valid) {
    fail('invalid-argument', locationValidation.errors.join(' '));
  }
  let selectedModules;
  try {
    selectedModules = sanitizeModules(data.selectedModules || RECOMMENDED_MODULE_IDS);
  } catch (error) {
    fail('invalid-argument', safeError(error));
  }
  const inventoryValidation = validateInventoryOption({
    inventoryOption: data.inventoryOption,
    destinationStoreCode: locationValidation.details.storeCode,
    confirmationStoreCode: data.inventoryConfirmationStoreCode,
    reason: data.inventoryReason,
  });
  if (!inventoryValidation.valid) fail('invalid-argument', inventoryValidation.errors.join(' '));
  const validationErrors = [...locationValidation.issues];
  if (selectedModules.includes('LEGAL_RECEIPT') && data.confirmLegalEntity !== true) {
    const legalIssue = {
      field: 'confirmLegalEntity',
      code: 'LEGAL_ENTITY_CONFIRMATION_REQUIRED',
      message: 'Confirm that the new location uses the same legal entity and GST registration.',
    };
    if (mode === 'CREATE') fail('failed-precondition', legalIssue.message);
    validationErrors.push(legalIssue);
  }
  return {
    location: locationValidation.details,
    selectedModules,
    staffAssignmentUids: unique(data.staffAssignmentUids || data.plannedStaffUids || []),
    inventoryOption: inventoryValidation.option,
    inventoryReason: cleanText(data.inventoryReason, 300),
    templateMode: data.templateMode === 'COPY' ? 'COPY' : 'BLANK',
    sourceStoreId: cleanText(data.sourceStoreId, 80),
    confirmDuplicateName: data.confirmDuplicateName === true,
    validationErrors,
    validationWarnings: [],
  };
}

async function loadSourceConfiguration(db, sourceStore, selectedModules) {
  if (!sourceStore) {
    return {
      menuDocs: [],
      inventoryDocs: [],
      publicSnapshotExists: false,
      sourceStaffCount: 0,
      addOnReferenceCount: 0,
      kotReferenceCount: 0,
      skippedDocumentCounts: {},
      skippedKnownDocumentCount: 0,
    };
  }

  const menuSelected = selectedModules.includes('MENU');
  const inventorySelected = selectedModules.includes('INVENTORY');
  const menuPromises = menuSelected
    ? MENU_COLLECTIONS.map(async (collectionName) => {
      const snapshot = await db.collection(collectionName)
        .where('availableStoreIds', 'array-contains', sourceStore.id)
        .get();
      return snapshot.docs.map((docSnap) => ({
        collection: collectionName,
        id: docSnap.id,
        data: docSnap.data() || {},
      }));
    })
    : [];
  const inventoryPromises = inventorySelected
    ? INVENTORY_COLLECTIONS.map(async (collectionName) => {
      const snapshot = await db.collection(collectionName).where('storeId', '==', sourceStore.id).get();
      return snapshot.docs.map((docSnap) => ({
        collection: collectionName,
        id: docSnap.id,
        data: docSnap.data() || {},
      }));
    })
    : [];

  const excludedCountPromises = COUNTED_EXCLUDED_COLLECTIONS.map(async (collectionName) => {
    const aggregate = await db.collection(collectionName)
      .where('storeId', '==', sourceStore.id)
      .count()
      .get();
    return [collectionName, aggregate.data().count];
  });
  const [menuGroups, inventoryGroups, publicSnapshot, usersSnap, excludedCounts] = await Promise.all([
    Promise.all(menuPromises),
    Promise.all(inventoryPromises),
    db.collection('publicMenuAvailability').doc(sourceStore.code || sourceStore.id).get(),
    db.collection('users').get(),
    Promise.all(excludedCountPromises),
  ]);
  const menuDocs = menuGroups.flat();
  const inventoryDocs = inventoryGroups.flat();
  const finishedGoods = menuDocs.filter((entry) => entry.collection === 'finishedGoods');
  const sourceStaffCount = usersSnap.docs.filter((userDoc) => {
    const profile = userDoc.data() || {};
    const assigned = unique([
      ...(Array.isArray(profile.storeIds) ? profile.storeIds : []),
      ...(Array.isArray(profile.assignedStoreIds) ? profile.assignedStoreIds : []),
    ]);
    return profile.isActive === true && assigned.includes(sourceStore.id);
  }).length;
  const skippedDocumentCounts = {
    ...Object.fromEntries(excludedCounts),
    users: sourceStaffCount,
    publicMenuAvailability: publicSnapshot.exists ? 1 : 0,
  };

  return {
    menuDocs,
    inventoryDocs,
    publicSnapshotExists: publicSnapshot.exists,
    sourceStaffCount,
    addOnReferenceCount: finishedGoods.filter((entry) => unique(entry.data.addOnGroupIds || entry.data.addonGroupIds).length > 0).length,
    kotReferenceCount: finishedGoods.filter((entry) => ['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(entry.data.prepStation)).length,
    skippedDocumentCounts,
    skippedKnownDocumentCount: Object.values(skippedDocumentCounts).reduce((sum, count) => sum + number(count), 0),
  };
}

async function buildStaffAssignmentPlan(db, storeId, selectedUids = []) {
  const selected = unique(selectedUids);
  const usersSnap = await db.collection('users').get();
  const users = usersSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  const activeAssignableUsers = users.filter((profile) => (
    profile.isActive === true
    && profile.role !== 'FRANCHISE_VIEWER'
    && cleanText(profile.uid || profile.id, 128)
  ));
  const activeByUid = new Map(activeAssignableUsers.map((profile) => [profile.uid || profile.id, profile]));
  const missing = selected.filter((uid) => !activeByUid.has(uid));
  const selectedProfiles = selected.map((uid) => activeByUid.get(uid)).filter(Boolean);
  const hasSetupLead = selectedProfiles.some((profile) => SETUP_LEAD_ROLES.has(profile.role));
  const hasPosCapable = selectedProfiles.some((profile) => POS_CAPABLE_ROLES.has(profile.role));
  const validationErrors = [];
  if (missing.length > 0) {
    validationErrors.push({
      field: 'staffAssignmentUids',
      code: 'UNKNOWN_OR_INACTIVE_STAFF',
      message: `Selected staff profile is missing or inactive: ${missing.join(', ')}`,
    });
  }
  if (!hasSetupLead) {
    validationErrors.push({
      field: 'staffAssignmentUids',
      code: 'SETUP_LEAD_REQUIRED',
      message: 'Assign at least one active Admin or Store Manager before creating this location.',
    });
  }
  if (!hasPosCapable) {
    validationErrors.push({
      field: 'staffAssignmentUids',
      code: 'POS_USER_REQUIRED',
      message: 'Assign at least one active POS-capable user before creating this location.',
    });
  }
  const changes = activeAssignableUsers
    .map((profile) => {
      const uid = profile.uid || profile.id;
      const before = unique(profile.assignedStoreIds || profile.storeIds || []);
      const shouldHaveStore = selected.includes(uid);
      const after = shouldHaveStore
        ? unique([...before, storeId])
        : before.filter((assignedStoreId) => assignedStoreId !== storeId);
      const beforeSorted = [...before].sort();
      const afterSorted = [...after].sort();
      if (JSON.stringify(beforeSorted) === JSON.stringify(afterSorted)) return null;
      return {
        uid,
        email: cleanText(profile.email, 160),
        name: cleanText(profile.displayName || profile.name || profile.email || uid, 120),
        role: cleanText(profile.role, 40),
        before,
        after,
      };
    })
    .filter(Boolean);
  return {
    selectedUids: selected,
    selectedCount: selected.length,
    hasSetupLead,
    hasPosCapable,
    validationErrors,
    changes,
  };
}

function inventoryQuantityForOption(source, option) {
  if (option === 'CONFIGURED_OPENING') return number(source.openingStock);
  if (option === 'CURRENT_STOCK_ADVANCED') return number(source.currentStock);
  return 0;
}

function destinationInventoryId(destinationStoreId, entry) {
  const source = entry.data;
  if (entry.collection === 'storeStock') {
    const type = cleanText(source.stockItemType || 'ITEM', 40).replace(/[^A-Za-z0-9_-]/g, '_');
    const code = cleanText(source.stockItemCode || source.inventoryItemId || entry.id, 100).replace(/[^A-Za-z0-9_-]/g, '_');
    return `${destinationStoreId}_${type}_${code}`;
  }
  const itemId = cleanText(source.inventoryItemId || source.inventoryItemCode || entry.id, 120).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${destinationStoreId}_${itemId}`;
}

function cloneInventoryPayload({ entry, destinationStore, inventoryOption, adminUid, jobId, timestamp }) {
  const source = entry.data;
  const forbidden = new Set([
    'id',
    'storeId',
    'storeCode',
    'storeName',
    'openingStock',
    'currentStock',
    'stockBefore',
    'stockAfter',
    'previousQty',
    'newQty',
    'quantity',
    'quantityDelta',
    'createdAt',
    'updatedAt',
    'createdBy',
    'createdByName',
    'updatedBy',
    'updatedByName',
    'lastMovementId',
    'lastOrderId',
    'lastOrderNumber',
    'audit',
    'history',
  ]);
  const structural = Object.entries(source).reduce((result, [key, value]) => {
    if (!forbidden.has(key)) result[key] = value;
    return result;
  }, {});
  const quantity = inventoryQuantityForOption(source, inventoryOption);
  return {
    ...structural,
    storeId: destinationStore.id,
    storeCode: destinationStore.code,
    storeName: destinationStore.name,
    openingStock: quantity,
    currentStock: quantity,
    provisioningJobId: jobId,
    provisionedFromStoreId: source.storeId || null,
    createdBy: adminUid,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildPreviewResponse({
  input,
  sourceStore,
  sourceConfiguration,
  duplicateNameWarning,
  staffAssignmentPlan = null,
}) {
  const moduleCompatibility = validateModuleCompatibility(input);
  const inventoryTargetIds = sourceConfiguration.inventoryDocs.map((entry) => (
    destinationInventoryId(input.location.storeCode, entry)
  ));
  const duplicateInventoryTargetIds = inventoryTargetIds.filter((targetId, index) => (
    inventoryTargetIds.indexOf(targetId) !== index
  ));
  const menuCounts = Object.fromEntries(MENU_COLLECTIONS.map((collectionName) => [
    collectionName,
    sourceConfiguration.menuDocs.filter((entry) => entry.collection === collectionName).length,
  ]));
  const inventoryCounts = Object.fromEntries(INVENTORY_COLLECTIONS.map((collectionName) => [
    collectionName,
    sourceConfiguration.inventoryDocs.filter((entry) => entry.collection === collectionName).length,
  ]));
  const openingMovementCount = input.inventoryOption === 'STRUCTURE_ONLY'
    ? 0
    : sourceConfiguration.inventoryDocs.filter((entry) => inventoryQuantityForOption(entry.data, input.inventoryOption) !== 0).length;
  const writesByCollection = {
    stores: 1,
    storeProvisioningJobs: 1,
    users: staffAssignmentPlan?.changes?.length || 0,
    storeProvisioningAudit: staffAssignmentPlan?.changes?.length ? 1 : 0,
    ...menuCounts,
    ...inventoryCounts,
    stockMovements: openingMovementCount,
  };
  const writeOperationsByCollection = Object.fromEntries(
    Object.entries(writesByCollection).map(([collectionName, count]) => [
      collectionName,
      {
        creates: ['stores', 'storeProvisioningJobs', 'storeProvisioningAudit', 'storeStock', 'stockMovements'].includes(collectionName)
          ? count
          : 0,
        updates: MENU_COLLECTIONS.includes(collectionName) || collectionName === 'users' ? count : 0,
      },
    ]),
  );
  const estimatedWrites = Object.values(writesByCollection).reduce((sum, count) => sum + count, 0);
  const warnings = [
    'The location will be created as Draft with POS and customer ordering disabled.',
    'Staff accounts and store assignments will not be copied.',
    'Transactional history and customer data will never be copied.',
  ];
  if (sourceConfiguration.publicSnapshotExists && input.selectedModules.includes('MENU')) {
    warnings.push('The source public menu snapshot is not copied while the destination remains Draft.');
  }
  if (input.selectedModules.includes('ADD_ONS')) {
    warnings.push('Add-on assignments are global Finished Good references in the current architecture; no duplicate add-on documents are created.');
  }
  if (input.selectedModules.includes('KOT')) {
    warnings.push('KOT routing is a global Finished Good attribute in the current architecture; no KOT history is copied.');
  }
  warnings.push(...moduleCompatibility.errors);
  if (input.inventoryOption === 'CURRENT_STOCK_ADVANCED') {
    warnings.push('Advanced current-stock copying creates destination opening balances and auditable opening movements; source balances remain unchanged.');
  }
  if (duplicateNameWarning) warnings.push(duplicateNameWarning);
  if (duplicateInventoryTargetIds.length > 0) {
    warnings.push(`Inventory structure contains duplicate destination row IDs: ${[...new Set(duplicateInventoryTargetIds)].join(', ')}`);
  }
  const requestChecksum = provisioningRequestChecksum(input);
  const planChecksum = valueChecksum({
    requestChecksum,
    sourceStoreId: sourceStore?.id || null,
    menuAssignments: sourceConfiguration.menuDocs.map((entry) => `${entry.collection}/${entry.id}`).sort(),
    inventoryCreates: sourceConfiguration.inventoryDocs.map((entry) => ({
      path: `${entry.collection}/${destinationInventoryId(input.location.storeCode, entry)}`,
      quantity: inventoryQuantityForOption(entry.data, input.inventoryOption),
    })).sort((left, right) => left.path.localeCompare(right.path)),
    writesByCollection,
  });

  const validationErrors = [...(input.validationErrors || [])];
  (staffAssignmentPlan?.validationErrors || []).forEach((issue) => validationErrors.push(issue));
  if (duplicateNameWarning && !input.confirmDuplicateName) {
    validationErrors.push({
      field: 'confirmDuplicateName',
      code: 'DUPLICATE_NAME_CONFIRMATION_REQUIRED',
      message: `${duplicateNameWarning} Confirm the duplicate normalized name to continue.`,
    });
  }
  moduleCompatibility.errors.forEach((message) => {
    validationErrors.push({
      field: 'selectedModules',
      code: 'MODULE_COMPATIBILITY_ERROR',
      message,
    });
  });
  if (duplicateInventoryTargetIds.length > 0) {
    validationErrors.push({
      field: 'inventoryOption',
      code: 'DUPLICATE_INVENTORY_TARGETS',
      message: `Inventory structure contains duplicate destination row IDs: ${[...new Set(duplicateInventoryTargetIds)].join(', ')}`,
    });
  }
  const canCreate = validationErrors.length === 0;

  return {
    destinationStore: {
      id: input.location.storeCode,
      ...input.location,
      status: 'DRAFT',
      isActive: false,
      posEnabled: false,
      customerOrderingEnabled: false,
      onlineOrderingPaused: true,
      inventoryMode: 'FINISHED_GOODS',
    },
    sourceTemplate: sourceStore ? {
      id: sourceStore.id,
      code: sourceStore.code || sourceStore.storeCode || sourceStore.id,
      name: sourceStore.name || sourceStore.displayName || sourceStore.id,
    } : null,
    selectedModules: input.selectedModules,
    inventoryOption: input.inventoryOption,
    requestChecksum,
    planChecksum,
    counts: {
      ...writesByCollection,
      skippedHistoricalDocuments: sourceConfiguration.skippedKnownDocumentCount,
      sourceStaffFoundButNotCopied: sourceConfiguration.sourceStaffCount,
      addOnGlobalReferences: input.selectedModules.includes('ADD_ONS') ? sourceConfiguration.addOnReferenceCount : 0,
      kotGlobalReferences: input.selectedModules.includes('KOT') ? sourceConfiguration.kotReferenceCount : 0,
      inventoryQuantityRows: openingMovementCount,
      estimatedWrites,
    },
    writesByCollection,
    writeOperationsByCollection,
    skippedDocumentsByCollection: sourceConfiguration.skippedDocumentCounts,
    skippedUncountedScopes: [
      'orders/{orderId}/items',
      'orders/{orderId}/payments',
      'Firebase Authentication accounts',
      'Storage product-image and supplier-invoice objects',
      'unscoped customer and public-tracking documents',
    ],
    legalGstSelected: input.selectedModules.includes('LEGAL_RECEIPT'),
    customerOrderingInitialStatus: 'DISABLED',
    staffAssignmentCount: staffAssignmentPlan?.selectedCount || 0,
    staffAssignmentValidation: staffAssignmentPlan ? {
      selectedCount: staffAssignmentPlan.selectedCount,
      hasSetupLead: staffAssignmentPlan.hasSetupLead,
      hasPosCapable: staffAssignmentPlan.hasPosCapable,
      changeCount: staffAssignmentPlan.changes.length,
    } : {
      selectedCount: 0,
      hasSetupLead: false,
      hasPosCapable: false,
      changeCount: 0,
    },
    warnings,
    validationErrors,
    validationWarnings: [...(input.validationWarnings || []), ...warnings],
    neverCopiedCollections: NEVER_COPY_COLLECTIONS,
    safeToCreateDraft: canCreate,
    canCreate,
    applyReadiness: canCreate ? 'READY' : 'BLOCKED_MISSING_DESTINATION_DETAILS',
    sourceStoreId: sourceStore?.id || null,
    sourceStoreCode: sourceStore?.code || sourceStore?.storeCode || sourceStore?.id || null,
    destinationStoreId: input.location.storeCode,
    destinationConflictCount: 0,
    countsByCollection: writesByCollection,
    totalProposedWrites: estimatedWrites,
    dryRunChecksum: planChecksum,
    firestoreWritesPerformed: 0,
  };
}

async function buildProvisioningContext(db, rawData, {
  allowExistingStoreId = '',
  allowUnconfirmedDuplicateName = false,
  validationMode = 'CREATE',
} = {}) {
  const input = validateProvisioningInput(rawData, { mode: validationMode });
  const duplicateStores = await getDuplicateStores(db, input.location.storeCode, input.location.displayName);
  const conflictingCodeMatches = duplicateStores.codeMatches.filter((storeDoc) => storeDoc.id !== allowExistingStoreId);
  const conflictingNameMatches = duplicateStores.nameMatches.filter((storeDoc) => storeDoc.id !== allowExistingStoreId);
  if (conflictingCodeMatches.length > 0) {
    fail('already-exists', `Store code ${input.location.storeCode} already exists.`);
  }
  const duplicateNameWarning = conflictingNameMatches.length > 0
    ? `A location named ${input.location.displayName} already exists.`
    : '';
  if (duplicateNameWarning && !input.confirmDuplicateName && !allowUnconfirmedDuplicateName) {
    fail('already-exists', `${duplicateNameWarning} Confirm the duplicate normalized name to continue.`);
  }
  const sourceStore = await resolveSourceStore(db, input.templateMode, input.sourceStoreId);
  const [sourceConfiguration, staffAssignmentPlan] = await Promise.all([
    loadSourceConfiguration(db, sourceStore, input.selectedModules),
    buildStaffAssignmentPlan(db, input.location.storeCode, input.staffAssignmentUids),
  ]);
  return {
    input,
    sourceStore,
    sourceConfiguration,
    staffAssignmentPlan,
    preview: buildPreviewResponse({
      input,
      sourceStore,
      sourceConfiguration,
      duplicateNameWarning,
      staffAssignmentPlan,
    }),
  };
}

async function countAssignedStaff(db, storeId) {
  const usersSnap = await db.collection('users').get();
  return usersSnap.docs.filter((userDoc) => {
    const profile = userDoc.data() || {};
    const assigned = unique([
      ...(Array.isArray(profile.storeIds) ? profile.storeIds : []),
      ...(Array.isArray(profile.assignedStoreIds) ? profile.assignedStoreIds : []),
    ]);
    return profile.isActive === true && assigned.includes(storeId);
  }).length;
}

async function loadReadinessCounts(db, store) {
  const [finishedGoodsSnap, storeStockSnap, staffCount, addOnGroupsSnap] = await Promise.all([
    db.collection('finishedGoods').where('availableStoreIds', 'array-contains', store.id).get(),
    db.collection('storeStock').where('storeId', '==', store.id).get(),
    countAssignedStaff(db, store.id),
    db.collection('addOnGroups').get(),
  ]);
  const enabledMenuItems = finishedGoodsSnap.docs
    .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
    .filter((item) => item.isActive !== false && item.isSellable !== false && item.isAvailable !== false);
  const addOnGroupIds = new Set(addOnGroupsSnap.docs.map((docSnap) => docSnap.id));
  const invalidProductAvailabilityCount = enabledMenuItems.filter((item) => (
    !Array.isArray(item.availableStoreIds) || !item.availableStoreIds.includes(store.id)
  )).length;
  const invalidAddOnReferenceCount = enabledMenuItems.filter((item) => (
    unique(item.addOnGroupIds || item.addonGroupIds).some((groupId) => !addOnGroupIds.has(groupId))
  )).length;
  const invalidKotRoutingCount = enabledMenuItems.filter((item) => {
    const station = cleanText(item.prepStation || 'NONE', 40).toUpperCase();
    const operational = item.itemType === 'MADE_TO_ORDER' || station !== 'NONE';
    return operational && !['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(station);
  }).length;
  return {
    menuProductCount: finishedGoodsSnap.size,
    inventoryRowCount: storeStockSnap.size,
    staffCount,
    invalidProductAvailabilityCount,
    invalidAddOnReferenceCount,
    invalidKotRoutingCount,
    gstRate: number(store.gstRate),
  };
}

async function writeProvisioningAudit(db, admin, payload) {
  await db.collection('storeProvisioningAudit').doc().set({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function applyProvisioningOperations({
  admin,
  db,
  adminUser,
  jobId,
  destinationStore,
  context,
  jobRef,
}) {
  const timestamp = FieldValue.serverTimestamp();
  const operations = [];
  const selectedModules = context.input.selectedModules;

  if (selectedModules.includes('MENU')) {
    context.sourceConfiguration.menuDocs.forEach((entry) => {
      operations.push({
        key: `ASSIGN:${entry.collection}/${entry.id}`,
        type: 'UPDATE_ASSIGNMENT',
        ref: db.collection(entry.collection).doc(entry.id),
        payload: {
          availableStoreIds: unique([...(entry.data.availableStoreIds || []), destinationStore.id]),
          updatedAt: timestamp,
        },
      });
    });
  }

  if (selectedModules.includes('INVENTORY')) {
    context.sourceConfiguration.inventoryDocs.forEach((entry) => {
      const destinationId = destinationInventoryId(destinationStore.id, entry);
      const destinationRef = db.collection(entry.collection).doc(destinationId);
      const quantity = inventoryQuantityForOption(entry.data, context.input.inventoryOption);
      operations.push({
        key: `CREATE:${entry.collection}/${destinationId}`,
        type: 'CREATE',
        ref: destinationRef,
        payload: cloneInventoryPayload({
          entry,
          destinationStore,
          inventoryOption: context.input.inventoryOption,
          adminUid: adminUser.uid,
          jobId,
          timestamp,
        }),
      });

      if (context.input.inventoryOption !== 'STRUCTURE_ONLY' && quantity !== 0) {
        const movementId = `${jobId}_${destinationId}_OPENING`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 400);
        operations.push({
          key: `CREATE:stockMovements/${movementId}`,
          type: 'CREATE',
          ref: db.collection('stockMovements').doc(movementId),
          payload: {
            storeId: destinationStore.id,
            storeCode: destinationStore.code,
            storeName: destinationStore.name,
            stockItemType: entry.data.stockItemType || 'ITEM',
            stockItemCode: entry.data.stockItemCode || entry.data.inventoryItemId || entry.id,
            stockItemName: entry.data.stockItemName || entry.data.inventoryItemName || entry.id,
            movementType: 'STORE_PROVISIONING_OPENING',
            quantity,
            quantityDelta: quantity,
            previousQty: 0,
            newQty: quantity,
            stockBefore: 0,
            stockAfter: quantity,
            unit: entry.data.uom || entry.data.unit || '',
            source: 'STORE_PROVISIONING',
            referenceType: 'STORE_PROVISIONING_JOB',
            referenceId: jobId,
            reason: context.input.inventoryReason || 'Approved store provisioning opening balance',
            provisioningJobId: jobId,
            createdBy: adminUser.uid,
            createdByName: adminUser.name,
            createdAt: timestamp,
          },
        });
      }
    });
  }

  (context.staffAssignmentPlan?.changes || []).forEach((change) => {
    operations.push({
      key: `ASSIGN_STAFF:users/${change.uid}`,
      type: 'UPDATE_STAFF_ASSIGNMENT',
      ref: db.collection('users').doc(change.uid),
      payload: {
        assignedStoreIds: change.after,
        storeIds: change.after,
        updatedAt: timestamp,
      },
    });
  });

  let completed = 0;
  for (let offset = 0; offset < operations.length; offset += BATCH_SIZE) {
    const chunk = operations.slice(offset, offset + BATCH_SIZE);
    const createOperations = chunk.filter((operation) => operation.type === 'CREATE');
    const createSnapshots = createOperations.length > 0
      ? await db.getAll(...createOperations.map((operation) => operation.ref))
      : [];
    const createState = new Map(createSnapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
    const batch = db.batch();
    let chunkWrites = 0;

    for (const operation of chunk) {
      if (operation.type === 'UPDATE_ASSIGNMENT' || operation.type === 'UPDATE_STAFF_ASSIGNMENT') {
        batch.update(operation.ref, operation.payload);
        chunkWrites += 1;
        continue;
      }
      const existing = createState.get(operation.ref.path);
      if (existing?.exists) {
        const existingData = existing.data() || {};
        if (existingData.provisioningJobId !== jobId) {
          fail('already-exists', `Provisioning target already exists: ${operation.ref.path}`);
        }
        continue;
      }
      batch.create(operation.ref, operation.payload);
      chunkWrites += 1;
    }

    if (chunkWrites > 0) await batch.commit();
    completed += chunk.length;
    await jobRef.set({
      status: 'IN_PROGRESS',
      completedOperationCount: completed,
      totalOperationCount: operations.length,
      updatedAt: timestamp,
    }, { merge: true });
  }

  if ((context.staffAssignmentPlan?.changes || []).length > 0) {
    await writeProvisioningAudit(db, admin, {
      storeId: destinationStore.id,
      action: 'SAVE_STAFF_ASSIGNMENTS',
      actorUid: adminUser.uid,
      actorName: adminUser.name,
      provisioningJobId: jobId,
      changedUsers: context.staffAssignmentPlan.changes.map((change) => ({
        uid: change.uid,
        email: change.email,
        name: change.name,
        role: change.role,
        previousStoreIds: change.before,
        resultingStoreIds: change.after,
      })),
    });
  }

  return { totalOperationCount: operations.length, completedOperationCount: completed };
}

function validateOpeningStockRows(store, stockDocs, submittedRows = [], { confirmAllZero = false, typedConfirmation = '' } = {}) {
  const storeCode = cleanText(store.code || store.storeCode || store.id, 80);
  const stockById = new Map(stockDocs.map((docSnap) => [docSnap.id, { id: docSnap.id, ...(docSnap.data() || {}) }]));
  if (stockById.size === 0) {
    return { valid: false, errors: ['Inventory rows must be created before opening stock can be confirmed.'], rows: [] };
  }
  if (confirmAllZero && normalizeStoreCode(typedConfirmation) !== normalizeStoreCode(storeCode)) {
    return { valid: false, errors: [`Type ${storeCode} to confirm all opening quantities are zero.`], rows: [] };
  }
  const errors = [];
  const submittedById = new Map();
  if (!confirmAllZero) {
    for (const row of Array.isArray(submittedRows) ? submittedRows : []) {
      const stockId = cleanText(row.stockId || row.id, 240);
      if (!stockId || !stockById.has(stockId)) {
        errors.push(`Unknown inventory row: ${stockId || '(blank)'}.`);
        continue;
      }
      if (submittedById.has(stockId)) errors.push(`Duplicate inventory row submitted: ${stockId}.`);
      submittedById.set(stockId, row);
    }
    for (const stockId of stockById.keys()) {
      if (!submittedById.has(stockId)) errors.push(`Missing inventory row: ${stockId}.`);
    }
  }
  const rows = [...stockById.values()].map((stock) => {
    const submitted = confirmAllZero ? {} : submittedById.get(stock.id) || {};
    const unit = normalizeUnit(stock.uom || stock.unit);
    const openingStock = confirmAllZero ? 0 : setupNumber(submitted.openingStock);
    const costPerUnit = confirmAllZero ? number(stock.costPerUnit) : setupNumber(submitted.costPerUnit ?? stock.costPerUnit ?? 0);
    const confirmed = confirmAllZero ? true : submitted.confirmed === true;
    if (!isSupportedInventoryUnit(unit)) {
      errors.push(`${stock.stockItemCode || stock.id}: ${unit || 'this unit'} is not a supported opening-stock unit.`);
    }
    if (!Number.isFinite(openingStock) || openingStock < 0) errors.push(`${stock.stockItemCode || stock.id}: opening quantity must be zero or positive.`);
    if (isSupportedInventoryUnit(unit) && !unitAllowsDecimal(unit) && Number.isFinite(openingStock) && !Number.isInteger(openingStock)) {
      errors.push(`${stock.stockItemCode || stock.id}: ${unit || 'this unit'} requires a whole-number quantity.`);
    }
    if (!Number.isFinite(costPerUnit) || costPerUnit < 0) errors.push(`${stock.stockItemCode || stock.id}: unit cost cannot be negative.`);
    if (!confirmed) errors.push(`${stock.stockItemCode || stock.id}: row must be confirmed.`);
    return {
      stock,
      openingStock: roundedQuantity(openingStock),
      currentStock: roundedQuantity(openingStock),
      costPerUnit: roundedQuantity(costPerUnit),
      confirmed,
      unit,
    };
  });
  return { valid: errors.length === 0, errors, rows };
}

async function saveOpeningStockSetup({ admin, db, adminUser, storeId, rows, confirmAllZero = false, typedConfirmation = '' }) {
  const storeRef = db.collection('stores').doc(storeId);
  const storeSnap = await storeRef.get();
  if (!storeSnap.exists) fail('not-found', 'Location not found.');
  const store = { id: storeSnap.id, ...(storeSnap.data() || {}) };
  if (store.isActive === true || store.status === 'ACTIVE') {
    fail('failed-precondition', 'Opening stock setup is only available before POS activation.');
  }
  const stockSnap = await db.collection('storeStock').where('storeId', '==', storeId).get();
  const validation = validateOpeningStockRows(store, stockSnap.docs, rows, { confirmAllZero, typedConfirmation });
  if (!validation.valid) fail('failed-precondition', validation.errors.join(' '));

  const timestamp = FieldValue.serverTimestamp();
  const provisioningJobId = cleanText(store.provisioningJobId || storeId, 120);
  const nonZeroRows = validation.rows.filter((row) => row.openingStock > 0);
  const movementRefs = nonZeroRows.map((row) => (
    db.collection('stockMovements').doc(openingMovementId(storeId, row.stock.id, provisioningJobId))
  ));
  const movementSnaps = movementRefs.length ? await db.getAll(...movementRefs) : [];
  const existingMovementByPath = new Map(movementSnaps.map((snap) => [snap.ref.path, snap]));

  const operations = [];
  const openingStockSource = confirmAllZero ? 'ZERO_CONFIRMATION' : 'LOCATION_WIZARD';
  validation.rows.forEach((row) => {
    const stockAlreadyMatches = sameQuantity(row.stock.openingStock, row.openingStock)
      && sameQuantity(row.stock.currentStock, row.currentStock)
      && sameQuantity(row.stock.costPerUnit, row.costPerUnit)
      && row.stock.openingStockConfirmed === true
      && cleanText(row.stock.openingStockSource, 40) === openingStockSource
      && cleanText(row.stock.provisioningJobId || provisioningJobId, 120) === provisioningJobId;
    if (stockAlreadyMatches) return;
    operations.push({
      type: 'UPDATE_STOCK',
      ref: db.collection('storeStock').doc(row.stock.id),
      payload: {
        openingStock: row.openingStock,
        currentStock: row.currentStock,
        costPerUnit: row.costPerUnit,
        openingStockConfirmed: true,
        openingStockConfirmedBy: adminUser.uid,
        openingStockConfirmedByName: adminUser.name,
        openingStockConfirmedAt: timestamp,
        openingStockSource,
        provisioningJobId,
        updatedAt: timestamp,
      },
    });
  });

  let createdMovementCount = 0;
  nonZeroRows.forEach((row, index) => {
    const ref = movementRefs[index];
    const existing = existingMovementByPath.get(ref.path);
    if (existing?.exists) {
      const data = existing.data() || {};
      if (data.movementType !== 'OPENING_STOCK'
        || number(data.quantityDelta) !== row.openingStock
        || number(data.stockAfter ?? data.newQty) !== row.openingStock) {
        fail('failed-precondition', `Opening movement already exists with different values for ${row.stock.stockItemCode || row.stock.id}.`);
      }
      return;
    }
    createdMovementCount += 1;
    operations.push({
      type: 'CREATE_MOVEMENT',
      ref,
      payload: {
        storeId,
        storeCode: store.code || store.storeCode || storeId,
        storeName: store.name || store.displayName || storeId,
        stockItemType: row.stock.stockItemType || 'ITEM',
        stockItemCode: row.stock.stockItemCode || row.stock.inventoryItemId || row.stock.id,
        stockItemName: row.stock.stockItemName || row.stock.inventoryItemName || row.stock.stockItemCode || row.stock.id,
        movementType: 'OPENING_STOCK',
        quantity: row.openingStock,
        quantityDelta: row.openingStock,
        previousQty: 0,
        newQty: row.openingStock,
        stockBefore: 0,
        stockAfter: row.openingStock,
        unit: row.stock.uom || row.stock.unit || '',
        source: 'LOCATION_ONBOARDING',
        referenceType: 'STORE_PROVISIONING_JOB',
        referenceId: provisioningJobId,
        reason: confirmAllZero ? 'Confirmed all opening stock as zero' : 'Location wizard opening stock',
        provisioningJobId,
        createdBy: adminUser.uid,
        createdByName: adminUser.name,
        createdAt: timestamp,
      },
    });
  });

  const storeReadiness = store.readiness || {};
  const storeNeedsOpeningStockReview = store.openingStockConfirmed !== true
    || storeReadiness.openingStockReviewed !== true;
  if (storeNeedsOpeningStockReview) {
    operations.push({
      type: 'UPDATE_STORE',
      ref: storeRef,
      payload: {
        openingStockConfirmed: true,
        'readiness.openingStockReviewed': true,
        openingStockConfirmedBy: adminUser.uid,
        openingStockConfirmedByName: adminUser.name,
        openingStockConfirmedAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  for (let offset = 0; offset < operations.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    operations.slice(offset, offset + BATCH_SIZE).forEach((operation) => {
      if (operation.type === 'CREATE_MOVEMENT') batch.create(operation.ref, operation.payload);
      else batch.update(operation.ref, operation.payload);
    });
    await batch.commit();
  }
  if (operations.length > 0) {
    await writeProvisioningAudit(db, admin, {
      storeId,
      action: confirmAllZero ? 'CONFIRM_ZERO_OPENING_STOCK' : 'SAVE_OPENING_STOCK',
      actorUid: adminUser.uid,
      actorName: adminUser.name,
      provisioningJobId,
      inventoryRowCount: validation.rows.length,
      nonZeroOpeningRows: nonZeroRows.length,
      createdMovementCount,
      totalOpeningQuantity: roundedQuantity(nonZeroRows.reduce((sum, row) => sum + row.openingStock, 0)),
    });
  }
  return {
    storeId,
    inventoryRowCount: validation.rows.length,
    nonZeroOpeningRows: nonZeroRows.length,
    openingStockReviewed: true,
    idempotent: operations.length === 0,
  };
}

async function saveStaffAssignments({ admin, db, adminUser, storeId, selectedUserIds }) {
  const storeRef = db.collection('stores').doc(storeId);
  const storeSnap = await storeRef.get();
  if (!storeSnap.exists) fail('not-found', 'Location not found.');
  const store = storeSnap.data() || {};
  if (store.status === 'ARCHIVED') fail('failed-precondition', 'Archived locations cannot be assigned staff.');
  const plan = await buildStaffAssignmentPlan(db, storeId, selectedUserIds);
  if (plan.validationErrors.length > 0) {
    fail('failed-precondition', plan.validationErrors.map((issue) => issue.message).join(' '));
  }
  const timestamp = FieldValue.serverTimestamp();
  const storeReadiness = store.readiness || {};
  const storeStaffNeedsUpdate = number(store.assignedStaffCount) !== plan.selectedCount
    || storeReadiness.staffAssigned !== true;
  if (plan.changes.length === 0 && !storeStaffNeedsUpdate) {
    return {
      storeId,
      assignedStaffCount: plan.selectedCount,
      changedUserCount: 0,
      staffAssigned: true,
      idempotent: true,
    };
  }
  for (let offset = 0; offset < plan.changes.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    plan.changes.slice(offset, offset + BATCH_SIZE).forEach((change) => {
      batch.update(db.collection('users').doc(change.uid), {
        assignedStoreIds: change.after,
        storeIds: change.after,
        updatedAt: timestamp,
      });
    });
    await batch.commit();
  }
  await storeRef.update({
    assignedStaffCount: plan.selectedCount,
    'readiness.staffAssigned': true,
    staffAssignmentReviewedAt: timestamp,
    staffAssignmentReviewedBy: adminUser.uid,
    updatedAt: timestamp,
  });
  await writeProvisioningAudit(db, admin, {
    storeId,
    action: 'SAVE_STAFF_ASSIGNMENTS',
    actorUid: adminUser.uid,
    actorName: adminUser.name,
    changedUsers: plan.changes.map((change) => ({
      uid: change.uid,
      email: change.email,
      name: change.name,
      role: change.role,
      previousStoreIds: change.before,
      resultingStoreIds: change.after,
    })),
  });
  return {
    storeId,
    assignedStaffCount: plan.selectedCount,
    changedUserCount: plan.changes.length,
    staffAssigned: true,
    idempotent: false,
  };
}

function createStoreProvisioningFunctions({ admin, db, region = REGION }) {
  const previewStoreProvisioning = onCall({ region, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    await requireActiveAdmin(db, request);
    const context = await buildProvisioningContext(db, request.data || {}, {
      allowUnconfirmedDuplicateName: true,
      validationMode: 'PREVIEW',
    });
    return context.preview;
  });

  const createStoreFromTemplate = onCall({ region, timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const data = request.data || {};
    const jobId = cleanText(data.provisioningJobId, 120);
    if (!isValidJobId(jobId)) fail('invalid-argument', 'A valid provisioning job ID is required.');
    const jobRef = db.collection('storeProvisioningJobs').doc(jobId);
    const existingJob = await jobRef.get();
    const validatedInput = validateProvisioningInput(data);
    const requestChecksum = provisioningRequestChecksum(validatedInput);
    if (existingJob.exists
      && existingJob.data()?.requestChecksum
      && existingJob.data()?.requestChecksum !== requestChecksum) {
      fail('already-exists', 'This provisioning job ID belongs to a different request.');
    }
    if (existingJob.exists && existingJob.data()?.status === 'COMPLETED') {
      const requestedDestinationId = normalizeStoreCode(data.location?.storeCode || data.location?.code);
      if (existingJob.data()?.destinationStoreId !== requestedDestinationId) {
        fail('already-exists', 'This provisioning job ID belongs to another destination.');
      }
      return {
        idempotent: true,
        storeId: requestedDestinationId,
        jobId,
        status: 'COMPLETED',
        message: 'Location already created as Draft.',
      };
    }
    const allowedExistingStoreId = existingJob.exists ? cleanText(existingJob.data()?.destinationStoreId, 80) : '';
    const context = await buildProvisioningContext(db, data, { allowExistingStoreId: allowedExistingStoreId });
    if (cleanText(data.previewChecksum, 64) !== context.preview.planChecksum) {
      fail('failed-precondition', 'The source configuration changed after preview. Run Preview again before creating the Draft.');
    }
    if (!context.preview.safeToCreateDraft) {
      const validationMessage = (context.preview.validationErrors || []).map((issue) => issue.message).join(' ');
      fail('failed-precondition', validationMessage || context.preview.warnings.join(' '));
    }
    const destinationId = context.input.location.storeCode;
    const destinationRef = db.collection('stores').doc(destinationId);
    const timestamp = FieldValue.serverTimestamp();

    await db.runTransaction(async (transaction) => {
      const [destinationSnap, jobSnap] = await Promise.all([
        transaction.get(destinationRef),
        transaction.get(jobRef),
      ]);
      if (destinationSnap.exists && destinationSnap.data()?.provisioningJobId !== jobId) {
        fail('already-exists', `Destination stores/${destinationId} already exists.`);
      }
      if (jobSnap.exists && jobSnap.data()?.destinationStoreId !== destinationId) {
        fail('already-exists', 'Provisioning job ID collision.');
      }
      if (!destinationSnap.exists) {
        transaction.create(destinationRef, buildDraftStorePayload({
          details: context.input.location,
          sourceStore: context.sourceStore,
          selectedModules: context.input.selectedModules,
          createdBy: adminUser.uid,
          provisioningJobId: jobId,
          timestamp,
        }));
      }
      const jobRecord = buildSafeJobRecord({
        jobId,
        sourceStoreId: context.sourceStore?.id || null,
        destinationStoreId: destinationId,
        selectedModules: context.input.selectedModules,
        inventoryOption: context.input.inventoryOption,
        reason: context.input.inventoryReason,
        adminUid: adminUser.uid,
        status: 'IN_PROGRESS',
        counts: context.preview.counts,
        requestChecksum,
        timestamp,
      });
      if (jobSnap.exists) transaction.set(jobRef, jobRecord, { merge: true });
      else transaction.create(jobRef, { ...jobRecord, createdAt: timestamp });
    });

    try {
      const operationResult = await applyProvisioningOperations({
        admin,
        db,
        adminUser,
        jobId,
        destinationStore: {
          id: destinationId,
          code: destinationId,
          name: context.input.location.displayName,
        },
        context,
        jobRef,
      });
      const readinessPatch = {
        'readiness.menuCopied': context.input.selectedModules.includes('MENU')
          && context.sourceConfiguration.menuDocs.some((entry) => entry.collection === 'finishedGoods'),
        'readiness.inventoryStructureCreated': context.input.selectedModules.includes('INVENTORY')
          && context.sourceConfiguration.inventoryDocs.length > 0,
        updatedAt: timestamp,
      };
      await destinationRef.update(readinessPatch);
      await jobRef.set({
        status: 'COMPLETED',
        ...operationResult,
        completedAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });
      return {
        idempotent: false,
        storeId: destinationId,
        jobId,
        status: 'COMPLETED',
        counts: context.preview.counts,
        message: 'Location created as Draft. No historical transactions or staff accounts were copied.',
      };
    } catch (error) {
      const message = safeError(error);
      await jobRef.set({
        status: 'FAILED',
        error: message,
        failedAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true }).catch(() => {});
      console.error('store-provisioning-failed', {
        jobId,
        destinationStoreId: destinationId,
        errorCode: error?.code || 'UNKNOWN',
        message,
      });
      throw error;
    }
  });

  const updateStoreConfiguration = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const data = request.data || {};
    const storeId = cleanText(data.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const action = cleanText(data.action || 'UPDATE', 40);
    const timestamp = FieldValue.serverTimestamp();

    if (action === 'CLASSIFY_LEGACY_MIGRATED') {
      const store = { id: storeSnap.id, ...(storeSnap.data() || {}) };
      const storeCode = cleanText(store.code || store.storeCode, 80).toUpperCase();
      if (storeId !== GOLDEN_I_STORE_ID || storeCode !== GOLDEN_I_STORE_ID) {
        fail('failed-precondition', 'Legacy migration compatibility is restricted to stores/GOLDEN_I.');
      }
      if (store.provisioningJobId || store.sourceTemplateStoreId || store.status === 'DRAFT' || store.status === 'INACTIVE') {
        fail('failed-precondition', 'A newly provisioned, Draft, or inactive store cannot use legacy migration compatibility.');
      }
      if (store.isActive !== true || store.onlineOrderingEnabled !== true) {
        fail('failed-precondition', 'Golden I must retain its existing active POS and online-ordering evidence before classification.');
      }
      if (isLegacyMigratedStore(store)) {
        return {
          storeId,
          onboardingMode: LEGACY_MIGRATED_ONBOARDING_MODE,
          auditId: store.legacyMigrationAuditId || null,
          idempotent: true,
        };
      }

      const [snapshot, menuEvidence, orderEvidence] = await Promise.all([
        db.collection('publicMenuAvailability').doc(GOLDEN_I_STORE_ID).get(),
        db.collection('finishedGoods').where('availableStoreIds', 'array-contains', GOLDEN_I_STORE_ID).limit(1).get(),
        db.collection('orders').where('storeId', '==', GOLDEN_I_STORE_ID).limit(1).get(),
      ]);
      if (!snapshot.exists || menuEvidence.empty || orderEvidence.empty) {
        fail('failed-precondition', 'Golden I legacy classification requires an existing public menu and historical operating evidence.');
      }

      const auditRef = db.collection('storeProvisioningAudit').doc();
      const batch = db.batch();
      batch.update(storeRef, {
        onboardingMode: LEGACY_MIGRATED_ONBOARDING_MODE,
        legacyMigratedAt: timestamp,
        legacyMigratedBy: adminUser.uid,
        legacyMigrationAuditId: auditRef.id,
        updatedAt: timestamp,
      });
      batch.set(auditRef, {
        storeId,
        action: 'CLASSIFY_LEGACY_MIGRATED_STORE',
        actorUid: adminUser.uid,
        actorName: adminUser.name,
        previousOnboardingMode: store.onboardingMode || null,
        openingStockReadinessChanged: false,
        preservedExistingOperations: true,
        createdAt: timestamp,
      });
      await batch.commit();
      return {
        storeId,
        onboardingMode: LEGACY_MIGRATED_ONBOARDING_MODE,
        auditId: auditRef.id,
        idempotent: false,
      };
    }

    if (action === 'DEACTIVATE') {
      await storeRef.update({
        status: 'INACTIVE',
        isActive: false,
        posEnabled: false,
        onlineOrderingEnabled: false,
        customerOrderingEnabled: false,
        publicOrderingEnabled: false,
        acceptingOrders: false,
        isAcceptingOrders: false,
        onlineOrderingPaused: true,
        deactivatedBy: adminUser.uid,
        deactivatedAt: timestamp,
        updatedAt: timestamp,
      });
      return { storeId, status: 'INACTIVE' };
    }

    const rawPatch = data.patch && typeof data.patch === 'object' && !Array.isArray(data.patch)
      ? data.patch
      : {};
    assertNoSystemManagedStoreConfigPatch(rawPatch);
    const patch = {};
    Object.entries(rawPatch).forEach(([key, value]) => {
      if (SAFE_EDIT_FIELDS.has(key)) patch[key] = value;
    });
    if (Object.keys(patch).length === 0) fail('invalid-argument', 'No safe configuration fields were supplied.');
    patch.updatedBy = adminUser.uid;
    patch.updatedAt = timestamp;
    await storeRef.update(patch);
    return { storeId, status: storeSnap.data()?.status || 'DRAFT' };
  });

  const enableInternalPosTest = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const store = storeSnap.data() || {};
    if (store.status === 'ACTIVE' || store.isActive === true) {
      fail('failed-precondition', 'Internal POS testing is only for Draft or Setup locations.');
    }
    if (store.internalPosTestEnabled === true && store.posEnabled === true && store.setupTestMode === true) {
      return {
        storeId,
        status: store.status || 'DRAFT',
        internalPosTestEnabled: true,
        idempotent: true,
      };
    }
    const timestamp = FieldValue.serverTimestamp();
    await storeRef.update({
      status: store.status || 'DRAFT',
      isActive: false,
      posEnabled: true,
      internalPosTestEnabled: true,
      setupTestMode: true,
      onlineOrderingEnabled: false,
      customerOrderingEnabled: false,
      publicOrderingEnabled: false,
      acceptingOrders: false,
      isAcceptingOrders: false,
      onlineOrderingPaused: true,
      internalPosTestEnabledBy: adminUser.uid,
      internalPosTestEnabledAt: timestamp,
      updatedAt: timestamp,
    });
    await writeProvisioningAudit(db, admin, {
      storeId,
      action: 'ENABLE_INTERNAL_POS_TEST',
      actorUid: adminUser.uid,
      actorName: adminUser.name,
    });
    return { storeId, status: store.status || 'DRAFT', internalPosTestEnabled: true };
  });

  const markInternalPosTestPassed = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const store = storeSnap.data() || {};
    if (store.posTestCompleted === true && store.readiness?.posTestCompleted === true) {
      return {
        storeId,
        posTestCompleted: true,
        idempotent: true,
      };
    }
    if (store.internalPosTestEnabled !== true) {
      fail('failed-precondition', 'Enable internal POS testing before marking the test complete.');
    }
    const setupOrdersSnap = await db.collection('orders')
      .where('storeId', '==', storeId)
      .where('isSetupTest', '==', true)
      .get();
    const setupOrders = setupOrdersSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    const voidedSetupOrder = setupOrders.find((order) => (
      order.status === 'VOIDED'
      && order.paymentMethod === 'CASH'
      && (order.paymentProvider === undefined || order.paymentProvider === null || order.paymentProvider === 'PAY_AT_COUNTER')
    ));
    if (!voidedSetupOrder) {
      fail('failed-precondition', 'Create and void one SETUP TEST cash order before marking the POS test complete.');
    }
    const [kotSnap, saleMovementSnap, reversalMovementSnap] = await Promise.all([
      db.collection('kotItems').where('storeId', '==', storeId).where('orderId', '==', voidedSetupOrder.id).get(),
      db.collection('stockMovements').where('storeId', '==', storeId).where('orderId', '==', voidedSetupOrder.id).get(),
      db.collection('stockMovements').where('storeId', '==', storeId).where('movementType', '==', 'ORDER_VOID_REVERSAL').get(),
    ]);
    const saleMovements = saleMovementSnap.docs.map((docSnap) => docSnap.data() || {});
    const reversalMovements = reversalMovementSnap.docs
      .map((docSnap) => docSnap.data() || {})
      .filter((movement) => (
        movement.orderId === voidedSetupOrder.id
        || movement.sourceOrderId === voidedSetupOrder.id
        || movement.voidedOrderId === voidedSetupOrder.id
        || movement.orderNumber === voidedSetupOrder.orderNumber
        || movement.referenceId === voidedSetupOrder.id
      ));
    if (kotSnap.empty) fail('failed-precondition', 'The setup-test order must generate KOT records.');
    if (saleMovements.filter((movement) => movement.movementType !== 'ORDER_VOID_REVERSAL').length === 0) {
      fail('failed-precondition', 'The setup-test order must create stock deduction movements.');
    }
    if (reversalMovements.length === 0) {
      fail('failed-precondition', 'Void the setup-test order and verify stock reversal before completing POS test.');
    }
    const timestamp = FieldValue.serverTimestamp();
    await storeRef.update({
      posTestCompleted: true,
      'readiness.posTestCompleted': true,
      posTestCompletedBy: adminUser.uid,
      posTestCompletedByName: adminUser.name,
      posTestCompletedAt: timestamp,
      updatedAt: timestamp,
    });
    await writeProvisioningAudit(db, admin, {
      storeId,
      action: 'MARK_INTERNAL_POS_TEST_PASSED',
      actorUid: adminUser.uid,
      actorName: adminUser.name,
      setupTestOrderId: voidedSetupOrder.id,
      setupTestOrderNumber: voidedSetupOrder.orderNumber || null,
      kotCount: kotSnap.size,
      saleMovementCount: saleMovements.filter((movement) => movement.movementType !== 'ORDER_VOID_REVERSAL').length,
      reversalMovementCount: reversalMovements.length,
    });
    return { storeId, posTestCompleted: true };
  });

  const saveLocationOpeningStock = onCall({ region, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    return saveOpeningStockSetup({
      admin,
      db,
      adminUser,
      storeId,
      rows: request.data?.rows || [],
      confirmAllZero: request.data?.confirmAllZero === true,
      typedConfirmation: request.data?.typedConfirmation || '',
    });
  });

  const saveLocationStaffAssignments = onCall({ region, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    return saveStaffAssignments({
      admin,
      db,
      adminUser,
      storeId,
      selectedUserIds: request.data?.selectedUserIds || request.data?.selectedUids || [],
    });
  });

  const setPosLaunchException = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    const enabled = request.data?.enabled !== false;
    const reason = cleanText(request.data?.reason, 300);
    if (storeId !== BAKED_BY_BOND_51_STORE_ID) {
      fail('failed-precondition', 'POS launch exception is approved only for BAKED_BY_BOND_51.');
    }
    if (!reason || reason.length < 10) {
      fail('invalid-argument', 'A launch-exception reason is required.');
    }

    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const store = { id: storeSnap.id, ...(storeSnap.data() || {}) };
    const nowMs = Date.now();
    const nowTimestamp = Timestamp.fromMillis(nowMs);
    const timestamp = FieldValue.serverTimestamp();

    if (!enabled) {
      if (store.posLaunchException?.enabled !== true) {
        return { storeId, enabled: false, idempotent: true };
      }
      const auditRef = db.collection('storeProvisioningAudit').doc();
      const batch = db.batch();
      batch.update(storeRef, {
        'posLaunchException.enabled': false,
        'posLaunchException.disabledAt': nowTimestamp,
        'posLaunchException.disabledBy': adminUser.uid,
        'posLaunchException.disabledReason': reason,
        updatedAt: timestamp,
      });
      batch.set(auditRef, {
        storeId,
        action: 'DISABLE_POS_LAUNCH_EXCEPTION',
        actorUid: adminUser.uid,
        actorName: adminUser.name,
        reason,
        previousException: store.posLaunchException || null,
        createdAt: timestamp,
      });
      await batch.commit();
      return { storeId, enabled: false, auditId: auditRef.id };
    }

    if (!openingStockIsPending(store)) {
      fail('failed-precondition', 'Opening stock is already confirmed; POS launch exception is not required.');
    }
    if (!customerOrderingIsDisabled(store)) {
      fail('failed-precondition', 'Customer ordering must be disabled before a staff-POS launch exception can be approved.');
    }
    const expiresAtMs = timestampMillis(request.data?.expiresAt);
    if (!expiresAtMs || expiresAtMs <= nowMs) {
      fail('invalid-argument', 'A future expiry timestamp is required.');
    }
    if (expiresAtMs > nowMs + POS_LAUNCH_EXCEPTION_MAX_MS) {
      fail('failed-precondition', 'POS launch exception expiry cannot exceed 48 hours.');
    }

    const counts = await loadReadinessCounts(db, store);
    const readiness = readinessResult(store, counts);
    const otherBlockingKeys = readiness.blockingKeys.filter((key) => key !== 'openingStockReviewed');
    if (otherBlockingKeys.length > 0) {
      fail('failed-precondition', `All other POS readiness checks must pass first: ${otherBlockingKeys.map((key) => READINESS_STEP_LABELS[key] || key).join(', ')}`);
    }

    const expiresAt = Timestamp.fromMillis(expiresAtMs);
    const existing = store.posLaunchException || {};
    if (
      existing.enabled === true
      && cleanText(existing.reason, 300) === reason
      && timestampMillis(existing.expiresAt) === expiresAtMs
    ) {
      return { storeId, enabled: true, expiresAt: expiresAt.toDate().toISOString(), idempotent: true };
    }

    const auditRef = db.collection('storeProvisioningAudit').doc();
    const exception = {
      enabled: true,
      scope: 'STAFF_POS_ONLY',
      reason,
      approvedBy: adminUser.uid,
      approvedByName: adminUser.name,
      approvedAt: nowTimestamp,
      expiresAt,
      maxHours: 48,
      openingStockRequired: true,
      customerOrderingDisabled: true,
      auditId: auditRef.id,
      message: POS_LAUNCH_EXCEPTION_MESSAGE,
    };
    const batch = db.batch();
    batch.update(storeRef, {
      posLaunchException: exception,
      updatedAt: timestamp,
      updatedBy: adminUser.uid,
    });
    batch.set(auditRef, {
      storeId,
      action: 'SET_POS_LAUNCH_EXCEPTION',
      actorUid: adminUser.uid,
      actorName: adminUser.name,
      reason,
      expiresAt,
      openingStockPending: true,
      customerOrderingDisabled: true,
      readiness,
      previousException: existing || null,
      createdAt: timestamp,
    });
    await batch.commit();
    return { storeId, enabled: true, expiresAt: expiresAt.toDate().toISOString(), auditId: auditRef.id, readiness };
  });

  const activateStore = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const store = { id: storeSnap.id, ...(storeSnap.data() || {}) };
    if (isLegacyMigratedStore(store)) {
      if (store.isActive === true && store.status === 'ACTIVE' && store.posEnabled === true) {
        return {
          storeId,
          status: 'ACTIVE',
          posEnabled: true,
          customerOrderingEnabled: store.customerOrderingEnabled === true,
          idempotent: true,
        };
      }
      const counts = await loadReadinessCounts(db, store);
      const readiness = readinessResult(store, counts);
      if (!readiness.posReady) {
        fail('failed-precondition', `Migrated location is not ready: ${readiness.friendlyPosBlockingSteps.join(', ')}`);
      }
      const timestamp = FieldValue.serverTimestamp();
      await storeRef.update({
        status: 'ACTIVE',
        operationalStatus: 'ACTIVE',
        isActive: true,
        posEnabled: true,
        updatedAt: timestamp,
        updatedBy: adminUser.uid,
      });
      await writeProvisioningAudit(db, admin, {
        storeId,
        action: 'NORMALIZE_LEGACY_MIGRATED_POS',
        actorUid: adminUser.uid,
        actorName: adminUser.name,
        readiness,
      });
      return {
        storeId,
        status: 'ACTIVE',
        posEnabled: true,
        customerOrderingEnabled: store.customerOrderingEnabled === true,
        readiness,
      };
    }
    if (store.isActive === true && store.status === 'ACTIVE') {
      return {
        storeId,
        status: 'ACTIVE',
        posEnabled: true,
        customerOrderingEnabled: store.customerOrderingEnabled === true || store.onlineOrderingEnabled === true,
        idempotent: true,
      };
    }
    const counts = await loadReadinessCounts(db, store);
    const readiness = readinessResult(store, counts);
    if (!readiness.posReady) {
      fail('failed-precondition', `Location is not ready: ${(readiness.friendlyPosBlockingSteps || readiness.friendlyBlockingSteps).join(', ')}`);
    }
    const timestamp = FieldValue.serverTimestamp();
    await storeRef.update({
      status: 'ACTIVE',
      isActive: true,
      posEnabled: true,
      onlineOrderingEnabled: false,
      customerOrderingEnabled: false,
      publicOrderingEnabled: false,
      acceptingOrders: false,
      isAcceptingOrders: false,
      onlineOrderingPaused: true,
      operationalStatus: 'ACTIVE',
      internalPosTestEnabled: false,
      setupTestMode: false,
      activatedBy: adminUser.uid,
      activatedAt: timestamp,
      updatedAt: timestamp,
    });
    await writeProvisioningAudit(db, admin, {
      storeId,
      action: 'ACTIVATE_POS',
      actorUid: adminUser.uid,
      actorName: adminUser.name,
      readiness,
    });
    return {
      storeId,
      status: 'ACTIVE',
      posEnabled: true,
      customerOrderingEnabled: false,
      readiness,
    };
  });

  const setStoreCustomerOrdering = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    const enabled = request.data?.enabled === true;
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const store = { id: storeSnap.id, ...(storeSnap.data() || {}) };
    if (enabled) {
      const counts = await loadReadinessCounts(db, store);
      const readiness = readinessResult(store, counts);
      const snapshot = await db.collection('publicMenuAvailability').doc(store.code || store.id).get();
      if (!readiness.customerOrderingReady || !snapshot.exists) {
        fail('failed-precondition', 'Customer ordering requires active POS, completed customer-ordering testing, and a public menu snapshot.');
      }
      if (isLegacyMigratedStore(store)) {
        const snapshotData = snapshot.data() || {};
        const menuItems = snapshotData.menuItems && typeof snapshotData.menuItems === 'object' ? snapshotData.menuItems : {};
        const availabilityItems = snapshotData.items && typeof snapshotData.items === 'object' ? snapshotData.items : {};
        const setupIncompletePublished = Object.keys(menuItems).filter((itemCode) => (
          availabilityItems[itemCode]?.publicStatus === 'SETUP_INCOMPLETE'
        ));
        if (setupIncompletePublished.length > 0) {
          fail('failed-precondition', 'Refresh the Golden I public menu before enabling customer ordering; setup-incomplete products must remain unpublished.');
        }
      }
    }
    const timestamp = FieldValue.serverTimestamp();
    await storeRef.update({
      onlineOrderingEnabled: enabled,
      customerOrderingEnabled: enabled,
      publicOrderingEnabled: enabled,
      acceptingOrders: enabled,
      isAcceptingOrders: enabled,
      onlineOrderingPaused: !enabled,
      customerOrderingUpdatedBy: adminUser.uid,
      customerOrderingUpdatedAt: timestamp,
      updatedAt: timestamp,
    });
    return { storeId, customerOrderingEnabled: enabled };
  });

  return {
    previewStoreProvisioning,
    createStoreFromTemplate,
    updateStoreConfiguration,
    enableInternalPosTest,
    markInternalPosTestPassed,
    saveLocationOpeningStock,
    saveLocationStaffAssignments,
    setPosLaunchException,
    activateStore,
    setStoreCustomerOrdering,
  };
}

module.exports = {
  ALL_MODULE_IDS,
  BATCH_SIZE,
  INVENTORY_COLLECTIONS,
  MENU_COLLECTIONS,
  READINESS_STEP_LABELS,
  RECOMMENDED_MODULE_IDS,
  buildPreviewResponse,
  createStoreProvisioningFunctions,
  destinationInventoryId,
  inventoryQuantityForOption,
  openingMovementId,
  setupNumber,
  isSupportedInventoryUnit,
  unitAllowsDecimal,
  SYSTEM_MANAGED_OPENING_STOCK_READINESS_MESSAGE,
  validateOpeningStockRows,
  validateProvisioningInput,
};
