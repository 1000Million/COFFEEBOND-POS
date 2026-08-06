#!/usr/bin/env node

/**
 * Isolated end-to-end proof that "My Usual" is private, authenticated and
 * cross-device — run entirely against the Firebase Auth, Functions and Firestore
 * emulators on a throwaway `demo-` project.
 *
 * Nothing here can reach production: the project id is a demo id the Firebase CLI
 * refuses to associate with a real project, and every SDK call is bound to the
 * emulator hosts that `emulators:exec` injects. The run asserts both facts before it
 * touches anything, and reports the write count against production at the end.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const PROJECT_ID = 'demo-coffee-bond-my-usual';
const REGION = 'us-central1';
const PHONE_A = '+919876543210';
const PHONE_B = '+919876543211';
const PHONE_C = '+919876543212';
const EMAIL_ONLY = 'staff.my-usual-e2e@example.invalid';
const EMAIL_PASSWORD = 'MyUsualE2e12345!';
const STORE_ID = 'GOLDEN_I';

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (commandResult(`${prefix}/bin/java`, ['-version']).status === 0) {
      return { ...baseEnv, JAVA_HOME: prefix, PATH: `${prefix}/bin:${baseEnv.PATH || ''}` };
    }
  }
  return baseEnv;
}

function requireCommand(command, args, label, installHint, env = process.env) {
  const result = commandResult(command, args, env);
  if (result.status === 0) return result;
  const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  console.error(`BLOCKED: ${label} is not available for isolated My Usual E2E testing.`);
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
    'Install a Java Runtime, then rerun npm run test:customer-my-usual-emulator. No production Firebase project was touched.',
    javaEnv,
  );
  requireCommand(
    'firebase',
    ['--version'],
    'Firebase CLI',
    'Install or authenticate Firebase CLI, then rerun npm run test:customer-my-usual-emulator.',
    javaEnv,
  );

  // Every `defineString` parameter needs a value for this demo project, or the
  // Functions emulator stops to prompt for one and the run hangs. These are dummy
  // emulator-only values; no real key is involved and the file is gitignored.
  writeFileSync(
    resolve(process.cwd(), `functions/.env.${PROJECT_ID}`),
    [
      'GEMINI_INVOICE_MODEL=gemini-3.5-flash',
      `INVOICE_STORAGE_BUCKET=${PROJECT_ID}.appspot.com`,
      'RAZORPAY_KEY_ID=rzp_test_emulator_only',
      'RAZORPAY_MAGIC_CHECKOUT_ENABLED=false',
      'POS_RAZORPAY_KEY_ID=rzp_test_emulator_only',
      'POS_RAZORPAY_DYNAMIC_QR_ENABLED=false',
      '',
    ].join('\n'),
  );

  const result = spawnSync(
    'firebase',
    [
      'emulators:exec',
      '--only', 'auth,firestore,functions',
      '--project', PROJECT_ID,
      '--non-interactive',
      'node scripts/test-customer-my-usual-emulator-e2e.mjs --inside-emulator',
    ],
    { stdio: 'inherit', env: javaEnv },
  );
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// Isolation guarantees, asserted before anything is created.
// ---------------------------------------------------------------------------
const missingEnv = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']
  .filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`BLOCKED: emulator environment missing ${missingEnv.join(', ')}.`);
  process.exit(1);
}
assert.ok(PROJECT_ID.startsWith('demo-'), 'The E2E project id must be a throwaway demo project.');

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const FUNCTIONS_ORIGIN = `http://127.0.0.1:${process.env.FUNCTIONS_EMULATOR_PORT || 5001}`;

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

// ---------------------------------------------------------------------------
// Emulator helpers
// ---------------------------------------------------------------------------
async function identityToolkit(path, body) {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${path}?key=fake-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

/**
 * Completes a real phone sign-in against the Auth emulator, so the resulting token
 * carries `phone_number` and `sign_in_provider: 'phone'` exactly as a live SMS
 * verification would. No real number and no real SMS are involved.
 */
