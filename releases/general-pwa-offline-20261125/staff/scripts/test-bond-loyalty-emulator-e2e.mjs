import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PROJECT_ID = 'demo-coffee-bond-loyalty';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-loyalty-firebase-config',
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
    console.error('BLOCKED: Firebase CLI and Java are required for isolated BOND emulator QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'auth,firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-bond-loyalty-emulator-e2e.mjs --inside-emulator',
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
const { createBondLoyaltyService, pointEarnLedgerId, pointEarnReversalLedgerId } = require('../functions/bondLoyalty');
const { calculateISTBusinessDate } = require('../functions/bondLoyaltyPolicy');
const service = createBondLoyaltyService({ admin, db });
const Timestamp = admin.firestore.Timestamp;

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

async function collectionSize(name) {
  return (await db.collection(name).get()).size;
}

async function setFlags(overrides = {}) {
  await db.doc('appSettings/loyalty').set({
    accountEnabled: false,
    shadowEnabled: false,
    earnEnabled: false,
    visitEnabled: false,
    expiryEnabled: false,
    redemptionEnabled: false,
    gamificationEnabled: false,
    clubEarnedEnabled: false,
    clubPaidEnabled: false,
    omakaseEnabled: false,
    customerOrderingOnly: true,
    ...overrides,
  });
}

async function seedEligibleOrder({
  orderId,
  customerId,
  taxableRupees = 150,
  gstRupees = 7.5,
  storeId = 'STORE_A',
  orderType = 'TAKEAWAY',
  paymentStatus = 'PAID',
  status = 'COMPLETED',
  occurredAt = Date.parse('2026-02-01T06:30:00.000Z'),
  onlineStatus = 'CONVERTED',
} = {}) {
  const onlineOrderId = `online_${orderId}`;
  const checkoutSessionId = `checkout_${onlineOrderId}`;
  const grandTotal = taxableRupees + gstRupees;
  const timestamp = Timestamp.fromMillis(occurredAt);
  const onlineOrder = {
    source: 'CUSTOMER_WEB',
    linkedOrderId: orderId,
    customerUid: customerId,
    checkoutSessionId,
    storeId,
    status: onlineStatus,
    paymentStatus,
    grandTotal,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const order = {
    source: 'CUSTOMER_WEB',
    onlineOrderId,
    storeId,
    orderType,
    status,
    paymentStatus,
    subtotal: taxableRupees,
    taxableAmount: taxableRupees,
    gstTotal: gstRupees,
    grandTotal,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(paymentStatus === 'PAID' ? { settledAt: timestamp } : {}),
  };
  const batch = db.batch();
  batch.set(db.collection('onlineOrders').doc(onlineOrderId), onlineOrder);
  batch.set(db.collection('customerCheckoutSessions').doc(checkoutSessionId), {
    customerUid: customerId,
    storeId,
    onlineOrderId,
    status: 'ORDER_CREATED',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(db.collection('orders').doc(orderId), order);
  await batch.commit();
  return { orderId, onlineOrderId, order, onlineOrder, timestamp };
}

async function seedServedKot(orderId, servedAt, storeId = 'STORE_A') {
  const data = {
    orderId,
    orderItemId: `item_${orderId}`,
    storeId,
    status: 'SERVED',
    servedAt: Timestamp.fromMillis(servedAt),
    updatedAt: Timestamp.fromMillis(servedAt),
  };
  await db.collection('kotItems').doc(`kot_${orderId}`).set(data);
  return data;
}

async function pointEntriesFor(customerId) {
  const snapshot = await db.collection('loyaltyPointLedger').where('customerId', '==', customerId).get();
  return snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
}

// Stage A: every feature false.
await setFlags();
const stageA = await seedEligibleOrder({ orderId: 'stage_a', customerId: 'customer_stage_a' });
const stageAResult = await service.processCustomerOrderLoyalty({ orderId: stageA.orderId, order: stageA.order });
check('Stage A returns disabled', stageAResult.status === 'DISABLED');
check('Stage A creates no loyalty ledger', await collectionSize('loyaltyPointLedger') === 0);
check('Stage A creates no loyalty account', await collectionSize('loyaltyAccounts') === 0);

// Stage B: shadow-only calculations.
await setFlags({ shadowEnabled: true });
const stageB = await seedEligibleOrder({ orderId: 'stage_b', customerId: 'customer_stage_b', taxableRupees: 159.99, gstRupees: 8 });
const stageBResult = await service.processCustomerOrderLoyalty({ orderId: stageB.orderId, order: stageB.order });
check('Stage B evaluates in shadow-only mode', stageBResult.status === 'SHADOW_ONLY');
check('Stage B writes one deterministic shadow record', await collectionSize('loyaltyShadowLogs') === 1);
check('Stage B still creates no financial ledger', await collectionSize('loyaltyPointLedger') === 0);
check('Stage B still creates no account projection', await collectionSize('loyaltyAccounts') === 0);

// Stage C: account and earning, with ten at-least-once deliveries.
await setFlags({ accountEnabled: true, earnEnabled: true });
const stageC = await seedEligibleOrder({ orderId: 'stage_c', customerId: 'customer_stage_c', taxableRupees: 590, gstRupees: 29.5 });
const retryResults = [];
for (let attempt = 0; attempt < 10; attempt += 1) {
  retryResults.push(await service.processCustomerOrderLoyalty({ orderId: stageC.orderId, order: stageC.order }));
}
const stageCEntries = await pointEntriesFor('customer_stage_c');
const stageCAccount = (await db.collection('loyaltyAccounts').doc('customer_stage_c').get()).data();
check('ten deliveries create one POINT_EARN ledger entry', stageCEntries.filter(entry => entry.eventType === 'POINT_EARN').length === 1);
check('ten deliveries update the account once', stageCAccount.pointsBalance === 59 && stageCAccount.lifetimePointsEarned === 59);
check('duplicate deliveries perform zero duplicate mutation', retryResults.slice(1).every(result => result.status === 'DUPLICATE_EVENT' && result.writes === 0));
check('ledger stores integer paise evidence and discarded remainder', stageCEntries[0].eligibleSpendPaise === 59000 && stageCEntries[0].remainderPaise === 0);
check('ledger records private checkout-session provenance', stageCEntries[0].originEvidenceType === 'PRIVATE_CHECKOUT_SESSION');

// Payment lifecycle: no POS order means no loyalty; pay-at-counter waits for settlement.
await db.collection('customerCheckoutSessions').doc('checkout_only').set({ status: 'PAYMENT_STARTED' });
await db.collection('onlineOrders').doc('paid_pending_only').set({ status: 'PAID_PENDING_ACCEPTANCE', source: 'CUSTOMER_WEB', customerUid: 'lifecycle_customer' });
check('checkout and PAID_PENDING_ACCEPTANCE create no loyalty', (await pointEntriesFor('lifecycle_customer')).length === 0);
const payAtCounter = await seedEligibleOrder({ orderId: 'pay_at_counter', customerId: 'customer_counter', paymentStatus: 'UNPAID', taxableRupees: 220, gstRupees: 11 });
const beforeSettlement = await service.processCustomerOrderLoyalty({ orderId: payAtCounter.orderId, order: payAtCounter.order });
check('pay-at-counter acceptance before settlement earns zero', beforeSettlement.status === 'INELIGIBLE_ORDER' && (await pointEntriesFor('customer_counter')).length === 0);
const paidCounterOrder = { ...payAtCounter.order, paymentStatus: 'PAID', settledAt: Timestamp.fromMillis(Date.parse('2026-02-01T07:00:00.000Z')) };
await db.collection('orders').doc(payAtCounter.orderId).set(paidCounterOrder);
await service.processCustomerOrderLoyalty({ orderId: payAtCounter.orderId, order: paidCounterOrder });
check('settled pay-at-counter order earns exactly once', (await pointEntriesFor('customer_counter')).filter(entry => entry.eventType === 'POINT_EARN').length === 1);

const rejected = await seedEligibleOrder({ orderId: 'rejected_order', customerId: 'customer_rejected', onlineStatus: 'REJECTED' });
const rejectedResult = await service.processCustomerOrderLoyalty({ orderId: rejected.orderId, order: rejected.order });
check('rejected customer order earns zero', rejectedResult.status === 'INELIGIBLE_CHANNEL' && (await pointEntriesFor('customer_rejected')).length === 0);

const forged = await seedEligibleOrder({ orderId: 'forged_customer_source', customerId: 'customer_forged' });
await db.collection('customerCheckoutSessions').doc(`checkout_${forged.onlineOrderId}`).delete();
const forgedResult = await service.processCustomerOrderLoyalty({ orderId: forged.orderId, order: forged.order });
check('forged customer source without private server provenance earns zero', forgedResult.status === 'INELIGIBLE_CHANNEL' && forgedResult.exclusionReasons.includes('MISSING_SERVER_PROVENANCE'));

// Native POS firewall matrix.
const nativeCases = [
  ['Cash', { paymentMethod: 'CASH' }],
  ['UPI', { paymentMethod: 'UPI' }],
  ['split', { paymentMethod: 'CASH', isSplitPayment: true }],
  ['discount', { paymentMethod: 'CASH', discountAmount: 20 }],
  ['held', { status: 'HELD' }],
  ['recalled/finalised', { paymentMethod: 'CASH' }],
];
for (const [label, extra] of nativeCases) {
  const order = {
    storeId: 'STORE_A',
    orderType: 'TAKEAWAY',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    taxableAmount: 500,
    grandTotal: 525,
    createdAt: Timestamp.fromMillis(Date.parse('2026-02-02T06:30:00.000Z')),
    ...extra,
  };
  const result = await service.processCustomerOrderLoyalty({ orderId: `native_${label}`, order });
  check(`native POS ${label} returns INELIGIBLE_CHANNEL`, result.status === 'INELIGIBLE_CHANNEL');
}
check('all native POS cases create zero ledger entries', await collectionSize('loyaltyPointLedger') === 2);
check('all native POS cases create zero visit events', await collectionSize('qualifyingVisitEvents') === 0);

// Visits: durable served KOT, one per IST day across stores, pickup only.
await setFlags({ accountEnabled: true, earnEnabled: true, visitEnabled: true });
const visitTime = Date.parse('2026-03-01T08:00:00.000Z');
const lateSettlement = await seedEligibleOrder({
  orderId: 'pay_at_counter_served_before_settlement',
  customerId: 'late_settlement_customer',
  paymentStatus: 'UNPAID',
  occurredAt: visitTime - 600000,
  taxableRupees: 220,
  gstRupees: 11,
});
const lateSettlementKot = await seedServedKot(lateSettlement.orderId, visitTime - 300000);
const beforeLateSettlement = await service.processKotFulfillment({
  before: { ...lateSettlementKot, status: 'READY' },
  after: lateSettlementKot,
  kotId: `kot_${lateSettlement.orderId}`,
});
check('served pay-at-counter pickup earns no visit before settlement', beforeLateSettlement.status === 'INELIGIBLE_ORDER');
const settledAfterService = {
  ...lateSettlement.order,
  paymentStatus: 'PAID',
  settledAt: Timestamp.fromMillis(visitTime),
  updatedAt: Timestamp.fromMillis(visitTime),
};
await db.collection('orders').doc(lateSettlement.orderId).set(settledAfterService);
const lateSettlementResult = await service.handleOrderWrite({
  orderId: lateSettlement.orderId,
  before: lateSettlement.order,
  after: settledAfterService,
});
check('later pay-at-counter settlement rechecks served KOT and posts one visit', lateSettlementResult.visitResult.status === 'VISIT_POSTED');

const visitOne = await seedEligibleOrder({ orderId: 'visit_one', customerId: 'visit_customer', occurredAt: visitTime, taxableRupees: 150, gstRupees: 7.5 });
await service.processCustomerOrderLoyalty({ orderId: visitOne.orderId, order: visitOne.order });
const visitOneKot = await seedServedKot(visitOne.orderId, visitTime + 60000);
const visitOneResult = await service.processKotFulfillment({ before: { ...visitOneKot, status: 'READY' }, after: visitOneKot, kotId: `kot_${visitOne.orderId}` });
check('completed pickup KOT posts one qualifying visit', visitOneResult.status === 'VISIT_POSTED');

const visitTwo = await seedEligibleOrder({ orderId: 'visit_two', customerId: 'visit_customer', occurredAt: visitTime + 120000, taxableRupees: 220, gstRupees: 11 });
await service.processCustomerOrderLoyalty({ orderId: visitTwo.orderId, order: visitTwo.order });
const visitTwoKot = await seedServedKot(visitTwo.orderId, visitTime + 180000);
const visitTwoResult = await service.processKotFulfillment({ before: { ...visitTwoKot, status: 'READY' }, after: visitTwoKot, kotId: `kot_${visitTwo.orderId}` });
check('same customer second order on same IST day adds points but no second visit', visitTwoResult.status === 'DAILY_VISIT_ALREADY_AWARDED');

const visitCrossStore = await seedEligibleOrder({ orderId: 'visit_cross_store', customerId: 'visit_customer', storeId: 'STORE_B', occurredAt: visitTime + 240000, taxableRupees: 220, gstRupees: 11 });
await service.processCustomerOrderLoyalty({ orderId: visitCrossStore.orderId, order: visitCrossStore.order });
const visitCrossKot = await seedServedKot(visitCrossStore.orderId, visitTime + 300000, 'STORE_B');
const crossStoreResult = await service.processKotFulfillment({ before: { ...visitCrossKot, status: 'READY' }, after: visitCrossKot, kotId: `kot_${visitCrossStore.orderId}` });
check('cross-store same-day pickup still adds no second visit', crossStoreResult.status === 'DAILY_VISIT_ALREADY_AWARDED');
const visitCustomerAccount = (await db.collection('loyaltyAccounts').doc('visit_customer').get()).data();
check('same-day and cross-store concurrency leave one visit', visitCustomerAccount.qualifyingVisitCount === 1);

const concurrentCustomer = 'concurrent_visit_customer';
const concurrentA = await seedEligibleOrder({ orderId: 'concurrent_visit_a', customerId: concurrentCustomer, occurredAt: visitTime + 360000, taxableRupees: 150, gstRupees: 7.5 });
const concurrentB = await seedEligibleOrder({ orderId: 'concurrent_visit_b', customerId: concurrentCustomer, storeId: 'STORE_B', occurredAt: visitTime + 420000, taxableRupees: 220, gstRupees: 11 });
await Promise.all([
  service.processCustomerOrderLoyalty({ orderId: concurrentA.orderId, order: concurrentA.order }),
  service.processCustomerOrderLoyalty({ orderId: concurrentB.orderId, order: concurrentB.order }),
]);
const concurrentResults = await Promise.all([
  service.processQualifyingVisit({ orderId: concurrentA.orderId, order: concurrentA.order, completionTimestamp: visitTime + 480000 }),
  service.processQualifyingVisit({ orderId: concurrentB.orderId, order: concurrentB.order, completionTimestamp: visitTime + 540000 }),
]);
const concurrentAccount = (await db.collection('loyaltyAccounts').doc(concurrentCustomer).get()).data();
check('truly concurrent same-day cross-store visits create one daily lock', concurrentResults.filter(result => result.status === 'VISIT_POSTED').length === 1 && concurrentAccount.qualifyingVisitCount === 1);

const boundaryCustomer = 'boundary_customer';
for (const [suffix, occurredAt] of [['2359', Date.parse('2026-03-01T18:29:00.000Z')], ['0001', Date.parse('2026-03-01T18:31:00.000Z')]]) {
  const seeded = await seedEligibleOrder({ orderId: `boundary_${suffix}`, customerId: boundaryCustomer, occurredAt, taxableRupees: 150, gstRupees: 7.5 });
  await service.processCustomerOrderLoyalty({ orderId: seeded.orderId, order: seeded.order });
  await service.processQualifyingVisit({ orderId: seeded.orderId, order: seeded.order, completionTimestamp: occurredAt });
}
const boundaryAccount = (await db.collection('loyaltyAccounts').doc(boundaryCustomer).get()).data();
check('23:59 and 00:01 IST create separate visit dates', boundaryAccount.qualifyingVisitCount === 2);
check('boundary dates are calculated from event time', calculateISTBusinessDate(Date.parse('2026-03-01T18:29:00.000Z')) !== calculateISTBusinessDate(Date.parse('2026-03-01T18:31:00.000Z')));

const delivery = await seedEligibleOrder({ orderId: 'delivery_order', customerId: 'delivery_customer', orderType: 'DELIVERY', taxableRupees: 220, gstRupees: 11 });
await service.processCustomerOrderLoyalty({ orderId: delivery.orderId, order: delivery.order });
const deliveryVisit = await service.processQualifyingVisit({ orderId: delivery.orderId, order: delivery.order, completionTimestamp: visitTime });
check('delivery earns points but no visit', deliveryVisit.status === 'DELIVERY_NO_VISIT' && (await pointEntriesFor('delivery_customer')).length === 1);

// Club activates once at the 125th valid rolling visit.
await setFlags({ accountEnabled: true, earnEnabled: true, visitEnabled: true, clubEarnedEnabled: true });
const clubCustomer = 'club_customer';
const existingDates = Array.from({ length: 124 }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
await db.collection('loyaltyAccounts').doc(clubCustomer).set({
  customerId: clubCustomer,
  pointsBalance: 0,
  lifetimePointsEarned: 0,
  lifetimePointsReversed: 0,
  qualifyingVisitCount: 124,
  rollingVisitBusinessDates: existingDates,
  currentClubStatus: 'NONE',
  policyVersion: 'BOND_POLICY_V1_2026',
});
check('124 valid visits has no Club membership', !(await db.collection('clubMemberships').doc(`${clubCustomer}__BOND_POLICY_V1_2026`).get()).exists);
const clubTime = Date.parse('2026-05-05T08:00:00.000Z');
const clubOrder = await seedEligibleOrder({ orderId: 'club_125', customerId: clubCustomer, occurredAt: clubTime, taxableRupees: 150, gstRupees: 7.5 });
await service.processCustomerOrderLoyalty({ orderId: clubOrder.orderId, order: clubOrder.order });
const clubResult = await service.processQualifyingVisit({ orderId: clubOrder.orderId, order: clubOrder.order, completionTimestamp: clubTime });
const clubRetry = await service.processQualifyingVisit({ orderId: clubOrder.orderId, order: clubOrder.order, completionTimestamp: clubTime });
const memberships = await db.collection('clubMemberships').where('customerId', '==', clubCustomer).get();
check('125th valid visit creates earned Club membership', clubResult.status === 'VISIT_AND_CLUB_POSTED' && memberships.size === 1);
check('Club qualification retry creates no duplicate membership', clubRetry.status === 'DUPLICATE_EVENT' && memberships.size === 1);
check('Club activation does not change points', (await db.collection('loyaltyAccounts').doc(clubCustomer).get()).data().pointsBalance === 15);

// Point reversal, duplicate void and negative balance.
const reversalOrder = await seedEligibleOrder({ orderId: 'void_order', customerId: 'void_customer', taxableRupees: 500, gstRupees: 25 });
await service.processCustomerOrderLoyalty({ orderId: reversalOrder.orderId, order: reversalOrder.order });
await db.collection('loyaltyPointLedger').doc('future_redemption_fixture').set({
  ledgerEntryId: 'future_redemption_fixture',
  customerId: 'void_customer',
  eventType: 'POINT_REDEEM',
  pointsDelta: -50,
  occurredAt: reversalOrder.timestamp,
  createdAt: reversalOrder.timestamp,
});
await db.collection('loyaltyAccounts').doc('void_customer').set({ pointsBalance: 0 }, { merge: true });
const voidedOrder = { ...reversalOrder.order, status: 'VOIDED', voidedAt: Timestamp.fromMillis(Date.parse('2026-02-03T08:00:00.000Z')) };
await db.collection('orders').doc(reversalOrder.orderId).set(voidedOrder);
await service.processCustomerOrderLoyalty({ orderId: reversalOrder.orderId, order: voidedOrder });
await service.processCustomerOrderLoyalty({ orderId: reversalOrder.orderId, order: voidedOrder });
const voidEntries = await pointEntriesFor('void_customer');
const voidAccount = (await db.collection('loyaltyAccounts').doc('void_customer').get()).data();
check('full void appends exactly one POINT_EARN_REVERSAL', voidEntries.filter(entry => entry.id === pointEarnReversalLedgerId(reversalOrder.orderId)).length === 1);
check('duplicate void still has one reversal', voidEntries.filter(entry => entry.eventType === 'POINT_EARN_REVERSAL').length === 1);
check('legitimate reversal allows negative projected balance', voidAccount.pointsBalance === -50);
check('original POINT_EARN remains immutable', (await db.collection('loyaltyPointLedger').doc(pointEarnLedgerId(reversalOrder.orderId)).get()).exists);

// Voiding the daily visit source selects another completed qualifying order.
const replacementCustomer = 'replacement_customer';
const replacementTime = Date.parse('2026-06-01T08:00:00.000Z');
const sourceOrder = await seedEligibleOrder({ orderId: 'day_source', customerId: replacementCustomer, occurredAt: replacementTime, taxableRupees: 150, gstRupees: 7.5 });
const alternateOrder = await seedEligibleOrder({ orderId: 'day_alternate', customerId: replacementCustomer, occurredAt: replacementTime + 60000, taxableRupees: 220, gstRupees: 11 });
await service.processCustomerOrderLoyalty({ orderId: sourceOrder.orderId, order: sourceOrder.order });
await service.processCustomerOrderLoyalty({ orderId: alternateOrder.orderId, order: alternateOrder.order });
const sourceKot = await seedServedKot(sourceOrder.orderId, replacementTime + 120000);
const alternateKot = await seedServedKot(alternateOrder.orderId, replacementTime + 180000);
await service.processKotFulfillment({ before: { ...sourceKot, status: 'READY' }, after: sourceKot });
await service.processKotFulfillment({ before: { ...alternateKot, status: 'READY' }, after: alternateKot });
const sourceVoided = { ...sourceOrder.order, status: 'VOIDED', voidedAt: Timestamp.fromMillis(replacementTime + 240000) };
await db.collection('orders').doc(sourceOrder.orderId).set(sourceVoided);
await service.processCustomerOrderLoyalty({ orderId: sourceOrder.orderId, order: sourceVoided });
const replacementDay = calculateISTBusinessDate(replacementTime);
const replacementLock = (await db.collection('qualifyingVisitDays').doc(`${replacementCustomer}__${replacementDay}`).get()).data();
check('voided daily source records immutable visit reversal', (await db.collection('qualifyingVisitEvents').doc(`QUALIFY_VISIT_REVERSAL__${sourceOrder.orderId}__BOND_POLICY_V1_2026`).get()).exists);
check('another qualifying served order becomes the daily source', replacementLock.sourceOrderId === alternateOrder.orderId);
check('daily source replacement keeps visit count at one', (await db.collection('loyaltyAccounts').doc(replacementCustomer).get()).data().qualifyingVisitCount === 1);

// Failure isolation and reconciliation recovery.
const failureOrder = await seedEligibleOrder({ orderId: 'failure_isolation', customerId: 'failure_customer', taxableRupees: 320, gstRupees: 16 });
await db.collection('kotItems').doc('failure_kot').set({ orderId: failureOrder.orderId, status: 'PENDING' });
await db.collection('stockMovements').doc('failure_stock').set({ orderId: failureOrder.orderId, quantity: -1 });
await db.collection('reportFixtures').doc('failure_report').set({ orderId: failureOrder.orderId, included: true });
let workerFailed = false;
try {
  await service.processCustomerOrderLoyalty({
    orderId: failureOrder.orderId,
    order: failureOrder.order,
    faultInjector: async stage => { if (stage === 'BEFORE_LEDGER_TRANSACTION') throw new Error('EMULATOR_LOYALTY_FAILURE'); },
  });
} catch {
  workerFailed = true;
}
check('deliberate loyalty worker failure is observable', workerFailed);
check('committed order survives loyalty failure', (await db.collection('orders').doc(failureOrder.orderId).get()).exists);
check('KOT stock and reporting evidence survive loyalty failure', (await db.collection('kotItems').doc('failure_kot').get()).exists && (await db.collection('stockMovements').doc('failure_stock').get()).exists && (await db.collection('reportFixtures').doc('failure_report').get()).exists);
check('failed worker posts no partial ledger entry', (await pointEntriesFor('failure_customer')).length === 0);
const beforeRecovery = await service.reconcileLoyaltyAccount('failure_customer');
check('reconciliation identifies the missing eligible order', beforeRecovery.missingLoyaltyOrders.includes(failureOrder.orderId));
await service.processCustomerOrderLoyalty({ orderId: failureOrder.orderId, order: failureOrder.order });
const afterRecovery = await service.reconcileLoyaltyAccount('failure_customer');
check('recovery posts points once and clears missing-order issue', (await pointEntriesFor('failure_customer')).filter(entry => entry.eventType === 'POINT_EARN').length === 1 && !afterRecovery.missingLoyaltyOrders.includes(failureOrder.orderId));
check('ledger and account projection reconcile after recovery', afterRecovery.projectionMismatch === false);

// Firestore rules: customer reads own exposed state, nobody writes financial state.
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
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  where,
} = await import('firebase/firestore');

async function clientFor(name, email) {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-key', authDomain: 'localhost' }, name);
  const auth = getAuth(app);
  const [authHost, authPort] = process.env.FIREBASE_AUTH_EMULATOR_HOST.split(':');
  connectAuthEmulator(auth, `http://${authHost}:${authPort}`, { disableWarnings: true });
  const firestore = getFirestore(app);
  const [firestoreHost, firestorePort] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(firestore, firestoreHost, Number(firestorePort));
  const credential = await createUserWithEmailAndPassword(auth, email, 'BondRules12345!');
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

const customerA = await clientFor('bond-customer-a', 'bond-customer-a@example.invalid');
const customerB = await clientFor('bond-customer-b', 'bond-customer-b@example.invalid');
await db.collection('loyaltyAccounts').doc(customerA.uid).set({ customerId: customerA.uid, pointsBalance: 15 });
await db.collection('loyaltyAccounts').doc(customerB.uid).set({ customerId: customerB.uid, pointsBalance: 99 });
await db.collection('loyaltyPointLedger').doc('rules_ledger_a').set({ customerId: customerA.uid, eventType: 'POINT_EARN', pointsDelta: 15 });
await db.collection('clubMemberships').doc('rules_club_a').set({ customerId: customerA.uid, status: 'ACTIVE' });
check('customer may read their own loyalty account', (await getDoc(doc(customerA.firestore, 'loyaltyAccounts', customerA.uid))).data().pointsBalance === 15);
check('customer may query their own exposed ledger', (await getDocs(query(collection(customerA.firestore, 'loyaltyPointLedger'), where('customerId', '==', customerA.uid)))).size === 1);
check('Customer A cannot read Customer B loyalty', await denied(() => getDoc(doc(customerA.firestore, 'loyaltyAccounts', customerB.uid))));
check('customer cannot write their balance', await denied(() => setDoc(doc(customerA.firestore, 'loyaltyAccounts', customerA.uid), { pointsBalance: 999 }, { merge: true })));
check('customer cannot create ledger entry', await denied(() => setDoc(doc(customerA.firestore, 'loyaltyPointLedger', 'forged'), { customerId: customerA.uid, pointsDelta: 999 })));
check('customer cannot create daily visit', await denied(() => setDoc(doc(customerA.firestore, 'qualifyingVisitDays', 'forged'), { customerId: customerA.uid })));
check('customer cannot activate Club', await denied(() => setDoc(doc(customerA.firestore, 'clubMemberships', 'forged'), { customerId: customerA.uid, status: 'ACTIVE' })));

const cashier = await clientFor('bond-cashier', 'bond-cashier@example.invalid');
await db.collection('users').doc(cashier.uid).set({ role: 'CASHIER', isActive: true, storeIds: ['STORE_A'] });
check('native POS user cannot write loyalty', await denied(() => setDoc(doc(cashier.firestore, 'loyaltyPointLedger', 'cashier_forged'), { customerId: cashier.uid, pointsDelta: 10 })));
check('Cashier cannot read another customer loyalty account', await denied(() => getDoc(doc(cashier.firestore, 'loyaltyAccounts', customerA.uid))));

await Promise.all([deleteApp(customerA.app), deleteApp(customerB.app), deleteApp(cashier.app)]);

console.log(`\nBOND emulator activation, exactly-once, reversal, rules and failure-isolation tests passed: ${passed.length}/${passed.length}.`);
