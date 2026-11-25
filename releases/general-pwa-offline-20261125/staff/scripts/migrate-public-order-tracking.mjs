#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const DEFAULT_ORDER_ID = 'dn7mPowd6whm89o6UVHx';
const DRY_RUN = process.argv.includes('--dry-run');
const ROTATE_TOKEN = process.argv.includes('--rotate-token');
const ORDER_ID = process.argv.find(arg => arg.startsWith('--order-id='))?.split('=')[1]?.trim() || DEFAULT_ORDER_ID;
const TRACKING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

async function loadAdminSdk() {
  try {
    return {
      appModule: await import('firebase-admin/app'),
      firestoreModule: await import('firebase-admin/firestore'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`firebase-admin is required to run this migration. Import error: ${message}`);
  }
}

async function loadCredential(appModule) {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) return appModule.cert(JSON.parse(rawJson));

  const credentialPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim()
    || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (credentialPath) {
    const absolutePath = path.isAbsolute(credentialPath)
      ? credentialPath
      : path.resolve(process.cwd(), credentialPath);
    const rawFile = await fs.readFile(absolutePath, 'utf8');
    return appModule.cert(JSON.parse(rawFile));
  }

  return appModule.applicationDefault();
}

function publicStatusMessage(status) {
  if (status === 'PENDING') return 'Your order request has been received. The store will confirm shortly.';
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Your order has been accepted and is being prepared.';
  if (status === 'READY') return 'Your order is ready for pickup.';
  if (status === 'SERVED') return 'Your order has been completed.';
  if (status === 'REJECTED') return 'Sorry, the store could not accept this order.';
  if (status === 'NEEDS_ATTENTION') return 'The store is reviewing your order.';
  return 'We are checking your order status.';
}

function normalizePublicStatus(status) {
  if (['PENDING', 'ACCEPTED', 'CONVERTED', 'REJECTED', 'NEEDS_ATTENTION', 'READY', 'SERVED', 'CANCELLED'].includes(status)) {
    return status;
  }
  return 'PENDING';
}

function generateSecureTrackingToken() {
  const token = randomBytes(24).toString('base64url');
  if (!TRACKING_TOKEN_PATTERN.test(token)) {
    fail('Could not create a secure public tracking token.');
  }
  return token;
}

function isValidSeparateTrackingToken(token, orderId) {
  return typeof token === 'string'
    && TRACKING_TOKEN_PATTERN.test(token)
    && token !== orderId;
}

function resolveTrackingToken(orderId, data) {
  const existingToken = typeof data.trackingToken === 'string' ? data.trackingToken.trim() : '';
  const hasValidSeparateToken = isValidSeparateTrackingToken(existingToken, orderId);

  if (ROTATE_TOKEN) {
    return {
      newToken: generateSecureTrackingToken(),
      oldToken: existingToken || null,
      rotated: true,
    };
  }

  if (hasValidSeparateToken) {
    return {
      newToken: existingToken,
      oldToken: existingToken,
      rotated: false,
    };
  }

  if (existingToken === orderId) {
    fail(`onlineOrders/${orderId}.trackingToken currently reuses the private order ID. Re-run with --rotate-token.`);
  }

  fail(`onlineOrders/${orderId} has no valid separate public tracking token. Re-run with --rotate-token.`);
}

function buildPublicTrackingPayload(data, trackingToken) {
  const publicOrderReference = typeof data.publicOrderReference === 'string' && data.publicOrderReference.trim()
    ? data.publicOrderReference.trim()
    : `CBWEB-${trackingToken.slice(0, 10).toUpperCase()}`;
  const publicStatus = normalizePublicStatus(data.status);

  return {
    trackingToken,
    publicOrderReference,
    storeName: String(data.storeName || 'Coffee Bond'),
    orderType: data.orderType === 'DINE_IN' ? 'DINE_IN' : 'PICKUP',
    ...(data.orderType === 'DINE_IN' && data.tableNumber ? { tableNumber: String(data.tableNumber) } : {}),
    items: Array.isArray(data.items)
      ? data.items.map(item => ({
        itemName: String(item.itemName || 'Item'),
        quantity: Number(item.quantity) || 0,
        lineTotal: Number(item.lineTotal) || 0,
      }))
      : [],
    subtotal: Number(data.subtotal) || 0,
    gstTotal: Number(data.gstTotal) || 0,
    total: Number(data.grandTotal) || 0,
    publicStatus,
    submittedAt: data.createdAt || FieldValue.serverTimestamp(),
    ...(data.convertedAt ? { acceptedAt: data.convertedAt } : {}),
    ...(data.linkedOrderNumber ? { publicOrderNumber: String(data.linkedOrderNumber) } : {}),
    customerStatusMessage: typeof data.customerStatusMessage === 'string' && data.customerStatusMessage.trim()
      ? data.customerStatusMessage.trim()
      : publicStatusMessage(publicStatus),
  };
}

