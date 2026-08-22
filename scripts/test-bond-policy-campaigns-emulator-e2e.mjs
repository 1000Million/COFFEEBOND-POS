import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PROJECT_ID = 'demo-coffee-bond-policy-campaigns';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-policy-campaigns-firebase-config',
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
  if (commandResult('java', ['-version'], env).status !== 0 || commandResult('firebase', ['--version'], env).status !== 0) {
    console.error('BLOCKED: Firebase CLI and Java are required for isolated BOND Policy Manager emulator QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'auth,firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-bond-policy-campaigns-emulator-e2e.mjs --inside-emulator',
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
const Timestamp = admin.firestore.Timestamp;
const {
  createBondPolicyCampaignManagerService,
  definitionHash,
} = require('../functions/bondPolicyCampaignManager');

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
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  setDoc,
  updateDoc,
} = await import('firebase/firestore');

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

async function expectCode(code, action, name) {
  let received = null;
  try {
    await action();
  } catch (error) {
    received = String(error?.code || '');
  }
  check(name, received === code || received.endsWith(`/${code}`));
}

async function denied(action) {
  try {
    await action();
    return false;
  } catch (error) {
    return String(error?.code || error?.message).includes('permission-denied');
  }
}

async function collectionSize(path) {
  return (await db.collection(path).get()).size;
}

function canonical(value) {
  if (value && typeof value.toMillis === 'function') return { __timestampMillis: value.toMillis() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

const MANAGED_COLLECTIONS = [
  'bondPolicyGuardrails',
  'bondPolicyGuardrailVersions',
  'bondPolicyVersions',
  'bondCampaignVersions',
  'bondPolicyScopes',
  'bondCampaignScopes',
  'bondRewardApprovals',
  'bondPolicySchedules',
  'bondCampaignSchedules',
  'bondRewardSchedules',
  'bondRewardRuntime',
  'bondCampaignBudgets',
  'bondCampaignCustomerUsage',
  'bondPolicyAudit',
];

async function managedStateSnapshot() {
  const output = {};
  for (const collectionName of MANAGED_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).get();
    output[collectionName] = snapshot.docs
      .map(document => ({ id: document.id, data: canonical(document.data()) }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  const segments = await db.collectionGroup('segments').get();
  output.__segments = segments.docs
    .map(document => ({ path: document.ref.path, data: canonical(document.data()) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify(output);
}

async function clientFor(name, email) {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-key', authDomain: 'localhost' }, name);
  const auth = getAuth(app);
  const [authHost, authPort] = process.env.FIREBASE_AUTH_EMULATOR_HOST.split(':');
  connectAuthEmulator(auth, `http://${authHost}:${authPort}`, { disableWarnings: true });
  const firestore = getFirestore(app);
  const [firestoreHost, firestorePort] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(firestore, firestoreHost, Number(firestorePort));
  const credential = await createUserWithEmailAndPassword(auth, email, 'BondPolicyManager12345!');
  return { app, auth, firestore, uid: credential.user.uid };
}

async function profileClient(name, role, profile = {}) {
  const client = await clientFor(`bond-policy-${name}`, `bond-policy-${name}@example.invalid`);
  await db.collection('users').doc(client.uid).set({
    role,
    isActive: true,
    displayName: name,
    assignedStoreIds: [],
    storeIds: [],
    ...profile,
  });
  return client;
}

function requestFor(client, data) {
  return {
    auth: {
      uid: client.uid,
      token: { name: client.uid, firebase: { sign_in_provider: 'password' } },
    },
    data,
  };
}

const adminClient = await profileClient('admin', 'ADMIN');
const managerClient = await profileClient('manager-a', 'FRANCHISE_MANAGER', {
  assignedStoreIds: ['STORE_A'],
  storeIds: ['STORE_A'],
});
const inactiveManagerClient = await profileClient('inactive-manager', 'FRANCHISE_MANAGER', {
  isActive: false,
  assignedStoreIds: ['STORE_A'],
  storeIds: ['STORE_A'],
});
const passwordChangeManagerClient = await profileClient('password-change-manager', 'FRANCHISE_MANAGER', {
  mustChangePassword: true,
  assignedStoreIds: ['STORE_A'],
  storeIds: ['STORE_A'],
});
const viewerClient = await profileClient('viewer', 'FRANCHISE_VIEWER', {
  assignedStoreIds: ['STORE_A'],
  storeIds: ['STORE_A'],
});
const cashierClient = await profileClient('cashier', 'CASHIER', {
  assignedStoreIds: ['STORE_A'],
  storeIds: ['STORE_A'],
});
const customerClient = await profileClient('customer', 'CUSTOMER');

await Promise.all([
  db.collection('stores').doc('STORE_A').set({ code: 'STORE_A', name: 'Store A', isActive: true }),
  db.collection('stores').doc('STORE_B').set({ code: 'STORE_B', name: 'Store B', isActive: true }),
  db.collection('stores').doc('STORE_INACTIVE').set({ code: 'STORE_INACTIVE', name: 'Inactive Store', isActive: false }),
  db.collection('orders').doc('OPERATIONAL_ORDER_A').set({ storeId: 'STORE_A', status: 'COMPLETED', paymentStatus: 'PAID' }),
  db.collection('kotItems').doc('OPERATIONAL_KOT_A').set({ storeId: 'STORE_A', station: 'KITCHEN', orderId: 'OPERATIONAL_ORDER_A', status: 'READY' }),
]);

let nowMillis = Date.parse('2026-09-15T08:00:00.000Z');
const service = createBondPolicyCampaignManagerService({ admin, db, now: () => nowMillis });

await expectCode('permission-denied', () => service.managerState(requestFor(inactiveManagerClient, {})), 'inactive Franchise Manager is denied');
await expectCode('failed-precondition', () => service.managerState(requestFor(passwordChangeManagerClient, {})), 'temporary-password Franchise Manager is denied until password change');
await expectCode('permission-denied', () => service.managerState(requestFor(viewerClient, {})), 'Franchise Viewer is denied the control plane');
await expectCode('permission-denied', () => service.managerState(requestFor(cashierClient, {})), 'Cashier is denied the control plane');
await expectCode('permission-denied', () => service.managerState(requestFor(customerClient, {})), 'customer is denied the control plane');

const guardrails = {
  minEarnRateBps: 500,
  maxEarnRateBps: 2000,
  maxMultiplierBps: 30000,
  maxFixedBonusPoints: 50,
  maxCampaignDays: 31,
  maxCustomerAwards: 5,
  maxCampaignBudgetPoints: 1000,
  liabilityPaisePerPoint: 100,
};
const saveGuardrailData = {
  requestId: 'guardrail-save-0001',
  configurationType: 'GUARDRAIL',
  scope: 'GUARDRAIL',
  guardrails,
  reason: 'HQ launch guardrails',
};
const guardrailSave = await service.savePolicyDraft(requestFor(adminClient, saveGuardrailData));
check('HQ Admin saves an immutable guardrail draft', guardrailSave.status === 'DRAFT' && guardrailSave.configurationType === 'GUARDRAIL');
const auditAfterGuardrailSave = await collectionSize('bondPolicyAudit');
const duplicateGuardrailSave = await service.savePolicyDraft(requestFor(adminClient, saveGuardrailData));
check('duplicate guardrail save is idempotent', duplicateGuardrailSave.versionId === guardrailSave.versionId && await collectionSize('bondPolicyAudit') === auditAfterGuardrailSave);
await expectCode('already-exists', () => service.savePolicyDraft(requestFor(adminClient, {
  ...saveGuardrailData,
  guardrails: { ...guardrails, maxEarnRateBps: 1900 },
})), 'requestId reuse with a different guardrail definition is rejected');

await expectCode('permission-denied', () => service.savePolicyDraft(requestFor(managerClient, {
  ...saveGuardrailData,
  requestId: 'manager-guardrail-0001',
})), 'Franchise Manager cannot define HQ guardrails');

const guardrailSubmitData = {
  requestId: 'guardrail-submit-0001',
  configurationType: 'GUARDRAIL',
  versionId: guardrailSave.versionId,
  reason: 'Submit HQ guardrails',
};
const guardrailSubmit = await service.submitPolicyDraft(requestFor(adminClient, guardrailSubmitData));
check('HQ guardrail draft enters approval', guardrailSubmit.status === 'PENDING_APPROVAL');
const guardrailApproveData = {
  requestId: 'guardrail-approve-0001',
  configurationType: 'GUARDRAIL',
  versionId: guardrailSave.versionId,
  reason: 'Approve HQ guardrails',
};
const guardrailApproval = await service.approveConfiguration(requestFor(adminClient, guardrailApproveData));
check('HQ Admin approves guardrails', guardrailApproval.status === 'APPROVED' && guardrailApproval.guardrailVersionId === guardrailSave.versionId);

const T0 = Date.parse('2026-09-16T00:00:00.000Z');
const T1 = Date.parse('2026-09-20T00:00:00.000Z');
const T2 = Date.parse('2026-09-25T00:00:00.000Z');
const DAY_MS = 86_400_000;

const embeddedGlobalData = {
  requestId: 'embedded-global-save-0001',
  configurationType: 'POLICY',
  scope: 'GLOBAL',
  storeIds: [],
  earnRateBps: 1000,
  startsAt: new Date(T0).toISOString(),
  endsAt: new Date(T2).toISOString(),
  guardrails,
  reason: 'Global policy with linked HQ guardrails',
};
const embeddedGlobal = await service.savePolicyDraft(requestFor(adminClient, embeddedGlobalData));
check('embedded HQ guardrail hash is bound to the policy save audit',
  Boolean(embeddedGlobal.linkedGuardrailDefinitionHash)
  && (await db.collection('bondPolicyAudit').where('requestId', '==', embeddedGlobalData.requestId).get())
    .docs.some(document => document.data()?.linkedDefinitionHashes?.guardrail === embeddedGlobal.linkedGuardrailDefinitionHash));
await expectCode('already-exists', () => service.savePolicyDraft(requestFor(adminClient, {
  ...embeddedGlobalData,
  guardrails: { ...guardrails, maxEarnRateBps: guardrails.maxEarnRateBps - 1 },
})), 'embedded guardrail changes cannot reuse an existing policy save requestId');
await service.submitPolicyDraft(requestFor(adminClient, {
  requestId: 'embedded-global-submit-0001',
  configurationType: 'POLICY',
  versionId: embeddedGlobal.versionId,
  reason: 'Submit global policy and linked guardrails',
}));
const embeddedGlobalApproval = await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'embedded-global-approve-0001',
  configurationType: 'POLICY',
  versionId: embeddedGlobal.versionId,
  reason: 'Approve global policy and linked guardrails',
}));
const embeddedPolicyApproval = await db.collection('bondRewardApprovals').doc(`POLICY__${embeddedGlobal.versionId}`).get();
const embeddedGuardrailApproval = await db.collection('bondRewardApprovals').doc(`GUARDRAIL__${embeddedGlobal.guardrailVersionId}`).get();
check('linked HQ guardrail approval has immutable hash evidence beside the policy approval',
  embeddedPolicyApproval.data()?.linkedGuardrailDefinitionHash === embeddedGlobal.linkedGuardrailDefinitionHash
  && embeddedGlobalApproval.linkedGuardrailDefinitionHash === embeddedGlobal.linkedGuardrailDefinitionHash
  && embeddedGuardrailApproval.data()?.definitionHash === embeddedGlobal.linkedGuardrailDefinitionHash);

await expectCode('invalid-argument', () => service.savePolicyDraft(requestFor(managerClient, {
  requestId: 'policy-missing-start-0001', configurationType: 'POLICY', scope: 'STORE',
  storeIds: ['STORE_A'], earnRateBps: 1000, startsAt: null, endsAt: new Date(T1).toISOString(),
  guardrailVersionId: guardrailSave.versionId, reason: 'A version must have an approved activation window',
})), 'policy versions require an immutable approved start before submission');

const sharedVersionId = 'shared-policy-campaign-version';
await service.savePolicyDraft(requestFor(managerClient, {
  requestId: 'shared-policy-save-0001', draftId: sharedVersionId, configurationType: 'POLICY',
  scope: 'STORE', storeIds: ['STORE_A'], earnRateBps: 1000,
  startsAt: new Date(T0).toISOString(), endsAt: new Date(T1).toISOString(),
  guardrailVersionId: guardrailSave.versionId, reason: 'Policy/campaign identifier isolation',
}));
await service.saveCampaignDraft(requestFor(managerClient, {
  requestId: 'shared-campaign-save-0001', draftId: sharedVersionId, name: 'Identifier isolation',
  storeIds: ['STORE_A'], startsAt: new Date(T0).toISOString(), endsAt: new Date(T1).toISOString(),
  rewardType: 'FIXED_POINTS', fixedBonusPoints: 1, multiplierBps: null, minimumSpendPaise: 0,
  eligibleProductCodes: [], eligibleCategoryCodes: [], minimumUniqueVisitDays: 0, visitWindowDays: null,
  customerAwardLimit: 1, budgetPoints: 10, stackingMode: 'EXCLUSIVE_ONE',
  guardrailVersionId: guardrailSave.versionId, reason: 'Policy/campaign identifier isolation',
}));
await service.submitPolicyDraft(requestFor(managerClient, {
  requestId: 'shared-policy-submit-0001', configurationType: 'POLICY', versionId: sharedVersionId, reason: 'Submit shared policy ID',
}));
await service.submitCampaignDraft(requestFor(managerClient, {
  requestId: 'shared-campaign-submit-0001', configurationType: 'CAMPAIGN', versionId: sharedVersionId, reason: 'Submit shared campaign ID',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'shared-policy-approve-0001', configurationType: 'POLICY', versionId: sharedVersionId, reason: 'Approve shared policy ID',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'shared-campaign-approve-0001', configurationType: 'CAMPAIGN', versionId: sharedVersionId, reason: 'Approve shared campaign ID',
}));
check('policy and campaign versions with the same caller ID retain separate approvals', (await db.collection('bondRewardApprovals').doc(`POLICY__${sharedVersionId}`).get()).exists
  && (await db.collection('bondRewardApprovals').doc(`CAMPAIGN__${sharedVersionId}`).get()).exists);

const previewData = {
  storeId: 'STORE_A',
  eligibleSpendPaise: 10000,
  productCodes: ['COFFEE'],
  categoryCodes: ['BEVERAGES'],
  scenario: { eventAt: new Date(T0 + 60000).toISOString() },
  guardrailVersionId: guardrailSave.versionId,
  policyDraft: {
    scope: 'STORE',
    storeIds: ['STORE_A'],
    earnRateBps: 1500,
    startsAt: new Date(T0).toISOString(),
    endsAt: new Date(T2).toISOString(),
    guardrailVersionId: guardrailSave.versionId,
    reason: 'Preview assigned-store rate',
  },
  campaignDraft: {
    name: 'Preview bonus',
    storeIds: ['STORE_A'],
    startsAt: new Date(T0).toISOString(),
    endsAt: new Date(T1).toISOString(),
    rewardType: 'FIXED_POINTS',
    fixedBonusPoints: 5,
    multiplierBps: null,
    minimumSpendPaise: 10000,
    eligibleProductCodes: ['COFFEE'],
    eligibleCategoryCodes: [],
    minimumUniqueVisitDays: 0,
    visitWindowDays: null,
    customerAwardLimit: 2,
    budgetPoints: 100,
    stackingMode: 'EXCLUSIVE_ONE',
    guardrailVersionId: guardrailSave.versionId,
    reason: 'Preview assigned-store campaign',
  },
};
await expectCode('invalid-argument', () => service.savePolicyDraft(requestFor(managerClient, {
  requestId: 'blank-policy-reason-0001',
  configurationType: 'POLICY',
  ...previewData.policyDraft,
  reason: '   ',
})), 'policy drafts require a nonempty immutable-audit reason');
await expectCode('invalid-argument', () => service.saveCampaignDraft(requestFor(managerClient, {
  requestId: 'blank-campaign-reason-0001',
  ...previewData.campaignDraft,
  reason: '   ',
})), 'campaign drafts require a nonempty immutable-audit reason');
const beforePreview = await managedStateSnapshot();
const preview = await service.previewPolicyCampaign(requestFor(managerClient, previewData));
const afterPreview = await managedStateSnapshot();
check('assigned-store dry run reports customer reward and liability for the explicit preview store', preview.previewStoreId === 'STORE_A'
  && preview.basePoints === 15
  && preview.campaignPoints === 5
  && preview.totalRewardPoints === 20
  && preview.storeLiabilityPaise === 2000);
const mixedBasketPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  matchingEligibleSpendPaise: 4000,
  campaignDraft: { ...previewData.campaignDraft, minimumSpendPaise: 5000 },
}));
check('mixed-basket dry run applies product eligibility only to matching pre-GST line spend',
  mixedBasketPreview.basePoints === 15
  && mixedBasketPreview.matchedSpendPaise === 4000
  && mixedBasketPreview.campaignPoints === 0
  && mixedBasketPreview.validationErrors.includes('MINIMUM_SPEND_NOT_MET'));
check('dry run reports zero writes and leaves every managed collection byte-equivalent', preview.writesPerformed === 0 && beforePreview === afterPreview);
await expectCode('permission-denied', () => service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  storeId: 'STORE_B',
  policyDraft: { ...previewData.policyDraft, storeIds: ['STORE_B'] },
  campaignDraft: { ...previewData.campaignDraft, storeIds: ['STORE_B'] },
})), 'Franchise Manager cannot preview an unassigned store');
await expectCode('failed-precondition', () => service.previewPolicyCampaign(requestFor(adminClient, {
  ...previewData,
  campaignDraft: { ...previewData.campaignDraft, storeIds: ['STORE_A', 'STORE_INACTIVE'] },
})), 'dry run validates every selected store instead of only the displayed store');
await expectCode('failed-precondition', () => service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  campaignDraft: { ...previewData.campaignDraft, fixedBonusPoints: 51 },
})), 'dry run enforces approved HQ campaign guardrails');
await expectCode('failed-precondition', () => service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  campaignDraft: { ...previewData.campaignDraft, fixedBonusPoints: 11, budgetPoints: 10 },
})), 'a fixed bonus larger than its full campaign budget is rejected before approval');
await expectCode('failed-precondition', () => service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  campaignDraft: {
    ...previewData.campaignDraft,
    startsAt: new Date(T0).toISOString(),
    endsAt: new Date(T0 + DAY_MS).toISOString(),
    minimumUniqueVisitDays: 2,
    visitWindowDays: 2,
  },
})), 'visit campaign window must contain every prospective unique IST visit day');
const midnightStart = T0 + (18 * 60 * 60 * 1000) + (29 * 60 * 1000);
const midnightBoundaryPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  scenario: {},
  campaignDraft: {
    ...previewData.campaignDraft,
    startsAt: new Date(midnightStart).toISOString(),
    endsAt: new Date(midnightStart + (2 * 60 * 1000)).toISOString(),
    minimumUniqueVisitDays: 2,
    visitWindowDays: 2,
  },
}));
check('visit preview counts two prospective IST calendar days across a two-minute midnight boundary',
  midnightBoundaryPreview.campaignPoints === previewData.campaignDraft.fixedBonusPoints
  && midnightBoundaryPreview.validationErrors.length === 0);

