#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

const require = createRequire(import.meta.url);

const PROJECT_ID = 'demo-coffee-bond-kot-tracking';
const ASSIGNED_STORE_ID = 'ASSIGNED_STORE';
const OTHER_STORE_ID = 'OTHER_STORE';
const ORDER_ID = 'CUSTOMER_WEB_ORDER';
const OTHER_ORDER_ID = 'OTHER_STORE_ORDER';
const KITCHEN_ITEM_ID = 'ITEM_01';
const BARISTA_ITEM_ID = 'ITEM_02';
const KITCHEN_KOT_ID = 'CUSTOMER_WEB_ORDER_ITEM_01_KITCHEN';
const BARISTA_KOT_ID = 'CUSTOMER_WEB_ORDER_ITEM_02_BARISTA';
const OTHER_KOT_ID = 'OTHER_STORE_ORDER_ITEM_01_KITCHEN';
const NATIVE_ORDER_ID = 'POS_NATIVE_NO_LOYALTY';
const TRACKING_TOKEN = 'tracking_token_0123456789abcdef0123456789abcdef';
const ASSIGNED_UID = 'assigned-manager-kot-tracking';
const UNASSIGNED_UID = 'unassigned-manager-kot-tracking';
const PASSWORD = 'KotTrackingE2e12345!';
const ASSIGNED_EMAIL = 'assigned.kot-tracking@example.invalid';
const UNASSIGNED_EMAIL = 'unassigned.kot-tracking@example.invalid';

const passed = [];
const check = (name, condition) => {
  assert(condition, name);
  passed.push(name);
};

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
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/private/tmp/firebase-cli-kot-tracking',
  };
  const candidates = [
    '/opt/homebrew/opt/openjdk@21',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk@21',
    '/usr/local/opt/openjdk',
  ];
  for (const prefix of candidates) {
    if (commandResult(`${prefix}/bin/java`, ['-version']).status === 0) {
      return { ...baseEnv, JAVA_HOME: prefix, PATH: `${prefix}/bin:${baseEnv.PATH || ''}` };
    }
  }
  return baseEnv;
}

function requireCommand(command, args, label, installHint, env = process.env) {
  const result = commandResult(command, args, env);
  if (result.status === 0) return;
  const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  console.error(`BLOCKED: ${label} is unavailable for the isolated KOT tracking test.`);
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
    'Install Java and rerun this script. No Firebase project was touched.',
    javaEnv,
  );
  requireCommand(
    'firebase',
    ['--version'],
    'Firebase CLI',
    'Install Firebase CLI and rerun this script. No Firebase project was touched.',
    javaEnv,
  );

  const result = spawnSync(
    'firebase',
    [
      'emulators:exec',
      '--only', 'auth,firestore',
      '--project', PROJECT_ID,
      '--non-interactive',
      'node scripts/test-kot-public-tracking-emulator-e2e.mjs --inside-emulator',
    ],
    { stdio: 'inherit', env: javaEnv },
  );
  process.exit(result.status ?? 1);
}

const missingEnv = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']
  .filter((key) => !process.env[key]);
assert.deepEqual(missingEnv, [], `Emulator environment missing: ${missingEnv.join(', ')}`);
assert.ok(PROJECT_ID.startsWith('demo-'), 'The test must use a Firebase demo project.');

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const kotSource = readFileSync(resolve('frontend/pages/kot/KOTScreen.tsx'), 'utf8');
const readySource = readFileSync(resolve('frontend/pages/kot/ReadyToServe.tsx'), 'utf8');
const runningOrdersSource = readFileSync(resolve('frontend/pages/pos/RunningOrders.tsx'), 'utf8');

const scopedSiblingQuery = /const orderKotSnap = await getDocs\(query\(\s*collection\(db, 'kotItems'\),\s*where\('storeId', '==', item\.storeId\),\s*where\('orderId', '==', item\.orderId\),\s*\)\);/;
const legacyOrderOnlyQuery = /getDocs\(query\(collection\(db, 'kotItems'\), where\('orderId', '==', item\.orderId\)\)\)/;

