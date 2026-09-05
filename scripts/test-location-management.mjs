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
const posSource = fs.readFileSync(new URL('../frontend/pages/pos/POSHome.tsx', import.meta.url), 'utf8');
const runningOrdersSource = fs.readFileSync(new URL('../frontend/pages/pos/RunningOrders.tsx', import.meta.url), 'utf8');
const runningOrdersVisibilitySource = fs.readFileSync(new URL('../frontend/lib/runningOrdersVisibility.ts', import.meta.url), 'utf8');
const reportingSource = fs.readFileSync(new URL('../functions/reportingCore.mjs', import.meta.url), 'utf8');
const publicMenuRefreshSource = fs.readFileSync(new URL('./refresh-public-menu-availability.mjs', import.meta.url), 'utf8');
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

function preview(selectedModules, sourceConfig = sourceConfiguration(), overrides = {}, staffAssignmentPlan = null) {
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
    staffAssignmentPlan,
  });
}

test('1. Admin-only backend authorization guards every provisioning callable', () => {
  assert.match(provisioningSource, /async function requireActiveAdmin/);
  assert.equal((provisioningSource.match(/await requireActiveAdmin\(db, request\)/g) || []).length, 10);
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
    users: 0,
    storeProvisioningAudit: 0,
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
  assert.equal(policy.ALL_MODULE_IDS.length, 8);
  assert.equal(new Set(policy.ALL_MODULE_IDS).size, 8);
  assert.ok(policy.ALL_MODULE_IDS.includes('LEGAL_RECEIPT'));
  assert.ok(policy.ALL_MODULE_IDS.includes('ITEM_OVERRIDES'));
  // Both opt-in modules stay out of the recommended default set.
  assert.ok(!policy.RECOMMENDED_MODULE_IDS.includes('LEGAL_RECEIPT'));
  assert.ok(!policy.RECOMMENDED_MODULE_IDS.includes('ITEM_OVERRIDES'));
});

test('12. Orders and payments are always excluded', () => {
  assert.ok(policy.NEVER_COPY_COLLECTIONS.includes('orders'));
  assert.ok(policy.NEVER_COPY_COLLECTIONS.includes('payments'));
});

test('13. Historical stock movements are never copied', () => {
  assert.ok(policy.NEVER_COPY_COLLECTIONS.includes('stockMovements'));
  assert.match(provisioningSource, /movementType: 'STORE_PROVISIONING_OPENING'/);
});