const policyDraft = (requestId, earnRateBps, startsAt, endsAt) => ({
  requestId,
  configurationType: 'POLICY',
  scope: 'STORE',
  storeIds: ['STORE_A'],
  earnRateBps,
  startsAt: new Date(startsAt).toISOString(),
  endsAt: new Date(endsAt).toISOString(),
  guardrailVersionId: guardrailSave.versionId,
  reason: `STORE_A earn rate ${earnRateBps}`,
});

await expectCode('permission-denied', () => service.savePolicyDraft(requestFor(managerClient, {
  ...policyDraft('manager-cross-store-0001', 1500, T0, T1),
  storeIds: ['STORE_B'],
})), 'Franchise Manager cannot draft for an unassigned store');
await expectCode('permission-denied', () => service.savePolicyDraft(requestFor(managerClient, {
  ...policyDraft('manager-global-policy-0001', 1500, T0, T1),
  scope: 'GLOBAL',
  storeIds: [],
})), 'Franchise Manager cannot define the global earn policy');

const policyV1 = await service.savePolicyDraft(requestFor(managerClient, policyDraft('policy-v1-save-0001', 1200, T0, T2)));
check('assigned Franchise Manager saves STORE_A policy draft', policyV1.status === 'DRAFT');
const policyV1SubmitData = {
  requestId: 'policy-v1-submit-0001', configurationType: 'POLICY', versionId: policyV1.versionId, reason: 'Submit V1',
};
const policyV1Submit = await service.submitPolicyDraft(requestFor(managerClient, policyV1SubmitData));
check('assigned Franchise Manager submits STORE_A policy', policyV1Submit.status === 'PENDING_APPROVAL');
await expectCode('permission-denied', () => service.approveConfiguration(requestFor(managerClient, {
  requestId: 'policy-v1-manager-approve', configurationType: 'POLICY', versionId: policyV1.versionId,
})), 'Franchise Manager cannot approve a policy');
const policyV1ApproveData = {
  requestId: 'policy-v1-approve-0001', configurationType: 'POLICY', versionId: policyV1.versionId, reason: 'HQ approves V1',
};
const policyV1Approval = await service.approveConfiguration(requestFor(adminClient, policyV1ApproveData));
check('HQ Admin approves STORE_A policy', policyV1Approval.status === 'APPROVED');
await expectCode('permission-denied', () => service.scheduleConfiguration(requestFor(managerClient, {
  requestId: 'policy-v1-manager-schedule', configurationType: 'POLICY', versionId: policyV1.versionId,
})), 'Franchise Manager cannot schedule activation');

