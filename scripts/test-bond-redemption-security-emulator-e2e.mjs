import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PROJECT_ID = 'demo-coffee-bond-redemption-security';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-redemption-security-firebase-config',
  };
  for (const prefix of ['/opt/homebrew/opt/openjdk@21', '/opt/homebrew/opt/openjdk', '/usr/local/opt/openjdk@21', '/usr/local/opt/openjdk']) {
    if (commandResult(`${prefix}/bin/java`, ['-version']).status === 0) {
      return { ...env, JAVA_HOME: prefix, PATH: `${prefix}/bin:${env.PATH || ''}` };
    }
  }
  return env;
}

if (!process.argv.includes('--inside-emulator')) {
  const env = emulatorEnv();
  const java = commandResult('java', ['-version'], env);
  const firebase = commandResult('firebase', ['--version'], env);
  if (java.status !== 0 || firebase.status !== 0) {
    console.error('BLOCKED: Firebase CLI and Java are required for isolated BOND redemption security QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'auth,firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-bond-redemption-security-emulator-e2e.mjs --inside-emulator',
  ], { stdio: 'inherit', env });
  process.exit(result.status ?? 1);
}

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator host is required.');
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth emulator host is required.');
assert.ok(PROJECT_ID.startsWith('demo-'), 'Only a throwaway demo project may be used.');
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const {
  initializeApp,
  deleteApp,
} = await import('firebase/app');
const {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} = await import('firebase/auth');
const {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  updateDoc,
  where,
} = await import('firebase/firestore');

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

async function clientFor(name, role, storeIds = []) {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-key', authDomain: 'localhost' }, name);
  const auth = getAuth(app);
  const [authHost, authPort] = process.env.FIREBASE_AUTH_EMULATOR_HOST.split(':');
  connectAuthEmulator(auth, `http://${authHost}:${authPort}`, { disableWarnings: true });
  const firestore = getFirestore(app);
  const [firestoreHost, firestorePort] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(firestore, firestoreHost, Number(firestorePort));
  const credential = await createUserWithEmailAndPassword(
    auth,
    `${name}@example.invalid`,
    'BondRules12345!',
  );
  await db.collection('users').doc(credential.user.uid).set({
    role,
    isActive: true,
    storeIds,
  });
  return { app, auth, firestore, uid: credential.user.uid };
}

async function denied(action) {
  try {
    await action();
    return false;
  } catch (error) {
    return String(error?.code || error?.message).includes('permission-denied');
  }
}

const customer = await clientFor('redemption-customer', 'CUSTOMER');
const unassignedManager = await clientFor('redemption-manager-unassigned', 'STORE_MANAGER', ['STORE_B']);
const assignedManager = await clientFor('redemption-manager-assigned', 'STORE_MANAGER', ['STORE_A']);
const adminClient = await clientFor('redemption-admin', 'ADMIN');

await db.collection('loyaltyAccounts').doc(customer.uid).set({
  customerId: customer.uid,
  pointsBalance: 56,
  reservedPoints: 50,
});
await db.collection('loyaltyPointLedger').doc('security_ledger_customer').set({
  customerId: customer.uid,
  eventType: 'POINT_EARN',
  pointsDelta: 56,
});
await db.collection('loyaltyRedemptionReservations').doc('security_reservation_existing').set({
  customerId: customer.uid,
  checkoutSessionId: 'security_checkout_session',
  storeId: 'STORE_A',
  points: 50,
  status: 'ACTIVE',
});

check(
  'customer can still read their own loyalty account',
  (await getDoc(doc(customer.firestore, 'loyaltyAccounts', customer.uid))).data().pointsBalance === 56,
);
check(
  'customer can still query their own immutable loyalty ledger',
  (await getDocs(query(
    collection(customer.firestore, 'loyaltyPointLedger'),
    where('customerId', '==', customer.uid),
  ))).size === 1,
);

const roles = [
  ['customer', customer],
  ['unassigned Store Manager', unassignedManager],
  ['assigned Store Manager', assignedManager],
  ['Admin UI client', adminClient],
];

for (const [label, client] of roles) {
  const reservation = doc(client.firestore, 'loyaltyRedemptionReservations', 'security_reservation_existing');
  check(`${label} cannot get a redemption reservation`, await denied(() => getDoc(reservation)));
  check(
    `${label} cannot list redemption reservations`,
    await denied(() => getDocs(collection(client.firestore, 'loyaltyRedemptionReservations'))),
  );
  check(
    `${label} cannot create a redemption reservation`,
    await denied(() => setDoc(
      doc(client.firestore, 'loyaltyRedemptionReservations', `forged_${client.uid}`),
      {
        customerId: client.uid,
        checkoutSessionId: `forged_checkout_${client.uid}`,
        storeId: 'STORE_A',
        points: 50,
        status: 'ACTIVE',
      },
    )),
  );
  check(
    `${label} cannot update a redemption reservation`,
    await denied(() => updateDoc(reservation, { points: 0, status: 'RELEASED' })),
  );
  check(
    `${label} cannot delete a redemption reservation`,
    await denied(() => deleteDoc(reservation)),
  );

  const account = doc(client.firestore, 'loyaltyAccounts', customer.uid);
  const ledger = doc(client.firestore, 'loyaltyPointLedger', 'security_ledger_customer');
  check(
    `${label} cannot create a loyalty account projection`,
    await denied(() => setDoc(
      doc(client.firestore, 'loyaltyAccounts', `forged_${client.uid}`),
      { customerId: client.uid, pointsBalance: 999 },
    )),
  );
  check(`${label} cannot update a loyalty account projection`, await denied(() => updateDoc(account, { pointsBalance: 999 })));
  check(`${label} cannot delete a loyalty account projection`, await denied(() => deleteDoc(account)));
  check(
    `${label} cannot create a loyalty ledger entry`,
    await denied(() => setDoc(
      doc(client.firestore, 'loyaltyPointLedger', `forged_${client.uid}`),
      { customerId: client.uid, eventType: 'POINT_REDEEM', pointsDelta: -50 },
    )),
  );
  check(`${label} cannot update a loyalty ledger entry`, await denied(() => updateDoc(ledger, { pointsDelta: 999 })));
  check(`${label} cannot delete a loyalty ledger entry`, await denied(() => deleteDoc(ledger)));
}

check(
  'denied client operations leave the server reservation unchanged',
  (await db.collection('loyaltyRedemptionReservations').doc('security_reservation_existing').get()).data().status === 'ACTIVE',
);
check(
  'denied client operations leave the server account unchanged',
  (await db.collection('loyaltyAccounts').doc(customer.uid).get()).data().pointsBalance === 56,
);
check(
  'denied client operations leave the immutable server ledger unchanged',
  (await db.collection('loyaltyPointLedger').doc('security_ledger_customer').get()).data().pointsDelta === 56,
);

await Promise.all(roles.map(([, client]) => deleteApp(client.app)));

console.log(`\nBOND redemption Firestore client-security tests passed: ${passed.length}/${passed.length}.`);