check('READY uses the item assigned-store scope before the order id', scopedSiblingQuery.test(kotSource));
check('SERVED uses the item assigned-store scope before the order id', scopedSiblingQuery.test(readySource));
check('the READY order-only sibling query is removed', !legacyOrderOnlyQuery.test(kotSource));
check('the SERVED order-only sibling query is removed', !legacyOrderOnlyQuery.test(readySource));
check(
  'Ready to Serve loads non-admin stores through assigned document reads',
  /assignedStoreIdentifiers\(staffProfile\)[\s\S]*?getDoc\(doc\(db, 'stores', storeId\)\)/.test(readySource)
    && /accessiblePosStores\(fetched, staffProfile\)/.test(readySource)
    && !/getDocs\(query\(collection\(db, 'stores'\), where\('isActive', '==', true\)\)\)/.test(readySource),
);
check(
  'Ready to Serve subscribes only to the already-authorized store list',
  /const storeIdsToQuery = stores\.map\(store => store\.id\)/.test(readySource),
);
check(
  'READY preserves the existing READY-or-PREPARING mapping',
  /publicStatus: allDone \? 'READY' : 'PREPARING'/.test(kotSource)
    && /publicStatusMessage\('READY'\)/.test(kotSource)
    && /publicStatusMessage\('PREPARING'\)/.test(kotSource),
);
check(
  'SERVED preserves the existing SERVED-or-READY mapping',
  /publicStatus: allServed \? 'SERVED' : 'READY'/.test(readySource)
    && /publicStatusMessage\('SERVED'\)/.test(readySource)
    && /publicStatusMessage\('READY'\)/.test(readySource),
);
check(
  'the same equality-only query shape already exists in Running Orders',
  /where\('storeId', '==', order\.storeId\),\s*where\('orderId', '==', order\.id\)/.test(runningOrdersSource),
);

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const adminDb = admin.firestore();

async function flushFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true, `Could not flush Firestore emulator: ${response.status}`);
}

async function createUser(uid, email) {
  try {
    await admin.auth().createUser({ uid, email, password: PASSWORD, emailVerified: true, disabled: false });
  } catch (error) {
    if (error?.code !== 'auth/uid-already-exists' && error?.code !== 'auth/email-already-exists') throw error;
  }
}

function kotData({ storeId, orderId, orderItemId, orderNumber, station = 'KITCHEN', trackingToken = null }) {
  const createdAt = admin.firestore.Timestamp.fromMillis(1_700_000_000_000);
  return {
    storeId,
    storeCode: storeId,
    storeName: storeId === ASSIGNED_STORE_ID ? 'Assigned Store' : 'Other Store',
    orderId,
    orderNumber,
    orderItemId,
    station,
    itemName: station === 'BARISTA' ? 'QA Flat White' : 'QA Paneer Toast',
    itemCode: station === 'BARISTA' ? 'QA_FLAT_WHITE' : 'QA_PANEER_TOAST',
    quantity: 1,
    orderType: 'TAKEAWAY',
    tableNumber: null,
    customerName: null,
    ...(trackingToken ? { onlineOrderTrackingToken: trackingToken } : {}),
    status: 'PREPARING',
    createdAt,
    updatedAt: createdAt,
    createdByUserId: 'seed-admin',
    createdByName: 'Emulator Seed',
    addOns: [],
  };
}