const policyV1ScheduleData = {
  requestId: 'policy-v1-schedule-0001',
  configurationType: 'POLICY',
  versionId: policyV1.versionId,
  startsAt: new Date(T0).toISOString(),
  endsAt: new Date(T1).toISOString(),
  reason: 'Activate V1',
};
const policyV1Schedule = await service.scheduleConfiguration(requestFor(adminClient, policyV1ScheduleData));
check('HQ Admin schedules STORE_A policy', policyV1Schedule.status === 'SCHEDULED');
const campaignOnlyPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  policyDraft: undefined,
}));
check('campaign-only dry run uses the scheduled store policy instead of legacy fallback', campaignOnlyPreview.basePoints === 12
  && campaignOnlyPreview.campaignPoints === 5
  && campaignOnlyPreview.policyVersionId === policyV1.versionId);
const uncoveredStorePreview = await service.previewPolicyCampaign(requestFor(adminClient, {
  ...previewData,
  policyDraft: undefined,
  campaignDraft: { ...previewData.campaignDraft, storeIds: ['STORE_A', 'STORE_B'] },
}));
check('campaign preview reports missing full-window policy coverage for every selected store',
  uncoveredStorePreview.validationErrors.some(message => message.includes('STORE_B')));
const overlappingPolicyPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  campaignDraft: undefined,
}));
check('policy dry run reports activation conflicts before scheduling', overlappingPolicyPreview.conflicts.some(conflict => conflict.startsWith('POLICY:STORE_STORE_A:')));
await expectCode('failed-precondition', () => service.scheduleConfiguration(requestFor(adminClient, {
  ...policyV1ScheduleData,
  requestId: 'policy-v1-backdated-0001',
  scheduleId: 'POLICY_V1_BACKDATED',
  startsAt: new Date(nowMillis - 1).toISOString(),
  endsAt: new Date(T0).toISOString(),
})), 'backdated activation is rejected');
const auditAfterV1Schedule = await collectionSize('bondPolicyAudit');
const policyV1ScheduleRetry = await service.scheduleConfiguration(requestFor(adminClient, policyV1ScheduleData));
check('schedule retry is audit-idempotent', policyV1ScheduleRetry.scheduleId === policyV1Schedule.scheduleId && await collectionSize('bondPolicyAudit') === auditAfterV1Schedule);
await expectCode('failed-precondition', () => service.scheduleConfiguration(requestFor(adminClient, {
  ...policyV1ScheduleData,
  requestId: 'policy-v1-overlap-0001',
  scheduleId: 'POLICY_V1_OVERLAP',
  startsAt: new Date(T0 + 60000).toISOString(),
  endsAt: new Date(T1 - 60000).toISOString(),
})), 'overlapping assigned-store policy schedule is rejected');