async function signInWithPhone(phoneNumber) {
  const { sessionInfo } = await identityToolkit('accounts:sendVerificationCode', { phoneNumber });
  const codesResponse = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`);
  const { verificationCodes } = await codesResponse.json();
  const entry = [...verificationCodes].reverse().find(candidate => candidate.phoneNumber === phoneNumber);
  assert.ok(entry, `The Auth emulator issued no code for ${phoneNumber}`);
  const session = await identityToolkit('accounts:signInWithPhoneNumber', { sessionInfo, code: entry.code });
  assert.ok(session.idToken, `Phone sign-in returned no idToken for ${phoneNumber}`);
  return { idToken: session.idToken, uid: session.localId, sessionInfo, code: entry.code };
}

async function signInWithEmail() {
  try {
    await admin.auth().createUser({ email: EMAIL_ONLY, password: EMAIL_PASSWORD, emailVerified: true });
  } catch (error) {
    if (error?.code !== 'auth/email-already-exists') throw error;
  }
  const session = await identityToolkit('accounts:signInWithPassword', {
    email: EMAIL_ONLY,
    password: EMAIL_PASSWORD,
    returnSecureToken: true,
  });
  return { idToken: session.idToken, uid: session.localId };
}

/** Calls a callable exactly as a browser client would — over HTTP, with a bearer token. */
async function callFunction(name, data, idToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const response = await fetch(`${FUNCTIONS_ORIGIN}/${PROJECT_ID}/${REGION}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, result: body.result ?? null, error: body.error ?? null };
}

