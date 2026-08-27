import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PROJECT_ID = 'demo-coffee-bond-refund-reversal';
const require = createRequire(import.meta.url);

function commandResult(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function emulatorEnv() {
  const env = {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    XDG_CONFIG_HOME: '/tmp/coffeebond-refund-reversal-firebase-config',
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
    console.error('BLOCKED: Firebase CLI and Java are required for customer refund reversal emulator QA.');
    process.exit(1);
  }
  const result = spawnSync('firebase', [
    'emulators:exec',
    '--only', 'firestore',
    '--project', PROJECT_ID,
    '--non-interactive',
    'node scripts/test-customer-web-refund-operational-reversal-emulator.mjs --inside-emulator',
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
  createCustomerWebRefundOperationalReversalService,
  deterministicVoidReversalMovementId,
} = require('../functions/customerWebRefundOperationalReversal');
const {
  customerOnlineOrderId,
  updateRefundFromWebhook,
} = require('../functions/razorpayPaymentFirst');
const { createBondRedemptionService } = require('../functions/bondRedemption');
const {
  createBondLoyaltyService,
  pointEarnLedgerId,
  pointEarnReversalLedgerId,
} = require('../functions/bondLoyalty');

const reversalService = createCustomerWebRefundOperationalReversalService({ admin, db });
const redemptionService = createBondRedemptionService({ admin, db });
const loyaltyService = createBondLoyaltyService({ admin, db });
const FieldValue = admin.firestore.FieldValue;
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

const onlineOrderId = 'ONLINE_REFUND_1';
const posOrderId = 'POS_REFUND_1';
const checkoutSessionId = 'CHECKOUT_REFUND_1';
const customerId = 'CUSTOMER_REFUND_1';
const storeId = 'STORE_A';
const stockId = `${storeId}_RAW_INGREDIENT_BREAD`;
const movementId = `${posOrderId}_SALE_001`;
const secondMovementId = `${posOrderId}_SALE_002`;
const providerPaymentId = 'pay_refund_1';
const providerRefundId = 'rfnd_refund_1';

await Promise.all([
  db.collection('onlineOrders').doc(onlineOrderId).set({
    source: 'CUSTOMER_WEB',
    paymentProvider: 'RAZORPAY',
    paymentMethod: 'ONLINE',
    providerPaymentId,
    status: 'REFUND_PENDING',
    paymentStatus: 'PAID',
    refundStatus: 'REFUND_PENDING',
    customerUid: customerId,
    storeId,
    linkedOrderId: posOrderId,
    checkoutSessionId,
    trackingToken: 'TRACK_REFUND_1',
    grandTotal: 210,
  }),
  db.collection('customerCheckoutSessions').doc(checkoutSessionId).set({
    status: 'ORDER_CREATED',
    customerUid: customerId,
    storeId,
    onlineOrderId,
    currency: 'INR',
  }),
  db.collection('razorpayRefunds').doc(onlineOrderId).set({
    onlineOrderId,
    storeId,
    provider: 'RAZORPAY',
    providerPaymentId,
    providerRefundId,
    workflow: 'CUSTOMER_WEB_ACCEPTED',
    sourceOrderId: posOrderId,
    amountPaise: 21000,
    currency: 'INR',
    status: 'REFUND_PENDING',
    reason: 'Store rejected the paid order.',
  }),
  db.collection('orders').doc(posOrderId).set({
    orderNumber: 'CB-STORE_A-20260821-0001',
    storeId,
    storeCode: 'STORE_A',
    storeName: 'Store A',
    source: 'CUSTOMER_WEB',
    onlineOrderId,
    paymentProvider: 'RAZORPAY',
    paymentMethod: 'ONLINE',
    paymentStatus: 'PAID',
    status: 'COMPLETED',
    subtotal: 200,
    taxableAmount: 200,
    discountAmount: 0,
    gstTotal: 10,
    grandTotal: 210,
    refundStatus: 'REFUND_PENDING',
    paymentReversalStatus: 'REFUND_PENDING',
  }),
  db.collection('orders').doc(posOrderId).collection('items').doc('ITEM_1').set({
    status: 'SERVED',
    itemCode: 'BREAD',
    quantity: 1,
  }),
  db.collection('orders').doc(posOrderId).collection('payments').doc('razorpay').set({
    method: 'ONLINE',
    provider: 'RAZORPAY',
    status: 'CAPTURED',
    amount: 210,
    providerPaymentId,
  }),
  db.collection('kotItems').doc(`${posOrderId}_ITEM_1_KITCHEN`).set({
    orderId: posOrderId,
    storeId,
    status: 'SERVED',
  }),
  db.collection('storeStock').doc(stockId).set({
    storeId,
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'BREAD',
    currentStock: 8,
  }),
  db.collection('stockMovements').doc(movementId).set({
    storeId,
    storeName: 'Store A',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'BREAD',
    inventoryItemId: 'BREAD',
    inventoryItemName: 'Bread',
    movementType: 'SALE_DEDUCTION',
    referenceType: 'ORDER',
    referenceId: posOrderId,
    quantity: -2,
    unit: 'SLICE',
  }),
  db.collection('stockMovements').doc(secondMovementId).set({
    storeId,
    storeName: 'Store A',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'BREAD',
    inventoryItemId: 'BREAD',
    inventoryItemName: 'Bread',
    movementType: 'ORDER_BOM_BACKFILL',
    referenceType: 'ORDER',
    referenceId: posOrderId,
    quantity: -1,
    unit: 'SLICE',
  }),
  db.collection('pendingInventoryConsumption').doc(`${posOrderId}_PENDING_1`).set({
    orderId: posOrderId,
    storeId,
    status: 'PENDING_BOM',
  }),
  db.collection('loyaltyAccounts').doc(customerId).set({
    customerId,
    pointsBalance: 20,
    lifetimePointsEarned: 20,
    lifetimePointsReversed: 0,
    reservedRedemptionPoints: 0,
    qualifyingVisitCount: 0,
  }),
  db.collection('loyaltyPointLedger').doc(pointEarnLedgerId(posOrderId)).set({
    ledgerEntryId: pointEarnLedgerId(posOrderId),
    customerId,
    eventType: 'POINT_EARN',
    pointsDelta: 20,
    eligibleSpendPaise: 20000,
    sourceOrderId: posOrderId,
    sourceOnlineOrderId: onlineOrderId,
  }),
]);

const refundEntity = {
  id: providerRefundId,
  payment_id: providerPaymentId,
  amount: 21000,
  currency: 'INR',
};
const first = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  refundOperationalReversalService: reversalService,
  eventName: 'refund.processed',
  refundEntity,
});
const [
  orderAfter,
  itemAfter,
  kotAfter,
  stockAfter,
  reversalAfter,
  secondReversalAfter,
  pendingAfter,
] = await Promise.all([
  db.collection('orders').doc(posOrderId).get(),
  db.collection('orders').doc(posOrderId).collection('items').doc('ITEM_1').get(),
  db.collection('kotItems').doc(`${posOrderId}_ITEM_1_KITCHEN`).get(),
  db.collection('storeStock').doc(stockId).get(),
  db.collection('stockMovements').doc(deterministicVoidReversalMovementId(movementId)).get(),
  db.collection('stockMovements').doc(deterministicVoidReversalMovementId(secondMovementId)).get(),
  db.collection('pendingInventoryConsumption').doc(`${posOrderId}_PENDING_1`).get(),
]);
check('confirmed accepted-order refund is reversed by the backend without a browser write',
  first.outcome === 'REFUNDED'
    && first.operationalReversal?.status === 'REVERSED'
    && orderAfter.data()?.status === 'VOIDED'
    && orderAfter.data()?.refundOperationalReversalStatus === 'COMPLETED');
check('POS order item and KOT are cancelled',
  itemAfter.data()?.status === 'CANCELLED' && kotAfter.data()?.status === 'CANCELLED');
check('pending BOM work is cancelled', pendingAfter.data()?.status === 'CANCELLED');
check('multiple sale movements restore one stock row exactly once with deterministic audits',
  stockAfter.data()?.currentStock === 11
    && reversalAfter.exists
    && reversalAfter.data()?.originalMovementId === movementId
    && secondReversalAfter.exists
    && secondReversalAfter.data()?.originalMovementId === secondMovementId);
check('confirmed refund records a complete payment-reversal audit',
  orderAfter.data()?.paymentReversalStatus === 'REFUNDED'
    && orderAfter.data()?.refundedAmount === 210
    && orderAfter.data()?.netCollectionAmount === 0
    && orderAfter.data()?.paymentReversalBreakdown?.[0]?.reversalStatus === 'REFUNDED');

const retry = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  refundOperationalReversalService: reversalService,
  eventName: 'refund.processed',
  refundEntity,
});
const [orderAfterRetry, stockAfterRetry, reversalRowsAfterRetry] = await Promise.all([
  db.collection('orders').doc(posOrderId).get(),
  db.collection('storeStock').doc(stockId).get(),
  db.collection('stockMovements').where('referenceId', '==', posOrderId).get(),
]);
check('retry is idempotent and does not restore stock twice',
  retry.outcome === 'REFUNDED'
    && retry.operationalReversal?.status === 'ALREADY_REVERSED'
    && stockAfterRetry.data()?.currentStock === 11
    && orderAfterRetry.data()?.refundOperationalReversalAt?.isEqual(
      orderAfter.data()?.refundOperationalReversalAt,
    )
    && reversalRowsAfterRetry.docs.filter(document => (
      document.data()?.movementType === 'ORDER_VOID_REVERSAL'
    )).length === 2);