const campaignDraftData = {
  requestId: 'campaign-v1-save-0001',
  name: 'STORE_A launch bonus',
  storeIds: ['STORE_A'],
  startsAt: new Date(T0).toISOString(),
  endsAt: new Date(T2).toISOString(),
  rewardType: 'FIXED_POINTS',
  fixedBonusPoints: 5,
  multiplierBps: null,
  minimumSpendPaise: 10000,
  eligibleProductCodes: ['COFFEE'],
  eligibleCategoryCodes: [],
  minimumUniqueVisitDays: 0,
  visitWindowDays: null,
  customerAwardLimit: 2,
  budgetPoints: 100,
  stackingMode: 'EXCLUSIVE_ONE',
  guardrailVersionId: guardrailSave.versionId,
  reason: 'Assigned-store launch bonus',
};
const campaignV1 = await service.saveCampaignDraft(requestFor(managerClient, campaignDraftData));
check('assigned Franchise Manager saves STORE_A campaign draft', campaignV1.status === 'DRAFT');
const campaignSubmit = await service.submitCampaignDraft(requestFor(managerClient, {
  requestId: 'campaign-v1-submit-0001', configurationType: 'CAMPAIGN', versionId: campaignV1.versionId, reason: 'Submit campaign',
}));
check('assigned Franchise Manager submits STORE_A campaign', campaignSubmit.status === 'PENDING_APPROVAL');
await expectCode('permission-denied', () => service.approveConfiguration(requestFor(managerClient, {
  requestId: 'campaign-v1-manager-approve', configurationType: 'CAMPAIGN', versionId: campaignV1.versionId,
})), 'Franchise Manager cannot approve a campaign');
const campaignApproval = await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'campaign-v1-approve-0001', configurationType: 'CAMPAIGN', versionId: campaignV1.versionId, reason: 'HQ campaign approval',
}));
check('HQ Admin approves campaign and its liability budget', campaignApproval.status === 'APPROVED' && (await db.collection('bondCampaignBudgets').doc(campaignV1.versionId).get()).exists);
await expectCode('failed-precondition', () => service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'campaign-v1-window-extension', configurationType: 'CAMPAIGN', versionId: campaignV1.versionId,
  startsAt: new Date(T0).toISOString(), endsAt: new Date(T2 + 60000).toISOString(), reason: 'Must stay approved',
})), 'campaign schedule cannot extend beyond its immutable approved window');
await expectCode('failed-precondition', () => service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'campaign-v1-uncovered-schedule', configurationType: 'CAMPAIGN', versionId: campaignV1.versionId,
  startsAt: new Date(T0).toISOString(), endsAt: new Date(T2).toISOString(), reason: 'Policy coverage is incomplete',
})), 'campaign scheduling is denied until one policy covers its complete window');

