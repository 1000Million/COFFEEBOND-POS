#!/usr/bin/env node
import process from 'node:process';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const DRY_RUN = process.argv.includes('--dry-run');
const TEMP_PASSWORD = process.env.TEMP_STAFF_PASSWORD?.trim();
const GOOGLE_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

const GOLDEN_I_STORE = {
  id: 'GOLDEN_I',
  code: 'GOLDEN_I',
  name: 'Golden I',
  address: [
    'Upper Ground Floor, Tower C, Unit No. 25 & 26,',
    'Golden I, Plot No. 11, Techzone 4,',
    'Greater Noida, Gautam Buddha Nagar,',
    'Uttar Pradesh - 201310',
  ].join('\n'),
};

const REFERENCE_STORE_IDS = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];

const GOLDEN_I_STAFF = [
  {
    email: 'cashier.goldeni@coffeebond.in',
    displayName: 'Golden I Cashier',
    role: 'CASHIER',
  },
  {
    email: 'kot.goldeni@coffeebond.in',
    displayName: 'Golden I KOT',
    role: 'BARISTA',
  },
  {
    email: 'manager.goldeni@coffeebond.in',
    displayName: 'Golden I Store Manager',
    role: 'STORE_MANAGER',
  },
];

const STORE_SETUP_FIELD_DEFAULTS = new Map([
  ['onlineOrderingEnabled', false],
  ['publicOrderingEnabled', false],
  ['acceptingOrders', false],
  ['isAcceptingOrders', false],
  ['customerOrderingEnabled', false],
  ['estimatedPrepMinutes', 20],
  ['onlineOrderingMessage', 'Online ordering is currently unavailable for this store.'],
  ['timezone', 'Asia/Kolkata'],
  ['timeZone', 'Asia/Kolkata'],
  ['setupStatus', 'SETUP'],
  ['operationalStatus', 'SETUP'],
  ['goLiveStatus', 'SETUP'],
  ['storeStatus', 'SETUP'],
  ['isLive', false],
  ['gstRate', 0],
  ['taxRate', 0],
  ['defaultGstRate', 0],
  ['defaultTaxRate', 0],
  ['gstPercent', 0],
  ['taxPercent', 0],
]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function requireRuntimeEnv() {
  if (!TEMP_PASSWORD) {
    fail('TEMP_STAFF_PASSWORD is required. Export it before running this script.');
  }

  if (TEMP_PASSWORD.length < 6) {
    fail('TEMP_STAFF_PASSWORD must be at least 6 characters long for Firebase Auth.');
  }

  if (!GOOGLE_CREDENTIALS) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required. Point it to your local Firebase service-account JSON before running.');
  }
}

function initializeAdmin() {
  const app = getApps().length > 0
    ? getApp()
    : initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });

  return {
    auth: getAuth(app),
    firestore: getFirestore(app),
  };
}

async function getStoreByIdOrCode(firestore, storeIdOrCode) {
  const direct = await firestore.collection('stores').doc(storeIdOrCode).get();
  if (direct.exists) {
    return { id: direct.id, ref: direct.ref, data: direct.data() || {} };
  }

  const byCode = await firestore.collection('stores')
    .where('code', '==', storeIdOrCode)
    .limit(1)
    .get();

  if (byCode.empty) return null;
  const doc = byCode.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() || {} };
}

async function loadReferenceStoreSchema(firestore) {
  const stores = [];
  const fields = new Set();

  for (const storeId of REFERENCE_STORE_IDS) {
    const store = await getStoreByIdOrCode(firestore, storeId);
    if (!store) {
      stores.push({ id: storeId, missing: true });
      continue;
    }

    stores.push({
      id: store.id,
      code: store.data.code,
      name: store.data.name,
      fields: Object.keys(store.data).sort(),
    });

    Object.keys(store.data).forEach((field) => fields.add(field));
  }

  return {
    stores,
    fields,
  };
}

async function loadUserSchema(firestore) {
  const snap = await firestore.collection('users').limit(50).get();
  const fields = new Set();
  const categoryByRole = new Map();
  let defaultCategory = null;

  snap.forEach((doc) => {
    const data = doc.data() || {};
    Object.keys(data).forEach((field) => fields.add(field));
    if (typeof data.userCategory === 'string' && data.userCategory.trim()) {
      defaultCategory ||= data.userCategory.trim();
      if (typeof data.role === 'string' && !categoryByRole.has(data.role)) {
        categoryByRole.set(data.role, data.userCategory.trim());
      }
    }
  });

  return { fields, categoryByRole, defaultCategory };
}

function buildGoldenStorePayload(storeSchemaFields) {
  const payload = {
    name: GOLDEN_I_STORE.name,
    code: GOLDEN_I_STORE.code,
    address: GOLDEN_I_STORE.address,
    isActive: true,
    onlineOrderingEnabled: false,
    estimatedPrepMinutes: 20,
    onlineOrderingMessage: 'Online ordering is currently unavailable for this store.',
    updatedAt: FieldValue.serverTimestamp(),
  };

  for (const [field, value] of STORE_SETUP_FIELD_DEFAULTS.entries()) {
    if (storeSchemaFields.has(field)) {
      payload[field] = value;
    }
  }

  return payload;
}

async function upsertGoldenStore(firestore, storeSchemaFields, dryRun) {
  const ref = firestore.collection('stores').doc(GOLDEN_I_STORE.id);
  const snapshot = await ref.get();
  const payload = buildGoldenStorePayload(storeSchemaFields);
  const action = snapshot.exists ? 'update-store' : 'create-store';

  if (!snapshot.exists) {
    payload.createdAt = FieldValue.serverTimestamp();
  }

  if (dryRun) {
    return {
      action: `would-${action}`,
      id: ref.id,
      path: ref.path,
      payload,
      previous: snapshot.exists ? snapshot.data() : null,
    };
  }

  await ref.set(payload, { merge: true });
  return {
    action: snapshot.exists ? 'updated-store' : 'created-store',
    id: ref.id,
    path: ref.path,
    payload,
  };
}