async function seed() {
  await Promise.all([
    createUser(ASSIGNED_UID, ASSIGNED_EMAIL),
    createUser(UNASSIGNED_UID, UNASSIGNED_EMAIL),
  ]);

  const createdAt = admin.firestore.Timestamp.fromMillis(1_700_000_000_000);
  const batch = adminDb.batch();
  batch.set(adminDb.collection('users').doc(ASSIGNED_UID), {
    uid: ASSIGNED_UID,
    email: ASSIGNED_EMAIL,
    displayName: 'Assigned Manager',
    role: 'STORE_MANAGER',
    isActive: true,
    storeIds: [ASSIGNED_STORE_ID],
    assignedStoreIds: [ASSIGNED_STORE_ID],
  });
  batch.set(adminDb.collection('users').doc(UNASSIGNED_UID), {
    uid: UNASSIGNED_UID,
    email: UNASSIGNED_EMAIL,
    displayName: 'Unassigned Manager',
    role: 'STORE_MANAGER',
    isActive: true,
    storeIds: [OTHER_STORE_ID],
    assignedStoreIds: [OTHER_STORE_ID],
  });
  batch.set(adminDb.collection('orders').doc(ORDER_ID), {
    storeId: ASSIGNED_STORE_ID,
    orderNumber: 'CB-ASSIGNED-0001',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    source: 'CUSTOMER_WEB',
    grandTotal: 252,
    inventoryConsumptionStatus: 'APPLIED',
    createdAt,
  });
  batch.set(adminDb.collection('orders').doc(ORDER_ID).collection('items').doc(KITCHEN_ITEM_ID), {
    itemCode: 'QA_PANEER_TOAST',
    itemName: 'QA Paneer Toast',
    quantity: 1,
    prepStation: 'KITCHEN',
    status: 'PREPARING',
  });
  batch.set(adminDb.collection('orders').doc(ORDER_ID).collection('items').doc(BARISTA_ITEM_ID), {
    itemCode: 'QA_FLAT_WHITE',
    itemName: 'QA Flat White',
    quantity: 1,
    prepStation: 'BARISTA',
    status: 'PREPARING',
  });
  batch.set(adminDb.collection('orders').doc(ORDER_ID).collection('payments').doc('razorpay'), {
    method: 'ONLINE',
    provider: 'RAZORPAY',
    status: 'PAID',
    amount: 252,
  });
  batch.set(adminDb.collection('kotItems').doc(KITCHEN_KOT_ID), kotData({
    storeId: ASSIGNED_STORE_ID,
    orderId: ORDER_ID,
    orderItemId: KITCHEN_ITEM_ID,
    orderNumber: 'CB-ASSIGNED-0001',
    trackingToken: TRACKING_TOKEN,
  }));
  batch.set(adminDb.collection('kotItems').doc(BARISTA_KOT_ID), kotData({
    storeId: ASSIGNED_STORE_ID,
    orderId: ORDER_ID,
    orderItemId: BARISTA_ITEM_ID,
    orderNumber: 'CB-ASSIGNED-0001',
    station: 'BARISTA',
    trackingToken: TRACKING_TOKEN,
  }));
  batch.set(adminDb.collection('orders').doc(OTHER_ORDER_ID), {
    storeId: OTHER_STORE_ID,
    orderNumber: 'CB-OTHER-0001',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    createdAt,
  });
  batch.set(adminDb.collection('kotItems').doc(OTHER_KOT_ID), kotData({
    storeId: OTHER_STORE_ID,
    orderId: OTHER_ORDER_ID,
    orderItemId: KITCHEN_ITEM_ID,
    orderNumber: 'CB-OTHER-0001',
  }));
  batch.set(adminDb.collection('orders').doc(NATIVE_ORDER_ID), {
    storeId: ASSIGNED_STORE_ID,
    orderNumber: 'POS-NATIVE-0001',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    source: 'POS',
    createdAt,
  });
  batch.set(adminDb.collection('publicOrderTracking').doc(TRACKING_TOKEN), {
    trackingToken: TRACKING_TOKEN,
    publicOrderReference: 'CBWEB-0123456789',
    storeName: 'Assigned Store',
    orderType: 'PICKUP',
    items: [
      { itemName: 'QA Paneer Toast', quantity: 1, lineTotal: 240 },
      { itemName: 'QA Flat White', quantity: 1, lineTotal: 180 },
    ],
    subtotal: 420,
    gstTotal: 21,
    total: 441,
    publicStatus: 'PREPARING',
    submittedAt: createdAt,
    customerStatusMessage: 'Your order is being prepared.',
  });
  batch.set(adminDb.collection('stockMovements').doc('SALE_SENTINEL'), {
    storeId: ASSIGNED_STORE_ID,
    orderId: ORDER_ID,
    movementType: 'SALE_DEDUCTION',
    quantityDelta: -2,
    createdAt,
  });
  await batch.commit();
}