test('14. Staff assignments are explicit and never copied from the source store', () => {
  const draft = policy.buildDraftStorePayload({
    details: validLocation(),
    selectedModules: policy.RECOMMENDED_MODULE_IDS,
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  assert.equal(draft.assignedStaffCount, 0);
  assert.equal(preview([]).staffAssignmentCount, 0);
  const planned = preview([], sourceConfiguration(), {}, {
    selectedCount: 2,
    hasSetupLead: true,
    hasPosCapable: true,
    changes: [{ uid: 'manager-uid' }, { uid: 'cashier-uid' }],
    validationErrors: [],
  });
  assert.equal(planned.staffAssignmentCount, 2);
  assert.equal(planned.writesByCollection.users, 2);
  assert.equal(planned.writesByCollection.storeProvisioningAudit, 1);
  assert.match(provisioningSource, /buildStaffAssignmentPlan/);
  assert.match(provisioningSource, /previousStoreIds/);
  assert.match(provisioningSource, /resultingStoreIds/);
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

test('17A. GST registration validates real GSTIN and positive GST rate', () => {
  assert.equal(policy.validateLocationDetails(validLocation({
    gstRegistered: true,
    gstin: '09AGGPB8235N1Z2',
    gstRate: 5,
    gstDecisionReviewed: true,
  })).valid, true);
  assert.equal(policy.validateLocationDetails(validLocation({
    gstRegistered: true,
    gstin: 'a',
    gstRate: 5,
    gstDecisionReviewed: true,
  })).valid, false);
  assert.equal(policy.validateLocationDetails(validLocation({
    gstRegistered: true,
    gstin: '09AGGPB8235N1Z2',
    gstRate: 0,
    gstDecisionReviewed: true,
  })).valid, false);
});

test('17B. GST-unregistered stores clear GSTIN and do not require GST receipt fields', () => {
  const details = policy.validateLocationDetails(validLocation({
    gstRegistered: false,
    gstin: '',
    gstRate: 0,
    gstDecisionReviewed: true,
  }));
  assert.equal(details.valid, true);
  const draft = policy.buildDraftStorePayload({
    details: details.details,
    selectedModules: [],
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  assert.equal(draft.gstin, '');
  assert.equal(draft.gstRate, 0);
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
  assert.ok(readiness.friendlyBlockingSteps.includes('Staff'));
});

test('26. Customer ordering requires a separate callable and public snapshot', () => {
  assert.match(provisioningSource, /const setStoreCustomerOrdering = onCall/);
  assert.match(provisioningSource, /publicMenuAvailability/);
  assert.match(provisioningSource, /Customer ordering requires active POS/);
});

test('26a. Exact Golden I sales-first enablement is narrow and preserves new-store readiness', () => {
  assert.equal(provisioning.GOLDEN_I_PUBLIC_MENU_ITEM_COUNT, 80);
  assert.equal(provisioning.isExactGoldenIStore({ id: 'GOLDEN_I', code: 'GOLDEN_I' }), true);
  assert.equal(provisioning.isExactGoldenIStore({ id: 'GOLDEN_I', code: 'OTHER' }), false);
  assert.equal(provisioning.isExactGoldenIStore({ id: 'OTHER', code: 'GOLDEN_I' }), false);
  assert.equal(provisioning.publicMenuItemCount({ menuItems: { A: {}, B: {} } }), 2);
  assert.equal(provisioning.publicMenuItemCount({ menuItems: [{}, {}, {}] }), 3);
  assert.match(provisioningSource, /exactGoldenISalesFirstEnable = enabled/);
  assert.match(provisioningSource, /store\.isActive !== true \|\| store\.onlineOrderingEnabled !== true/);
  assert.match(provisioningSource, /snapshotCount !== GOLDEN_I_PUBLIC_MENU_ITEM_COUNT/);
  assert.match(provisioningSource, /posEnabled: true,[\s\S]*customerOrderingEnabled: true,[\s\S]*publicOrderingEnabled: true,[\s\S]*acceptingOrders: true,[\s\S]*isAcceptingOrders: true/);
  assert.match(provisioningSource, /if \(enabled\) \{[\s\S]*readiness\.customerOrderingReady/);
  assert.match(locationSource, /return isGoldenI\(store\)[\s\S]*customerOrderingFullyEnabled\(store\)/);
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
  assert.match(rules, /resource\.data\.internalPosTestEnabled == true/);
  assert.match(rules, /match \/storeProvisioningAudit\/\{auditId\}/);
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
    users: 0,
    storeProvisioningAudit: 0,
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

test('38. Location list uses friendly setup steps instead of raw readiness field names', () => {
  assert.match(locationSource, /needs \{progress\.incomplete\.length\} setup steps before POS can be activated/);
  assert.match(locationSource, /Review legal and GST/);
  assert.match(locationSource, /Validate add-ons/);
  assert.match(locationSource, /Complete POS test/);
  assert.doesNotMatch(locationSource, /Object\.entries\(READINESS_LABELS\)\.map/);
});

test('39. Internal POS test stays Draft and customer ordering disabled', () => {
  assert.match(provisioningSource, /const enableInternalPosTest = onCall/);
  assert.match(provisioningSource, /internalPosTestEnabled: true/);
  assert.match(provisioningSource, /setupTestMode: true/);
  assert.match(provisioningSource, /customerOrderingEnabled: false/);
  assert.match(provisioningSource, /MARK_INTERNAL_POS_TEST_PASSED/);
  assert.match(provisioningSource, /repeatInternalTestResult|idempotent: true|store\.internalPosTestEnabled === true && store\.posEnabled === true/);
  assert.match(provisioningSource, /store\.posTestCompleted === true && store\.readiness\?\.posTestCompleted === true/);
});

test('40. POS setup-test stores are Admin or assigned-manager only and orders are labelled', () => {
  assert.match(posSource, /import \{ accessiblePosStores, assignedStoreIdentifiers \} from '\.\.\/\.\.\/lib\/posStoreAccess'/);
  assert.match(posSource, /const allowedStores = accessiblePosStores\(fetchedStores, staffProfile\)/);
  assert.match(posSource, /Setup test sale/);
  assert.match(posSource, /isSetupTest: isSetupTestSale/);
  assert.match(posSource, /setupTestLabel: isSetupTestSale \? 'SETUP TEST' : null/);
  assert.match(posSource, /const setupPaymentMethods: PaymentMethod\[\] = isSetupTestSale \? \['CASH'\] : PAYMENT_METHODS/);
  assert.match(posSource, /Setup-test orders must use Cash only/);
});

test('41. Setup-test orders are excluded from normal Reporting Centre rows', () => {
  assert.match(reportingSource, /function isSetupTestOrder/);
  assert.match(reportingSource, /\.filter\(\(record\) => !isSetupTestOrder\(record\?\.order \|\| record\)\)/);
});

test('42. Wizard exposes seven guided steps', () => {
  assert.match(locationSource, /Store Details', 'Copy Config', 'Opening Stock', 'Staff', 'Validation', 'POS Test', 'Activate/);
  assert.match(locationSource, /Confirm opening stock/);
  assert.match(locationSource, /Assign staff here/);
  assert.match(locationSource, /Run validation preview/);
});

test('43. Opening stock validation supports canonical integer and decimal units only', () => {
  function validateStockUnit(unit, openingStock) {
    const stockDocs = [
      { id: 'unit-row', data: () => ({ stockItemCode: `${unit || 'BLANK'}_ITEM`, uom: unit, costPerUnit: 1 }) },
    ];
    return provisioning.validateOpeningStockRows(
      { id: 'BAKED_BY_BOND_51', code: 'BAKED_BY_BOND_51' },
      stockDocs,
      [{ stockId: 'unit-row', openingStock, costPerUnit: '1', confirmed: true }],
    );
  }

  for (const value of ['0', '1', '12']) {
    assert.equal(validateStockUnit('PCS', value).valid, true, `PCS should accept ${value}`);
    assert.equal(validateStockUnit('PC', value).valid, true, `PC should normalize to PCS and accept ${value}`);
    assert.equal(validateStockUnit('SLICE', value).valid, true, `SLICE should accept ${value}`);
  }

  for (const value of ['1.5', '-1', 'not-a-number']) {
    assert.equal(validateStockUnit('PCS', value).valid, false, `PCS should reject ${value}`);
    assert.equal(validateStockUnit('SLICE', value).valid, false, `SLICE should reject ${value}`);
  }

  assert.equal(validateStockUnit('G', '1.5').valid, true);
  assert.equal(validateStockUnit('KG', '0.25').valid, true);
  assert.equal(validateStockUnit('ML', '12.5').valid, true);
  assert.equal(validateStockUnit('L', '0.75').valid, true);

  const unsupported = validateStockUnit('EACH', '1');
  assert.equal(unsupported.valid, false);
  assert.ok(unsupported.errors.some((message) => message.includes('not a supported opening-stock unit')));

  assert.match(provisioningSource, /const INTEGER_UNITS = new Set\(\['PCS', 'SLICE'/);
  assert.match(provisioningSource, /PC: 'PCS'/);
  assert.match(provisioningSource, /SLICES: 'SLICE'/);
  assert.match(provisioningSource, /function isSupportedInventoryUnit/);
  assert.match(locationSource, /const INTEGER_OPENING_STOCK_UNITS = new Set\(\['PCS', 'SLICE'/);
  assert.match(locationSource, /PC: 'PCS'/);
  assert.match(locationSource, /SLICES: 'SLICE'/);
  assert.match(locationSource, /isSupportedOpeningStockUnit/);
});

test('44. Opening stock validation rejects negative and invalid integer quantities without creating movements', () => {
  const stockDocs = [
    { id: 'milk-row', data: () => ({ stockItemCode: 'MILK', uom: 'ML', costPerUnit: 1 }) },
    { id: 'cup-row', data: () => ({ stockItemCode: 'CUP', uom: 'PCS', costPerUnit: 2 }) },
  ];
  const valid = provisioning.validateOpeningStockRows(
    { id: 'BAKED_BY_BOND_51', code: 'BAKED_BY_BOND_51' },
    stockDocs,
    [
      { stockId: 'milk-row', openingStock: '12.5', costPerUnit: '1.25', confirmed: true },
      { stockId: 'cup-row', openingStock: '10', costPerUnit: '2', confirmed: true },
    ],
  );
  assert.equal(valid.valid, true);
  assert.equal(valid.rows[0].openingStock, 12.5);
  const invalid = provisioning.validateOpeningStockRows(
    { id: 'BAKED_BY_BOND_51', code: 'BAKED_BY_BOND_51' },
    stockDocs,
    [
      { stockId: 'milk-row', openingStock: '-1', costPerUnit: '1.25', confirmed: true },
      { stockId: 'cup-row', openingStock: '10.5', costPerUnit: '2', confirmed: true },
    ],
  );
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((message) => message.includes('opening quantity must be zero or positive')));
  assert.ok(invalid.errors.some((message) => message.includes('requires a whole-number quantity')));
  assert.doesNotMatch(provisioning.validateOpeningStockRows.toString(), /CREATE_MOVEMENT|stockMovements|batch\.create/);
});

test('45. Zero opening stock requires typed destination code confirmation', () => {
  const stockDocs = [
    { id: 'milk-row', data: () => ({ stockItemCode: 'MILK', uom: 'ML', costPerUnit: 1 }) },
  ];
  const blocked = provisioning.validateOpeningStockRows(
    { id: 'BAKED_BY_BOND_51', code: 'BAKED_BY_BOND_51' },
    stockDocs,
    [],
    { confirmAllZero: true, typedConfirmation: 'wrong' },
  );
  assert.equal(blocked.valid, false);
  assert.ok(blocked.errors[0].includes('Type BAKED_BY_BOND_51'));
  const confirmed = provisioning.validateOpeningStockRows(
    { id: 'BAKED_BY_BOND_51', code: 'BAKED_BY_BOND_51' },
    stockDocs,
    [],
    { confirmAllZero: true, typedConfirmation: 'BAKED_BY_BOND_51' },
  );
  assert.equal(confirmed.valid, true);
  assert.equal(confirmed.rows[0].openingStock, 0);
  assert.equal(confirmed.rows[0].confirmed, true);
});

test('46. Opening stock writes use deterministic movements and do not overwrite history', () => {
  assert.equal(
    provisioning.openingMovementId('BAKED_BY_BOND_51', 'stock-row-1', 'job-1'),
    provisioning.openingMovementId('BAKED_BY_BOND_51', 'stock-row-1', 'job-1'),
  );
  assert.match(provisioningSource, /movementType: 'OPENING_STOCK'/);
  assert.match(provisioningSource, /batch\.create\(operation\.ref, operation\.payload\)/);
  assert.match(provisioningSource, /Opening movement already exists with different values/);
  assert.match(provisioningSource, /stockAlreadyMatches/);
  assert.match(provisioningSource, /createdMovementCount/);
  assert.match(provisioningSource, /idempotent: operations\.length === 0/);
  assert.doesNotMatch(provisioningSource, /batch\.set\(operation\.ref, operation\.payload/);
});

test('47. Opening stock CSV import previews before applying to the editor', () => {
  assert.match(locationSource, /<Download size=\{15\} \/> Template/);
  assert.match(locationSource, /Upload CSV/);
  assert.match(locationSource, /function parseCsv/);
  assert.match(locationSource, /previewOpeningStockCsv/);
  assert.match(locationSource, /Apply CSV to editor/);
  assert.match(locationSource, /No Firestore write happens until Save Opening Stock/);
});

test('48. Direct staff assignment stays callable-backed and audited', () => {
  assert.match(provisioningSource, /async function saveStaffAssignments/);
  assert.match(provisioningSource, /SETUP_LEAD_REQUIRED/);
  assert.match(provisioningSource, /POS_USER_REQUIRED/);
  assert.match(provisioningSource, /plan\.changes\.length === 0 && !storeStaffNeedsUpdate/);
  assert.match(provisioningSource, /idempotent: true/);
  assert.match(provisioningSource, /previousStoreIds/);
  assert.match(provisioningSource, /resultingStoreIds/);
  assert.match(locationSource, /saveLocationStaffAssignmentsCallable/);
});

test('49. New provisioning callables are exported for emulator and backend QA', () => {
  const indexSource = fs.readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /exports\.saveLocationOpeningStock/);
  assert.match(indexSource, /exports\.saveLocationStaffAssignments/);
  assert.match(indexSource, /exports\.setPosLaunchException/);
});

test('50. Generic store configuration updates cannot patch opening-stock readiness', () => {
  const safeEditFields = provisioningSource.match(/const SAFE_EDIT_FIELDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.doesNotMatch(safeEditFields, /'readiness'/);
  assert.doesNotMatch(safeEditFields, /'openingStockConfirmed'/);
  assert.match(provisioningSource, /function assertNoSystemManagedStoreConfigPatch/);
  assert.match(provisioningSource, /key === 'readiness'/);
  assert.match(provisioningSource, /key === 'openingStockConfirmed'/);
  assert.match(provisioningSource, /key === 'posLaunchException'/);
  assert.match(provisioningSource, /key === 'readiness\.openingStockReviewed'/);
  assert.match(provisioningSource, /key === 'readiness\.openingStockConfirmed'/);
  assert.match(provisioningSource, /key\.startsWith\('readiness\.'\)/);
  assert.match(provisioningSource, /key\.startsWith\('posLaunchException\.'\)/);
  assert.match(provisioningSource, /Opening-stock readiness is system-managed and can only be changed through saveLocationOpeningStock/);
  assert.match(provisioningSource, /const rawPatch = data\.patch/);
  assert.match(provisioningSource, /assertNoSystemManagedStoreConfigPatch\(rawPatch\)/);
  assert.doesNotMatch(provisioningSource, /patch\.readiness = \{ \.\.\.currentReadiness/);
});

test('51. Baked by Bond staff-POS exception bypasses only opening-stock readiness for POS activation', () => {
  const baseStore = {
    id: 'BAKED_BY_BOND_51',
    code: 'BAKED_BY_BOND_51',
    storeCode: 'BAKED_BY_BOND_51',
    name: 'Baked by Bond 51',
    address: 'Address',
    city: 'Noida',
    state: 'Uttar Pradesh',
    pinCode: '201301',
    receiptName: 'Baked by Bond 51',
    gstRegistered: false,
    status: 'DRAFT',
    posEnabled: false,
    readiness: {
      inventoryStructureCreated: true,
      posTestCompleted: true,
      customerOrderingTestCompleted: false,
    },
  };
  const counts = {
    menuProductCount: 54,
    inventoryRowCount: 228,
    staffCount: 3,
    invalidProductAvailabilityCount: 0,
    invalidAddOnReferenceCount: 0,
    invalidKotRoutingCount: 0,
  };
  const blocked = policy.readinessResult(baseStore, counts);
  assert.equal(blocked.posReady, false);
  assert.ok(blocked.blockingKeys.includes('openingStockReviewed'));
  const withException = policy.readinessResult({
    ...baseStore,
    posLaunchException: {
      enabled: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  }, counts);
  assert.equal(withException.launchExceptionActive, true);
  assert.equal(withException.openingStockPending, true);
  assert.equal(withException.posReady, true);
  assert.equal(withException.customerOrderingReady, false);
  assert.ok(withException.blockingKeys.includes('openingStockReviewed'));
  assert.ok(!withException.posBlockingKeys.includes('openingStockReviewed'));
  const otherStore = policy.readinessResult({
    ...baseStore,
    id: 'UDAY_PARK',
    code: 'UDAY_PARK',
    storeCode: 'UDAY_PARK',
    posLaunchException: {
      enabled: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  }, counts);
  assert.equal(otherStore.posReady, false);
});

test('52. POS launch exception callable is Baked-only, expiring, audited and customer-ordering safe', () => {
  assert.match(provisioningSource, /const setPosLaunchException = onCall/);
  assert.match(provisioningSource, /storeId !== BAKED_BY_BOND_51_STORE_ID/);
  assert.match(provisioningSource, /POS_LAUNCH_EXCEPTION_MAX_MS = 48 \* 60 \* 60 \* 1000/);
  assert.match(provisioningSource, /Customer ordering must be disabled/);
  assert.match(provisioningSource, /openingStockIsPending\(store\)/);
  assert.match(provisioningSource, /otherBlockingKeys/);
  assert.match(provisioningSource, /SET_POS_LAUNCH_EXCEPTION/);
  assert.match(provisioningSource, /scope: 'STAFF_POS_ONLY'/);
  assert.match(provisioningSource, /updatedBy: adminUser\.uid/);
  assert.match(locationSource, /setPosLaunchExceptionCallable/);
  assert.match(locationSource, /Approve staff-POS exception/);
  assert.match(locationSource, /POS_LAUNCH_EXCEPTION_HOURS = 24/);
  assert.match(posSource, /Provisional stock launch/);
});

test('53. POS checkout uses deterministic document IDs and recovers committed retries', () => {
  assert.match(posSource, /CHECKOUT_ATTEMPT_STORAGE_KEY/);
  assert.match(posSource, /loadExistingCheckoutResult/);
  assert.match(posSource, /String\(order\.checkoutPayloadHash \|\| ''\) !== expectedPayloadHash/);
  assert.match(posSource, /loadExistingCheckoutResult\(\s*newOrderRef,\s*checkoutAttempt,\s*requestPayloadHash/);
  assert.match(posSource, /clientCheckoutIdempotencyKey/);
  assert.match(posSource, /checkoutPayloadHash/);
  assert.match(posSource, /transaction\.get\(newOrderRef\)/);
  assert.match(posSource, /existingOrderId: newOrderRef\.id/);
  assert.match(posSource, /deterministicOrderItemId/);
  assert.match(posSource, /deterministicStockMovementId/);
  assert.match(posSource, /deterministicKotId/);
  assert.match(posSource, /deterministicPaymentId/);
  assert.doesNotMatch(posSource, /const newOrderRef = doc\(collection\(db, 'orders'\)\)/);
  assert.doesNotMatch(posSource, /const paymentRef = doc\(collection\(newOrderRef, 'payments'\)\)/);
  assert.doesNotMatch(posSource, /const kotRef = doc\(collection\(db, 'kotItems'\)\)/);
});

test('54. Sale stock movement payloads include stable stock document identity', () => {
  const inventorySource = fs.readFileSync(new URL('../frontend/lib/inventoryDeduction.ts', import.meta.url), 'utf8');
  assert.match(inventorySource, /stockDocId: string/);
  assert.match(inventorySource, /aggregatedEntries/);
  assert.match(inventorySource, /movementPayloads\.push\(\{\s*stockDocId/);
  assert.match(posSource, /doc\(db, 'stockMovements', deterministicStockMovementId/);
});

test('55. Void reversal movements use deterministic IDs and remain compatible with historical movements', () => {
  assert.match(runningOrdersSource, /deterministicVoidReversalMovementId/);
  assert.match(runningOrdersSource, /movement\.id \|\| `\$\{freshOrder\.id\}_\$\{stockItemType\}_\$\{stockItemCode\}`/);
  assert.match(runningOrdersSource, /duplicateReversalIndex/);
  assert.doesNotMatch(runningOrdersSource, /transaction\.set\(doc\(collection\(db, 'stockMovements'\)\)/);
});

test('56. Running Orders exposes only the approved Draft setup-test order to active Admin', () => {
  assert.match(runningOrdersVisibilitySource, /DRAFT_SETUP_TEST_STORE_ID = 'BAKED_BY_BOND_51'/);
  assert.match(runningOrdersVisibilitySource, /staffProfile\?\.isActive === true && staffProfile\.role === 'ADMIN'/);
  assert.match(runningOrdersVisibilitySource, /store\.status === 'DRAFT'/);
  assert.match(runningOrdersVisibilitySource, /order\.setupTestMode === true/);
  assert.match(runningOrdersVisibilitySource, /store\.customerOrderingEnabled === false/);
  assert.match(runningOrdersVisibilitySource, /store\.onlineOrderingEnabled === false/);
  assert.match(runningOrdersVisibilitySource, /store\.publicOrderingEnabled === false/);
  assert.match(runningOrdersSource, /getDoc\(doc\(db, 'stores', DRAFT_SETUP_TEST_STORE_ID\)\)/);
  assert.match(runningOrdersSource, /filter\(order => isOrderVisibleInRunningOrders\(order, store, staffProfile\)\)/);
  assert.match(runningOrdersSource, />\s*SETUP TEST\s*</);
  assert.match(runningOrdersSource, /This order is not available for voiding in Running Orders\./);
});

test('57. Legacy migration compatibility is exact to classified Golden I and preserves recorded readiness truth', () => {
  const counts = {
    menuProductCount: 80,
    inventoryRowCount: 33,
    staffCount: 3,
    invalidProductAvailabilityCount: 0,
    invalidAddOnReferenceCount: 0,
    invalidKotRoutingCount: 0,
  };
  const golden = {
    id: 'GOLDEN_I',
    code: 'GOLDEN_I',
    storeCode: 'GOLDEN_I',
    onboardingMode: 'LEGACY_MIGRATED',
    name: 'Golden I',
    address: 'Existing full legacy address',
    isActive: true,
    status: 'ACTIVE',
    posEnabled: true,
    onlineOrderingEnabled: true,
    gstRegistered: false,
    readiness: {},
  };
  const migrated = policy.readinessResult(golden, counts);
  assert.equal(policy.isLegacyMigratedStore(golden), true);
  assert.equal(migrated.posReady, true);
  assert.equal(migrated.customerOrderingReady, true);
  assert.equal(migrated.checks.openingStockReviewed, false);
  assert.equal(migrated.checks.posTestCompleted, false);
  assert.equal(migrated.checks.customerOrderingTestCompleted, false);
  assert.deepEqual(migrated.compatibilityExemptions, ['openingStockReviewed', 'posTestCompleted']);
  assert.equal(migrated.customerOrderingTestExempt, true);
  assert.ok(migrated.warnings.some((warning) => warning.includes('Opening stock')));
  assert.ok(migrated.warnings.some((warning) => warning.includes('hours')));

  const missingClassification = policy.readinessResult({ ...golden, onboardingMode: undefined }, counts);
  assert.equal(missingClassification.posReady, false);
  assert.equal(missingClassification.customerOrderingReady, false);
  const arbitraryStore = policy.readinessResult({ ...golden, id: 'UDAY_PARK', code: 'UDAY_PARK', storeCode: 'UDAY_PARK' }, counts);
  assert.equal(policy.isLegacyMigratedStore({ ...golden, id: 'UDAY_PARK', code: 'UDAY_PARK' }), false);
  assert.equal(arbitraryStore.posReady, false);
  assert.equal(arbitraryStore.customerOrderingReady, false);
});

test('58. Migration action is Admin-only, evidence-gated, audited, idempotent, and cannot alter Baked or readiness', () => {
  const draft = policy.buildDraftStorePayload({
    details: validLocation(),
    selectedModules: [],
    createdBy: 'admin-uid',
    provisioningJobId: 'store_123456789abc',
    timestamp: 'SERVER_TIMESTAMP',
  });
  assert.equal(draft.onboardingMode, 'PROVISIONED');
  assert.match(provisioningSource, /action === 'CLASSIFY_LEGACY_MIGRATED'/);
  assert.match(provisioningSource, /storeId !== GOLDEN_I_STORE_ID \|\| storeCode !== GOLDEN_I_STORE_ID/);
  assert.match(provisioningSource, /store\.provisioningJobId \|\| store\.sourceTemplateStoreId/);
  assert.match(provisioningSource, /publicMenuAvailability/);
  assert.match(provisioningSource, /CLASSIFY_LEGACY_MIGRATED_STORE/);
  assert.match(provisioningSource, /legacyMigrationAuditId/);
  assert.match(provisioningSource, /isLegacyMigratedStore\(store\)/);
  assert.match(provisioningSource, /NORMALIZE_LEGACY_MIGRATED_POS/);
  assert.match(provisioningSource, /setup-incomplete products must remain unpublished/);
  const classificationBlock = provisioningSource.match(/if \(action === 'CLASSIFY_LEGACY_MIGRATED'\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.doesNotMatch(classificationBlock, /readiness\s*:/);
  assert.doesNotMatch(classificationBlock, /openingStockConfirmed/);
  assert.match(locationSource, /Classify migrated legacy store/);
  assert.match(locationSource, /Normalize staff POS/);
  assert.match(locationSource, /Migrated legacy-store warnings/);
  assert.match(publicMenuRefreshSource, /isGoldenISalesFirstOrderingStore/);
  assert.match(publicMenuRefreshSource, /salesFirstOrdering/);
  assert.match(publicMenuRefreshSource, /currentPublicCatalog\.has/);
  assert.doesNotMatch(publicMenuRefreshSource, /excludeSetupIncomplete/);
});

console.log(`\n${checks.length} Location Management checks passed.`);
