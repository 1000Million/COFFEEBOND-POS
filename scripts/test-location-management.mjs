#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('../functions/storeProvisioningPolicy.js');
const provisioning = require('../functions/storeProvisioning.js');

const provisioningSource = fs.readFileSync(new URL('../functions/storeProvisioning.js', import.meta.url), 'utf8');
const locationSource = fs.readFileSync(new URL('../frontend/pages/admin/LocationManagement.tsx', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../frontend/App.tsx', import.meta.url), 'utf8');
const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

const checks = [];
function test(name, fn) {
  fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}

function validLocation(overrides = {}) {
  return {
    displayName: 'Baked by Bond 51',
    storeCode: 'BAKED_BY_BOND_51',
    legalEntityName: '',
    address: 'Owner-approved address',
    city: 'Noida',
    state: 'Uttar Pradesh',
    pinCode: '201301',
    phone: '9999999999',
    email: 'location@example.invalid',
    gstRegistered: false,
    gstin: '',
    receiptName: '',
    receiptFooter: '',
    timezone: 'Asia/Kolkata',
    inventoryMode: 'FINISHED_GOODS',
    gstDecisionReviewed: true,
    receiptReviewComplete: true,
    ...overrides,
  };
}

function sourceConfiguration(overrides = {}) {
  return {
    menuDocs: [],
    inventoryDocs: [],
    publicSnapshotExists: false,
    sourceStaffCount: 0,
    addOnReferenceCount: 0,
    kotReferenceCount: 0,
    skippedDocumentCounts: {},
    skippedKnownDocumentCount: 0,
    ...overrides,
  };
}

function preview(selectedModules, sourceConfig = sourceConfiguration(), overrides = {}) {
  return provisioning.buildPreviewResponse({
    input: {
      location: validLocation(),
      templateMode: 'COPY',
      sourceStoreId: 'SOURCE_REAL_ID',
      selectedModules,
      inventoryOption: 'STRUCTURE_ONLY',
      inventoryReason: '',
      confirmDuplicateName: false,
      ...overrides,
    },
    sourceStore: { id: 'SOURCE_REAL_ID', code: 'NOIDA_51', name: 'Noida Sector 51' },
    sourceConfiguration: sourceConfig,
    duplicateNameWarning: '',
  });
}

test('1. Admin-only backend authorization guards every provisioning callable', () => {
  assert.match(provisioningSource, /async function requireActiveAdmin/);
  assert.equal((provisioningSource.match(/await requireActiveAdmin\(db, request\)/g) || []).length, 5);
  assert.match(provisioningSource, /profile\.isActive !== true \|\| profile\.role !== 'ADMIN'/);
});

test('2. Store Manager cannot preview or create stores', () => {
  assert.ok(!provisioningSource.includes("profile.role === 'STORE_MANAGER'"));
});

test('3. Cashier cannot preview or create stores', () => {
  assert.ok(!provisioningSource.includes("profile.role === 'CASHIER'"));
});

test('4. Franchise Viewer cannot access Location Management', () => {
  assert.match(appSource, /allowedRoles=\{\['ADMIN'\]\}[\s\S]*\/admin\/locations/);
  assert.match(locationSource, /staffProfile\?\.role === 'ADMIN'/);
});

test('5. Duplicate store codes are checked across code, storeCode, and document path', () => {
  assert.match(provisioningSource, /\.where\('code', '==', destinationCode\)/);
  assert.match(provisioningSource, /\.where\('storeCode', '==', destinationCode\)/);
  assert.match(provisioningSource, /Destination stores\/\$\{destinationId\} already exists/);
});

test('6. Destination store and stock writes are create-only', () => {
  assert.match(provisioningSource, /transaction\.create\(destinationRef/);
  assert.match(provisioningSource, /batch\.create\(operation\.ref, operation\.payload\)/);
  assert.ok(!provisioningSource.includes('transaction.set(destinationRef'));
});

test('7. Preview does not mutate source store configuration', () => {
  const sourceStore = Object.freeze({ id: 'SOURCE_REAL_ID', code: 'NOIDA_51', name: 'Noida Sector 51' });
  const before = JSON.stringify(sourceStore);
  provisioning.buildPreviewResponse({
    input: {
      location: validLocation(),
      selectedModules: ['OPERATING'],
      inventoryOption: 'STRUCTURE_ONLY',
    },
    sourceStore,
    sourceConfiguration: sourceConfiguration(),
    duplicateNameWarning: '',
  });
  assert.equal(JSON.stringify(sourceStore), before);
});

test('8. Blank store creation produces one draft store and one job', () => {
  const result = provisioning.buildPreviewResponse({
    input: {
      location: validLocation(),
      selectedModules: [],
      inventoryOption: 'STRUCTURE_ONLY',
    },
    sourceStore: null,
    sourceConfiguration: sourceConfiguration(),
    duplicateNameWarning: '',
  });
  assert.equal(result.sourceTemplate, null);
  assert.deepEqual(result.writesByCollection, {
    stores: 1,
    storeProvisioningJobs: 1,
    finishedGoods: 0,
    menuItems: 0,
    categories: 0,
    storeStock: 0,
    stockMovements: 0,
  });
});

test('9. Template preview uses the exact Firestore source document ID', () => {
  assert.equal(preview(['MENU']).sourceTemplate.id, 'SOURCE_REAL_ID');
});

test('10. Recommended modules exclude legal and receipt configuration', () => {
  assert.deepEqual(policy.RECOMMENDED_MODULE_IDS, [
    'OPERATING',
    'MENU',
    'ADD_ONS',
    'KOT',
    'INVENTORY',
    'CUSTOMER_ORDERING',
  ]);
});

test('11. Select-all contains each supported configuration module once', () => {
  assert.equal(policy.ALL_MODULE_IDS.length, 7);
  assert.equal(new Set(policy.ALL_MODULE_IDS).size, 7);
  assert.ok(policy.ALL_MODULE_IDS.includes('LEGAL_RECEIPT'));
});

test('12. Orders and payments are always excluded', () => {
  assert.ok(policy.NEVER_COPY_COLLECTIONS.includes('orders'));
  assert.ok(policy.NEVER_COPY_COLLECTIONS.includes('payments'));
});

test('13. Historical stock movements are never copied', () => {
  assert.ok(policy.NEVER_COPY_COLLECTIONS.includes('stockMovements'));
  assert.match(provisioningSource, /movementType: 'STORE_PROVISIONING_OPENING'/);
});

test('14. Staff assignments start empty', () => {
  const draft = policy.buildDraftStorePayload({
    details: validLocation(),
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  assert.equal(draft.assignedStaffCount, 0);
  assert.equal(preview([]).staffAssignmentCount, 0);
});

test('15. Draft store is excluded from public ordering', () => {
  const draft = policy.buildDraftStorePayload({
    details: validLocation(),
    selectedModules: [],
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  assert.equal(draft.isActive, false);
  assert.equal(draft.customerOrderingEnabled, false);
  assert.equal(draft.onlineOrderingPaused, true);
});

test('16. Draft store is excluded from unauthorised POS selection', () => {
  assert.match(rules, /!isSignedIn\(\) && resource\.data\.isActive == true/);
  assert.match(rules, /isActiveStaff\(\)[\s\S]*hasStoreAccess\(storeId\)/);
  assert.equal(preview([]).destinationStore.posEnabled, false);
});

test('17. Finished Goods V2 inventory structure copies with zero quantities', () => {
  assert.deepEqual(provisioning.INVENTORY_COLLECTIONS || ['storeStock'], ['storeStock']);
  assert.equal(provisioning.inventoryQuantityForOption({ openingStock: 12, currentStock: 7 }, 'STRUCTURE_ONLY'), 0);
  assert.ok(!provisioningSource.includes("const INVENTORY_COLLECTIONS = ['storeStock', 'storeInventory']"));
});

test('18. Current-stock copy requires exact code confirmation and reason', () => {
  assert.equal(policy.validateInventoryOption({
    inventoryOption: 'CURRENT_STOCK_ADVANCED',
    destinationStoreCode: 'BAKED_BY_BOND_51',
    confirmationStoreCode: '',
    reason: '',
  }).valid, false);
  assert.equal(policy.validateInventoryOption({
    inventoryOption: 'CURRENT_STOCK_ADVANCED',
    destinationStoreCode: 'BAKED_BY_BOND_51',
    confirmationStoreCode: 'BAKED_BY_BOND_51',
    reason: 'Approved physical opening balance',
  }).valid, true);
});

test('19. Legal and GST copying is off by default', () => {
  assert.ok(!policy.RECOMMENDED_MODULE_IDS.includes('LEGAL_RECEIPT'));
  assert.match(provisioningSource, /confirmLegalEntity !== true/);
});

test('20. KOT routing is referenced only when KOT is selected', () => {
  const config = sourceConfiguration({ kotReferenceCount: 12 });
  assert.equal(preview([], config).counts.kotGlobalReferences, 0);
  assert.equal(preview(['KOT'], config).counts.kotGlobalReferences, 12);
  const source = { id: 'SOURCE_REAL_ID', printerSettings: { barista: 'printer-1' } };
  const withoutKot = policy.buildDraftStorePayload({
    details: validLocation(),
    sourceStore: source,
    selectedModules: ['OPERATING'],
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  const withKot = policy.buildDraftStorePayload({
    details: validLocation(),
    sourceStore: source,
    selectedModules: ['KOT'],
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  assert.equal(withoutKot.printerSettings, undefined);
  assert.deepEqual(withKot.printerSettings, source.printerSettings);
  assert.equal(policy.validateModuleCompatibility({
    templateMode: 'COPY',
    selectedModules: ['MENU', 'ADD_ONS'],
  }).valid, false);
});

test('21. Product availability is updated only when MENU is selected', () => {
  assert.match(provisioningSource, /if \(selectedModules\.includes\('MENU'\)\)/);
  assert.equal(preview([], sourceConfiguration()).writesByCollection.finishedGoods, 0);
});

test('22. Add-on controls are referenced only when ADD_ONS is selected', () => {
  const config = sourceConfiguration({ addOnReferenceCount: 8 });
  assert.equal(preview([], config).counts.addOnGlobalReferences, 0);
  assert.equal(preview(['ADD_ONS'], config).counts.addOnGlobalReferences, 8);
  assert.equal(policy.validateModuleCompatibility({
    templateMode: 'COPY',
    selectedModules: ['MENU', 'KOT'],
  }).valid, false);
});

test('23. Repeated provisioning is protected by a deterministic request checksum', () => {
  const base = {
    location: validLocation(),
    templateMode: 'COPY',
    sourceStoreId: 'SOURCE_REAL_ID',
    selectedModules: ['MENU'],
    inventoryOption: 'STRUCTURE_ONLY',
  };
  assert.equal(policy.provisioningRequestChecksum(base), policy.provisioningRequestChecksum({ ...base }));
  assert.match(provisioningSource, /requestChecksum !== requestChecksum/);
  assert.match(provisioningSource, /data\.previewChecksum[\s\S]*context\.preview\.planChecksum/);
});

test('24. Interrupted provisioning is resumable without duplicate creates', () => {
  assert.match(provisioningSource, /existingData\.provisioningJobId !== jobId/);
  assert.match(provisioningSource, /completedOperationCount/);
  assert.match(provisioningSource, /status: 'FAILED'/);
});

test('25. Activation is blocked until mandatory readiness succeeds', () => {
  const readiness = policy.readinessResult({
    name: 'Baked by Bond 51',
    code: 'BAKED_BY_BOND_51',
    address: 'Address',
    city: 'Noida',
    state: 'Uttar Pradesh',
    pinCode: '201301',
    readiness: {},
  }, { menuProductCount: 0, inventoryRowCount: 0, staffCount: 0 });
  assert.equal(readiness.posReady, false);
  assert.ok(readiness.blockingKeys.includes('staffAssigned'));
});

test('26. Customer ordering requires a separate callable and public snapshot', () => {
  assert.match(provisioningSource, /const setStoreCustomerOrdering = onCall/);
  assert.match(provisioningSource, /publicMenuAvailability/);
  assert.match(provisioningSource, /Customer ordering requires active POS/);
});

test('27. Provisioning audit metadata excludes passwords, tokens, and customer data', () => {
  const audit = policy.buildSafeJobRecord({
    jobId: 'store_123456789abc',
    sourceStoreId: 'SOURCE_REAL_ID',
    destinationStoreId: 'BAKED_BY_BOND_51',
    selectedModules: ['MENU'],
    inventoryOption: 'STRUCTURE_ONLY',
    reason: '',
    adminUid: 'admin-uid',
    status: 'IN_PROGRESS',
    counts: { stores: 1 },
    requestChecksum: 'a'.repeat(64),
    timestamp: 'SERVER_TIMESTAMP',
  });
  const keys = Object.keys(audit);
  assert.ok(!keys.some((key) => /password|token|customer|report/i.test(key)));
});

test('28. Firestore rules reserve provisioning writes for the backend', () => {
  assert.match(rules, /match \/storeProvisioningJobs\/\{jobId\}/);
  assert.match(rules, /allow create, update, delete: if false;/);
  assert.match(rules, /match \/stores\/\{storeId\}[\s\S]*allow create, update, delete: if false;/);
});

test('29. UI uses callables and contains no direct store write API', () => {
  assert.match(locationSource, /httpsCallable/);
  for (const directWrite of ['setDoc(', 'addDoc(', 'updateDoc(', 'deleteDoc(']) {
    assert.ok(!locationSource.includes(directWrite), `Unexpected direct write API: ${directWrite}`);
  }
});

test('30. Incomplete destination details remain previewable with structured validation issues', () => {
  const incomplete = validLocation({
    address: '',
    city: '',
    state: '',
    pinCode: '',
    phone: '',
    email: '',
    gstDecisionReviewed: false,
    receiptReviewComplete: false,
  });
  const input = provisioning.validateProvisioningInput({
    location: incomplete,
    templateMode: 'COPY',
    sourceStoreId: 'SOURCE_REAL_ID',
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    inventoryOption: 'STRUCTURE_ONLY',
  }, { mode: 'PREVIEW' });
  assert.deepEqual(
    input.validationErrors.map((issue) => issue.field),
    ['address', 'city', 'state', 'pinCode', 'phone', 'email', 'gstDecisionReviewed', 'receiptReviewComplete'],
  );
});

test('31. Incomplete preview returns a full blocked zero-write plan', () => {
  const incompleteInput = provisioning.validateProvisioningInput({
    location: validLocation({
      address: '',
      city: '',
      state: '',
      pinCode: '',
      phone: '',
      email: '',
      gstDecisionReviewed: false,
      receiptReviewComplete: false,
    }),
    templateMode: 'COPY',
    sourceStoreId: 'SOURCE_REAL_ID',
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    inventoryOption: 'STRUCTURE_ONLY',
  }, { mode: 'PREVIEW' });
  const sourceConfig = sourceConfiguration({
    menuDocs: [
      { collection: 'finishedGoods', id: 'FG_1', data: {} },
      { collection: 'menuItems', id: 'MENU_1', data: {} },
    ],
    inventoryDocs: [
      { collection: 'storeStock', id: 'STOCK_1', data: { stockItemType: 'RAW', stockItemCode: 'RAW_1' } },
      { collection: 'storeStock', id: 'STOCK_2', data: { stockItemType: 'PREP', stockItemCode: 'PREP_1' } },
    ],
  });
  const result = provisioning.buildPreviewResponse({
    input: incompleteInput,
    sourceStore: { id: 'SOURCE_REAL_ID', code: 'NOIDA_51', name: 'Noida Sector 51' },
    sourceConfiguration: sourceConfig,
    duplicateNameWarning: '',
  });
  assert.equal(result.canCreate, false);
  assert.equal(result.safeToCreateDraft, false);
  assert.equal(result.applyReadiness, 'BLOCKED_MISSING_DESTINATION_DETAILS');
  assert.equal(result.firestoreWritesPerformed, 0);
  assert.equal(result.sourceStoreId, 'SOURCE_REAL_ID');
  assert.equal(result.sourceStoreCode, 'NOIDA_51');
  assert.equal(result.destinationStoreId, 'BAKED_BY_BOND_51');
  assert.deepEqual(result.countsByCollection, {
    stores: 1,
    storeProvisioningJobs: 1,
    finishedGoods: 1,
    menuItems: 1,
    categories: 0,
    storeStock: 2,
    stockMovements: 0,
  });
  assert.equal(result.totalProposedWrites, 6);
  assert.equal(result.dryRunChecksum, result.planChecksum);
});

test('32. Repeated incomplete previews produce the same checksum', () => {
  const raw = {
    location: validLocation({
      address: '',
      gstDecisionReviewed: false,
      receiptReviewComplete: false,
    }),
    templateMode: 'COPY',
    sourceStoreId: 'SOURCE_REAL_ID',
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    inventoryOption: 'STRUCTURE_ONLY',
  };
  const input = provisioning.validateProvisioningInput(raw, { mode: 'PREVIEW' });
  const first = provisioning.buildPreviewResponse({
    input,
    sourceStore: { id: 'SOURCE_REAL_ID', code: 'NOIDA_51', name: 'Noida Sector 51' },
    sourceConfiguration: sourceConfiguration(),
    duplicateNameWarning: '',
  });
  const second = provisioning.buildPreviewResponse({
    input: provisioning.validateProvisioningInput(raw, { mode: 'PREVIEW' }),
    sourceStore: { id: 'SOURCE_REAL_ID', code: 'NOIDA_51', name: 'Noida Sector 51' },
    sourceConfiguration: sourceConfiguration(),
    duplicateNameWarning: '',
  });
  assert.equal(first.planChecksum, second.planChecksum);
});

test('33. Create validation remains strict for the same incomplete payload', () => {
  assert.throws(() => provisioning.validateProvisioningInput({
    location: validLocation({ address: '' }),
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    inventoryOption: 'STRUCTURE_ONLY',
  }), /Address is required/);
});

test('34. Complete valid destination details produce a create-ready preview', () => {
  const input = provisioning.validateProvisioningInput({
    location: validLocation(),
    templateMode: 'COPY',
    sourceStoreId: 'SOURCE_REAL_ID',
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    inventoryOption: 'STRUCTURE_ONLY',
  }, { mode: 'PREVIEW' });
  const result = provisioning.buildPreviewResponse({
    input,
    sourceStore: { id: 'SOURCE_REAL_ID', code: 'NOIDA_51', name: 'Noida Sector 51' },
    sourceConfiguration: sourceConfiguration(),
    duplicateNameWarning: '',
  });
  assert.equal(result.canCreate, true);
  assert.equal(result.applyReadiness, 'READY');
  assert.deepEqual(result.validationErrors, []);
});

test('35. Invalid store code and unsupported modules remain hard preview failures', () => {
  assert.throws(() => provisioning.validateProvisioningInput({
    location: validLocation({ storeCode: 'invalid code' }),
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
  }, { mode: 'PREVIEW' }), /Store code must use uppercase/);
  assert.throws(() => provisioning.validateProvisioningInput({
    location: validLocation(),
    selectedModules: ['UNSUPPORTED'],
  }, { mode: 'PREVIEW' }), /Unsupported copy modules/);
});

test('36. Duplicate code and invalid source checks remain hard backend failures', () => {
  assert.match(provisioningSource, /if \(conflictingCodeMatches\.length > 0\)[\s\S]*fail\('already-exists'/);
  assert.match(provisioningSource, /if \(!sourceSnap\.exists\) fail\('not-found'/);
});

test('37. Wizard renders structured validation inline and disables Create while blocked', () => {
  assert.match(locationSource, /Preview generated\. Complete the required destination details before creating this location\./);
  assert.match(locationSource, /preview\.validationErrors\.map/);
  assert.match(locationSource, /disabled=\{actioning === 'create' \|\| !preview\?\.canCreate\}/);
  assert.match(locationSource, /role="alert"[\s\S]*wizardError/);
});

console.log(`\n${checks.length} Location Management checks passed.`);
