#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PROJECT_ID = 'demo-coffee-bond-location-onboarding';
const REGION = 'us-central1';
const SOURCE_STORE_ID = 'SOURCE_NOIDA_51';
const DESTINATION_STORE_ID = 'BAKED_BY_BOND_51';
const PASSWORD = 'LocationE2e12345!';
const ADMIN_UID = 'admin-location-e2e';
const MANAGER_UID = 'manager-location-e2e';
const CASHIER_UID = 'cashier-location-e2e';

const RECOMMENDED_MODULES = [
  'OPERATING',
  'MENU',
  'ADD_ONS',
  'KOT',
  'INVENTORY',
  'CUSTOMER_ORDERING',
];

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function homebrewJavaEnv() {
  const baseEnv = {
    ...process.env,
    GEMINI_INVOICE_MODEL: process.env.GEMINI_INVOICE_MODEL || 'gemini-3.5-flash',
    INVOICE_STORAGE_BUCKET: process.env.INVOICE_STORAGE_BUCKET || `${PROJECT_ID}.appspot.com`,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_test_emulator_only',
    RAZORPAY_MAGIC_CHECKOUT_ENABLED: process.env.RAZORPAY_MAGIC_CHECKOUT_ENABLED || 'false',
  };
  const candidates = [
    '/opt/homebrew/opt/openjdk@21',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk@21',
    '/usr/local/opt/openjdk',
  ];
  for (const prefix of candidates) {
    const result = commandResult(`${prefix}/bin/java`, ['-version']);
    if (result.status === 0) {
      return {
        ...baseEnv,
        JAVA_HOME: prefix,
        PATH: `${prefix}/bin:${baseEnv.PATH || ''}`,
      };
    }
  }
  return baseEnv;
}

function requireCommand(command, args, label, installHint, env = process.env) {
  const result = commandResult(command, args, env);
  if (result.status === 0) return result;
  const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  console.error(`BLOCKED: ${label} is not available for isolated Location Management E2E testing.`);
  if (details) console.error(details);
  console.error(installHint);
  process.exit(1);
}

if (!process.argv.includes('--inside-emulator')) {
  const javaEnv = homebrewJavaEnv();
  requireCommand(
    'java',
    ['-version'],
    'Java Runtime',
    'Install a Java Runtime, then rerun npm run test:location-management-emulator. No production Firebase project was touched.',
    javaEnv,
  );
  requireCommand(
    'firebase',
    ['--version'],
    'Firebase CLI',
    'Install or authenticate Firebase CLI, then rerun npm run test:location-management-emulator.',
    javaEnv,
  );

  const command = [
    'node',
    'scripts/test-location-management-emulator-e2e.mjs',
    '--inside-emulator',
  ].join(' ');
  const result = spawnSync(
    'firebase',
    [
      'emulators:exec',
      '--only',
      'auth,firestore,functions',
      '--project',
      PROJECT_ID,
      command,
    ],
    { stdio: 'inherit', env: javaEnv },
  );
  process.exit(result.status ?? 1);
}

const requiredEnv = [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`BLOCKED: emulator environment missing ${missingEnv.join(', ')}.`);
  process.exit(1);
}

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });
}

const db = admin.firestore();

async function flushFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const response = await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  assert.equal(response.ok, true, `Could not flush Firestore emulator: ${response.status}`);
}

async function createAuthUser({ uid, email, displayName }) {
  try {
    await admin.auth().createUser({
      uid,
      email,
      displayName,
      password: PASSWORD,
      emailVerified: true,
      disabled: false,
    });
  } catch (error) {
    if (error?.code !== 'auth/uid-already-exists' && error?.code !== 'auth/email-already-exists') throw error;
  }
}

async function signIn(email) {
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-in failed for ${email}: ${JSON.stringify(body)}`);
  assert.ok(body.idToken, `Auth emulator did not return an idToken for ${email}`);
  return body.idToken;
}

async function callFunction(name, data, idToken, { expectError = false } = {}) {
  const response = await fetch(`http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data }),
  });
  const body = await response.json().catch(() => ({}));
  if (expectError) {
    assert.notEqual(response.status, 200, `${name} unexpectedly succeeded`);
    return body;
  }
  assert.equal(response.status, 200, `${name} failed: ${response.status} ${JSON.stringify(body)}`);
  return body.result ?? body.data ?? body;
}