const loyaltyResult = await loyaltyService.processCustomerOrderLoyalty({
  orderId: posOrderId,
  order: { id: orderAfter.id, ...orderAfter.data() },
});
const [accountAfter, earnReversalAfter] = await Promise.all([
  db.collection('loyaltyAccounts').doc(customerId).get(),
  db.collection('loyaltyPointLedger').doc(pointEarnReversalLedgerId(posOrderId)).get(),
]);
check('confirmed refund plus VOIDED status drives exactly one earned-points reversal',
  loyaltyResult.pointResult?.status === 'REVERSED'
    && accountAfter.data()?.pointsBalance === 0
    && earnReversalAfter.data()?.pointsDelta === -20);
const duplicateLoyaltyResult = await loyaltyService.processCustomerOrderLoyalty({
  orderId: posOrderId,
  order: { id: orderAfter.id, ...orderAfter.data() },
});
check('earned-points reversal retry has zero duplicate effect',
  duplicateLoyaltyResult.pointResult?.status === 'DUPLICATE_EVENT'
    && (await db.collection('loyaltyAccounts').doc(customerId).get()).data()?.pointsBalance === 0);

const nativeOrderId = 'NATIVE_POS_REFUND_1';
await db.collection('orders').doc(nativeOrderId).set({
  source: 'POS',
  status: 'COMPLETED',
  paymentProvider: 'RAZORPAY',
  paymentMethod: 'RAZORPAY',
  refundStatus: 'REFUNDED',
  paymentReversalStatus: 'REFUNDED',
});
check('native POS cannot enter the customer-web refund reversal', await rejectsWithCode(
  () => reversalService.reverseConfirmedRefund({
    onlineOrderId: 'NOT_A_CUSTOMER_ORDER',
    posOrderId: nativeOrderId,
  }),
  'INELIGIBLE_REFUND_REVERSAL',
));
check('native POS state remains unchanged',
  (await db.collection('orders').doc(nativeOrderId).get()).data()?.status === 'COMPLETED');
