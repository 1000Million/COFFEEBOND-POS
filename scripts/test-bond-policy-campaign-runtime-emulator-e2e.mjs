import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PROJECT_ID = 'demo-coffee-bond-campaign-runtime';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-campaign-runtime-firebase-config',
  };
  for (const prefix of [
    '/opt/homebrew/opt/openjdk@21',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk@21',
    '/usr/local/opt/openjdk',
  ]) {
    if (commandResult(`${prefix}/bin/java`, ['-version']).status === 0) {
      return { ...env, JAVA_HOME: prefix, PATH: `${prefix}/bin:${env.PATH || ''}` };
    }
  }
  return env;
}

if (!process.argv.includes('--inside-emulator')) {
  const env = emulatorEnv();
  if (commandResult('java', ['-version'], env).status !== 0 || commandResult('firebase', ['--version'], env).status !== 0) {
    console.error('BLOCKED: Firebase CLI and Java are required for isolated BOND campaign runtime emulator QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'auth,firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-bond-policy-campaign-runtime-emulator-e2e.mjs --inside-emulator',
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
  POINT_EARN_ZERO_DECISION,
  createBondLoyaltyService,
  legacyPointEarnLedgerId,
  pointEarnLedgerId,
  pointEarnReversalLedgerId,
  visitCampaignEarnLedgerId,
  visitCampaignReversalLedgerId,
} = require('../functions/bondLoyalty');
const {
  CAMPAIGN_BUDGETS,
  CAMPAIGN_CUSTOMER_USAGE,
  CAMPAIGN_SCOPES,
  CAMPAIGN_VERSIONS,
  GUARDRAIL_VERSIONS,
  POLICY_SCOPES,
  POLICY_VERSIONS,
  definitionHash,
} = require('../functions/bondPolicyCampaignManager');
const { campaignCustomerUsageId } = require('../functions/bondPolicyCampaignRuntime');

const service = createBondLoyaltyService({ admin, db });
const WINDOW_START = Date.parse('2026-09-01T00:00:00.000Z');
const WINDOW_END = Date.parse('2026-10-01T00:00:00.000Z');
const EVENT_TIME = Date.parse('2026-09-15T08:00:00.000Z');
const GUARDRAIL_VERSION_ID = 'guardrails-runtime-v1';
const DEFAULT_POLICY_VERSION_ID = 'policy-global-1000-v1';

const EARN_FLAGS = Object.freeze({
  accountEnabled: true,
  shadowEnabled: false,
  earnEnabled: true,
  visitEnabled: false,
  expiryEnabled: false,
  redemptionEnabled: false,
  gamificationEnabled: false,
  clubEarnedEnabled: false,
  clubPaidEnabled: false,
  omakaseEnabled: false,
  customerOrderingOnly: true,
});

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

async function expectRuntimeCode(code, action, name) {
  let received = '';
  try {
    await action();
  } catch (error) {
    received = String(error?.code || '');
  }
  check(name, received === code);
}

function versionDocument({ versionId, configurationType, definition, storeIds = [], campaignId = null }) {
  const hash = definitionHash(definition);
  return {
    ref: db.collection(configurationType === 'POLICY' ? POLICY_VERSIONS : CAMPAIGN_VERSIONS).doc(versionId),
    data: {
      versionId,
      configurationType,
      definition,
      definitionHash: hash,
      storeIds,
      ...(campaignId ? { campaignId } : {}),
      guardrailVersionId: GUARDRAIL_VERSION_ID,
      status: 'SCHEDULED',
      approvalStatus: 'APPROVED',
      immutable: true,
    },
    hash,
  };
}

function segmentDocument({ configurationType, versionId, hash, scopeKey, storeId = null, startsAt = WINDOW_START, endsAt = WINDOW_END, scheduleId = `${versionId}-${scopeKey}` }) {
  return {
    scheduleId,
    scopeKey,
    storeId,
    configurationType,
    versionId,
    guardrailVersionId: GUARDRAIL_VERSION_ID,
    definitionHash: hash,
    startsAt: Timestamp.fromMillis(startsAt),
    endsAt: Timestamp.fromMillis(endsAt),
    status: 'SCHEDULED',
  };
}

async function seedGuardrails() {
  const definition = {
    schemaVersion: 1,
    configurationType: 'GUARDRAIL',
    guardrails: {
      minEarnRateBps: 500,
      maxEarnRateBps: 2000,
      maxMultiplierBps: 30000,
      maxFixedBonusPoints: 50,
      maxCampaignDays: 60,
      maxCustomerAwards: 10,
      maxCampaignBudgetPoints: 1000,
      liabilityPaisePerPoint: 100,
    },
    reason: 'Runtime emulator guardrails',
  };
  await db.collection(GUARDRAIL_VERSIONS).doc(GUARDRAIL_VERSION_ID).set({
    versionId: GUARDRAIL_VERSION_ID,
    configurationType: 'GUARDRAIL',
    definition,
    definitionHash: definitionHash(definition),
    storeIds: [],
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    immutable: true,
  });
}

async function seedPolicy({
  versionId,
  earnRateBps,
  scope = 'GLOBAL',
  storeId = null,
  startsAt = WINDOW_START,
  endsAt = WINDOW_END,
  scheduleId,
} = {}) {
  const storeIds = scope === 'STORE' ? [storeId] : [];
  const definition = {
    schemaVersion: 1,
    configurationType: 'POLICY',
    scope,
    storeIds,
    earnRateBps,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: endsAt === null ? null : new Date(endsAt).toISOString(),
    channel: 'CUSTOMER_ORDERING_ONLY',
    nativePosEligible: false,
  };
  const version = versionDocument({ versionId, configurationType: 'POLICY', definition, storeIds });
  const scopeKey = scope === 'GLOBAL' ? 'GLOBAL' : `STORE_${storeId}`;
  const segment = segmentDocument({
    configurationType: 'POLICY',
    versionId,
    hash: version.hash,
    scopeKey,
    storeId,
    startsAt,
    endsAt,
    ...(scheduleId ? { scheduleId } : {}),
  });
  const batch = db.batch();
  batch.set(version.ref, version.data);
  batch.set(db.collection(POLICY_SCOPES).doc(scopeKey).collection('segments').doc(segment.scheduleId), segment);
  await batch.commit();
  return { definition, hash: version.hash, scopeKey, scheduleId: segment.scheduleId };
}

async function seedCampaign({
  versionId,
  campaignId = versionId,
  storeId,
  rewardType = 'FIXED_POINTS',
  fixedBonusPoints = 7,
  multiplierBps = null,
  minimumSpendPaise = 0,
  eligibleProductCodes = [],
  eligibleCategoryCodes = [],
  minimumUniqueVisitDays = 0,
  visitWindowDays = null,
  customerAwardLimit = 10,
  budgetPoints = 100,
  startsAt = WINDOW_START,
  endsAt = WINDOW_END,
  scheduleId,
} = {}) {
  const definition = {
    schemaVersion: 1,
    configurationType: 'CAMPAIGN',
    campaignId,
    name: versionId,
    storeIds: [storeId],
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    rewardType,
    fixedBonusPoints: rewardType === 'FIXED_POINTS' ? fixedBonusPoints : null,
    multiplierBps: rewardType === 'EARN_MULTIPLIER' ? multiplierBps : null,
    minimumSpendPaise,
    eligibleProductCodes,
    eligibleCategoryCodes,
    minimumUniqueVisitDays,
    visitWindowDays,
    customerAwardLimit,
    budgetPoints,
    stackingMode: 'EXCLUSIVE_ONE',
    visitBasis: 'UNIQUE_IST_VISIT_DAYS',
    channel: 'CUSTOMER_ORDERING_ONLY',
    nativePosEligible: false,
  };
  const version = versionDocument({
    versionId,
    configurationType: 'CAMPAIGN',
    definition,
    storeIds: [storeId],
    campaignId,
  });
  const segment = segmentDocument({
    configurationType: 'CAMPAIGN',
    versionId,
    hash: version.hash,
    scopeKey: storeId,
    storeId,
    startsAt,
    endsAt,
    ...(scheduleId ? { scheduleId } : {}),
  });
  segment.campaignId = campaignId;
  const batch = db.batch();
  batch.set(version.ref, version.data);
  batch.set(db.collection(CAMPAIGN_SCOPES).doc(storeId).collection('segments').doc(segment.scheduleId), segment);
  batch.set(db.collection(CAMPAIGN_BUDGETS).doc(versionId), {
    versionId,
    campaignId,
    storeIds: [storeId],
    budgetPoints,
    awardedPoints: 0,
    reversedPoints: 0,
    netConsumedPoints: 0,
    awardCount: 0,
  });
  await batch.commit();
  return { definition, hash: version.hash, scheduleId: segment.scheduleId };
}

async function seedEligibleOrder({
  orderId,
  customerId,
  storeId,
  taxableRupees = 200,
  gstRupees = 10,
  occurredAt = EVENT_TIME,
  items = [{ finishedGoodCode: 'ANY', categoryCode: 'GENERAL', lineTaxable: taxableRupees }],
} = {}) {
  const onlineOrderId = `online_${orderId}`;
  const checkoutSessionId = `checkout_${orderId}`;
  const grandTotal = taxableRupees + gstRupees;
  const timestamp = Timestamp.fromMillis(occurredAt);
  const order = {
    source: 'CUSTOMER_WEB',
    onlineOrderId,
    storeId,
    orderType: 'TAKEAWAY',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    subtotal: taxableRupees,
    taxableAmount: taxableRupees,
    gstTotal: gstRupees,
    grandTotal,
    createdAt: timestamp,
    updatedAt: timestamp,
    settledAt: timestamp,
  };
  const batch = db.batch();
  batch.set(db.collection('onlineOrders').doc(onlineOrderId), {
    source: 'CUSTOMER_WEB',
    linkedOrderId: orderId,
    customerUid: customerId,
    checkoutSessionId,
    storeId,
    status: 'CONVERTED',
    paymentStatus: 'PAID',
    grandTotal,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('customerCheckoutSessions').doc(checkoutSessionId), {
    customerUid: customerId,
    storeId,
    onlineOrderId,
    status: 'ORDER_CREATED',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('orders').doc(orderId), order);
  items.forEach((item, index) => {
    batch.set(db.collection('orders').doc(orderId).collection('items').doc(`item_${index + 1}`), {
      orderId,
      storeId,
      quantity: 1,
      ...item,
    });
  });
  await batch.commit();
  return { orderId, order, onlineOrderId, customerId };
}

async function earn(seed) {
  return service.processCustomerOrderLoyalty({ orderId: seed.orderId, order: seed.order, flags: EARN_FLAGS });
}

async function ledgerFor(orderId) {
  const snapshot = await db.collection('loyaltyPointLedger').doc(pointEarnLedgerId(orderId)).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function visitCampaignLedgerFor(orderId) {
  const snapshot = await db.collection('loyaltyPointLedger').doc(visitCampaignEarnLedgerId(orderId)).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function accountFor(customerId) {
  const snapshot = await db.collection('loyaltyAccounts').doc(customerId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function budgetFor(versionId) {
  return (await db.collection(CAMPAIGN_BUDGETS).doc(versionId).get()).data();
}

async function usageFor(versionId, customerId) {
  const id = campaignCustomerUsageId(versionId, customerId);
  const snapshot = await db.collection(CAMPAIGN_CUSTOMER_USAGE).doc(id).get();
  return snapshot.exists ? snapshot.data() : null;
}

await seedGuardrails();
await seedPolicy({
  versionId: DEFAULT_POLICY_VERSION_ID,
  earnRateBps: 1000,
  scope: 'GLOBAL',
});

// Global policy and a per-store override use the same authoritative event time.
const globalOrder = await seedEligibleOrder({
  orderId: 'runtime_global_default',
  customerId: 'customer_global',
  storeId: 'STORE_GLOBAL',
  taxableRupees: 200,
  gstRupees: 10,
});
const globalResult = await earn(globalOrder);
const globalLedger = await ledgerFor(globalOrder.orderId);
check('global default policy posts twenty points at ten percent', globalResult.status === 'POSTED' && globalLedger.pointsDelta === 20);
check('global ledger identifies the immutable global policy and issuing store', globalLedger.policyVersionId === DEFAULT_POLICY_VERSION_ID && globalLedger.issuingStoreId === 'STORE_GLOBAL' && globalLedger.policySource === 'GLOBAL_DEFAULT');

await seedPolicy({
  versionId: 'policy-store-1500-v1',
  earnRateBps: 1500,
  scope: 'STORE',
  storeId: 'STORE_OVERRIDE',
});
const overrideOrder = await seedEligibleOrder({
  orderId: 'runtime_store_override',
  customerId: 'customer_override',
  storeId: 'STORE_OVERRIDE',
  taxableRupees: 200,
  gstRupees: 10,
});
const overrideResult = await earn(overrideOrder);
const overrideLedger = await ledgerFor(overrideOrder.orderId);
check('per-store override replaces the global earn percentage', overrideResult.status === 'POSTED' && overrideLedger.basePoints === 30 && overrideLedger.pointsDelta === 30);
check('store override ledger is immutable policy evidence', overrideLedger.policyVersionId === 'policy-store-1500-v1' && overrideLedger.effectiveEarnRateBps === 1500 && overrideLedger.policySource === 'STORE_OVERRIDE');

// A product-filtered fixed campaign uses only canonical matching line spend for its threshold.
await seedCampaign({
  versionId: 'campaign-fixed-product-v1',
  campaignId: 'campaign-fixed-product',
  storeId: 'STORE_FIXED',
  fixedBonusPoints: 7,
  minimumSpendPaise: 10_000,
  eligibleProductCodes: ['COFFEE'],
  customerAwardLimit: 3,
  budgetPoints: 50,
});
const fixedOrder = await seedEligibleOrder({
  orderId: 'runtime_fixed_product',
  customerId: 'customer_fixed',
  storeId: 'STORE_FIXED',
  taxableRupees: 200,
  gstRupees: 10,
  items: [
    { finishedGoodCode: 'COFFEE', categoryCode: 'DRINKS', lineTaxable: 120 },
    { finishedGoodCode: 'COOKIE', categoryCode: 'FOOD', lineTaxable: 80 },
  ],
});
const fixedResult = await earn(fixedOrder);
const fixedLedger = await ledgerFor(fixedOrder.orderId);
check('eligible product and minimum-spend campaign adds one fixed bonus', fixedResult.status === 'POSTED' && fixedLedger.basePoints === 20 && fixedLedger.campaignBonusPoints === 7 && fixedLedger.pointsDelta === 27);
check('fixed campaign ledger records issuing store, policy, campaign, liability, and product evidence', fixedLedger.issuingStoreId === 'STORE_FIXED'
  && fixedLedger.policyVersionId === DEFAULT_POLICY_VERSION_ID
  && fixedLedger.campaignId === 'campaign-fixed-product'
  && fixedLedger.campaignVersionId === 'campaign-fixed-product-v1'
  && fixedLedger.liabilityPaise === 2700
  && fixedLedger.calculationEvidence.matchedProductCodes.includes('COFFEE'));

const belowMinimumOrder = await seedEligibleOrder({
  orderId: 'runtime_fixed_below_minimum',
  customerId: 'customer_fixed_below',
  storeId: 'STORE_FIXED',
  taxableRupees: 200,
  gstRupees: 10,
  items: [
    { finishedGoodCode: 'COFFEE', categoryCode: 'DRINKS', lineTaxable: 40 },
    { finishedGoodCode: 'COOKIE', categoryCode: 'FOOD', lineTaxable: 160 },
  ],
});
await earn(belowMinimumOrder);
const belowMinimumLedger = await ledgerFor(belowMinimumOrder.orderId);
check('non-matching spend cannot pad the campaign minimum', belowMinimumLedger.basePoints === 20 && belowMinimumLedger.campaignBonusPoints === 0 && belowMinimumLedger.pointsDelta === 20);

// A category-filtered 2x campaign adds only the incremental points for matching spend.
await seedCampaign({
  versionId: 'campaign-category-multiplier-v1',
  campaignId: 'campaign-category-multiplier',
  storeId: 'STORE_MULTIPLIER',
  rewardType: 'EARN_MULTIPLIER',
  multiplierBps: 20_000,
  minimumSpendPaise: 5_000,
  eligibleCategoryCodes: ['FOOD'],
  customerAwardLimit: 3,
  budgetPoints: 100,
});
const multiplierOrder = await seedEligibleOrder({
  orderId: 'runtime_category_multiplier',
  customerId: 'customer_multiplier',
  storeId: 'STORE_MULTIPLIER',
  taxableRupees: 250,
  gstRupees: 12.5,
  items: [
    { finishedGoodCode: 'SANDWICH', categoryCode: 'FOOD', lineTaxable: 100 },
    { finishedGoodCode: 'COFFEE', categoryCode: 'DRINKS', lineTaxable: 150 },
  ],
});
await earn(multiplierOrder);
const multiplierLedger = await ledgerFor(multiplierOrder.orderId);
check('category multiplier applies once and only to matching canonical spend', multiplierLedger.basePoints === 25 && multiplierLedger.campaignBonusPoints === 10 && multiplierLedger.pointsDelta === 35);
check('multiplier ledger records the authoritative category evidence', multiplierLedger.calculationEvidence.matchedCategoryCodes.length === 1 && multiplierLedger.calculationEvidence.matchedCategoryCodes[0] === 'FOOD');

// Visit-frequency campaigns award only after the unique served-day lock commits.
// Paid order creation posts base points, never an early visit-frequency bonus.
const visitCampaignStartsAt = Date.parse('2026-09-01T06:00:00.000Z');
await seedCampaign({
  versionId: 'campaign-visit-frequency-v1',
  campaignId: 'campaign-visit-frequency',
  storeId: 'STORE_VISIT',
  fixedBonusPoints: 9,
  minimumUniqueVisitDays: 2,
  visitWindowDays: 30,
  customerAwardLimit: 2,
  budgetPoints: 50,
  startsAt: visitCampaignStartsAt,
});
const visitCustomerId = 'customer_visit_frequency';
const visitBatch = db.batch();
for (const [businessDate, occurredAt] of [
  ['2026-09-01', visitCampaignStartsAt - 60_000],
  ['2026-09-02', visitCampaignStartsAt + 86_400_000],
]) {
  visitBatch.set(db.collection('qualifyingVisitDays').doc(`${visitCustomerId}__${businessDate}`), {
    customerId: visitCustomerId,
    businessDate,
    occurredAt: Timestamp.fromMillis(occurredAt),
  });
}
await visitBatch.commit();
const visitOrder = await seedEligibleOrder({
  orderId: 'runtime_visit_frequency',
  customerId: visitCustomerId,
  storeId: 'STORE_VISIT',
  taxableRupees: 200,
  gstRupees: 10,
});
await earn(visitOrder);
const visitLedger = await ledgerFor(visitOrder.orderId);
check('paid order posts base points without awarding a visit-frequency campaign early', visitLedger.pointsDelta === 20
  && visitLedger.campaignBonusPoints === 0
  && await visitCampaignLedgerFor(visitOrder.orderId) === null);
const visitCompletion = visitCampaignStartsAt + (2 * 86_400_000);
const visitResult = await service.processQualifyingVisit({
  orderId: visitOrder.orderId,
  order: visitOrder.order,
  completionTimestamp: visitCompletion,
  flags: { ...EARN_FLAGS, visitEnabled: true },
});
const visitCampaignLedger = await visitCampaignLedgerFor(visitOrder.orderId);
check('second post-activation served day posts the visit-frequency campaign bonus', visitResult.status === 'VISIT_POSTED'
  && visitResult.campaignResult?.status === 'CAMPAIGN_BONUS_POSTED'
  && visitCampaignLedger.pointsDelta === 9
  && visitCampaignLedger.calculationEvidence.uniqueIstVisitDays === 2);
check('visit-frequency campaign excludes a pre-activation instant on the activation IST date', visitCampaignLedger.calculationEvidence.uniqueIstVisitDays === 2
  && visitCampaignLedger.campaignVersionId === 'campaign-visit-frequency-v1');
const duplicateVisitResult = await service.processQualifyingVisit({
  orderId: visitOrder.orderId,
  order: visitOrder.order,
  completionTimestamp: visitCompletion,
  flags: { ...EARN_FLAGS, visitEnabled: true },
});
const visitBudget = await budgetFor('campaign-visit-frequency-v1');
const visitUsage = await usageFor('campaign-visit-frequency-v1', visitCustomerId);
check('visit retries create zero duplicate campaign debits', duplicateVisitResult.status === 'DUPLICATE_EVENT'
  && duplicateVisitResult.campaignResult?.status === 'DUPLICATE_CAMPAIGN_EVENT'
  && visitBudget.netConsumedPoints === 9
  && visitBudget.awardCount === 1
  && visitUsage.netAwardCount === 1);
const voidedVisitOrder = {
  ...visitOrder.order,
  status: 'VOIDED',
  voidedAt: Timestamp.fromMillis(visitCompletion + 60_000),
  updatedAt: Timestamp.fromMillis(visitCompletion + 60_000),
};
await db.collection('orders').doc(visitOrder.orderId).set(voidedVisitOrder);
const visitReversal = await service.processCustomerOrderLoyalty({
  orderId: visitOrder.orderId,
  order: voidedVisitOrder,
  flags: { ...EARN_FLAGS, visitEnabled: true },
});
const visitCampaignReversal = await db.collection('loyaltyPointLedger')
  .doc(visitCampaignReversalLedgerId(visitOrder.orderId)).get();
const reversedVisitBudget = await budgetFor('campaign-visit-frequency-v1');
const reversedVisitUsage = await usageFor('campaign-visit-frequency-v1', visitCustomerId);
check('void reverses the separate visit campaign bonus with immutable evidence', visitReversal.campaignResult?.status === 'CAMPAIGN_BONUS_REVERSED'
  && visitCampaignReversal.data()?.pointsDelta === -9
  && visitCampaignReversal.data()?.originalLedgerEntryId === visitCampaignEarnLedgerId(visitOrder.orderId));
check('visit campaign reversal restores budget and customer usage once', reversedVisitBudget.netConsumedPoints === 0
  && reversedVisitUsage.netAwardCount === 0
  && reversedVisitUsage.netPoints === 0);

// Two schedule records at one store are a configuration error, never stacked rewards.
await seedCampaign({
  versionId: 'campaign-overlap-a-v1',
  storeId: 'STORE_OVERLAP',
  fixedBonusPoints: 5,
  budgetPoints: 50,
});
await seedCampaign({
  versionId: 'campaign-overlap-b-v1',
  storeId: 'STORE_OVERLAP',
  fixedBonusPoints: 6,
  budgetPoints: 50,
});
const overlapOrder = await seedEligibleOrder({
  orderId: 'runtime_overlap',
  customerId: 'customer_overlap',
  storeId: 'STORE_OVERLAP',
});
await expectRuntimeCode(
  'BOND_CAMPAIGN_WINDOW_OVERLAP',
  () => earn(overlapOrder),
  'overlapping campaigns fail closed instead of stacking',
);
check('overlap failure writes no ledger or customer projection', await ledgerFor(overlapOrder.orderId) === null && await accountFor(overlapOrder.customerId) === null);

// Budget concurrency: only one of two different customers receives the final seven bonus points.
await seedCampaign({
  versionId: 'campaign-budget-race-v1',
  storeId: 'STORE_BUDGET_RACE',
  fixedBonusPoints: 7,
  customerAwardLimit: 5,
  budgetPoints: 7,
});
const budgetRaceOne = await seedEligibleOrder({
  orderId: 'runtime_budget_race_one',
  customerId: 'customer_budget_one',
  storeId: 'STORE_BUDGET_RACE',
  taxableRupees: 100,
  gstRupees: 5,
});
const budgetRaceTwo = await seedEligibleOrder({
  orderId: 'runtime_budget_race_two',
  customerId: 'customer_budget_two',
  storeId: 'STORE_BUDGET_RACE',
  taxableRupees: 100,
  gstRupees: 5,
});
await Promise.all([earn(budgetRaceOne), earn(budgetRaceTwo)]);
const budgetRaceLedgers = await Promise.all([
  ledgerFor(budgetRaceOne.orderId),
  ledgerFor(budgetRaceTwo.orderId),
]);
const budgetRaceProjection = await budgetFor('campaign-budget-race-v1');
check('concurrent budget contention awards exactly one campaign bonus', budgetRaceLedgers.filter(entry => entry.campaignBonusPoints === 7).length === 1
  && budgetRaceLedgers.filter(entry => entry.campaignBonusPoints === 0).length === 1);
check('campaign budget projection cannot overspend under concurrent transactions', budgetRaceProjection.awardedPoints === 7 && budgetRaceProjection.netConsumedPoints === 7 && budgetRaceProjection.awardCount === 1);

// Customer-limit concurrency: two orders for one customer still receive at most one bonus.
await seedCampaign({
  versionId: 'campaign-customer-race-v1',
  storeId: 'STORE_CUSTOMER_RACE',
  fixedBonusPoints: 4,
  customerAwardLimit: 1,
  budgetPoints: 100,
});
const customerRaceOne = await seedEligibleOrder({
  orderId: 'runtime_customer_race_one',
  customerId: 'customer_limit_race',
  storeId: 'STORE_CUSTOMER_RACE',
  taxableRupees: 100,
  gstRupees: 5,
});
const customerRaceTwo = await seedEligibleOrder({
  orderId: 'runtime_customer_race_two',
  customerId: 'customer_limit_race',
  storeId: 'STORE_CUSTOMER_RACE',
  taxableRupees: 100,
  gstRupees: 5,
});
await Promise.all([earn(customerRaceOne), earn(customerRaceTwo)]);
const customerRaceLedgers = await Promise.all([
  ledgerFor(customerRaceOne.orderId),
  ledgerFor(customerRaceTwo.orderId),
]);
const customerRaceUsage = await usageFor('campaign-customer-race-v1', 'customer_limit_race');
check('concurrent customer-limit contention awards exactly one bonus', customerRaceLedgers.filter(entry => entry.campaignBonusPoints === 4).length === 1
  && customerRaceLedgers.filter(entry => entry.campaignBonusPoints === 0).length === 1);
check('customer usage projection records one net award after the race', customerRaceUsage.netAwardCount === 1 && customerRaceUsage.netPoints === 4);

// Retry is keyed to the logical order, not the policy active when a callback is delivered.
const retryOrder = await seedEligibleOrder({
  orderId: 'runtime_policy_switch_retry',
  customerId: 'customer_policy_switch',
  storeId: 'STORE_POLICY_SWITCH',
  taxableRupees: 100,
  gstRupees: 5,
});
const firstRetryResult = await earn(retryOrder);
const originalRetryLedger = await ledgerFor(retryOrder.orderId);
await seedPolicy({
  versionId: 'policy-store-switch-v2',
  earnRateBps: 2000,
  scope: 'STORE',
  storeId: 'STORE_POLICY_SWITCH',
  startsAt: EVENT_TIME + 60_000,
  endsAt: WINDOW_END,
});
const laterTimestamp = Timestamp.fromMillis(EVENT_TIME + 120_000);
const retriedAfterSwitch = {
  ...retryOrder,
  order: { ...retryOrder.order, settledAt: laterTimestamp, updatedAt: laterTimestamp },
};
const secondRetryResult = await earn(retriedAfterSwitch);
const retryLedgerAfterSwitch = await ledgerFor(retryOrder.orderId);
const retryCustomerLedgerSnapshot = await db.collection('loyaltyPointLedger').where('customerId', '==', retryOrder.customerId).get();
check('first policy-switch test delivery posts under the original global policy', firstRetryResult.status === 'POSTED' && originalRetryLedger.policyVersionId === DEFAULT_POLICY_VERSION_ID && originalRetryLedger.pointsDelta === 10);
check('retry after a policy switch creates zero duplicate ledger effects', secondRetryResult.status === 'DUPLICATE_EVENT' && secondRetryResult.writes === 0 && retryCustomerLedgerSnapshot.size === 1);
check('retry cannot rewrite immutable original policy evidence', retryLedgerAfterSwitch.policyVersionId === DEFAULT_POLICY_VERSION_ID && retryLedgerAfterSwitch.pointsDelta === 10);

// Logical earn IDs are order-only. A zero-point decision is an immutable tombstone,
// so a later policy cannot turn the same order into an award.
check('earn and reversal logical IDs do not contain a mutable static policy version',
  pointEarnLedgerId('runtime_logical_id', 'BOND_POLICY_V9_FUTURE') === 'POINT_EARN__runtime_logical_id'
  && pointEarnReversalLedgerId('runtime_logical_id', 'BOND_POLICY_V9_FUTURE') === 'POINT_EARN_REVERSAL__runtime_logical_id');
const zeroOrder = await seedEligibleOrder({
  orderId: 'runtime_zero_decision',
  customerId: 'customer_zero_decision',
  storeId: 'STORE_ZERO_DECISION',
  taxableRupees: 5,
  gstRupees: 0.25,
});
const zeroResult = await earn(zeroOrder);
const zeroDecision = await ledgerFor(zeroOrder.orderId);
const zeroSummary = await service.getCustomerOrderEarnings(zeroOrder.customerId);
const zeroReconciliation = await service.reconcileLoyaltyAccount(zeroOrder.customerId);
check('zero points writes one immutable order-keyed decision without an account projection', zeroResult.status === 'ZERO_POINTS'
  && zeroResult.writes === 1
  && zeroDecision.eventType === POINT_EARN_ZERO_DECISION
  && zeroDecision.pointsDelta === 0
  && await accountFor(zeroOrder.customerId) === null);
check('zero-point decisions are ignored by customer earnings and reconciliation balances', !zeroSummary.has(zeroOrder.onlineOrderId)
  && zeroReconciliation.ledgerBalance === 0
  && zeroReconciliation.projectionMismatch === false
  && zeroReconciliation.postedLedgerMissingAccountProjection === false
  && zeroReconciliation.missingLoyaltyOrders.length === 0);
await seedPolicy({
  versionId: 'policy-store-zero-v2',
  earnRateBps: 2000,
  scope: 'STORE',
  storeId: 'STORE_ZERO_DECISION',
  startsAt: EVENT_TIME + 60_000,
  endsAt: WINDOW_END,
});
const zeroLaterTimestamp = Timestamp.fromMillis(EVENT_TIME + 120_000);
const zeroOrderAfterPolicyChange = {
  ...zeroOrder.order,
  settledAt: zeroLaterTimestamp,
  updatedAt: zeroLaterTimestamp,
};
await db.collection('orders').doc(zeroOrder.orderId).set(zeroOrderAfterPolicyChange);
const zeroRetry = await service.processCustomerOrderLoyalty({
  orderId: zeroOrder.orderId,
  order: zeroOrderAfterPolicyChange,
  flags: EARN_FLAGS,
});
const zeroDecisionCount = (await db.collection('loyaltyPointLedger')
  .where('customerId', '==', zeroOrder.customerId).get()).size;
check('zero-point tombstone prevents re-evaluation after a policy-rate change', zeroRetry.status === 'DUPLICATE_EVENT'
  && zeroRetry.writes === 0
  && zeroDecisionCount === 1
  && await accountFor(zeroOrder.customerId) === null);
const voidedZeroOrder = {
  ...zeroOrderAfterPolicyChange,
  status: 'VOIDED',
  voidedAt: Timestamp.fromMillis(EVENT_TIME + 180_000),
};
await db.collection('orders').doc(zeroOrder.orderId).set(voidedZeroOrder);
const zeroReversal = await service.processCustomerOrderLoyalty({
  orderId: zeroOrder.orderId,
  order: voidedZeroOrder,
  flags: EARN_FLAGS,
});
check('reversal treats a zero-point tombstone as no original earn', zeroReversal.pointResult.status === 'NO_ORIGINAL_EARN'
  && !(await db.collection('loyaltyPointLedger').doc(pointEarnReversalLedgerId(zeroOrder.orderId)).get()).exists);

// Existing V1 ledger IDs remain authoritative during migration to the stable ID.
const legacyOrder = await seedEligibleOrder({
  orderId: 'runtime_legacy_v1_id',
  customerId: 'customer_legacy_v1_id',
  storeId: 'STORE_LEGACY_ID',
  taxableRupees: 100,
  gstRupees: 5,
});
const legacyLedgerEntryId = legacyPointEarnLedgerId(legacyOrder.orderId);
await db.collection('loyaltyPointLedger').doc(legacyLedgerEntryId).set({
  ledgerEntryId: legacyLedgerEntryId,
  customerId: legacyOrder.customerId,
  eventType: 'POINT_EARN',
  pointsDelta: 10,
  basePoints: 10,
  campaignBonusPoints: 0,
  eligibleSpendPaise: 10_000,
  sourceOrderId: legacyOrder.orderId,
  sourceOnlineOrderId: legacyOrder.onlineOrderId,
  storeId: legacyOrder.order.storeId,
  issuingStoreId: legacyOrder.order.storeId,
  orderChannel: 'CUSTOMER_ORDERING',
  originEvidenceType: 'PRIVATE_CHECKOUT_SESSION',
  policyVersion: 'BOND_POLICY_V1_2026',
  policyVersionId: 'BOND_POLICY_V1_2026',
  occurredAt: legacyOrder.order.settledAt,
  createdAt: legacyOrder.order.settledAt,
});
await db.collection('loyaltyAccounts').doc(legacyOrder.customerId).set({
  customerId: legacyOrder.customerId,
  pointsBalance: 10,
  lifetimePointsEarned: 10,
  lifetimePointsReversed: 0,
});
const legacyRetry = await earn(legacyOrder);
const legacyEntriesAfterRetry = await db.collection('loyaltyPointLedger')
  .where('customerId', '==', legacyOrder.customerId).get();
check('legacy V1 earn lookup prevents a duplicate stable-ID award', legacyRetry.status === 'DUPLICATE_EVENT'
  && legacyRetry.ledgerEntryId === legacyLedgerEntryId
  && legacyEntriesAfterRetry.size === 1);
const voidedLegacyOrder = {
  ...legacyOrder.order,
  status: 'VOIDED',
  voidedAt: Timestamp.fromMillis(EVENT_TIME + 240_000),
};
await db.collection('orders').doc(legacyOrder.orderId).set(voidedLegacyOrder);
const legacyReversal = await service.processCustomerOrderLoyalty({
  orderId: legacyOrder.orderId,
  order: voidedLegacyOrder,
  flags: EARN_FLAGS,
});
const migratedReversal = (await db.collection('loyaltyPointLedger')
  .doc(pointEarnReversalLedgerId(legacyOrder.orderId)).get()).data();
check('stable reversal finds and references the immutable legacy V1 earn', legacyReversal.pointResult.status === 'REVERSED'
  && migratedReversal.originalLedgerEntryId === legacyLedgerEntryId
  && migratedReversal.calculationEvidence.reversalOfLedgerEntryId === legacyLedgerEntryId
  && (await accountFor(legacyOrder.customerId)).pointsBalance === 0);

// A stale completion delivery blocked before its transaction cannot earn after the
// authoritative order has already been voided.
const staleOrder = await seedEligibleOrder({
  orderId: 'runtime_stale_completion_after_void',
  customerId: 'customer_stale_completion',
  storeId: 'STORE_STALE_COMPLETION',
  taxableRupees: 100,
  gstRupees: 5,
});
let releaseStaleWorker;
let staleWorkerReachedTransaction;
const staleWorkerGate = new Promise(resolve => { releaseStaleWorker = resolve; });
const staleWorkerReached = new Promise(resolve => { staleWorkerReachedTransaction = resolve; });
const staleCompletionWork = service.processCustomerOrderLoyalty({
  orderId: staleOrder.orderId,
  order: staleOrder.order,
  flags: EARN_FLAGS,
  faultInjector: async stage => {
    if (stage !== 'BEFORE_LEDGER_TRANSACTION') return;
    staleWorkerReachedTransaction();
    await staleWorkerGate;
  },
});
await staleWorkerReached;
const authoritativeVoid = {
  ...staleOrder.order,
  status: 'VOIDED',
  voidedAt: Timestamp.fromMillis(EVENT_TIME + 300_000),
  updatedAt: Timestamp.fromMillis(EVENT_TIME + 300_000),
};
await db.collection('orders').doc(staleOrder.orderId).set(authoritativeVoid);
releaseStaleWorker();
const staleCompletionResult = await staleCompletionWork;
check('authoritative transaction read rejects reordered stale completion after void', staleCompletionResult.status === 'INELIGIBLE_ORDER'
  && staleCompletionResult.writes === 0
  && await ledgerFor(staleOrder.orderId) === null
  && await accountFor(staleOrder.customerId) === null);

// Reversal negates the original immutable award and restores campaign projections once.
const voidedFixedOrder = {
  ...fixedOrder.order,
  status: 'VOIDED',
  voidedAt: Timestamp.fromMillis(EVENT_TIME + 180_000),
  updatedAt: Timestamp.fromMillis(EVENT_TIME + 180_000),
};
const firstReversal = await service.processCustomerOrderLoyalty({
  orderId: fixedOrder.orderId,
  order: voidedFixedOrder,
  flags: EARN_FLAGS,
});
const secondReversal = await service.processCustomerOrderLoyalty({
  orderId: fixedOrder.orderId,
  order: voidedFixedOrder,
  flags: EARN_FLAGS,
});
const reversalLedger = (await db.collection('loyaltyPointLedger').doc(pointEarnReversalLedgerId(fixedOrder.orderId)).get()).data();
const fixedBudgetAfterReversal = await budgetFor('campaign-fixed-product-v1');
const fixedUsageAfterReversal = await usageFor('campaign-fixed-product-v1', fixedOrder.customerId);
const fixedAccountAfterReversal = await accountFor(fixedOrder.customerId);
check('reversal negates the exact original base and campaign points once', firstReversal.pointResult.status === 'REVERSED'
  && reversalLedger.pointsDelta === -27
  && reversalLedger.basePoints === -20
  && reversalLedger.campaignBonusPoints === -7
  && reversalLedger.liabilityPaise === -fixedLedger.liabilityPaise
  && reversalLedger.baseLiabilityPaise === -fixedLedger.baseLiabilityPaise
  && reversalLedger.campaignLiabilityPaise === -fixedLedger.campaignLiabilityPaise
  && reversalLedger.calculationEvidence.reversalOfLedgerEntryId === pointEarnLedgerId(fixedOrder.orderId)
  && reversalLedger.policyVersionId === fixedLedger.policyVersionId
  && reversalLedger.campaignVersionId === fixedLedger.campaignVersionId);
check('duplicate reversal creates zero duplicate effects', secondReversal.pointResult.status === 'DUPLICATE_EVENT' && secondReversal.pointResult.writes === 0);
check('reversal restores campaign budget and customer usage projections exactly once', fixedBudgetAfterReversal.awardedPoints === 7
  && fixedBudgetAfterReversal.reversedPoints === 7
  && fixedBudgetAfterReversal.netConsumedPoints === 0
  && fixedUsageAfterReversal.awardCount === 1
  && fixedUsageAfterReversal.reversedAwardCount === 1
  && fixedUsageAfterReversal.netAwardCount === 0
  && fixedUsageAfterReversal.netPoints === 0);
check('reversal restores the customer points projection to zero', fixedAccountAfterReversal.pointsBalance === 0 && fixedAccountAfterReversal.lifetimePointsReversed === 27);

// Native POS never enters managed policy/campaign calculation or projection writes.
const nativeBudgetBefore = await budgetFor('campaign-budget-race-v1');
const nativeOrder = {
  storeId: 'STORE_BUDGET_RACE',
  orderType: 'TAKEAWAY',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  taxableAmount: 100,
  grandTotal: 105,
  createdAt: Timestamp.fromMillis(EVENT_TIME),
  updatedAt: Timestamp.fromMillis(EVENT_TIME),
  settledAt: Timestamp.fromMillis(EVENT_TIME),
};
const nativeResult = await service.processCustomerOrderLoyalty({
  orderId: 'runtime_native_pos',
  order: nativeOrder,
  flags: EARN_FLAGS,
});
const nativeBudgetAfter = await budgetFor('campaign-budget-race-v1');
check('native POS remains excluded from managed policy and campaign rewards', nativeResult.status === 'INELIGIBLE_CHANNEL' && await ledgerFor('runtime_native_pos') === null && await accountFor('runtime_native_pos') === null);
check('native POS causes zero campaign budget or customer-usage mutation', JSON.stringify(nativeBudgetAfter) === JSON.stringify(nativeBudgetBefore));

console.log(`\nBOND policy/campaign runtime emulator tests passed: ${passed.length}/${passed.length}.`);
await admin.app().delete();