const alternateGuardrailId = 'guardrail-alternate-approved';
const alternateGuardrailDefinition = {
  schemaVersion: 1,
  configurationType: 'GUARDRAIL',
  guardrails,
  reason: 'Conflicting guardrail identity test',
};
const alternateCampaignId = 'campaign-alternate-guardrail';
const alternateCampaignDefinition = {
  ...campaignDraftData,
  campaignId: alternateCampaignId,
  guardrailVersionId: alternateGuardrailId,
};
delete alternateCampaignDefinition.requestId;
await Promise.all([
  db.collection('bondPolicyGuardrails').doc(alternateGuardrailId).set({
    versionId: alternateGuardrailId,
    configurationType: 'GUARDRAIL',
    definition: alternateGuardrailDefinition,
    definitionHash: definitionHash(alternateGuardrailDefinition),
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    immutable: true,
  }),
  db.collection('bondCampaignVersions').doc(alternateCampaignId).set({
    versionId: alternateCampaignId,
    campaignId: alternateCampaignId,
    configurationType: 'CAMPAIGN',
    definition: alternateCampaignDefinition,
    definitionHash: definitionHash(alternateCampaignDefinition),
    storeIds: ['STORE_A'],
    guardrailVersionId: alternateGuardrailId,
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    immutable: true,
  }),
  db.collection('bondCampaignBudgets').doc(alternateCampaignId).set({
    versionId: alternateCampaignId,
    campaignId: alternateCampaignId,
    storeIds: ['STORE_A'],
    budgetPoints: 100,
    awardedPoints: 0,
    reversedPoints: 0,
    netConsumedPoints: 0,
    awardCount: 0,
  }),
]);
await expectCode('failed-precondition', () => service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'campaign-alternate-guardrail-schedule',
  configurationType: 'CAMPAIGN',
  versionId: alternateCampaignId,
  startsAt: new Date(T0).toISOString(),
  endsAt: new Date(T1).toISOString(),
  reason: 'Must conflict with active policy guardrails',
})), 'overlapping policy and campaign schedules must share one approved guardrail version');

const policyV2 = await service.savePolicyDraft(requestFor(managerClient, policyDraft('policy-v2-save-0001', 1500, T1, T2)));
await service.submitPolicyDraft(requestFor(managerClient, {
  requestId: 'policy-v2-submit-0001', configurationType: 'POLICY', versionId: policyV2.versionId, reason: 'Submit V2',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'policy-v2-approve-0001', configurationType: 'POLICY', versionId: policyV2.versionId, reason: 'HQ approves V2',
}));
const policyV2Schedule = await service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'policy-v2-schedule-0001', configurationType: 'POLICY', versionId: policyV2.versionId,
  startsAt: new Date(T1).toISOString(), endsAt: new Date(T2).toISOString(), reason: 'Activate V2',
}));
check('adjacent policy version schedules without overlap', policyV2Schedule.status === 'SCHEDULED');
const campaignSchedule = await service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'campaign-v1-schedule-0001', configurationType: 'CAMPAIGN', versionId: campaignV1.versionId,
  startsAt: new Date(T0).toISOString(), endsAt: new Date(T2).toISOString(), reason: 'Schedule campaign after full policy coverage',
}));
check('HQ Admin schedules the approved campaign after complete policy coverage', campaignSchedule.status === 'SCHEDULED');
const storePolicyOverlayPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  campaignDraft: undefined,
  policyDraft: { ...previewData.policyDraft, earnRateBps: 1300 },
}));
check('policy-only dry run overlays the candidate store rate with the active scheduled campaign',
  storePolicyOverlayPreview.basePoints === 13 && storePolicyOverlayPreview.campaignPoints === 5);
const filteredCampaignOverlayPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  productCodes: undefined,
  categoryCodes: undefined,
  scenario: { ...previewData.scenario, productCodes: undefined, categoryCodes: undefined },
  campaignDraft: undefined,
  policyDraft: { ...previewData.policyDraft, earnRateBps: 1300 },
}));
check('policy-only dry run uses the active filtered campaign when explicit scenario codes are omitted',
  filteredCampaignOverlayPreview.basePoints === 13
  && filteredCampaignOverlayPreview.campaignPoints === 5
  && filteredCampaignOverlayPreview.validationErrors.length === 0);
const globalPolicyOverlayPreview = await service.previewPolicyCampaign(requestFor(adminClient, {
  ...previewData,
  campaignDraft: undefined,
  policyDraft: {
    ...previewData.policyDraft,
    scope: 'GLOBAL',
    storeIds: [],
    earnRateBps: 1800,
  },
}));
check('candidate global dry run preserves the active store override and active campaign',
  globalPolicyOverlayPreview.basePoints === 12 && globalPolicyOverlayPreview.campaignPoints === 5);
const orphaningPolicyPreview = await service.previewPolicyCampaign(requestFor(managerClient, {
  ...previewData,
  campaignDraft: undefined,
  policyDraft: {
    ...previewData.policyDraft,
    earnRateBps: 1300,
    endsAt: new Date(T1 + DAY_MS).toISOString(),
  },
}));
check('policy-only dry run reports when the candidate would orphan an existing campaign window',
  orphaningPolicyPreview.validationErrors.some(message => message.includes('not fully covered')));