async function seedData() {
  await Promise.all([
    createAuthUser({ uid: ADMIN_UID, email: 'admin.location-e2e@example.invalid', displayName: 'Location Admin E2E' }),
    createAuthUser({ uid: MANAGER_UID, email: 'manager.location-e2e@example.invalid', displayName: 'Location Manager E2E' }),
    createAuthUser({ uid: CASHIER_UID, email: 'cashier.location-e2e@example.invalid', displayName: 'Location Cashier E2E' }),
  ]);

  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(db.collection('users').doc(ADMIN_UID), {
    uid: ADMIN_UID,
    email: 'admin.location-e2e@example.invalid',
    displayName: 'Location Admin E2E',
    role: 'ADMIN',
    isActive: true,
    assignedStoreIds: [],
    storeIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('users').doc(MANAGER_UID), {
    uid: MANAGER_UID,
    email: 'manager.location-e2e@example.invalid',
    displayName: 'Location Manager E2E',
    role: 'STORE_MANAGER',
    isActive: true,
    assignedStoreIds: [SOURCE_STORE_ID],
    storeIds: [SOURCE_STORE_ID],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('users').doc(CASHIER_UID), {
    uid: CASHIER_UID,
    email: 'cashier.location-e2e@example.invalid',
    displayName: 'Location Cashier E2E',
    role: 'CASHIER',
    isActive: true,
    assignedStoreIds: [SOURCE_STORE_ID],
    storeIds: [SOURCE_STORE_ID],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('stores').doc(SOURCE_STORE_ID), {
    id: SOURCE_STORE_ID,
    code: 'NOIDA_51',
    storeCode: 'NOIDA_51',
    name: 'Noida Sector 51',
    displayName: 'Noida Sector 51',
    address: 'Source address',
    city: 'Noida',
    state: 'Uttar Pradesh',
    pinCode: '201301',
    phone: '9999999999',
    email: 'source@example.invalid',
    gstRegistered: false,
    gstin: '',
    gstRate: 0,
    receiptName: 'Coffee Bond',
    receiptFooter: 'Thank you',
    timezone: 'Asia/Kolkata',
    status: 'ACTIVE',
    isActive: true,
    posEnabled: true,
    customerOrderingEnabled: true,
    onlineOrderingEnabled: true,
    publicOrderingEnabled: true,
    acceptingOrders: true,
    inventoryMode: 'FINISHED_GOODS',
    paymentMethods: ['CASH', 'UPI'],
    openingHours: { monday: '09:00-21:00' },
    orderTypes: ['DINE_IN', 'TAKEAWAY'],
    printerSettings: { barista: 'barista-printer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('addOnGroups').doc('beverage_add_on'), {
    id: 'beverage_add_on',
    name: 'Beverage Add On',
    isActive: true,
  });
  batch.set(db.collection('finishedGoods').doc('HOT_LATTE'), {
    code: 'HOT_LATTE',
    name: 'Hot Latte',
    salePrice: 225,
    isActive: true,
    isSellable: true,
    isAvailable: true,
    itemType: 'MADE_TO_ORDER',
    prepStation: 'BARISTA',
    addOnGroupIds: ['beverage_add_on'],
    availableStoreIds: [SOURCE_STORE_ID],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('finishedGoods').doc('AVOCADO_BOWL'), {
    code: 'AVOCADO_BOWL',
    name: 'Avocado Breakfast Bowl',
    salePrice: 350,
    isActive: true,
    isSellable: true,
    isAvailable: true,
    itemType: 'MADE_TO_ORDER',
    prepStation: 'KITCHEN',
    availableStoreIds: [SOURCE_STORE_ID],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('menuItems').doc('MENU_LATTE'), {
    code: 'HOT_LATTE',
    name: 'Hot Latte',
    availableStoreIds: [SOURCE_STORE_ID],
    isActive: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  [
    ['SOURCE_MILK', 'RAW_INGREDIENT', 'MILK', 'Fresh Milk', 'ML', 1000],
    ['SOURCE_BEANS', 'RAW_INGREDIENT', 'BEANS', 'Roasted Coffee Beans', 'G', 500],
    ['SOURCE_CUPS', 'PACKAGING', 'CUPS', 'Paper Cups', 'PCS', 100],
  ].forEach(([id, type, code, name, unit, quantity]) => {
    batch.set(db.collection('storeStock').doc(id), {
      storeId: SOURCE_STORE_ID,
      storeCode: 'NOIDA_51',
      stockItemType: type,
      stockItemCode: code,
      stockItemName: name,
      uom: unit,
      unit,
      openingStock: quantity,
      currentStock: quantity,
      costPerUnit: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  await batch.commit();
}

function location(overrides = {}) {
  return {
    displayName: 'Baked by Bond 51',
    storeCode: DESTINATION_STORE_ID,
    legalEntityName: '',
    address: 'QA address, Sector 51',
    city: 'Noida',
    state: 'Uttar Pradesh',
    pinCode: '201301',
    phone: '9999999999',
    email: 'baked51@example.invalid',
    gstRegistered: false,
    gstin: '',
    gstRate: 0,
    receiptName: 'Baked by Bond 51',
    receiptFooter: 'Setup test',
    timezone: 'Asia/Kolkata',
    inventoryMode: 'FINISHED_GOODS',
    gstDecisionReviewed: true,
    receiptReviewComplete: true,
    ...overrides,
  };
}

function provisioningPayload(overrides = {}) {
  return {
    location: location(),
    templateMode: 'COPY',
    sourceStoreId: SOURCE_STORE_ID,
    selectedModules: RECOMMENDED_MODULES,
    inventoryOption: 'STRUCTURE_ONLY',
    staffAssignmentUids: [MANAGER_UID, CASHIER_UID],
    ...overrides,
  };
}

async function destinationStockRows() {
  const snapshot = await db.collection('storeStock').where('storeId', '==', DESTINATION_STORE_ID).get();
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

async function movementCount(type) {
  const snapshot = await db.collection('stockMovements')
    .where('storeId', '==', DESTINATION_STORE_ID)
    .where('movementType', '==', type)
    .get();
  return snapshot.size;
}

async function auditActionCount(action) {
  const snapshot = await db.collection('storeProvisioningAudit')
    .where('storeId', '==', DESTINATION_STORE_ID)
    .where('action', '==', action)
    .get();
  return snapshot.size;
}

function assertSameTimestamp(actual, expected, label) {
  if (expected?.isEqual) {
    assert.equal(actual?.isEqual(expected), true, `${label} changed`);
    return;
  }
  assert.deepEqual(actual, expected, `${label} changed`);
}

async function run() {
  console.log('Location Management emulator environment is isolated.');
  console.log(`Project: ${process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT_ID}`);
  assert.notEqual(PROJECT_ID, 'coffee-bond-pos');

  await flushFirestore();
  await seedData();

  const adminToken = await signIn('admin.location-e2e@example.invalid');
  const cashierToken = await signIn('cashier.location-e2e@example.invalid');

  const invalidGstinPreview = await callFunction('previewStoreProvisioning', provisioningPayload({
    location: location({
      gstRegistered: true,
      gstin: 'INVALID',
      gstRate: 5,
    }),
  }), adminToken);
  assert.equal(invalidGstinPreview.canCreate, false);
  assert.ok(invalidGstinPreview.validationErrors.some((issue) => issue.code === 'INVALID_GSTIN'));

  const gstRegisteredPreview = await callFunction('previewStoreProvisioning', provisioningPayload({
    location: location({
      storeCode: 'GST_REGISTERED_E2E',
      gstRegistered: true,
      gstin: '09AGGPB8235N1Z2',
      gstRate: 5,
    }),
  }), adminToken);
  assert.equal(gstRegisteredPreview.canCreate, true);

  await callFunction('previewStoreProvisioning', provisioningPayload(), cashierToken, { expectError: true });

  const preview = await callFunction('previewStoreProvisioning', provisioningPayload(), adminToken);
  assert.equal(preview.canCreate, true);
  assert.equal(preview.destinationStoreId, DESTINATION_STORE_ID);
  assert.equal(preview.firestoreWritesPerformed, 0);
  assert.equal(preview.writesByCollection.stores, 1);
  assert.equal(preview.writesByCollection.users, 2);
  assert.equal(preview.writesByCollection.finishedGoods, 2);
  assert.equal(preview.writesByCollection.menuItems, 1);
  assert.equal(preview.writesByCollection.storeStock, 3);

  const jobId = 'store_location_e2e_001';
  const createResult = await callFunction('createStoreFromTemplate', {
    ...provisioningPayload(),
    provisioningJobId: jobId,
    previewChecksum: preview.planChecksum,
  }, adminToken);
  assert.equal(createResult.status, 'COMPLETED');

  const destinationSnap = await db.collection('stores').doc(DESTINATION_STORE_ID).get();
  assert.equal(destinationSnap.exists, true);
  const destination = destinationSnap.data();
  assert.equal(destination.isActive, false);
  assert.equal(destination.customerOrderingEnabled, false);
  assert.equal(destination.posEnabled, false);

  const latteSnap = await db.collection('finishedGoods').doc('HOT_LATTE').get();
  assert.ok(latteSnap.data().availableStoreIds.includes(DESTINATION_STORE_ID));

  const managerSnap = await db.collection('users').doc(MANAGER_UID).get();
  assert.deepEqual(new Set(managerSnap.data().assignedStoreIds), new Set([SOURCE_STORE_ID, DESTINATION_STORE_ID]));
  const cashierSnap = await db.collection('users').doc(CASHIER_UID).get();
  assert.deepEqual(new Set(cashierSnap.data().assignedStoreIds), new Set([SOURCE_STORE_ID, DESTINATION_STORE_ID]));

  const stockRows = await destinationStockRows();
  assert.equal(stockRows.length, 3);
  assert.ok(stockRows.every((row) => row.openingStock === 0 && row.currentStock === 0));

  const blockedStoreBefore = (await db.collection('stores').doc(DESTINATION_STORE_ID).get()).data();
  const blockedReadinessBefore = blockedStoreBefore.readiness;
  const blockedUpdatedAtBefore = blockedStoreBefore.updatedAt;
  const blockedPatches = [
    { label: 'nested opening stock true', patch: { readiness: { openingStockReviewed: true } } },
    { label: 'nested opening stock false', patch: { readiness: { openingStockReviewed: false } } },
    { label: 'root opening stock confirmed', patch: { openingStockConfirmed: true } },
    { label: 'dotted opening stock reviewed', patch: { 'readiness.openingStockReviewed': true } },
    { label: 'dotted opening stock confirmed', patch: { 'readiness.openingStockConfirmed': true } },
    { label: 'nested opening stock confirmed', patch: { readiness: { openingStockConfirmed: true } } },
  ];
  for (const blockedPatch of blockedPatches) {
    const errorBody = await callFunction('updateStoreConfiguration', {
      storeId: DESTINATION_STORE_ID,
      action: 'UPDATE',
      patch: blockedPatch.patch,
    }, adminToken, { expectError: true });
    assert.match(JSON.stringify(errorBody), /Opening-stock readiness is system-managed/, blockedPatch.label);
    const afterBlockedPatch = (await db.collection('stores').doc(DESTINATION_STORE_ID).get()).data();
    assert.deepEqual(afterBlockedPatch.readiness, blockedReadinessBefore, `${blockedPatch.label} changed readiness`);
    assert.equal(afterBlockedPatch.openingStockConfirmed, undefined, `${blockedPatch.label} set openingStockConfirmed`);
    assertSameTimestamp(afterBlockedPatch.updatedAt, blockedUpdatedAtBefore, `${blockedPatch.label} updatedAt`);
  }

  const normalUpdate = await callFunction('updateStoreConfiguration', {
    storeId: DESTINATION_STORE_ID,
    action: 'UPDATE',
    patch: { receiptFooter: 'QA setup receipt footer' },
  }, adminToken);
  assert.equal(normalUpdate.status, 'DRAFT');
  const afterNormalUpdate = (await db.collection('stores').doc(DESTINATION_STORE_ID).get()).data();
  assert.equal(afterNormalUpdate.receiptFooter, 'QA setup receipt footer');
  assert.deepEqual(afterNormalUpdate.readiness, blockedReadinessBefore);
  assert.equal(afterNormalUpdate.openingStockConfirmed, undefined);

  const openingRows = stockRows.map((row) => ({
    stockId: row.id,
    openingStock: row.stockItemCode === 'MILK' ? 150.5 : row.stockItemCode === 'CUPS' ? 12 : 0,
    costPerUnit: row.stockItemCode === 'MILK' ? 0.25 : 1,
    confirmed: true,
  }));
  const openingResult = await callFunction('saveLocationOpeningStock', {
    storeId: DESTINATION_STORE_ID,
    rows: openingRows,
  }, adminToken);
  assert.equal(openingResult.openingStockReviewed, true);
  assert.equal(openingResult.nonZeroOpeningRows, 2);
  assert.equal(await movementCount('OPENING_STOCK'), 2);
  assert.equal(await auditActionCount('SAVE_OPENING_STOCK'), 1);
  const repeatOpeningResult = await callFunction('saveLocationOpeningStock', {
    storeId: DESTINATION_STORE_ID,
    rows: openingRows,
  }, adminToken);
  assert.equal(repeatOpeningResult.idempotent, true);
  assert.equal(await movementCount('OPENING_STOCK'), 2);
  assert.equal(await auditActionCount('SAVE_OPENING_STOCK'), 1);

  await db.collection('stores').doc('ZERO_STOCK_E2E').set({
    code: 'ZERO_STOCK_E2E',
    storeCode: 'ZERO_STOCK_E2E',
    name: 'Zero Stock E2E',
    status: 'DRAFT',
    isActive: false,
  });
  await db.collection('storeStock').doc('ZERO_STOCK_E2E_ROW').set({
    storeId: 'ZERO_STOCK_E2E',
    storeCode: 'ZERO_STOCK_E2E',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'ZERO',
    stockItemName: 'Zero Ingredient',
    uom: 'G',
    openingStock: 99,
    currentStock: 99,
  });
  await callFunction('saveLocationOpeningStock', {
    storeId: 'ZERO_STOCK_E2E',
    confirmAllZero: true,
    typedConfirmation: 'ZERO_STOCK_E2E',
  }, adminToken);
  const zeroRow = await db.collection('storeStock').doc('ZERO_STOCK_E2E_ROW').get();
  assert.equal(zeroRow.data().currentStock, 0);

  const staffAuditCountBefore = await auditActionCount('SAVE_STAFF_ASSIGNMENTS');
  const staffAssignmentResult = await callFunction('saveLocationStaffAssignments', {
    storeId: DESTINATION_STORE_ID,
    selectedUserIds: [ADMIN_UID, MANAGER_UID, CASHIER_UID],
  }, adminToken);
  assert.equal(staffAssignmentResult.staffAssigned, true);
  assert.equal(staffAssignmentResult.idempotent, false);
  assert.equal(await auditActionCount('SAVE_STAFF_ASSIGNMENTS'), staffAuditCountBefore + 1);
  const repeatStaffAssignmentResult = await callFunction('saveLocationStaffAssignments', {
    storeId: DESTINATION_STORE_ID,
    selectedUserIds: [ADMIN_UID, MANAGER_UID, CASHIER_UID],
  }, adminToken);
  assert.equal(repeatStaffAssignmentResult.idempotent, true);
  assert.equal(await auditActionCount('SAVE_STAFF_ASSIGNMENTS'), staffAuditCountBefore + 1);
  const adminProfile = await db.collection('users').doc(ADMIN_UID).get();
  assert.ok(adminProfile.data().assignedStoreIds.includes(DESTINATION_STORE_ID));

  const internalTestResult = await callFunction('enableInternalPosTest', { storeId: DESTINATION_STORE_ID }, adminToken);
  assert.equal(internalTestResult.internalPosTestEnabled, true);
  assert.equal(await auditActionCount('ENABLE_INTERNAL_POS_TEST'), 1);
  const repeatInternalTestResult = await callFunction('enableInternalPosTest', { storeId: DESTINATION_STORE_ID }, adminToken);
  assert.equal(repeatInternalTestResult.idempotent, true);
  assert.equal(await auditActionCount('ENABLE_INTERNAL_POS_TEST'), 1);
  const testingStore = await db.collection('stores').doc(DESTINATION_STORE_ID).get();
  assert.equal(testingStore.data().posEnabled, true);
  assert.equal(testingStore.data().customerOrderingEnabled, false);

  await db.collection('orders').doc('SETUP_ORDER_1').set({
    storeId: DESTINATION_STORE_ID,
    storeCode: DESTINATION_STORE_ID,
    orderNumber: 'CB-SETUP-0001',
    status: 'VOIDED',
    paymentMethod: 'CASH',
    paymentProvider: 'PAY_AT_COUNTER',
    isSetupTest: true,
    setupTestMode: true,
    total: 100,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection('kotItems').doc('SETUP_KOT_1').set({
    storeId: DESTINATION_STORE_ID,
    orderId: 'SETUP_ORDER_1',
    orderNumber: 'CB-SETUP-0001',
    station: 'BARISTA',
    status: 'VOIDED',
  });
  await db.collection('stockMovements').doc('SETUP_SALE_MOVE_1').set({
    storeId: DESTINATION_STORE_ID,
    orderId: 'SETUP_ORDER_1',
    orderNumber: 'CB-SETUP-0001',
    movementType: 'SALE_CONSUMPTION',
    quantityDelta: -150,
  });
  await db.collection('stockMovements').doc('SETUP_REVERSAL_MOVE_1').set({
    storeId: DESTINATION_STORE_ID,
    sourceOrderId: 'SETUP_ORDER_1',
    orderNumber: 'CB-SETUP-0001',
    movementType: 'ORDER_VOID_REVERSAL',
    quantityDelta: 150,
  });
  const posTest = await callFunction('markInternalPosTestPassed', { storeId: DESTINATION_STORE_ID }, adminToken);
  assert.equal(posTest.posTestCompleted, true);
  assert.equal(await auditActionCount('MARK_INTERNAL_POS_TEST_PASSED'), 1);
  const repeatPosTest = await callFunction('markInternalPosTestPassed', { storeId: DESTINATION_STORE_ID }, adminToken);
  assert.equal(repeatPosTest.idempotent, true);
  assert.equal(await auditActionCount('MARK_INTERNAL_POS_TEST_PASSED'), 1);

  const activation = await callFunction('activateStore', { storeId: DESTINATION_STORE_ID }, adminToken);
  assert.equal(activation.status, 'ACTIVE');
  assert.equal(activation.posEnabled, true);
  assert.equal(activation.customerOrderingEnabled, false);
  const activeStore = await db.collection('stores').doc(DESTINATION_STORE_ID).get();
  assert.equal(activeStore.data().isActive, true);
  assert.equal(activeStore.data().onlineOrderingEnabled, false);

  const sourceStore = await db.collection('stores').doc(SOURCE_STORE_ID).get();
  assert.equal(sourceStore.data().isActive, true);
  assert.equal(sourceStore.data().customerOrderingEnabled, true);

  const auditSnap = await db.collection('storeProvisioningAudit').where('storeId', '==', DESTINATION_STORE_ID).get();
  const auditActions = auditSnap.docs.map((docSnap) => docSnap.data().action);
  assert.ok(auditActions.includes('SAVE_STAFF_ASSIGNMENTS'));
  assert.ok(auditActions.includes('SAVE_OPENING_STOCK'));
  assert.ok(auditActions.includes('ENABLE_INTERNAL_POS_TEST'));
  assert.ok(auditActions.includes('MARK_INTERNAL_POS_TEST_PASSED'));
  assert.ok(auditActions.includes('ACTIVATE_POS'));

  await flushFirestore();
  await seedData();
  const exceptionAdminToken = await signIn('admin.location-e2e@example.invalid');
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const readyExceptOpeningBatch = db.batch();
  readyExceptOpeningBatch.set(db.collection('stores').doc(DESTINATION_STORE_ID), {
    id: DESTINATION_STORE_ID,
    code: DESTINATION_STORE_ID,
    storeCode: DESTINATION_STORE_ID,
    name: 'Baked by Bond 51',
    displayName: 'Baked by Bond 51',
    address: 'QA address, Sector 51',
    city: 'Noida',
    state: 'Uttar Pradesh',
    pinCode: '201301',
    phone: '9999999999',
    email: 'baked51@example.invalid',
    gstRegistered: false,
    gstin: '',
    gstRate: 0,
    receiptName: 'Baked by Bond 51',
    receiptFooter: 'Setup test',
    timezone: 'Asia/Kolkata',
    status: 'DRAFT',
    isActive: false,
    posEnabled: false,
    customerOrderingEnabled: false,
    onlineOrderingEnabled: false,
    publicOrderingEnabled: false,
    acceptingOrders: false,
    isAcceptingOrders: false,
    onlineOrderingPaused: true,
    inventoryMode: 'FINISHED_GOODS',
    readiness: {
      inventoryStructureCreated: true,
      openingStockReviewed: false,
      posTestCompleted: true,
      customerOrderingTestCompleted: false,
    },
    posTestCompleted: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  for (const uid of [ADMIN_UID, MANAGER_UID, CASHIER_UID]) {
    readyExceptOpeningBatch.update(db.collection('users').doc(uid), {
      assignedStoreIds: admin.firestore.FieldValue.arrayUnion(DESTINATION_STORE_ID),
      storeIds: admin.firestore.FieldValue.arrayUnion(DESTINATION_STORE_ID),
      updatedAt: timestamp,
    });
  }
  readyExceptOpeningBatch.update(db.collection('finishedGoods').doc('HOT_LATTE'), {
    availableStoreIds: admin.firestore.FieldValue.arrayUnion(DESTINATION_STORE_ID),
  });
  readyExceptOpeningBatch.set(db.collection('storeStock').doc(`${DESTINATION_STORE_ID}_RAW_INGREDIENT_MILK`), {
    storeId: DESTINATION_STORE_ID,
    storeCode: DESTINATION_STORE_ID,
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'MILK',
    stockItemName: 'Fresh Milk',
    uom: 'ML',
    openingStock: 0,
    currentStock: 0,
    costPerUnit: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await readyExceptOpeningBatch.commit();

  const blockedActivation = await callFunction('activateStore', { storeId: DESTINATION_STORE_ID }, exceptionAdminToken, { expectError: true });
  assert.match(JSON.stringify(blockedActivation), /Opening stock/);
  const tooLongException = await callFunction('setPosLaunchException', {
    storeId: DESTINATION_STORE_ID,
    enabled: true,
    reason: 'Owner approved temporary staff POS for launch QA.',
    expiresAt: new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString(),
  }, exceptionAdminToken, { expectError: true });
  assert.match(JSON.stringify(tooLongException), /48 hours/);
  const validException = await callFunction('setPosLaunchException', {
    storeId: DESTINATION_STORE_ID,
    enabled: true,
    reason: 'Owner approved temporary staff POS for launch QA.',
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  }, exceptionAdminToken);
  assert.equal(validException.enabled, true);
  assert.equal(await auditActionCount('SET_POS_LAUNCH_EXCEPTION'), 1);
  const exceptionStore = await db.collection('stores').doc(DESTINATION_STORE_ID).get();
  assert.equal(exceptionStore.data().readiness.openingStockReviewed, false);
  assert.equal(exceptionStore.data().posLaunchException.enabled, true);
  const exceptionActivation = await callFunction('activateStore', { storeId: DESTINATION_STORE_ID }, exceptionAdminToken);
  assert.equal(exceptionActivation.status, 'ACTIVE');
  assert.equal(exceptionActivation.customerOrderingEnabled, false);
  const activatedExceptionStore = await db.collection('stores').doc(DESTINATION_STORE_ID).get();
  assert.equal(activatedExceptionStore.data().isActive, true);
  assert.equal(activatedExceptionStore.data().onlineOrderingEnabled, false);
  assert.equal(activatedExceptionStore.data().readiness.openingStockReviewed, false);
  const blockedOrdering = await callFunction('setStoreCustomerOrdering', {
    storeId: DESTINATION_STORE_ID,
    enabled: true,
  }, exceptionAdminToken, { expectError: true });
  assert.match(JSON.stringify(blockedOrdering), /Customer ordering requires active POS/);

  console.log('PASS Location Management emulator E2E');
  console.log(JSON.stringify({
    projectId: PROJECT_ID,
    destinationStoreId: DESTINATION_STORE_ID,
    firestoreWritesPerformedAgainstProduction: 0,
    checked: [
      'GST-registered preview',
      'GST-unregistered create',
      'invalid GSTIN rejected',
      'safe store copy',
      'opening stock manual entry',
      'zero-stock confirmation',
      'no duplicate opening-stock movements',
      'direct staff assignment',
      'existing staff assignments preserved',
      'cashier denied provisioning callable',
      'draft store hidden from customers and ordinary cashiers',
      'KOT/add-on/product validation readiness',
      'internal POS test evidence',
      'stock deduction and void reversal evidence',
      'activation',
      'customer ordering remains disabled',
      'source store unchanged',
    ],
  }, null, 2));
}

await run();
