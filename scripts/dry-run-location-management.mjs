#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { destinationInventoryId } = require('../functions/storeProvisioning.js');
const {
  NEVER_COPY_COLLECTIONS,
  RECOMMENDED_MODULE_IDS,
  validateLocationDetails,
} = require('../functions/storeProvisioningPolicy.js');

const PROJECT_ID = 'coffee-bond-pos';
const SOURCE_STORE_CODE = 'NOIDA_51';
const DESTINATION_STORE_ID = 'BAKED_BY_BOND_51';
const DESTINATION_STORE_NAME = 'Baked by Bond 51';
const REPORT_PATH = path.resolve('reports/location-management/baked-by-bond-51-dry-run.json');
const MENU_COLLECTIONS = ['finishedGoods', 'menuItems', 'categories'];
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

function checksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function countStoreDocuments(db, collectionName, storeId) {
  const aggregate = await db.collection(collectionName)
    .where('storeId', '==', storeId)
    .count()
    .get();
  return aggregate.data().count;
}

async function main() {
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID,
  }, `location-dry-run-${Date.now()}`);

  try {
    const db = getFirestore(app);
    const storesSnap = await db.collection('stores').get();
    const stores = storesSnap.docs.map((storeDoc) => ({
      id: storeDoc.id,
      ...(storeDoc.data() || {}),
    }));
    const sourceMatches = stores.filter((store) => (
      String(store.code || store.storeCode || '').trim().toUpperCase() === SOURCE_STORE_CODE
    ));
    const destinationConflicts = stores.filter((store) => (
      store.id === DESTINATION_STORE_ID
      || String(store.code || store.storeCode || '').trim().toUpperCase() === DESTINATION_STORE_ID
    ));

    if (sourceMatches.length !== 1) {
      throw new Error(`Expected exactly one active ${SOURCE_STORE_CODE} source document; found ${sourceMatches.length}.`);
    }

    const source = sourceMatches[0];
    if (source.isActive !== true) {
      throw new Error(`Source stores/${source.id} is not active.`);
    }

    const menuGroups = await Promise.all(MENU_COLLECTIONS.map(async (collectionName) => {
      const snapshot = await db.collection(collectionName)
        .where('availableStoreIds', 'array-contains', source.id)
        .get();
      return snapshot.docs.map((docSnap) => ({
        collection: collectionName,
        id: docSnap.id,
        data: docSnap.data() || {},
      }));
    }));
    const menuDocs = menuGroups.flat();
    const stockSnap = await db.collection('storeStock').where('storeId', '==', source.id).get();
    const stockDocs = stockSnap.docs.map((docSnap) => ({
      collection: 'storeStock',
      id: docSnap.id,
      data: docSnap.data() || {},
    }));
    const usersSnap = await db.collection('users').get();
    const assignedStaffCount = usersSnap.docs.filter((userDoc) => {
      const profile = userDoc.data() || {};
      const storeIds = [
        ...(Array.isArray(profile.storeIds) ? profile.storeIds : []),
        ...(Array.isArray(profile.assignedStoreIds) ? profile.assignedStoreIds : []),
      ];
      return profile.isActive === true && storeIds.includes(source.id);
    }).length;
    const snapshotExists = (await db.collection('publicMenuAvailability').doc(SOURCE_STORE_CODE).get()).exists;
    const excludedCountRows = await Promise.all(COUNTED_EXCLUDED_COLLECTIONS.map(async (collectionName) => [
      collectionName,
      await countStoreDocuments(db, collectionName, source.id),
    ]));
    const sourceOrders = await db.collection('orders').where('storeId', '==', source.id).get();
    const nestedOrderCounts = await Promise.all(sourceOrders.docs.map(async (orderDoc) => {
      const [items, payments] = await Promise.all([
        orderDoc.ref.collection('items').count().get(),
        orderDoc.ref.collection('payments').count().get(),
      ]);
      return {
        items: items.data().count,
        payments: payments.data().count,
      };
    }));
    const skippedDocumentsByCollection = {
      ...Object.fromEntries(excludedCountRows),
      'orders/*/items': nestedOrderCounts.reduce((sum, row) => sum + row.items, 0),
      'orders/*/payments': nestedOrderCounts.reduce((sum, row) => sum + row.payments, 0),
      users: assignedStaffCount,
      publicMenuAvailability: snapshotExists ? 1 : 0,
    };

    const countsByCollection = {
      stores: 1,
      storeProvisioningJobs: 1,
      finishedGoods: menuDocs.filter((entry) => entry.collection === 'finishedGoods').length,
      menuItems: menuDocs.filter((entry) => entry.collection === 'menuItems').length,
      categories: menuDocs.filter((entry) => entry.collection === 'categories').length,
      storeStock: stockDocs.length,
      stockMovements: 0,
    };
    const proposedWrites = [
      {
        operation: 'CREATE',
        path: `stores/${DESTINATION_STORE_ID}`,
        safety: 'Create-only Draft store; blocked until required destination details are supplied.',
      },
      {
        operation: 'CREATE',
        path: 'storeProvisioningJobs/{admin-generated-id}',
        safety: 'Create-only safe audit metadata.',
      },
      ...menuDocs.map((entry) => ({
        operation: 'UPDATE_SHARED_ASSIGNMENT',
        path: `${entry.collection}/${entry.id}`,
        field: 'availableStoreIds',
        change: `Append ${DESTINATION_STORE_ID}; preserve every existing store ID.`,
      })),
      ...stockDocs.map((entry) => ({
        operation: 'CREATE',
        path: `storeStock/${destinationInventoryId(DESTINATION_STORE_ID, entry)}`,
        quantity: 0,
        safety: 'Finished Goods V2 structure only; openingStock and currentStock both zero.',
      })),
    ];
    const planCore = {
      projectId: PROJECT_ID,
      destinationStoreId: DESTINATION_STORE_ID,
      destinationStoreName: DESTINATION_STORE_NAME,
      sourceStoreId: source.id,
      sourceStoreCode: SOURCE_STORE_CODE,
      selectedModules: RECOMMENDED_MODULE_IDS,
      inventoryOption: 'STRUCTURE_ONLY',
      legalGstCopySelected: false,
      countsByCollection,
      proposedWrites,
    };
    const locationValidation = validateLocationDetails({
      displayName: DESTINATION_STORE_NAME,
      storeCode: DESTINATION_STORE_ID,
      timezone: 'Asia/Kolkata',
    });
    const missingRequiredDetails = [
      'Full address',
      'City',
      'State',
      'PIN code',
      'Store phone',
      'Store email',
      'GST registration decision and GSTIN if registered',
      'Receipt name/footer review',
    ];
    const totalProposedWrites = Object.values(countsByCollection).reduce((sum, count) => sum + count, 0);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'READ_ONLY_FIRESTORE_DRY_RUN',
      firestoreWritesPerformed: 0,
      sourceTemplate: {
        documentPath: `stores/${source.id}`,
        id: source.id,
        code: source.code || source.storeCode,
        name: source.name || source.displayName,
        active: source.isActive === true,
      },
      destinationStore: {
        documentPath: `stores/${DESTINATION_STORE_ID}`,
        name: DESTINATION_STORE_NAME,
        displayName: DESTINATION_STORE_NAME,
        code: DESTINATION_STORE_ID,
        storeCode: DESTINATION_STORE_ID,
        address: null,
        city: null,
        state: null,
        pinCode: null,
        phone: null,
        email: null,
        gstRegistered: null,
        gstin: null,
        receiptName: null,
        receiptFooter: null,
        timezone: 'Asia/Kolkata',
        inventoryMode: 'FINISHED_GOODS',
        status: 'DRAFT',
        isActive: false,
        posEnabled: false,
        customerOrderingEnabled: false,
        onlineOrderingEnabled: false,
        publicOrderingEnabled: false,
        acceptingOrders: false,
        onlineOrderingPaused: true,
        assignedStaffCount: 0,
      },
      destinationConflictCount: destinationConflicts.length,
      missingRequiredDetails,
      selectedModules: RECOMMENDED_MODULE_IDS,
      inventoryOption: 'STRUCTURE_ONLY',
      legalGstCopySelected: false,
      customerOrderingInitialStatus: 'DISABLED',
      staffAssignmentsCreated: 0,
      sourceAssignedStaffFoundButNotCopied: assignedStaffCount,
      countsByCollection,
      totalProposedWrites,
      skippedDocumentsByCollection,
      skippedKnownDocumentCount: Object.values(skippedDocumentsByCollection).reduce((sum, count) => sum + count, 0),
      skippedUncountedScopes: [
        'Firebase Authentication accounts',
        'Storage product-image and supplier-invoice objects',
        'unscoped customer and public-tracking documents',
      ],
      neverCopyPolicy: NEVER_COPY_COLLECTIONS,
      proposedWrites,
      warnings: [
        'No production Firebase writes were performed.',
        'The destination remains Draft with POS and customer ordering disabled.',
        'No staff, history, current stock, legal/GST data, or public snapshot will be copied by default.',
        'Menu operations update shared availableStoreIds arrays; existing store IDs are preserved.',
        'Add-on and KOT assignments are global Finished Good references in the current schema and create no duplicate documents.',
      ],
      dryRunChecksum: checksum(planCore),
      canCreate: false,
      validationErrors: locationValidation.issues,
      validationWarnings: [],
      applyReadiness: destinationConflicts.length > 0
        ? 'BLOCKED_DESTINATION_CONFLICT'
        : 'BLOCKED_MISSING_DESTINATION_DETAILS',
    };

    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      sourceStoreId: source.id,
      sourceStoreCode: SOURCE_STORE_CODE,
      destinationStoreId: DESTINATION_STORE_ID,
      countsByCollection,
      totalProposedWrites,
      destinationConflictCount: destinationConflicts.length,
      applyReadiness: report.applyReadiness,
      dryRunChecksum: report.dryRunChecksum,
      reportPath: REPORT_PATH,
      firestoreWritesPerformed: 0,
    }, null, 2));
  } finally {
    await deleteApp(app);
  }
}

main().catch((error) => {
  console.error(`Location Management dry run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