nowMillis = T1 + 60000;
const rollback = await service.rollbackConfiguration(requestFor(adminClient, {
  requestId: 'policy-rollback-0001',
  configurationType: 'POLICY',
  versionId: policyV1.versionId,
  scheduleId: policyV2Schedule.scheduleId,
  endsAt: new Date(T2).toISOString(),
  reason: 'Rollback V2 to approved V1',
}));
check('HQ rollback appends a new V1 activation and links the replaced schedule', rollback.status === 'SCHEDULED' && rollback.rollbackOfScheduleId === policyV2Schedule.scheduleId);
const oldV1Definition = (await db.collection('bondPolicyVersions').doc(policyV1.versionId).get()).data().definitionHash;
const rollbackSegment = await db.collection('bondPolicyScopes').doc('STORE_STORE_A').collection('segments').doc(rollback.scheduleId).get();
check('rollback preserves immutable V1 and creates a separate segment', rollbackSegment.exists && (await db.collection('bondPolicyVersions').doc(policyV1.versionId).get()).data().definitionHash === oldV1Definition);

const campaignRollback = await service.rollbackConfiguration(requestFor(adminClient, {
  requestId: 'campaign-rollback-implicit-end-0001',
  configurationType: 'CAMPAIGN',
  versionId: campaignV1.versionId,
  scheduleId: campaignSchedule.scheduleId,
  reason: 'Verify immutable campaign end is retained',
}));
check('finite campaign rollback without an end retains its immutable approved end', campaignRollback.endsAt === new Date(T2).toISOString());
await expectCode('failed-precondition', () => service.rollbackConfiguration(requestFor(adminClient, {
  requestId: 'campaign-rollback-overlong-end-0001',
  configurationType: 'CAMPAIGN',
  versionId: campaignV1.versionId,
  scheduleId: campaignRollback.scheduleId,
  endsAt: new Date(T2 + 60000).toISOString(),
  reason: 'Must not extend the immutable campaign window',
})), 'finite campaign rollback cannot extend beyond its immutable approved end');

nowMillis += 60000;
const pauseData = {
  requestId: 'policy-pause-0001',
  configurationType: 'POLICY',
  versionId: policyV1.versionId,
  scheduleId: rollback.scheduleId,
  reason: 'Assigned manager pauses STORE_A rollback segment',
};
await expectCode('failed-precondition', () => service.pauseConfiguration(requestFor(managerClient, {
  ...pauseData,
  requestId: 'policy-pause-while-campaign-active',
})), 'underlying policy cannot be paused while an active campaign still depends on it');
const campaignPause = await service.pauseConfiguration(requestFor(managerClient, {
  requestId: 'campaign-pause-0001',
  configurationType: 'CAMPAIGN',
  versionId: campaignV1.versionId,
  scheduleId: campaignRollback.scheduleId,
  reason: 'Pause campaign before its underlying policy',
}));
check('assigned Franchise Manager can pause the assigned-store campaign first', campaignPause.status === 'PAUSED');
const pause = await service.pauseConfiguration(requestFor(managerClient, pauseData));
check('assigned Franchise Manager pauses only the assigned-store policy', pause.status === 'PAUSED' && pause.scheduleId === rollback.scheduleId);
const auditAfterPause = await collectionSize('bondPolicyAudit');
const pauseRetry = await service.pauseConfiguration(requestFor(managerClient, pauseData));
check('pause retry is audit-idempotent', pauseRetry.scheduleId === pause.scheduleId && await collectionSize('bondPolicyAudit') === auditAfterPause);

const T3 = Date.parse('2026-10-01T00:00:00.000Z');
const globalOpen = await service.savePolicyDraft(requestFor(adminClient, {
  requestId: 'global-open-save-0001',
  configurationType: 'POLICY',
  scope: 'GLOBAL',
  storeIds: [],
  earnRateBps: 1000,
  startsAt: new Date(T3).toISOString(),
  endsAt: null,
  guardrailVersionId: guardrailSave.versionId,
  reason: 'Open-ended global default regression',
}));
await service.submitPolicyDraft(requestFor(adminClient, {
  requestId: 'global-open-submit-0001', configurationType: 'POLICY', versionId: globalOpen.versionId, reason: 'Submit open global',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'global-open-approve-0001', configurationType: 'POLICY', versionId: globalOpen.versionId, reason: 'Approve open global',
}));
const globalOpenSchedule = await service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'global-open-schedule-0001', configurationType: 'POLICY', versionId: globalOpen.versionId,
  startsAt: new Date(T3).toISOString(), endsAt: null, reason: 'Activate open global',
}));
check('open-ended global schedule preserves a null end', globalOpenSchedule.endsAt === null);
await expectCode('failed-precondition', () => service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'global-open-overlap-0001', configurationType: 'POLICY', versionId: globalOpen.versionId,
  scheduleId: 'GLOBAL_OPEN_OVERLAP', startsAt: new Date(T3 + 60000).toISOString(), endsAt: null, reason: 'Must overlap',
})), 'open-ended global schedule rejects every later overlapping activation');
nowMillis = T3 + 120000;
const stateWithOpenGlobal = await service.managerState(requestFor(adminClient, {}));
check('open-ended global schedule is active after its start', stateWithOpenGlobal.globalPolicy?.versionId === globalOpen.versionId && stateWithOpenGlobal.globalPolicy.status === 'ACTIVE');
const futureCampaign = await service.saveCampaignDraft(requestFor(managerClient, {
  requestId: 'future-campaign-save-0001',
  name: 'Future pause regression',
  storeIds: ['STORE_A'],
  startsAt: new Date(T3 + DAY_MS).toISOString(),
  endsAt: new Date(T3 + (2 * DAY_MS)).toISOString(),
  rewardType: 'FIXED_POINTS',
  fixedBonusPoints: 2,
  multiplierBps: null,
  minimumSpendPaise: 0,
  eligibleProductCodes: [],
  eligibleCategoryCodes: [],
  minimumUniqueVisitDays: 0,
  visitWindowDays: null,
  customerAwardLimit: 1,
  budgetPoints: 10,
  stackingMode: 'EXCLUSIVE_ONE',
  guardrailVersionId: guardrailSave.versionId,
  reason: 'Future schedule must remain cancellable',
}));
await service.submitCampaignDraft(requestFor(managerClient, {
  requestId: 'future-campaign-submit-0001', configurationType: 'CAMPAIGN', versionId: futureCampaign.versionId, reason: 'Submit future campaign',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'future-campaign-approve-0001', configurationType: 'CAMPAIGN', versionId: futureCampaign.versionId, reason: 'Approve future campaign',
}));
const futureCampaignSchedule = await service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'future-campaign-schedule-0001', configurationType: 'CAMPAIGN', versionId: futureCampaign.versionId,
  startsAt: new Date(T3 + DAY_MS).toISOString(), endsAt: new Date(T3 + (2 * DAY_MS)).toISOString(), reason: 'Schedule future campaign',
}));
const pausedFutureCampaign = await service.pauseConfiguration(requestFor(managerClient, {
  requestId: 'future-campaign-pause-0001', configurationType: 'CAMPAIGN', versionId: futureCampaign.versionId,
  scheduleId: futureCampaignSchedule.scheduleId, reason: 'Cancel future campaign before activation',
}));
const pausedFutureCampaignSegment = await db.collection('bondCampaignScopes').doc('STORE_A').collection('segments').doc(futureCampaignSchedule.scheduleId).get();
check('a future campaign can be paused before activation without creating a reward window', pausedFutureCampaign.status === 'PAUSED'
  && pausedFutureCampaignSegment.data().status === 'PAUSED'
  && pausedFutureCampaignSegment.data().startsAt.toMillis() === pausedFutureCampaignSegment.data().endsAt.toMillis());
