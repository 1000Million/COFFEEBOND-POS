#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { FieldValue } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const DRY_RUN = process.argv.includes('--dry-run');
const TEMP_PASSWORD = process.env.TEMP_STAFF_PASSWORD?.trim();

const LIVE_STAFF = [
  { email: 'cashier.uday@coffeebond.in', displayName: 'Uday Park Cashier', role: 'CASHIER', storeCode: 'UDAY_PARK' },
  { email: 'kot.uday@coffeebond.in', displayName: 'Uday Park KOT', role: 'BARISTA', storeCode: 'UDAY_PARK' },
  { email: 'manager.uday@coffeebond.in', displayName: 'Uday Park Store Manager', role: 'STORE_MANAGER', storeCode: 'UDAY_PARK' },
  { email: 'cashier.noida29@coffeebond.in', displayName: 'Noida 29 Cashier', role: 'CASHIER', storeCode: 'NOIDA_29' },
  { email: 'kot.noida29@coffeebond.in', displayName: 'Noida 29 KOT', role: 'BARISTA', storeCode: 'NOIDA_29' },
  { email: 'manager.noida29@coffeebond.in', displayName: 'Noida 29 Store Manager', role: 'STORE_MANAGER', storeCode: 'NOIDA_29' },
  { email: 'cashier.noida51@coffeebond.in', displayName: 'Noida 51 Cashier', role: 'CASHIER', storeCode: 'NOIDA_51' },
  { email: 'kot.noida51@coffeebond.in', displayName: 'Noida 51 KOT', role: 'BARISTA', storeCode: 'NOIDA_51' },
  { email: 'manager.noida51@coffeebond.in', displayName: 'Noida 51 Store Manager', role: 'STORE_MANAGER', storeCode: 'NOIDA_51' },
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function requireTempPassword() {
  if (!TEMP_PASSWORD) {
    fail('TEMP_STAFF_PASSWORD is required. Export it before running this script.');
  }
  if (TEMP_PASSWORD.length < 6) {
    fail('TEMP_STAFF_PASSWORD must be at least 6 characters long for Firebase Auth.');
  }
}

async function loadAdminSdk() {
  try {
    return {
      appModule: await import('firebase-admin/app'),
      authModule: await import('firebase-admin/auth'),
      firestoreModule: await import('firebase-admin/firestore'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail([
      'firebase-admin is not installed in this workspace yet.',
      'Install it first with `npm install firebase-admin` in a network-enabled environment,',
      'or make sure it is already available in your local node_modules before running this script.',
      `Import error: ${message}`,
    ].join('\n'));
  }
}

async function loadCredential(appModule) {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    return appModule.cert(JSON.parse(rawJson));
  }

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

async function loadStoreDirectory(firestore) {
  const snap = await firestore.collection('stores').get();
  const stores = new Map();
  snap.forEach((doc) => {
    const data = doc.data();
    if (typeof data?.code === 'string' && data.code.trim()) {
      stores.set(data.code.trim(), {
        id: doc.id,
        code: data.code.trim(),
        name: typeof data.name === 'string' ? data.name : doc.id,
      });
    }
  });
  return stores;
}

async function resolveAuthUser(auth, email, displayName, tempPassword, dryRun) {
  let existing = null;
  try {
    existing = await auth.getUserByEmail(email);
  } catch (error) {
    const code = error?.code || error?.errorInfo?.code;
    if (code !== 'auth/user-not-found') throw error;
  }

  if (existing) {
    if (dryRun) {
      return { uid: existing.uid, action: 'would-update-auth' };
    }
    await auth.updateUser(existing.uid, {
      displayName,
      email,
      password: tempPassword,
      disabled: false,
      emailVerified: true,
    });
    return { uid: existing.uid, action: 'updated-auth' };
  }

  if (dryRun) {
    return { uid: '(new uid)', action: 'would-create-auth' };
  }

  const created = await auth.createUser({
    email,
    displayName,
    password: tempPassword,
    disabled: false,
    emailVerified: true,
  });
  return { uid: created.uid, action: 'created-auth' };
}

async function upsertStaffProfile(firestore, store, spec, uid, dryRun) {
  const docRef = firestore.collection('users').doc(uid);
  const assignedStoreIds = [store.id];

  const payload = {
    uid,
    name: spec.displayName,
    displayName: spec.displayName,
    email: spec.email,
    role: spec.role,
    isActive: true,
    assignedStoreIds,
    storeIds: assignedStoreIds,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (dryRun && uid === '(new uid)') {
    return { action: 'would-create-profile', payload };
  }

  const snapshot = await docRef.get();

  if (!snapshot.exists) {
    if (dryRun) {
      return { action: 'would-create-profile', payload };
    }
    await docRef.set({
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { action: 'created-profile', payload };
  }

  if (dryRun) {
    return { action: 'would-update-profile', payload };
  }

  await docRef.set(payload, { merge: true });
  return { action: 'updated-profile', payload };
}

async function setSupplementalClaims(auth, uid, role, storeIds, dryRun) {
  const claims = {
    role,
    storeIds,
    assignedStoreIds: storeIds,
  };
  if (dryRun) {
    return { action: 'would-set-claims', claims };
  }
  await auth.setCustomUserClaims(uid, claims);
  return { action: 'set-claims', claims };
}

async function main() {
  requireTempPassword();
  const sdk = await loadAdminSdk();
  const credential = await loadCredential(sdk.appModule);

  const app = sdk.appModule.getApps().length > 0
    ? sdk.appModule.getApp()
    : sdk.appModule.initializeApp({
      credential,
      projectId: PROJECT_ID,
    });

  const auth = sdk.authModule.getAuth(app);
  const firestore = sdk.firestoreModule.getFirestore(app);

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log('Password: [hidden]');
  console.log(`Users to provision: ${LIVE_STAFF.length}`);

  const storeDirectory = await loadStoreDirectory(firestore);
  const requiredStores = [...new Set(LIVE_STAFF.map((user) => user.storeCode))];
  const missingStores = requiredStores.filter((code) => !storeDirectory.has(code));
  if (missingStores.length > 0) {
    fail(`Missing store docs for: ${missingStores.join(', ')}. Check the stores collection first.`);
  }

  for (const spec of LIVE_STAFF) {
    const store = storeDirectory.get(spec.storeCode);
    if (!store) {
      fail(`Store ${spec.storeCode} is not available in Firestore.`);
    }

    const authResult = await resolveAuthUser(auth, spec.email, spec.displayName, TEMP_PASSWORD, DRY_RUN);
    const resolvedUid = authResult.uid;
    const profileResult = await upsertStaffProfile(firestore, store, spec, resolvedUid, DRY_RUN);
    const claimsResult = await setSupplementalClaims(auth, resolvedUid, spec.role, [store.id], DRY_RUN);

    console.log(
      `${DRY_RUN ? '[DRY RUN]' : '[DONE]'} ${spec.email} -> uid=${resolvedUid} role=${spec.role} store=${store.code} (${store.id})`,
    );
    console.log(`  auth: ${authResult.action}`);
    console.log(`  firestore/users/{uid}: ${profileResult.action}`);
    console.log(`  claims: ${claimsResult.action}`);
  }

  console.log('');
  console.log('Firestore fields written to users/{uid}: uid, name, displayName, email, role, isActive, assignedStoreIds, storeIds, createdAt (new docs only), updatedAt');
  console.log('Supplemental custom claims: role, storeIds, assignedStoreIds');
  console.log(DRY_RUN ? 'Dry run complete. No writes were performed.' : 'Live run complete.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