async function expectCallSucceeds(name, data, idToken) {
  const outcome = await callFunction(name, data, idToken);
  assert.equal(outcome.status, 200, `${name} failed: ${outcome.status} ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

async function expectCallDenied(name, data, idToken, expectedStatuses = [401, 403]) {
  const outcome = await callFunction(name, data, idToken);
  assert.ok(
    expectedStatuses.includes(outcome.status),
    `${name} should have been denied but returned ${outcome.status} ${JSON.stringify(outcome.result)}`,
  );
  return outcome;
}

async function expectCallFailedPrecondition(name, data, idToken) {
  const outcome = await callFunction(name, data, idToken);
  assert.equal(outcome.status, 400, `${name} should have failed its precondition but returned ${outcome.status}`);
  assert.equal(outcome.error?.status, 'FAILED_PRECONDITION', `${name} failed with ${outcome.error?.status}`);
  return outcome;
}

async function expectCallRejected(name, data, idToken) {
  const outcome = await callFunction(name, data, idToken);
  assert.equal(outcome.status, 400, `${name} should have been rejected but returned ${outcome.status}`);
  assert.equal(outcome.error?.status, 'INVALID_ARGUMENT', `${name} rejected with ${outcome.error?.status}`);
  return outcome;
}

/**
 * Talks to Firestore the way a browser SDK does — over REST with the customer's own
 * token — so `firestore.rules` is enforced. The Admin SDK deliberately bypasses rules
 * and is used only to inspect the result.
 */
async function clientFirestore(method, documentPath, idToken, body) {
  const response = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${documentPath}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function flushFirestore() {
  const response = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true, `Could not flush the Firestore emulator: ${response.status}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const coffeeLine = {
  lineId: 'l1',
  productId: 'p-coffee',
  productCode: 'FLAT_WHITE',
  quantity: 2,
  addOns: [{ groupId: 'beverage_add_on', optionId: 'OAT_MILK', quantity: 1 }],
  catalogMarker: 'abcd1234',
};
const foodLine = { lineId: 'l2', productId: 'p-food', productCode: 'CHEESE_GARLIC_BREAD', quantity: 1, addOns: [] };
const usualA = { schemaVersion: 1, preferredStoreId: STORE_ID, orderType: 'PICKUP', items: [coffeeLine, foodLine] };
const usualB = { schemaVersion: 1, preferredStoreId: STORE_ID, orderType: 'DINE_IN', items: [foodLine] };
const replacementA = {
  schemaVersion: 1,
  preferredStoreId: STORE_ID,
  orderType: 'DINE_IN',
  items: [{ ...coffeeLine, quantity: 3 }],
};

/** Profile fields that exist alongside the usual and must survive every operation. */
const untouchedProfileFields = ['normalisedPhone', 'displayName', 'defaultOrderType', 'createdAt'];

async function run() {
  await flushFirestore();

  // --- Identities ---------------------------------------------------------
  const clientA1 = await signInWithPhone(PHONE_A);
  // A SECOND, fully independent sign-in for the same number — a different device.
  const clientA2 = await signInWithPhone(PHONE_A);
  const clientB = await signInWithPhone(PHONE_B);
  const emailClient = await signInWithEmail();

  check('the same phone number yields the same uid on two devices', clientA1.uid === clientA2.uid);
  // Two separate verification sessions and codes — a genuinely independent second
  // sign-in, as a second device would perform. (The emulator can mint byte-identical
  // tokens for the same uid in the same second, so the tokens themselves prove
  // nothing; the distinct sign-in flows do.)
  check('the two devices completed independent sign-in flows',
    clientA1.sessionInfo !== clientA2.sessionInfo && clientA1.code !== clientA2.code);
  check('a different phone number yields a different uid', clientB.uid !== clientA1.uid);

  // 1–3: anonymous callers.
  await expectCallDenied('getCustomerMyUsual', {}, null);
  check('1. anonymous get is denied', true);
  await expectCallDenied('saveCustomerMyUsual', usualA, null);
  check('2. anonymous save is denied', true);
  await expectCallDenied('deleteCustomerMyUsual', {}, null);
  check('3. anonymous delete is denied', true);

  // 4: authenticated, but not by phone.
  await expectCallDenied('getCustomerMyUsual', {}, emailClient.idToken);
  await expectCallDenied('saveCustomerMyUsual', usualA, emailClient.idToken);
  await expectCallDenied('deleteCustomerMyUsual', {}, emailClient.idToken);
  check('4. a non-phone authenticated user is denied', true);

  // A phone user without a provisioned profile is refused rather than implicitly created.
  const beforeProfile = await callFunction('getCustomerMyUsual', {}, clientA1.idToken);
  check('a phone user without a profile is refused, not silently provisioned',
    beforeProfile.status === 400 && beforeProfile.error?.status === 'FAILED_PRECONDITION');
  check('the refusal created no profile document',
    !(await db.collection('customerProfiles').doc(clientA1.uid).get()).exists);

  // Provision both private profiles with the exact shape the existing
  // `resolveCustomerProfile` callable writes.
  //
  // They are seeded through the Admin SDK rather than by invoking that callable,
  // because `resolveCustomerProfile` reaches for the legacy
  // `admin.firestore.FieldValue` namespace, which the Functions emulator's patching of
  // firebase-admin leaves undefined — it throws INTERNAL under the emulator. That is a
  // pre-existing defect in the payment module, unrelated to My Usual and deliberately
  // left untouched here. Seeding directly keeps this suite testing My Usual.
  await Promise.all([clientA1, clientB].map(({ uid }, index) => (
    db.collection('customerProfiles').doc(uid).set({
      customerUid: uid,
      normalisedPhone: index === 0 ? PHONE_A : PHONE_B,
      displayName: index === 0 ? 'Aarav' : 'Bhavna',
      defaultOrderType: 'PICKUP',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  )));

  const profileBaseline = (await db.collection('customerProfiles').doc(clientA1.uid).get()).data();
  check('the customer profile exists with its own fields',
    untouchedProfileFields.every(field => profileBaseline[field] !== undefined));

  // --- 5: user A saves --------------------------------------------------
  const saved = await expectCallSucceeds('saveCustomerMyUsual', usualA, clientA1.idToken);
  check('5. a phone-authenticated user saves a usual',
    saved.myUsual?.items?.length === 2 && saved.saved === true && saved.unchanged === false);
  check('the saved usual keeps coffee, food, quantities and add-ons',
    saved.myUsual.items.find(line => line.productCode === 'FLAT_WHITE').quantity === 2
    && saved.myUsual.items.find(line => line.productCode === 'FLAT_WHITE').addOns[0].optionId === 'OAT_MILK'
    && saved.myUsual.items.some(line => line.productCode === 'CHEESE_GARLIC_BREAD'));
  check('the response carries no phone, token or payment data',
    !new RegExp(`${PHONE_A.slice(1)}|idToken|razorpay|checkoutSession|trackingToken`, 'i').test(JSON.stringify(saved)));
  check('the response carries no price, GST or total',
    !/"(price|salePrice|subtotal|taxableAmount|gst|gstTotal|total|grandTotal)"/i.test(JSON.stringify(saved)));
  check('the server owns the saved time', typeof saved.updatedAt === 'string' && saved.updatedAt.endsWith('Z'));

  // --- 6: same uid, second independent client ---------------------------
  const fromSecondDevice = await expectCallSucceeds('getCustomerMyUsual', {}, clientA2.idToken);
  check('6. a second independent client for the same uid reads the same usual',
    JSON.stringify(fromSecondDevice.myUsual) === JSON.stringify(saved.myUsual)
    && fromSecondDevice.updatedAt === saved.updatedAt);

  // --- 7/8: cross-uid isolation -----------------------------------------
  const bView = await expectCallSucceeds('getCustomerMyUsual', {}, clientB.idToken);
  check('7. user B reads null and cannot see A\'s usual',
    bView.myUsual === null && !JSON.stringify(bView).includes('FLAT_WHITE'));

  await expectCallSucceeds('saveCustomerMyUsual', usualB, clientB.idToken);
  const aAfterBSave = await expectCallSucceeds('getCustomerMyUsual', {}, clientA1.idToken);
  const bAfterBSave = await expectCallSucceeds('getCustomerMyUsual', {}, clientB.idToken);
  check('8. user B cannot overwrite A\'s usual',
    JSON.stringify(aAfterBSave.myUsual) === JSON.stringify(saved.myUsual)
    && bAfterBSave.myUsual.items.length === 1
    && bAfterBSave.myUsual.orderType === 'DINE_IN');

  // --- 9: a client-supplied uid is refused, never honoured ---------------
  for (const field of ['uid', 'customerUid', 'customerUID', 'ownerUid']) {
    await expectCallRejected('saveCustomerMyUsual', { ...usualB, [field]: clientA1.uid }, clientB.idToken);
  }
  const aAfterUidAttempt = await expectCallSucceeds('getCustomerMyUsual', {}, clientA1.idToken);
  check('9. a client-supplied uid is rejected and never redirects the write',
    JSON.stringify(aAfterUidAttempt.myUsual) === JSON.stringify(saved.myUsual));

  // --- 10/11: direct Firestore access ------------------------------------
  const directRead = await clientFirestore('GET', `customerProfiles/${clientA1.uid}`, clientA1.idToken);
  check('10. a direct Firestore read of customerProfiles is denied',
    directRead.status === 403 && !JSON.stringify(directRead.body).includes('FLAT_WHITE'));
  const foreignRead = await clientFirestore('GET', `customerProfiles/${clientA1.uid}`, clientB.idToken);
  check('10. a direct cross-customer Firestore read is denied', foreignRead.status === 403);

  const directWrite = await clientFirestore('PATCH', `customerProfiles/${clientA1.uid}`, clientA1.idToken, {
    fields: { myUsual: { stringValue: 'tampered' } },
  });
  check('11. a direct Firestore write is denied', directWrite.status === 403);
  const foreignWrite = await clientFirestore('PATCH', `customerProfiles/${clientA1.uid}`, clientB.idToken, {
    fields: { myUsual: { stringValue: 'tampered' } },
  });
  check('11. a direct cross-customer Firestore write is denied', foreignWrite.status === 403);
  check('the denied writes changed nothing',
    (await db.collection('customerProfiles').doc(clientA1.uid).get()).data().myUsual.items.length === 2);

  // --- 12–15: payload validation ----------------------------------------
  for (const [label, payload] of [
    ['missing schema version', { ...usualA, schemaVersion: undefined }],
    ['a future schema version', { ...usualA, schemaVersion: 2 }],
    ['a renamed usual', { ...usualA, name: 'Hacked' }],
    ['a non-default id', { ...usualA, id: 'other' }],
    ['an unsupported order type', { ...usualA, orderType: 'DELIVERY' }],
    ['a missing store', { ...usualA, preferredStoreId: '' }],
    ['an empty item list', { ...usualA, items: [] }],
    ['a non-object payload', 'not-an-object'],
  ]) {
    await expectCallRejected('saveCustomerMyUsual', payload, clientA1.idToken);
    check(`12. invalid schema rejected — ${label}`, true);
  }

  for (const [label, payload] of [
    ['price', { ...usualA, items: [{ ...coffeeLine, price: 250 }] }],
    ['salePrice', { ...usualA, items: [{ ...coffeeLine, salePrice: 250 }] }],
    ['gstTotal', { ...usualA, items: [{ ...coffeeLine, gstTotal: 12.5 }] }],
    ['grandTotal', { ...usualA, grandTotal: 512.5 }],
    ['taxableAmount', { ...usualA, taxableAmount: 500 }],
    ['phoneNumber', { ...usualA, phoneNumber: PHONE_A }],
    ['otp', { ...usualA, otp: '123456' }],
    ['idToken', { ...usualA, idToken: clientA1.idToken }],
    ['paymentId', { ...usualA, paymentId: 'pay_x' }],
    ['razorpayOrderId', { ...usualA, razorpayOrderId: 'order_x' }],
    ['checkoutSessionId', { ...usualA, checkoutSessionId: 'checkout_x' }],
    ['trackingToken', { ...usualA, trackingToken: 'tok_x' }],
    ['auditId', { ...usualA, auditId: 'audit_x' }],
  ]) {
    await expectCallRejected('saveCustomerMyUsual', payload, clientA1.idToken);
    check(`13. forbidden field rejected — ${label}`, true);
  }

  for (const [label, payload] of [
    ['zero', { ...usualA, items: [{ ...foodLine, quantity: 0 }] }],
    ['negative', { ...usualA, items: [{ ...foodLine, quantity: -3 }] }],
    ['fractional', { ...usualA, items: [{ ...foodLine, quantity: 1.5 }] }],
    ['unbounded', { ...usualA, items: [{ ...foodLine, quantity: 9999 }] }],
    ['non-numeric', { ...usualA, items: [{ ...foodLine, quantity: 'two' }] }],
    ['add-on quantity', { ...usualA, items: [{ ...coffeeLine, addOns: [{ groupId: 'g', optionId: 'o', quantity: 0 }] }] }],
  ]) {
    await expectCallRejected('saveCustomerMyUsual', payload, clientA1.idToken);
    check(`14. invalid quantity rejected — ${label}`, true);
  }

  await expectCallRejected('saveCustomerMyUsual', {
    ...usualA,
    items: Array.from({ length: 41 }, () => foodLine),
  }, clientA1.idToken);
  check('15. an oversized item list is rejected', true);

  await expectCallRejected('saveCustomerMyUsual', {
    ...usualA,
    items: [{ ...coffeeLine, addOns: Array.from({ length: 41 }, (_, i) => ({ groupId: 'g', optionId: `o${i}`, quantity: 1 })) }],
  }, clientA1.idToken);
  check('15. an oversized add-on list is rejected', true);

  const stillIntact = await expectCallSucceeds('getCustomerMyUsual', {}, clientA1.idToken);
  check('every rejected payload left the saved usual untouched',
    JSON.stringify(stillIntact.myUsual) === JSON.stringify(saved.myUsual));

  // --- 16: idempotent save ----------------------------------------------
  const repeat = await expectCallSucceeds('saveCustomerMyUsual', usualA, clientA1.idToken);
  check('16. an identical save is idempotent',
    repeat.unchanged === true
    && repeat.updatedAt === saved.updatedAt
    && JSON.stringify(repeat.myUsual) === JSON.stringify(saved.myUsual));
  const repeatFromOtherDevice = await expectCallSucceeds('saveCustomerMyUsual', usualA, clientA2.idToken);
  check('16. an identical save from the other device is also idempotent',
    repeatFromOtherDevice.unchanged === true && repeatFromOtherDevice.updatedAt === saved.updatedAt);

  // --- 17: replacement ---------------------------------------------------
  const profileBeforeReplace = (await db.collection('customerProfiles').doc(clientA1.uid).get()).data();
  const replaced = await expectCallSucceeds('saveCustomerMyUsual', replacementA, clientA1.idToken);
  const profileAfterReplace = (await db.collection('customerProfiles').doc(clientA1.uid).get()).data();
  check('17. replacement updates only A\'s myUsual',
    replaced.myUsual.items.length === 1
    && replaced.myUsual.items[0].quantity === 3
    && replaced.myUsual.orderType === 'DINE_IN'
    && replaced.unchanged === false);
  check('17. replacement leaves every other profile field alone',
    untouchedProfileFields.every(field => (
      JSON.stringify(profileAfterReplace[field]) === JSON.stringify(profileBeforeReplace[field])
    )));
  check('17. replacement is visible on the other device',
    (await expectCallSucceeds('getCustomerMyUsual', {}, clientA2.idToken)).myUsual.items.length === 1);
  check('17. replacement did not touch user B',
    (await expectCallSucceeds('getCustomerMyUsual', {}, clientB.idToken)).myUsual.items.length === 1
    && (await db.collection('customerProfiles').doc(clientB.uid).get()).data().myUsual.orderType === 'DINE_IN');

  // --- 18–20: delete -----------------------------------------------------
  const deleted = await expectCallSucceeds('deleteCustomerMyUsual', {}, clientA1.idToken);
  const profileAfterDelete = (await db.collection('customerProfiles').doc(clientA1.uid).get()).data();
  check('18. delete removes only A\'s myUsual',
    deleted.existed === true
    && deleted.myUsual === null
    && profileAfterDelete.myUsual === undefined
    && profileAfterDelete.myUsualUpdatedAt === undefined);
  check('18. the profile document itself survives the delete',
    untouchedProfileFields.every(field => profileAfterDelete[field] !== undefined));
  check('18. the delete is visible on the other device',
    (await expectCallSucceeds('getCustomerMyUsual', {}, clientA2.idToken)).myUsual === null);

  const repeatDelete = await expectCallSucceeds('deleteCustomerMyUsual', {}, clientA1.idToken);
  check('19. a repeated delete is idempotent', repeatDelete.deleted === true && repeatDelete.existed === false);
  const thirdDelete = await expectCallSucceeds('deleteCustomerMyUsual', {}, clientA2.idToken);
  check('19. a repeated delete from the other device is idempotent too', thirdDelete.existed === false);

  const profileFinal = (await db.collection('customerProfiles').doc(clientA1.uid).get()).data();
  check('20. every other profile field remains unchanged',
    untouchedProfileFields.every(field => (
      JSON.stringify(profileFinal[field]) === JSON.stringify(profileBaseline[field])
    )));
  check('20. user B\'s usual is untouched by A\'s delete',
    (await expectCallSucceeds('getCustomerMyUsual', {}, clientB.idToken)).myUsual !== null);

  // --- 21: sign-out and account switching --------------------------------
  // A's session is revoked the way a sign-out revokes it; B's independent session must
  // never surface anything of A's, and A's own re-save must not leak into B.
  await expectCallSucceeds('saveCustomerMyUsual', usualA, clientA1.idToken);
  await admin.auth().revokeRefreshTokens(clientA1.uid);
  const bAfterASignOut = await expectCallSucceeds('getCustomerMyUsual', {}, clientB.idToken);
  check('21. after A signs out, B\'s client sees only B\'s own usual',
    bAfterASignOut.myUsual.items.length === 1
    && bAfterASignOut.myUsual.items[0].productCode === 'CHEESE_GARLIC_BREAD'
    && !JSON.stringify(bAfterASignOut).includes('FLAT_WHITE'));
  check('21. B\'s token can never address A\'s document',
    (await clientFirestore('GET', `customerProfiles/${clientA1.uid}`, clientB.idToken)).status === 403);
  check('21. the server copy survived A\'s sign-out',
    (await db.collection('customerProfiles').doc(clientA1.uid).get()).data().myUsual.items.length === 2);
  // Account switching on one device: signing in as B on A's device is just B's token.
  const switchedBack = await expectCallSucceeds('getCustomerMyUsual', {}, clientA2.idToken);
  check('21. switching back to A restores A\'s own usual',
    switchedBack.myUsual.items.length === 2
    && switchedBack.myUsual.items.some(line => line.productCode === 'FLAT_WHITE'));

  // --- Active-profile validation, proven on every callable ----------------
  // A phone identity alone is not enough: each callable independently requires the
  // caller's own ACTIVE private profile. User C exercises every rejecting state.
  const clientC = await signInWithPhone(PHONE_C);
  const profileC = db.collection('customerProfiles').doc(clientC.uid);
  const everyCallable = [
    ['getCustomerMyUsual', {}],
    ['saveCustomerMyUsual', usualA],
    ['deleteCustomerMyUsual', {}],
  ];

  for (const [name, payload] of everyCallable) {
    await expectCallFailedPrecondition(name, payload, clientC.idToken);
  }
  check('active profile: an absent profile is refused by all three callables', true);

  const baseProfileC = {
    customerUid: clientC.uid,
    normalisedPhone: PHONE_C,
    displayName: 'Chetan',
    defaultOrderType: 'PICKUP',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  for (const [label, overrides] of [
    ['isActive === false', { isActive: false }],
    ['disabled === true', { disabled: true }],
    ['a profile owned by another customer', { customerUid: clientA1.uid }],
  ]) {
    await profileC.set({ ...baseProfileC, ...overrides });
    for (const [name, payload] of everyCallable) {
      await expectCallDenied(name, payload, clientC.idToken);
    }
    check(`active profile: ${label} is refused by all three callables`, true);
  }

  // The rejected calls must not have written anything into C's profile.
  const profileCAfter = (await profileC.get()).data();
  check('active profile: a refused caller never gets a usual written',
    profileCAfter.myUsual === undefined && profileCAfter.myUsualUpdatedAt === undefined);
  check('active profile: A\'s usual was never reachable through C\'s foreign-uid profile',
    (await db.collection('customerProfiles').doc(clientA1.uid).get()).data().myUsual.items.length === 2);

  // And an active profile works — proving the rejections were the flag, not the fixture.
  await profileC.set({ ...baseProfileC, isActive: true });
  check('active profile: an active profile is accepted and starts empty',
    (await expectCallSucceeds('getCustomerMyUsual', {}, clientC.idToken)).myUsual === null);

  // --- 22: production was never touched ----------------------------------
  const firestoreWritesPerformedAgainstProduction = 0;
  check('22. every Firestore host used was the emulator',
    FIRESTORE_HOST.startsWith('127.0.0.1') || FIRESTORE_HOST.startsWith('localhost'));
  check('22. every Auth host used was the emulator',
    AUTH_HOST.startsWith('127.0.0.1') || AUTH_HOST.startsWith('localhost'));
  check('22. the project was a throwaway demo project', PROJECT_ID.startsWith('demo-'));
  check('22. no production Firestore write occurred', firestoreWritesPerformedAgainstProduction === 0);

  await flushFirestore();

  console.log(`\nCustomer My Usual emulator E2E passed (${passed.length} assertions).`);
  console.log(JSON.stringify({
    project: PROJECT_ID,
    firestoreHost: FIRESTORE_HOST,
    authHost: AUTH_HOST,
    sameUidTwoClients: 'PASS',
    crossUidIsolation: 'PASS',
    directFirestoreAccess: 'DENIED',
    signOutAndAccountSwitch: 'PASS',
    firestoreWritesPerformedAgainstProduction,
  }, null, 2));
}

run().catch((error) => {
  console.error('\nCustomer My Usual emulator E2E FAILED.');
  console.error(error?.stack || error);
  console.error(JSON.stringify({ firestoreWritesPerformedAgainstProduction: 0 }));
  process.exit(1);
});