const nativeLinkOnlineOrderId = 'ONLINE_NATIVE_LINK_REFUND_1';
const nativeLinkRefundId = 'rfnd_native_link_1';
const nativeLinkPaymentId = 'pay_native_link_1';
await Promise.all([
  db.collection('onlineOrders').doc(nativeLinkOnlineOrderId).set({
    source: 'CUSTOMER_WEB',
    paymentProvider: 'RAZORPAY',
    paymentMethod: 'ONLINE',
    providerPaymentId: nativeLinkPaymentId,
    paymentStatus: 'PAID',
    refundStatus: 'REFUND_PENDING',
    status: 'REFUND_PENDING',
    linkedOrderId: nativeOrderId,
    checkoutSessionId: 'CHECKOUT_NATIVE_LINK_1',
    grandTotal: 100,
  }),
  db.collection('razorpayRefunds').doc(nativeLinkOnlineOrderId).set({
    onlineOrderId: nativeLinkOnlineOrderId,
    provider: 'RAZORPAY',
    providerPaymentId: nativeLinkPaymentId,
    providerRefundId: nativeLinkRefundId,
    workflow: 'CUSTOMER_WEB_ACCEPTED',
    amountPaise: 10000,
    currency: 'INR',
    status: 'REFUND_PENDING',
  }),
]);
const nativeLinkOutcome = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService,
  refundOperationalReversalService: reversalService,
  eventName: 'refund.processed',
  refundEntity: {
    id: nativeLinkRefundId,
    payment_id: nativeLinkPaymentId,
    amount: 10000,
    currency: 'INR',
  },
});
check('refund webhook cannot mutate a native POS order through a forged customer link',
  nativeLinkOutcome.handled === false
    && nativeLinkOutcome.outcome === 'REFUND_POS_ORDER_EVIDENCE_MISMATCH'
    && (await db.collection('orders').doc(nativeOrderId).get()).data()?.status === 'COMPLETED'
    && !(await db.collection('orders').doc(nativeOrderId).get()).data()?.refundedAmount);