function emulatorClient(name) {
  const app = initializeApp({ apiKey: 'fake-key', projectId: PROJECT_ID }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const firestore = getFirestore(app);
  const [host, portText] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(firestore, host, Number(portText));
  return { app, auth, firestore };
}

function isPermissionDenied(error) {
  return error?.code === 'permission-denied' || error?.code === 'firestore/permission-denied';
}

function scopedOrderKots(firestore, storeId, orderId) {
  return query(
    collection(firestore, 'kotItems'),
    where('storeId', '==', storeId),
    where('orderId', '==', orderId),
  );
}

async function size(path) {
  return (await adminDb.collection(path).get()).size;
}

async function collectionGroupSize(name) {
  return (await adminDb.collectionGroup(name).get()).size;
}

async function operationalCounts() {
  return {
    orders: await size('orders'),
    orderItems: await collectionGroupSize('items'),
    payments: await collectionGroupSize('payments'),
    kotItems: await size('kotItems'),
    stockMovements: await size('stockMovements'),
    loyaltyPointLedger: await size('loyaltyPointLedger'),
    qualifyingVisitEvents: await size('qualifyingVisitEvents'),
    loyaltyShadowLogs: await size('loyaltyShadowLogs'),
    clubMemberships: await size('clubMemberships'),
  };
}

function stableData(value) {
  if (value?.toMillis) return { timestampMillis: value.toMillis() };
  if (Array.isArray(value)) return value.map(stableData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableData(item)]));
  }
  return value;
}