function assertSanitizedPublicPayload(payload) {
  const forbiddenKeys = new Set([
    'customerName',
    'customerPhone',
    'notes',
    'convertedBy',
    'convertedByName',
    'rejectedBy',
    'rejectedByName',
    'rejectReason',
    'linkedOrderId',
    'phone',
    'uid',
    'staff',
    'bom',
    'stock',
  ]);
  const leaked = [];

  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key) || forbiddenKeys.has(key.toLowerCase())) {
        leaked.push(key);
      }
      visit(child);
    }
  }

  visit(payload);
  if (leaked.length > 0) {
    fail(`Public tracking payload contains forbidden private field(s): ${[...new Set(leaked)].join(', ')}`);
  }
}

async function main() {
  if (!ORDER_ID) fail('Missing --order-id value.');
  const sdk = await loadAdminSdk();
  const credential = await loadCredential(sdk.appModule);
  const app = sdk.appModule.getApps().length > 0
    ? sdk.appModule.getApp()
    : sdk.appModule.initializeApp({ credential, projectId: PROJECT_ID });
  const firestore = sdk.firestoreModule.getFirestore(app);

  const onlineOrderRef = firestore.collection('onlineOrders').doc(ORDER_ID);
  const onlineOrderSnap = await onlineOrderRef.get();
  if (!onlineOrderSnap.exists) fail(`onlineOrders/${ORDER_ID} does not exist.`);

  const onlineOrder = onlineOrderSnap.data();
  const tokenPlan = resolveTrackingToken(ORDER_ID, onlineOrder);
  const publicPayload = buildPublicTrackingPayload(onlineOrder, tokenPlan.newToken);
  assertSanitizedPublicPayload(publicPayload);

  const publicRef = firestore.collection('publicOrderTracking').doc(publicPayload.trackingToken);
  const oldPublicToken = tokenPlan.oldToken || ORDER_ID;
  const oldPublicRef = firestore.collection('publicOrderTracking').doc(oldPublicToken);
  const legacyPublicRef = firestore.collection('publicOrderTracking').doc(ORDER_ID);
  const refsToDelete = new Map();
  if (ROTATE_TOKEN && oldPublicToken !== tokenPlan.newToken) {
    refsToDelete.set(oldPublicRef.path, oldPublicRef);
  }
  if (ROTATE_TOKEN && ORDER_ID !== tokenPlan.newToken) {
    refsToDelete.set(legacyPublicRef.path, legacyPublicRef);
  }

  const privatePatch = {
    trackingToken: publicPayload.trackingToken,
    publicOrderReference: publicPayload.publicOrderReference,
  };

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`Private order: onlineOrders/${ORDER_ID}`);
  console.log(`Old public tracking path: ${oldPublicRef.path}`);
  console.log(`New public tracking path: ${publicRef.path}`);
  console.log(`New tracking URL: /order/status/${publicPayload.trackingToken}`);
  console.log(`Rotate token: ${ROTATE_TOKEN ? 'yes' : 'no'}`);
  console.log(`No PII written publicly: yes`);
  console.log(`Old tracking document removed: ${DRY_RUN ? 'dry-run pending' : refsToDelete.size > 0 ? 'yes after successful batch' : 'not needed'}`);
  console.log('Public payload:', JSON.stringify(publicPayload, null, 2));

  if (DRY_RUN) return;

  const batch = firestore.batch();
  batch.set(publicRef, publicPayload, { merge: true });
  batch.set(onlineOrderRef, privatePatch, { merge: true });
  refsToDelete.forEach(ref => batch.delete(ref));
  await batch.commit();
  console.log(`Migration complete. Removed ${refsToDelete.size} old public tracking document(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