const unconfirmedOrderId = 'POS_UNCONFIRMED_REFUND_1';
await db.collection('orders').doc(unconfirmedOrderId).set({
  source: 'CUSTOMER_WEB',
  onlineOrderId: 'ONLINE_UNCONFIRMED_REFUND_1',
  status: 'COMPLETED',
  paymentProvider: 'RAZORPAY',
  paymentMethod: 'ONLINE',
  refundStatus: 'REFUND_PENDING',
  paymentReversalStatus: 'REFUND_PENDING',
});
check('pending provider refund cannot reverse operational effects', await rejectsWithCode(
  () => reversalService.reverseConfirmedRefund({
    onlineOrderId: 'ONLINE_UNCONFIRMED_REFUND_1',
    posOrderId: unconfirmedOrderId,
  }),
  'REFUND_NOT_CONFIRMED',
));

const orphanSessionId = 'CHECKOUT_ORPHAN_REFUND_1';
const orphanProviderPaymentId = 'pay_orphan_refund_1';
const orphanProviderRefundId = 'rfnd_orphan_refund_1';
await Promise.all([
  db.collection('customerCheckoutSessions').doc(orphanSessionId).set({
    status: 'REFUND_PENDING',
    refundStatus: 'REFUND_PENDING',
    storeId,
    customerUid: 'CUSTOMER_ORPHAN_1',
    razorpayOrderId: 'order_orphan_refund_1',
    providerPaymentId: orphanProviderPaymentId,
    providerRefundId: orphanProviderRefundId,
    amountPaise: 7350,
    currency: 'INR',
  }),
  db.collection('razorpayRefunds').doc('ORPHAN_REFUND_1').set({
    checkoutSessionId: orphanSessionId,
    onlineOrderId: null,
    storeId,
    provider: 'RAZORPAY',
    providerPaymentId: orphanProviderPaymentId,
    providerOrderId: 'order_orphan_refund_1',
    providerRefundId: orphanProviderRefundId,
    workflow: 'CUSTOMER_CHECKOUT_ORPHAN',
    amountPaise: 7350,
    currency: 'INR',
    status: 'REFUND_PENDING',
  }),
]);
let orphanRedemptionRestoreCalls = 0;
const orphanRedemptionService = {
  async restoreInTransaction() {
    orphanRedemptionRestoreCalls += 1;
    throw new Error('Orphan checkout refunds must not restore redeemed points.');
  },
};
const orphanRefundEntity = {
  id: orphanProviderRefundId,
  payment_id: orphanProviderPaymentId,
  amount: 7350,
  currency: 'INR',
};
const orphanProcessed = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService: orphanRedemptionService,
  eventName: 'refund.processed',
  refundEntity: orphanRefundEntity,
});
const [orphanSessionAfter, orphanRefundAfter, orphanOrderAfter] = await Promise.all([
  db.collection('customerCheckoutSessions').doc(orphanSessionId).get(),
  db.collection('razorpayRefunds').doc('ORPHAN_REFUND_1').get(),
  db.collection('onlineOrders').doc(customerOnlineOrderId(orphanSessionId)).get(),
]);
check('validated orphan late-capture refund marks only the checkout session refunded',
  orphanProcessed.outcome === 'REFUNDED'
    && orphanSessionAfter.data()?.status === 'REFUNDED'
    && orphanSessionAfter.data()?.refundStatus === 'REFUNDED'
    && orphanRefundAfter.data()?.status === 'REFUNDED'
    && !orphanOrderAfter.exists
    && orphanRedemptionRestoreCalls === 0);
const orphanLateFailure = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService: orphanRedemptionService,
  eventName: 'refund.failed',
  refundEntity: { ...orphanRefundEntity, error_code: 'LATE_FAILURE' },
});
check('orphan REFUNDED state is terminal across a late failed webhook',
  orphanLateFailure.outcome === 'REFUNDED'
    && (await db.collection('customerCheckoutSessions').doc(orphanSessionId).get()).data()?.status === 'REFUNDED'
    && (await db.collection('razorpayRefunds').doc('ORPHAN_REFUND_1').get()).data()?.status === 'REFUNDED');
const mismatchedOrphan = await updateRefundFromWebhook({
  db,
  admin,
  redemptionService: orphanRedemptionService,
  eventName: 'refund.processed',
  refundEntity: { ...orphanRefundEntity, amount: 7349 },
});
check('orphan refund rejects mismatched provider amount evidence without writes',
  mismatchedOrphan.handled === false
    && mismatchedOrphan.outcome === 'REFUND_AMOUNT_MISMATCH'
    && (await db.collection('customerCheckoutSessions').doc(orphanSessionId).get()).data()?.status === 'REFUNDED');

await db.collection('orders').doc(posOrderId).set({
  updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });
await admin.app().delete();
console.log(`\nCustomer-web confirmed-refund operational reversal tests passed: ${passed.length}/${passed.length}.`);