async function run() {
  console.log('KOT public-tracking test is isolated to Firebase Auth and Firestore emulators.');
  await flushFirestore();
  await seed();

  const assigned = emulatorClient('kot-tracking-assigned');
  const unassigned = emulatorClient('kot-tracking-unassigned');
  await signInWithEmailAndPassword(assigned.auth, ASSIGNED_EMAIL, PASSWORD);
  await signInWithEmailAndPassword(unassigned.auth, UNASSIGNED_EMAIL, PASSWORD);

  const countsBefore = await operationalCounts();
  const orderBefore = stableData((await adminDb.collection('orders').doc(ORDER_ID).get()).data());
  const nativeOrderBefore = stableData((await adminDb.collection('orders').doc(NATIVE_ORDER_ID).get()).data());
  const paymentBefore = stableData((await adminDb.collection('orders').doc(ORDER_ID).collection('payments').doc('razorpay').get()).data());
  const stockBefore = stableData((await adminDb.collection('stockMovements').doc('SALE_SENTINEL').get()).data());

  await assert.rejects(
    getDocs(query(collection(assigned.firestore, 'kotItems'), where('orderId', '==', ORDER_ID))),
    isPermissionDenied,
    'The reproduced orderId-only Store Manager query must be denied.',
  );
  passed.push('the orderId-only query reproduces permission-denied');

  const assignedSnapshot = await getDocs(scopedOrderKots(assigned.firestore, ASSIGNED_STORE_ID, ORDER_ID));
  check('the assigned Store Manager can read both scoped sibling KOTs', assignedSnapshot.size === 2);

  await assert.rejects(
    getDocs(scopedOrderKots(unassigned.firestore, ASSIGNED_STORE_ID, ORDER_ID)),
    isPermissionDenied,
    'An unassigned Store Manager must not read another store KOT.',
  );
  passed.push('an unassigned Store Manager is denied the scoped KOT read');

  await assert.rejects(
    updateDoc(doc(unassigned.firestore, 'kotItems', KITCHEN_KOT_ID), {
      status: 'READY',
      readyAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    isPermissionDenied,
    'An unassigned Store Manager must not update another store KOT.',
  );
  passed.push('an unassigned Store Manager is denied the KOT update');

  const kitchenKotRef = doc(assigned.firestore, 'kotItems', KITCHEN_KOT_ID);
  const baristaKotRef = doc(assigned.firestore, 'kotItems', BARISTA_KOT_ID);
  const kitchenItemRef = doc(assigned.firestore, 'orders', ORDER_ID, 'items', KITCHEN_ITEM_ID);
  const baristaItemRef = doc(assigned.firestore, 'orders', ORDER_ID, 'items', BARISTA_ITEM_ID);
  const trackingRef = doc(assigned.firestore, 'publicOrderTracking', TRACKING_TOKEN);

  const markReadyAndSync = async (kotRef, orderItemRef) => {
    await updateDoc(kotRef, {
      status: 'READY',
      readyAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await updateDoc(orderItemRef, { status: 'READY' });
    const relatedKots = await getDocs(scopedOrderKots(assigned.firestore, ASSIGNED_STORE_ID, ORDER_ID));
    const allReady = relatedKots.size > 0
      && relatedKots.docs.every((snapshot) => ['READY', 'SERVED', 'CANCELLED', 'WASTAGE_RECORDED'].includes(snapshot.data().status));
    await updateDoc(trackingRef, {
      publicStatus: allReady ? 'READY' : 'PREPARING',
      customerStatusMessage: allReady ? 'Your order is ready for pickup.' : 'Your order is being prepared.',
      ...(allReady ? { readyAt: serverTimestamp() } : {}),
    });
    return relatedKots;
  };

  const markServedAndSync = async (kotRef, orderItemRef) => {
    await updateDoc(kotRef, {
      status: 'SERVED',
      servedAt: serverTimestamp(),
      handledByUserId: ASSIGNED_UID,
      handledByName: 'Assigned Manager',
      updatedAt: serverTimestamp(),
    });
    await updateDoc(orderItemRef, { status: 'SERVED' });
    const relatedKots = await getDocs(scopedOrderKots(assigned.firestore, ASSIGNED_STORE_ID, ORDER_ID));
    const allServed = relatedKots.size > 0
      && relatedKots.docs.every((snapshot) => ['SERVED', 'CANCELLED', 'WASTAGE_RECORDED'].includes(snapshot.data().status));
    await updateDoc(trackingRef, {
      publicStatus: allServed ? 'SERVED' : 'READY',
      customerStatusMessage: allServed ? 'Your order has been completed.' : 'Your order is ready for pickup.',
      ...(allServed ? { servedAt: serverTimestamp() } : {}),
    });
    return relatedKots;
  };

  const firstReadyKots = await markReadyAndSync(kitchenKotRef, kitchenItemRef);
  check(
    'the first READY transition changes only its intended KOT and order item',
    firstReadyKots.size === 2
      && (await getDoc(kitchenKotRef)).data()?.status === 'READY'
      && (await getDoc(baristaKotRef)).data()?.status === 'PREPARING'
      && (await getDoc(kitchenItemRef)).data()?.status === 'READY'
      && (await getDoc(baristaItemRef)).data()?.status === 'PREPARING',
  );
  check('one unfinished sibling keeps public tracking PREPARING', (await getDoc(trackingRef)).data()?.publicStatus === 'PREPARING');

  const finalReadyKots = await markReadyAndSync(baristaKotRef, baristaItemRef);
  const readyTracking = (await getDoc(trackingRef)).data();
  check(
    'the final READY transition leaves exactly two READY KOTs and items',
    finalReadyKots.size === 2
      && finalReadyKots.docs.every((snapshot) => snapshot.data().status === 'READY')
      && (await getDoc(kitchenItemRef)).data()?.status === 'READY'
      && (await getDoc(baristaItemRef)).data()?.status === 'READY',
  );
  check('the final READY sibling moves public tracking to READY', readyTracking?.publicStatus === 'READY' && Boolean(readyTracking?.readyAt));

  const firstServedKots = await markServedAndSync(kitchenKotRef, kitchenItemRef);
  check(
    'the first SERVED transition changes only its intended KOT and order item',
    firstServedKots.size === 2
      && (await getDoc(kitchenKotRef)).data()?.status === 'SERVED'
      && (await getDoc(baristaKotRef)).data()?.status === 'READY'
      && (await getDoc(kitchenItemRef)).data()?.status === 'SERVED'
      && (await getDoc(baristaItemRef)).data()?.status === 'READY',
  );
  check('one unserved sibling keeps public tracking READY', (await getDoc(trackingRef)).data()?.publicStatus === 'READY');

  const finalServedKots = await markServedAndSync(baristaKotRef, baristaItemRef);
  check(
    'the final SERVED transition leaves exactly two SERVED KOTs and items',
    finalServedKots.size === 2
      && finalServedKots.docs.every((snapshot) => snapshot.data().status === 'SERVED')
      && (await getDoc(kitchenItemRef)).data()?.status === 'SERVED'
      && (await getDoc(baristaItemRef)).data()?.status === 'SERVED',
  );
  const servedTrackingSnapshot = await getDoc(trackingRef);
  const servedTracking = servedTrackingSnapshot.data();
  check('public tracking reflects the authoritative SERVED status', servedTracking?.publicStatus === 'SERVED' && Boolean(servedTracking?.servedAt));

  const retryArtifactsBefore = await Promise.all([
    adminDb.collection('kotItems').doc(BARISTA_KOT_ID).get(),
    adminDb.collection('orders').doc(ORDER_ID).collection('items').doc(BARISTA_ITEM_ID).get(),
    adminDb.collection('publicOrderTracking').doc(TRACKING_TOKEN).get(),
  ]);
  const retryKots = await markServedAndSync(baristaKotRef, baristaItemRef);
  const retryTracking = (await getDoc(trackingRef)).data();
  const retryArtifactsAfter = await Promise.all([
    adminDb.collection('kotItems').doc(BARISTA_KOT_ID).get(),
    adminDb.collection('orders').doc(ORDER_ID).collection('items').doc(BARISTA_ITEM_ID).get(),
    adminDb.collection('publicOrderTracking').doc(TRACKING_TOKEN).get(),
  ]);
  check(
    'a repeated final SERVED path has no duplicate business artifact',
    retryKots.size === 2
      && retryTracking?.publicStatus === 'SERVED'
      && retryKots.docs.every((snapshot) => snapshot.data().status === 'SERVED')
      && retryArtifactsAfter.every((snapshot, index) => snapshot.createTime.isEqual(retryArtifactsBefore[index].createTime)),
  );

  const countsAfter = await operationalCounts();
  check('document counts are unchanged by READY, SERVED, and retry', JSON.stringify(countsAfter) === JSON.stringify(countsBefore));
  check(
    'the customer-web POS order is unchanged',
    JSON.stringify(stableData((await adminDb.collection('orders').doc(ORDER_ID).get()).data())) === JSON.stringify(orderBefore),
  );
  check(
    'the native POS sentinel order is unchanged',
    JSON.stringify(stableData((await adminDb.collection('orders').doc(NATIVE_ORDER_ID).get()).data())) === JSON.stringify(nativeOrderBefore),
  );
  check(
    'the payment is unchanged',
    JSON.stringify(stableData((await adminDb.collection('orders').doc(ORDER_ID).collection('payments').doc('razorpay').get()).data())) === JSON.stringify(paymentBefore),
  );
  check(
    'stock is unchanged',
    JSON.stringify(stableData((await adminDb.collection('stockMovements').doc('SALE_SENTINEL').get()).data())) === JSON.stringify(stockBefore),
  );
  check(
    'the client fulfillment flow writes no loyalty documents',
    countsAfter.loyaltyPointLedger === 0
      && countsAfter.qualifyingVisitEvents === 0
      && countsAfter.loyaltyShadowLogs === 0
      && countsAfter.clubMemberships === 0,
  );

  await Promise.all([deleteApp(assigned.app), deleteApp(unassigned.app)]);
  console.log(`KOT public tracking emulator tests passed: ${passed.length}/${passed.length}.`);
  console.log('PRODUCTION_WRITES=0');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