const pausedOpenGlobal = await service.pauseConfiguration(requestFor(adminClient, {
  requestId: 'global-open-pause-0001', configurationType: 'POLICY', versionId: globalOpen.versionId,
  scheduleId: globalOpenSchedule.scheduleId, reason: 'Pause open global',
}));
const pausedOpenSegment = await db.collection('bondPolicyScopes').doc('GLOBAL').collection('segments').doc(globalOpenSchedule.scheduleId).get();
check('pausing an open-ended schedule writes a finite close time', pausedOpenGlobal.status === 'PAUSED' && pausedOpenSegment.data().endsAt.toMillis() === nowMillis);

const hiddenGlobalDraft = await service.savePolicyDraft(requestFor(adminClient, {
  requestId: 'global-hidden-draft-save',
  configurationType: 'POLICY',
  scope: 'GLOBAL',
  storeIds: [],
  earnRateBps: 1100,
  startsAt: new Date(T3 + 86_400_000).toISOString(),
  endsAt: null,
  guardrailVersionId: guardrailSave.versionId,
  reason: 'HQ draft must not leak to franchise scope',
}));

const T4 = T3 + 24 * 60 * 60 * 1000;
const multiStorePolicy = await service.savePolicyDraft(requestFor(adminClient, {
  requestId: 'multi-store-policy-save-0001',
  configurationType: 'POLICY',
  scope: 'STORE',
  storeIds: ['STORE_A', 'STORE_B'],
  earnRateBps: 1000,
  startsAt: new Date(T4).toISOString(),
  endsAt: new Date(T4 + 4 * 24 * 60 * 60 * 1000).toISOString(),
  guardrailVersionId: guardrailSave.versionId,
  reason: 'Multi-store state regression',
}));
await service.submitPolicyDraft(requestFor(adminClient, {
  requestId: 'multi-store-policy-submit-0001', configurationType: 'POLICY', versionId: multiStorePolicy.versionId, reason: 'Submit multi-store policy',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'multi-store-policy-approve-0001', configurationType: 'POLICY', versionId: multiStorePolicy.versionId, reason: 'Approve multi-store policy',
}));
const multiStoreActiveSchedule = await service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'multi-store-policy-active-0001', configurationType: 'POLICY', versionId: multiStorePolicy.versionId,
  startsAt: new Date(T4).toISOString(), endsAt: new Date(T4 + 24 * 60 * 60 * 1000).toISOString(), reason: 'First multi-store window',
}));
await service.scheduleConfiguration(requestFor(adminClient, {
  requestId: 'multi-store-policy-future-0001', configurationType: 'POLICY', versionId: multiStorePolicy.versionId,
  startsAt: new Date(T4 + 2 * 24 * 60 * 60 * 1000).toISOString(),
  endsAt: new Date(T4 + 3 * 24 * 60 * 60 * 1000).toISOString(),
  reason: 'Second multi-store window',
}));
nowMillis = T4 + 60000;
const multiStoreState = await service.managerState(requestFor(adminClient, {}));
const multiStoreRow = multiStoreState.storePolicies.find(policy => policy.versionId === multiStorePolicy.versionId);
check('multi-store scheduled version appears once with both stores', multiStoreState.storePolicies.filter(policy => policy.versionId === multiStorePolicy.versionId).length === 1
  && multiStoreRow?.storeIds.join(',') === 'STORE_A,STORE_B');
check('active segment wins over a future segment for the same version', multiStoreRow?.status === 'ACTIVE'
  && multiStoreRow?.scheduleId === multiStoreActiveSchedule.scheduleId);
const endedCentralBefore = (await db.collection('bondRewardSchedules').doc(policyV1Schedule.scheduleId).get()).data();
await expectCode('failed-precondition', () => service.pauseConfiguration(requestFor(adminClient, {
  requestId: 'ended-policy-pause-0001', configurationType: 'POLICY', versionId: policyV1.versionId,
  scheduleId: policyV1Schedule.scheduleId, reason: 'An ended segment must remain historical',
})), 'an ended schedule cannot be paused into a phantom central interval');
const endedCentralAfter = (await db.collection('bondRewardSchedules').doc(policyV1Schedule.scheduleId).get()).data();
check('rejected ended-schedule pause leaves its central record unchanged',
  canonical(endedCentralBefore) && JSON.stringify(canonical(endedCentralBefore)) === JSON.stringify(canonical(endedCentralAfter)));
