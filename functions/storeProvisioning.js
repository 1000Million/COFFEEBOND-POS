'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  ALL_MODULE_IDS,
  NEVER_COPY_COLLECTIONS,
  RECOMMENDED_MODULE_IDS,
  buildDraftStorePayload,
  buildSafeJobRecord,
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
  'readiness',
]);

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

function validateProvisioningInput(data = {}) {
  const locationValidation = validateLocationDetails(data.location || {});
  if (!locationValidation.valid) {
    fail('invalid-argument', locationValidation.errors.join(' '));
  }
  const selectedModules = sanitizeModules(data.selectedModules || RECOMMENDED_MODULE_IDS);
  const inventoryValidation = validateInventoryOption({
    inventoryOption: data.inventoryOption,
    destinationStoreCode: locationValidation.details.storeCode,
    confirmationStoreCode: data.inventoryConfirmationStoreCode,
    reason: data.inventoryReason,
  });
  if (!inventoryValidation.valid) fail('invalid-argument', inventoryValidation.errors.join(' '));
  if (selectedModules.includes('LEGAL_RECEIPT') && data.confirmLegalEntity !== true) {
    fail('failed-precondition', 'Confirm that the new location uses the same legal entity and GST registration.');
  }
  return {
    location: locationValidation.details,
    selectedModules,
    inventoryOption: inventoryValidation.option,
    inventoryReason: cleanText(data.inventoryReason, 300),
    templateMode: data.templateMode === 'COPY' ? 'COPY' : 'BLANK',
    sourceStoreId: cleanText(data.sourceStoreId, 80),
    confirmDuplicateName: data.confirmDuplicateName === true,
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
    ...menuCounts,
    ...inventoryCounts,
    stockMovements: openingMovementCount,
  };
  const writeOperationsByCollection = Object.fromEntries(
    Object.entries(writesByCollection).map(([collectionName, count]) => [
      collectionName,
      {
        creates: ['stores', 'storeProvisioningJobs', 'storeStock', 'stockMovements'].includes(collectionName)
          ? count
          : 0,
        updates: MENU_COLLECTIONS.includes(collectionName) ? count : 0,
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
    staffAssignmentCount: 0,
    warnings,
    neverCopiedCollections: NEVER_COPY_COLLECTIONS,
    safeToCreateDraft: moduleCompatibility.valid
      && duplicateInventoryTargetIds.length === 0
      && (!duplicateNameWarning || input.confirmDuplicateName),
  };
}

async function buildProvisioningContext(db, rawData, {
  allowExistingStoreId = '',
  allowUnconfirmedDuplicateName = false,
} = {}) {
  const input = validateProvisioningInput(rawData);
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
  const sourceConfiguration = await loadSourceConfiguration(db, sourceStore, input.selectedModules);
  return {
    input,
    sourceStore,
    sourceConfiguration,
    preview: buildPreviewResponse({
      input,
      sourceStore,
      sourceConfiguration,
      duplicateNameWarning,
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
  const [finishedGoodsSnap, storeStockSnap, staffCount] = await Promise.all([
    db.collection('finishedGoods').where('availableStoreIds', 'array-contains', store.id).get(),
    db.collection('storeStock').where('storeId', '==', store.id).get(),
    countAssignedStaff(db, store.id),
  ]);
  return {
    menuProductCount: finishedGoodsSnap.size,
    inventoryRowCount: storeStockSnap.size,
    staffCount,
  };
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
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
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
      if (operation.type === 'UPDATE_ASSIGNMENT') {
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

  return { totalOperationCount: operations.length, completedOperationCount: completed };
}

function createStoreProvisioningFunctions({ admin, db, region = REGION }) {
  const previewStoreProvisioning = onCall({ region, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    await requireActiveAdmin(db, request);
    const context = await buildProvisioningContext(db, request.data || {}, {
      allowUnconfirmedDuplicateName: true,
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
      fail('failed-precondition', context.preview.warnings.join(' '));
    }
    const destinationId = context.input.location.storeCode;
    const destinationRef = db.collection('stores').doc(destinationId);
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

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
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

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

    const patch = {};
    Object.entries(data.patch || {}).forEach(([key, value]) => {
      if (SAFE_EDIT_FIELDS.has(key)) patch[key] = value;
    });
    if (Object.keys(patch).length === 0) fail('invalid-argument', 'No safe configuration fields were supplied.');
    if ('readiness' in patch) {
      const currentReadiness = storeSnap.data()?.readiness || {};
      const nextReadiness = patch.readiness && typeof patch.readiness === 'object' ? patch.readiness : {};
      patch.readiness = { ...currentReadiness, ...nextReadiness };
    }
    patch.updatedBy = adminUser.uid;
    patch.updatedAt = timestamp;
    await storeRef.update(patch);
    return { storeId, status: storeSnap.data()?.status || 'DRAFT' };
  });

  const activateStore = onCall({ region }, async (request) => {
    const adminUser = await requireActiveAdmin(db, request);
    const storeId = cleanText(request.data?.storeId, 80);
    if (!storeId) fail('invalid-argument', 'Store ID is required.');
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) fail('not-found', 'Location not found.');
    const store = { id: storeSnap.id, ...(storeSnap.data() || {}) };
    if (store.isActive === true || store.posEnabled === true) {
      fail('failed-precondition', 'This location is already active.');
    }
    const counts = await loadReadinessCounts(db, store);
    const readiness = readinessResult(store, counts);
    if (!readiness.posReady) {
      fail('failed-precondition', `Location is not ready: ${readiness.blockingKeys.join(', ')}`);
    }
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
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
      activatedBy: adminUser.uid,
      activatedAt: timestamp,
      updatedAt: timestamp,
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
    }
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
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
    activateStore,
    setStoreCustomerOrdering,
  };
}

module.exports = {
  ALL_MODULE_IDS,
  BATCH_SIZE,
  INVENTORY_COLLECTIONS,
  MENU_COLLECTIONS,
  RECOMMENDED_MODULE_IDS,
  buildPreviewResponse,
  createStoreProvisioningFunctions,
  destinationInventoryId,
  inventoryQuantityForOption,
  validateProvisioningInput,
};