async function resolveAuthUser(auth, spec, dryRun) {
  let existing = null;

  try {
    existing = await auth.getUserByEmail(spec.email);
  } catch (error) {
    const code = error?.code || error?.errorInfo?.code;
    if (code !== 'auth/user-not-found') throw error;
  }

  if (existing) {
    if (dryRun) {
      return { uid: existing.uid, action: 'would-update-auth' };
    }

    await auth.updateUser(existing.uid, {
      email: spec.email,
      displayName: spec.displayName,
      password: TEMP_PASSWORD,
      disabled: false,
      emailVerified: true,
    });

    return { uid: existing.uid, action: 'updated-auth' };
  }

  if (dryRun) {
    return { uid: '(new uid)', action: 'would-create-auth' };
  }

  const created = await auth.createUser({
    email: spec.email,
    displayName: spec.displayName,
    password: TEMP_PASSWORD,
    disabled: false,
    emailVerified: true,
  });

  return { uid: created.uid, action: 'created-auth' };
}

function buildStaffProfilePayload(spec, uid, userSchema) {
  const assignedStoreIds = [GOLDEN_I_STORE.id];
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

  if (userSchema.fields.has('active')) {
    payload.active = true;
  }

  if (userSchema.fields.has('userCategory')) {
    payload.userCategory = userSchema.categoryByRole.get(spec.role)
      || userSchema.defaultCategory
      || 'STAFF';
  }

  return payload;
}

async function upsertStaffProfile(firestore, spec, uid, userSchema, dryRun) {
  const payload = buildStaffProfilePayload(spec, uid, userSchema);

  if (dryRun && uid === '(new uid)') {
    return { action: 'would-create-profile', path: 'users/{new uid}', payload };
  }

  const ref = firestore.collection('users').doc(uid);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    payload.createdAt = FieldValue.serverTimestamp();
  }

  if (dryRun) {
    return {
      action: snapshot.exists ? 'would-update-profile' : 'would-create-profile',
      path: ref.path,
      payload,
    };
  }

  await ref.set(payload, { merge: true });
  return {
    action: snapshot.exists ? 'updated-profile' : 'created-profile',
    path: ref.path,
    payload,
  };
}

async function setSupplementalClaims(auth, uid, role, dryRun) {
  const claims = {
    role,
    storeIds: [GOLDEN_I_STORE.id],
    assignedStoreIds: [GOLDEN_I_STORE.id],
  };

  if (dryRun) {
    return { action: 'would-set-claims', claims };
  }

  await auth.setCustomUserClaims(uid, claims);
  return { action: 'set-claims', claims };
}

function printReferenceSchema(schema) {
  console.log('Reference stores inspected:');
  for (const store of schema.stores) {
    if (store.missing) {
      console.log(`  - ${store.id}: missing`);
      continue;
    }
    console.log(`  - ${store.id}: code=${store.code} name=${store.name}`);
    console.log(`    fields: ${store.fields.join(', ')}`);
  }
}

function printableValue(value) {
  if (value && typeof value === 'object' && '_methodName' in value) {
    return '[serverTimestamp]';
  }
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function printPayload(label, payload) {
  console.log(label);
  Object.keys(payload).sort().forEach((key) => {
    console.log(`  ${key}: ${printableValue(payload[key])}`);
  });
}

async function main() {
  requireRuntimeEnv();

  const { auth, firestore } = initializeAdmin();
  const storeSchema = await loadReferenceStoreSchema(firestore);
  const userSchema = await loadUserSchema(firestore);

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log('Password: [hidden]');
  console.log('Credentials: [GOOGLE_APPLICATION_CREDENTIALS set]');
  printReferenceSchema(storeSchema);

  const missingReferenceStores = storeSchema.stores.filter((store) => store.missing).map((store) => store.id);
  if (missingReferenceStores.length > 0) {
    fail(`Cannot safely infer current store schema. Missing reference stores: ${missingReferenceStores.join(', ')}`);
  }

  const storeResult = await upsertGoldenStore(firestore, storeSchema.fields, DRY_RUN);
  console.log('');
  console.log(`${DRY_RUN ? '[DRY RUN]' : '[DONE]'} stores/${GOLDEN_I_STORE.id}: ${storeResult.action}`);
  printPayload('Store payload:', storeResult.payload);

  console.log('');
  console.log('Golden I staff provisioning:');
  for (const spec of GOLDEN_I_STAFF) {
    const authResult = await resolveAuthUser(auth, spec, DRY_RUN);
    const profileResult = await upsertStaffProfile(firestore, spec, authResult.uid, userSchema, DRY_RUN);
    const claimsResult = await setSupplementalClaims(auth, authResult.uid, spec.role, DRY_RUN);

    console.log(`${DRY_RUN ? '[DRY RUN]' : '[DONE]'} ${spec.email} -> uid=${authResult.uid} role=${spec.role} store=${GOLDEN_I_STORE.id}`);
    console.log(`  auth: ${authResult.action}`);
    console.log(`  profile: ${profileResult.action} (${profileResult.path})`);
    console.log(`  claims: ${claimsResult.action}`);
  }

  console.log('');
  console.log('Existing Uday Park, Noida 29, Noida 51 store records were read only.');
  console.log('Existing operational users are not modified unless their email is one of the three Golden I accounts.');
  console.log('No storeStock, orders, purchase entries, day closings, stock movements, or test data are created.');
  console.log(DRY_RUN ? 'Dry run complete. No writes were performed.' : 'Live run complete.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