await expectCode('failed-precondition', () => service.rollbackConfiguration(requestFor(adminClient, {
  requestId: 'expired-policy-rollback-0001', configurationType: 'POLICY', versionId: policyV1.versionId,
  scheduleId: multiStoreActiveSchedule.scheduleId, endsAt: null, reason: 'Expired policy versions cannot escape their approved window',
})), 'a finite policy cannot roll back after its immutable approved window');
const activeWindowRollbackTarget = await service.savePolicyDraft(requestFor(adminClient, {
  requestId: 'active-window-rollback-target-save', configurationType: 'POLICY', scope: 'STORE',
  storeIds: ['STORE_A'], earnRateBps: 900, startsAt: new Date(T4).toISOString(),
  endsAt: new Date(T4 + (2 * DAY_MS)).toISOString(), guardrailVersionId: guardrailSave.versionId,
  reason: 'Target used to prove source schedule validation',
}));
await service.submitPolicyDraft(requestFor(adminClient, {
  requestId: 'active-window-rollback-target-submit', configurationType: 'POLICY', versionId: activeWindowRollbackTarget.versionId,
  reason: 'Submit source-validation target',
}));
await service.approveConfiguration(requestFor(adminClient, {
  requestId: 'active-window-rollback-target-approve', configurationType: 'POLICY', versionId: activeWindowRollbackTarget.versionId,
  reason: 'Approve source-validation target',
}));
await expectCode('failed-precondition', () => service.rollbackConfiguration(requestFor(adminClient, {
  requestId: 'ended-source-rollback-0001', configurationType: 'POLICY', versionId: activeWindowRollbackTarget.versionId,
  scheduleId: policyV1Schedule.scheduleId, endsAt: new Date(T4 + DAY_MS).toISOString(), reason: 'Ended source schedule is not active',
})), 'rollback cannot use an already-ended supplied source schedule');

const managerState = await service.managerState(requestFor(managerClient, {}));
check('Franchise Manager state is scoped to STORE_A', managerState.actorRole === 'FRANCHISE_MANAGER' && managerState.stores.length === 1 && managerState.stores[0].id === 'STORE_A');
check('Franchise Manager state cannot expose STORE_B policy or campaign rows', managerState.storePolicies.every(policy => policy.storeIds.every(storeId => storeId === 'STORE_A')) && managerState.campaigns.every(campaign => campaign.storeIds.every(storeId => storeId === 'STORE_A')));
check('Franchise Manager state hides HQ draft and pending global definitions', managerState.globalPolicies.every(policy => policy.versionId !== hiddenGlobalDraft.versionId));
check('production safety contracts remain hard off/excluded in manager state', managerState.redemptionEnabled === false && managerState.customerOrderingOnly === true && managerState.nativePosEligible === false);

for (const [label, path] of [
  ['store', 'stores/STORE_A'],
  ['order', 'orders/OPERATIONAL_ORDER_A'],
  ['KOT', 'kotItems/OPERATIONAL_KOT_A'],
]) {
  check(`Franchise Manager cannot read operational ${label}`, await denied(() => getDoc(doc(managerClient.firestore, path))));
}

// Populate paths that are intentionally reserved for compatibility/runtime projections
// so reads, updates and deletes are checked against an existing document too.
await Promise.all([
  db.collection('bondPolicyGuardrailVersions').doc('RULES_EXISTING').set({ marker: true }),
  db.collection('bondPolicySchedules').doc('RULES_EXISTING').set({ marker: true }),
  db.collection('bondCampaignSchedules').doc('RULES_EXISTING').set({ marker: true }),
  db.collection('bondRewardRuntime').doc('RULES_EXISTING').set({ marker: true }),
  db.collection('bondCampaignCustomerUsage').doc('RULES_EXISTING').set({ marker: true }),
]);

const securedExistingPaths = [
  `bondPolicyGuardrails/${guardrailSave.versionId}`,
  'bondPolicyGuardrailVersions/RULES_EXISTING',
  `bondPolicyVersions/${policyV1.versionId}`,
  `bondCampaignVersions/${campaignV1.versionId}`,
  'bondPolicyScopes/STORE_STORE_A',
  'bondCampaignScopes/STORE_A',
  `bondRewardApprovals/POLICY__${policyV1.versionId}`,
  'bondPolicySchedules/RULES_EXISTING',
  'bondCampaignSchedules/RULES_EXISTING',
  `bondRewardSchedules/${policyV1Schedule.scheduleId}`,
  'bondRewardRuntime/RULES_EXISTING',
  `bondCampaignBudgets/${campaignV1.versionId}`,
  'bondCampaignCustomerUsage/RULES_EXISTING',
  (await db.collection('bondPolicyAudit').limit(1).get()).docs[0].ref.path,
  `bondPolicyScopes/STORE_STORE_A/segments/${policyV1Schedule.scheduleId}`,
  `bondCampaignScopes/STORE_A/segments/${campaignSchedule.scheduleId}`,
];

const directClients = [adminClient, managerClient, viewerClient, cashierClient, customerClient];
for (const client of directClients) {
  const actorLabel = (await db.collection('users').doc(client.uid).get()).data().role;
  const allReadsDenied = (await Promise.all(securedExistingPaths.map(path => denied(() => getDoc(doc(client.firestore, path)))))).every(Boolean);
  check(`${actorLabel} direct reads are denied for all BOND control-plane collections`, allReadsDenied);

  const allCreatesDenied = (await Promise.all(securedExistingPaths.map((path, index) => {
    const segments = path.split('/');
    segments[segments.length - 1] = `FORGED_${index}_${client.uid.slice(0, 8)}`;
    return denied(() => setDoc(doc(client.firestore, segments.join('/')), { forged: true }));
  }))).every(Boolean);
  check(`${actorLabel} direct creates are denied for all BOND control-plane collections`, allCreatesDenied);
}

for (const [actorLabel, client] of [['ADMIN', adminClient], ['FRANCHISE_MANAGER', managerClient], ['CUSTOMER', customerClient]]) {
  const allUpdatesDenied = (await Promise.all(securedExistingPaths.map(path => denied(() => updateDoc(doc(client.firestore, path), { forged: true }))))).every(Boolean);
  const allDeletesDenied = (await Promise.all(securedExistingPaths.map(path => denied(() => deleteDoc(doc(client.firestore, path)))))).every(Boolean);
  check(`${actorLabel} direct updates are denied for all BOND control-plane collections`, allUpdatesDenied);
  check(`${actorLabel} direct deletes are denied for all BOND control-plane collections`, allDeletesDenied);
}

const finalAudits = await db.collection('bondPolicyAudit').get();
const auditRequestIds = finalAudits.docs.map(document => document.data().requestId);
check('audit history contains one immutable row per successful requestId', new Set(auditRequestIds).size === auditRequestIds.length);
check('every audit row identifies actor role and operation result', finalAudits.docs.every(document => {
  const data = document.data();
  return typeof data.actorUid === 'string' && ['ADMIN', 'FRANCHISE_MANAGER'].includes(data.actorRole) && data.result?.ok === true;
}));

await Promise.all([
  deleteApp(adminClient.app),
  deleteApp(managerClient.app),
  deleteApp(inactiveManagerClient.app),
  deleteApp(viewerClient.app),
  deleteApp(cashierClient.app),
  deleteApp(customerClient.app),
]);

console.log(`\nBOND Policy and Campaign Manager Auth/Firestore emulator tests passed: ${passed.length}/${passed.length}.`);
