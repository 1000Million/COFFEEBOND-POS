import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PROJECT_ID = 'demo-coffee-bond-redemption';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-redemption-firebase-config',
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
  if (commandResult('java', ['-version'], env).status !== 0
    || commandResult('firebase', ['--version'], env).status !== 0) {
    console.error('BLOCKED: Firebase CLI and Java are required for BOND redemption emulator QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-bond-redemption-emulator-e2e.mjs --inside-emulator',
  ], { stdio: 'inherit', env });
  process.exit(result.status ?? 1);
}

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator host is required.');
assert.ok(PROJECT_ID.startsWith('demo-'), 'Only a throwaway demo project may be used.');
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const {
  createBondRedemptionService,
  redemptionLedgerId,
  redemptionReservationId,
  redemptionRestoreLedgerId,
} = require('../functions/bondRedemption');
const service = createBondRedemptionService({ admin, db });
const Timestamp = admin.firestore.Timestamp;

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

async function rejectsWithCode(action, code) {
  try {
    await action();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

async function setFlags(overrides = {}) {
  await db.doc('appSettings/loyalty').set({
    accountEnabled: true,
    shadowEnabled: true,
    earnEnabled: true,
    visitEnabled: false,
    expiryEnabled: false,
    redemptionEnabled: true,
    gamificationEnabled: false,
    clubEarnedEnabled: false,
    clubPaidEnabled: false,
    omakaseEnabled: false,
    customerOrderingOnly: true,
    ...overrides,
  });
}

function canonicalBasket({ source = 'CUSTOMER_WEB', price = 250, discount = 0 } = {}) {
  const taxableAmount = price - discount;
  const gstTotal = Math.round(taxableAmount * 5) / 100;
  return {
    source,
    storeId: 'STORE_A',
    storeCode: 'NOIDA_29',
    orderType: 'TAKEAWAY',
    items: [{
      lineId: 'line_bread',
      finishedGoodId: 'FG_BREAD',
      finishedGoodCode: 'BREAD',
      name: 'Bread',
      quantity: 1,
      baseUnitPrice: price,
      taxRate: 5,
      addOns: [],
      lineSubtotal: price,
      lineDiscount: discount,
      lineTaxable: taxableAmount,
      lineTax: gstTotal,
      lineTotal: taxableAmount + gstTotal,
    }],
    subtotal: price,
    discount,
    discountAmount: discount,
    discountTotal: discount,
    taxableAmount,
    gstTotal,
    grandTotal: taxableAmount + gstTotal,
  };
}

async function seedAccount(customerId, pointsBalance = 56) {
  await db.collection('loyaltyAccounts').doc(customerId).set({
    customerId,
    pointsBalance,
    reservedRedemptionPoints: 0,
    lifetimePointsEarned: pointsBalance,
    lifetimePointsRedeemed: 0,
    lifetimePointsRestored: 0,
    policyVersion: 'BOND_POLICY_V1_2026',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function reserve({ customerId, sessionId, canonical, expiresAt, checksum = sessionId }) {
  return db.runTransaction(transaction => service.reserveInTransaction({
    transaction,
    customerId,
    sessionId,
    canonical,
    expiresAt: expiresAt || Timestamp.fromMillis(Date.now() + (15 * 60 * 1000)),
    requestChecksum: checksum,
  }));
}

async function settle({ customerId, sessionId, onlineOrderId, canonical }) {
  return db.runTransaction(transaction => service.settleInTransaction({
    transaction,
    customerId,
    sessionId,
    onlineOrderId,
    canonical,
  }));
}

async function restore({ sessionId, onlineOrderId, sourceOrderId }) {
  return db.runTransaction(transaction => service.restoreInTransaction({
    transaction,
    sessionId,
    onlineOrderId,
    sourceOrderId,
    reason: 'ORDER_REFUNDED',
  }));
}

await setFlags();

// A 56-point account may spend 50 points (the 20% cap) on a ₹250 pre-GST basket.
const coreCustomer = 'customer_core';
await seedAccount(coreCustomer, 56);
const baseBasket = canonicalBasket();
const coreQuote = await service.quote({
  customerId: coreCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
check('56-point balance reports 50 maximum usable points on ₹250',
  coreQuote.pointsBalance === 56 && coreQuote.availablePoints === 56
    && coreQuote.maximumUsablePoints === 50
    && coreQuote.selectedPoints === 50
    && coreQuote.policy.maximumPercent === 20);
check('50 points creates a clearly labelled ₹50 server discount',
  coreQuote.discountPaise === 5000
    && coreQuote.canonical.discountReason === 'BOND Points Redemption'
    && coreQuote.canonical.discountSource === 'BOND_REDEMPTION');
check('redemption is applied before GST',
  coreQuote.subtotal === 250 && coreQuote.taxableAmount === 200
    && coreQuote.gstTotal === 10 && coreQuote.grandTotal === 210);

check('below-minimum points are rejected', await rejectsWithCode(
  () => service.quote({ customerId: coreCustomer, canonical: baseBasket, requestedPoints: 40 }),
  'REDEMPTION_BELOW_MINIMUM',
));
check('non-multiple-of-ten points are rejected', await rejectsWithCode(
  () => service.quote({ customerId: coreCustomer, canonical: baseBasket, requestedPoints: 55 }),
  'REDEMPTION_INCREMENT_REQUIRED',
));
check('more than the 20% basket maximum is rejected', await rejectsWithCode(
  () => service.quote({ customerId: coreCustomer, canonical: baseBasket, requestedPoints: 60 }),
  'INSUFFICIENT_POINTS',
));

const highBalanceCustomer = 'customer_high_balance';
await seedAccount(highBalanceCustomer, 500);
check('20% cap applies even when the balance is higher', await rejectsWithCode(
  () => service.quote({ customerId: highBalanceCustomer, canonical: baseBasket, requestedPoints: 60 }),
  'REDEMPTION_EXCEEDS_MAXIMUM',
));
check('redemption cannot be combined with another discount', await rejectsWithCode(
  () => service.quote({
    customerId: highBalanceCustomer,
    canonical: canonicalBasket({ discount: 10 }),
    requestedPoints: 50,
  }),
  'REDEMPTION_WITH_DISCOUNT_NOT_ALLOWED',
));

const belowBalanceCustomer = 'customer_below_balance';
await seedAccount(belowBalanceCustomer, 49);
check('insufficient points are rejected', await rejectsWithCode(
  () => service.quote({
    customerId: belowBalanceCustomer,
    canonical: baseBasket,
    requestedPoints: 50,
  }),
  'INSUFFICIENT_POINTS',
));

// Two sessions quote the same 56 points; Firestore serialization permits only one reservation.
const concurrentCustomer = 'customer_concurrent';
await seedAccount(concurrentCustomer, 56);
const concurrentQuoteA = await service.quote({
  customerId: concurrentCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
const concurrentQuoteB = await service.quote({
  customerId: concurrentCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
const concurrentResults = await Promise.allSettled([
  reserve({
    customerId: concurrentCustomer,
    sessionId: 'session_concurrent_a',
    canonical: concurrentQuoteA.canonical,
  }),
  reserve({
    customerId: concurrentCustomer,
    sessionId: 'session_concurrent_b',
    canonical: concurrentQuoteB.canonical,
  }),
]);
const concurrentSuccesses = concurrentResults.filter(result => result.status === 'fulfilled');
const concurrentFailures = concurrentResults.filter(result => result.status === 'rejected');
check('two simultaneous checkouts create exactly one reservation',
  concurrentSuccesses.length === 1 && concurrentFailures.length === 1);
check('concurrent double-spend loses with insufficient available points',
  concurrentFailures[0].reason?.code === 'INSUFFICIENT_POINTS');
const concurrentAccount = (await db.collection('loyaltyAccounts').doc(concurrentCustomer).get()).data();
check('the winning reservation holds exactly 50 points without debiting balance',
  concurrentAccount.pointsBalance === 56 && concurrentAccount.reservedRedemptionPoints === 50);
const winningSessionId = concurrentSuccesses[0].value.reservationId
  === redemptionReservationId('session_concurrent_a')
  ? 'session_concurrent_a'
  : 'session_concurrent_b';
const sameSessionRetryQuote = await service.quote({
  customerId: concurrentCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
  sessionId: winningSessionId,
});
check('the exact checkout session may idempotently reuse its own active hold',
  sameSessionRetryQuote.maximumUsablePoints === 50
    && sameSessionRetryQuote.ownReservedPoints === 50);
await service.releaseReservation({
  customerId: concurrentCustomer,
  sessionId: winningSessionId,
  reason: 'TEST_CLEANUP',
});

// Payment failure/cancellation releases the hold, exactly once, without a ledger mutation.
const failureCustomer = 'customer_failure';
await seedAccount(failureCustomer, 56);
const failureQuote = await service.quote({
  customerId: failureCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
await reserve({
  customerId: failureCustomer,
  sessionId: 'session_failure',
  canonical: failureQuote.canonical,
});
const firstRelease = await service.releaseReservation({
  customerId: failureCustomer,
  sessionId: 'session_failure',
  reason: 'PAYMENT_FAILED',
});
const duplicateRelease = await service.releaseReservation({
  customerId: failureCustomer,
  sessionId: 'session_failure',
  reason: 'PAYMENT_FAILED_RETRY',
});
const failureAccount = (await db.collection('loyaltyAccounts').doc(failureCustomer).get()).data();
check('failed payment releases points exactly once',
  firstRelease.status === 'RELEASED' && duplicateRelease.status === 'ALREADY_RELEASED'
    && failureAccount.pointsBalance === 56 && failureAccount.reservedRedemptionPoints === 0);
check('failed payment creates no redemption ledger',
  !(await db.collection('loyaltyPointLedger').doc(redemptionLedgerId('session_failure')).get()).exists);

// Verified payment atomically converts the hold to one immutable debit.
const paidCustomer = 'customer_paid';
const paidSession = 'session_paid';
const paidOnlineOrder = 'online_paid';
await seedAccount(paidCustomer, 56);
const paidQuote = await service.quote({
  customerId: paidCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
await reserve({ customerId: paidCustomer, sessionId: paidSession, canonical: paidQuote.canonical });
const firstSettle = await settle({
  customerId: paidCustomer,
  sessionId: paidSession,
  onlineOrderId: paidOnlineOrder,
  canonical: paidQuote.canonical,
});
const duplicateSettle = await settle({
  customerId: paidCustomer,
  sessionId: paidSession,
  onlineOrderId: paidOnlineOrder,
  canonical: paidQuote.canonical,
});
const paidAccount = (await db.collection('loyaltyAccounts').doc(paidCustomer).get()).data();
const paidRedemption = (await db.collection('loyaltyPointLedger')
  .doc(redemptionLedgerId(paidSession)).get()).data();
check('verified payment debits points exactly once',
  firstSettle.status === 'REDEEMED' && duplicateSettle.status === 'ALREADY_REDEEMED'
    && paidAccount.pointsBalance === 6 && paidAccount.reservedRedemptionPoints === 0);
check('the immutable debit records one -50 customer-ordering redemption',
  paidRedemption.eventType === 'POINT_REDEMPTION'
    && paidRedemption.pointsDelta === -50
    && paidRedemption.sourceOnlineOrderId === paidOnlineOrder
    && paidRedemption.orderChannel === 'CUSTOMER_ORDERING');

// Rejection/refund restores the redeemed points once, even across duplicate callbacks.
const firstRestore = await restore({
  sessionId: paidSession,
  onlineOrderId: paidOnlineOrder,
  sourceOrderId: 'POS_ORDER_PAID',
});
const duplicateRestore = await restore({
  sessionId: paidSession,
  onlineOrderId: paidOnlineOrder,
  sourceOrderId: 'POS_ORDER_PAID',
});
const restoredAccount = (await db.collection('loyaltyAccounts').doc(paidCustomer).get()).data();
const restoredLedger = (await db.collection('loyaltyPointLedger')
  .doc(redemptionRestoreLedgerId(paidSession)).get()).data();
check('rejected/refunded order restores points exactly once',
  firstRestore.status === 'RESTORED' && duplicateRestore.status === 'ALREADY_RESTORED'
    && restoredAccount.pointsBalance === 56);
check('restoration is one immutable +50 ledger event linked to the original debit',
  restoredLedger.eventType === 'POINT_REDEMPTION_RESTORE'
    && restoredLedger.pointsDelta === 50
    && restoredLedger.originalLedgerEntryId === redemptionLedgerId(paidSession));
const paidEntries = await db.collection('loyaltyPointLedger')
  .where('customerId', '==', paidCustomer).get();
check('duplicate callbacks create zero duplicate redemption ledger records',
  paidEntries.size === 2
    && paidEntries.docs.reduce((sum, document) => sum + document.data().pointsDelta, 0) === 0);

// Expiry uses the same exact-once release path.
const expiryCustomer = 'customer_expiry';
const expirySession = 'session_expiry';
await seedAccount(expiryCustomer, 56);
const expiryQuote = await service.quote({
  customerId: expiryCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
await reserve({
  customerId: expiryCustomer,
  sessionId: expirySession,
  canonical: expiryQuote.canonical,
  expiresAt: Timestamp.fromMillis(Date.now() - 1000),
});
const expiryRun = await service.releaseExpiredReservations({ now: Date.now(), limit: 10 });
const expiryAccount = (await db.collection('loyaltyAccounts').doc(expiryCustomer).get()).data();
check('expired reservation releases the hold',
  expiryRun.released === 1 && expiryAccount.reservedRedemptionPoints === 0
    && expiryAccount.pointsBalance === 56);

// A retry owns and refreshes its expired hold before the sweeper can release it.
const refreshCustomer = 'customer_expired_retry';
const refreshSession = 'session_expired_retry';
await seedAccount(refreshCustomer, 56);
const refreshQuote = await service.quote({
  customerId: refreshCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
await reserve({
  customerId: refreshCustomer,
  sessionId: refreshSession,
  canonical: refreshQuote.canonical,
  expiresAt: Timestamp.fromMillis(Date.now() - 1000),
});
const retryQuote = await service.quote({
  customerId: refreshCustomer,
  sessionId: refreshSession,
  canonical: baseBasket,
  requestedPoints: 50,
});
const refreshed = await reserve({
  customerId: refreshCustomer,
  sessionId: refreshSession,
  canonical: retryQuote.canonical,
  expiresAt: Timestamp.fromMillis(Date.now() + (15 * 60 * 1000)),
});
const refreshedReservation = (await db.collection('loyaltyRedemptionReservations')
  .doc(redemptionReservationId(refreshSession)).get()).data();
const refreshedAccount = (await db.collection('loyaltyAccounts').doc(refreshCustomer).get()).data();
check('same-session retry refreshes an expired hold without double-reserving points',
  refreshed.status === 'RESERVED'
    && refreshedReservation.status === 'ACTIVE'
    && refreshedReservation.previousReleaseReason === 'RESERVATION_EXPIRED'
    && refreshedAccount.reservedRedemptionPoints === 50);

// A posted earn reversal after reservation becomes points debt; the captured hold remains guaranteed.
const debtCustomer = 'customer_reserved_debt';
const debtSession = 'session_reserved_debt';
await seedAccount(debtCustomer, 56);
const debtQuote = await service.quote({
  customerId: debtCustomer,
  canonical: baseBasket,
  requestedPoints: 50,
});
await reserve({ customerId: debtCustomer, sessionId: debtSession, canonical: debtQuote.canonical });
await db.collection('loyaltyAccounts').doc(debtCustomer).update({ pointsBalance: 6 });
const debtSettlement = await settle({
  customerId: debtCustomer,
  sessionId: debtSession,
  onlineOrderId: 'online_reserved_debt',
  canonical: debtQuote.canonical,
});
const debtAccount = (await db.collection('loyaltyAccounts').doc(debtCustomer).get()).data();
check('an active hold remains settleable after an earn reversal and records non-spendable points debt',
  debtSettlement.status === 'REDEEMED'
    && debtAccount.pointsBalance === -44
    && debtAccount.reservedRedemptionPoints === 0);

// Native POS is an explicit firewall: it cannot quote, reserve or write a ledger.
const nativeCustomer = 'native_pos_customer';
await seedAccount(nativeCustomer, 100);
check('native POS channel is rejected before reservation', await rejectsWithCode(
  () => service.quote({
    customerId: nativeCustomer,
    canonical: canonicalBasket({ source: 'POS' }),
    requestedPoints: 50,
  }),
  'REDEMPTION_CHANNEL_INELIGIBLE',
));
check('native POS rejection creates no reservation or financial ledger',
  (await db.collection('loyaltyRedemptionReservations')
    .where('customerId', '==', nativeCustomer).get()).empty
    && (await db.collection('loyaltyPointLedger')
      .where('customerId', '==', nativeCustomer).get()).empty);

await admin.app().delete();
console.log(`\nBOND redemption emulator transaction and idempotency tests passed: ${passed.length}/${passed.length}.`);
