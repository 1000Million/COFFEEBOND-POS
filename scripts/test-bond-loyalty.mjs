import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  BOND_POLICY,
  DEFAULT_LOYALTY_FLAGS,
  addCalendarMonthsIST,
  calculateBondJourney,
  calculateBondPoints,
  calculateEligibleSpendPaise,
  calculateISTBusinessDate,
  resolveLoyaltyFlags,
  rupeesToPaise,
} = require('../functions/bondLoyaltyPolicy');
const { isEligibleCustomerOrderingOrigin } = require('../functions/bondLoyalty');

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

const pointCases = [
  [0, 0],
  [9.99, 0],
  [10, 1],
  [149, 14],
  [150, 15],
  [159.99, 15],
  [220, 22],
  [590, 59],
];
for (const [rupees, expected] of pointCases) {
  const paise = rupeesToPaise(rupees);
  check(`₹${rupees} eligible spend earns ${expected} points`, calculateBondPoints(paise).pointsEarned === expected);
}

const discounted = calculateEligibleSpendPaise({
  subtotal: 200,
  discountAmount: 50,
  taxableAmount: 150,
  gstTotal: 7.5,
  grandTotal: 157.5,
});
check('discount uses authoritative post-discount taxable spend', discounted.eligibleSpendPaise === 15000);
check('GST is recorded as excluded evidence', discounted.gstExcludedPaise === 750);
check('authoritative taxableAmount wins over GST-inclusive grand total', calculateBondPoints(discounted.eligibleSpendPaise).pointsEarned === 15);

const representedFees = calculateEligibleSpendPaise({
  subtotal: 180,
  taxableAmount: 150,
  gstTotal: 7.5,
  grandTotal: 187.5,
  deliveryFee: 30,
});
check('represented delivery fee is excluded through authoritative taxableAmount', representedFees.eligibleSpendPaise === 15000);
check('delivery fee exclusion evidence is retained', representedFees.excludedRepresentedAmounts.deliveryFeesPaise === 3000);

check('policy identifier is versioned', BOND_POLICY.policyVersion === 'BOND_POLICY_V1_2026');
check('policy remains customer-ordering-only', BOND_POLICY.channel === 'CUSTOMER_ORDERING_ONLY');
check('visit threshold is ₹150 in integer paise', BOND_POLICY.visitMinimumPaise === 15000);
check('Club target is 125 visits', BOND_POLICY.clubVisitTarget === 125);
check('timezone is Asia/Kolkata', BOND_POLICY.timezone === 'Asia/Kolkata');

const at2359 = Date.parse('2026-01-01T18:29:00.000Z');
const at0001 = Date.parse('2026-01-01T18:31:00.000Z');
check('23:59 IST uses the earlier business date', calculateISTBusinessDate(at2359) === '2026-01-01');
check('00:01 IST uses the next business date', calculateISTBusinessDate(at0001) === '2026-01-02');

const sourceExpiry = Date.parse('2026-01-31T06:30:00.000Z');
check(
  '18-month projected expiry preserves the IST calendar day',
  new Date(addCalendarMonthsIST(sourceExpiry, 18)).toISOString() === '2027-07-31T06:30:00.000Z',
);

const journey0 = calculateBondJourney(0);
const journey1 = calculateBondJourney(1);
const journey10 = calculateBondJourney(10);
const journey124 = calculateBondJourney(124);
const journey125 = calculateBondJourney(125);
check('Journey starts before First Bond', journey0.currentMilestone === null && journey0.nextMilestone.name === 'First Bond');
check('Journey identifies First Bond', journey1.currentMilestone.name === 'First Bond');
check('Journey identifies Familiar Face', journey10.currentMilestone.name === 'Familiar Face');
check('124 visits does not qualify for Club', journey124.clubQualified === false && journey124.visitsRemaining === 1);
check('125 visits qualifies for Club', journey125.clubQualified === true && journey125.currentMilestone.name === 'The BOND Club');

const validOrder = {
  source: 'CUSTOMER_WEB',
  onlineOrderId: 'online_1',
  storeId: 'STORE_A',
  grandTotal: 157.5,
};
const validOnlineOrder = {
  id: 'online_1',
  linkedOrderId: 'order_1',
  source: 'CUSTOMER_WEB',
  storeId: 'STORE_A',
  grandTotal: 157.5,
  status: 'CONVERTED',
  customerUid: 'customer_uid_1',
};
check('matched order and server provenance is eligible', isEligibleCustomerOrderingOrigin({
  orderId: 'order_1',
  order: validOrder,
  onlineOrder: validOnlineOrder,
  originEvidenceValid: true,
  originEvidenceType: 'PRIVATE_CHECKOUT_SESSION',
}).eligible);
check(
  'matched source and online order without server provenance remains ineligible',
  !isEligibleCustomerOrderingOrigin({ orderId: 'order_1', order: validOrder, onlineOrder: validOnlineOrder }).eligible,
);
for (const [label, order] of [
  ['POS Cash', { paymentMethod: 'CASH' }],
  ['POS UPI', { paymentMethod: 'UPI' }],
  ['POS split', { isSplitPayment: true }],
  ['POS discount', { paymentMethod: 'CASH', discountAmount: 20 }],
  ['POS held bill', { status: 'HELD' }],
  ['POS recalled bill', { status: 'COMPLETED' }],
]) {
  const result = isEligibleCustomerOrderingOrigin({ orderId: `native_${label}`, order, onlineOrder: null });
  check(`${label} fails the customer-order provenance firewall`, !result.eligible && result.exclusionReasons.includes('ORDER_SOURCE_NOT_CUSTOMER_WEB'));
}
check(
  'forged source without a linked online order remains ineligible',
  !isEligibleCustomerOrderingOrigin({ orderId: 'forged', order: { ...validOrder, onlineOrderId: 'missing' }, onlineOrder: null }).eligible,
);
check(
  'mismatched linkedOrderId remains ineligible',
  !isEligibleCustomerOrderingOrigin({ orderId: 'other_order', order: validOrder, onlineOrder: validOnlineOrder }).eligible,
);
check(
  'missing verified customer UID remains ineligible',
  !isEligibleCustomerOrderingOrigin({ orderId: 'order_1', order: validOrder, onlineOrder: { ...validOnlineOrder, customerUid: null } }).eligible,
);

check('all production-safe flags default false except the channel firewall', Object.entries(DEFAULT_LOYALTY_FLAGS).every(([key, value]) => key === 'customerOrderingOnly' ? value === true : value === false));
const unsafeFlags = resolveLoyaltyFlags({
  accountEnabled: false,
  earnEnabled: true,
  visitEnabled: true,
  expiryEnabled: true,
  redemptionEnabled: true,
  clubPaidEnabled: true,
  omakaseEnabled: true,
  customerOrderingOnly: false,
});
check('earn cannot activate without accountEnabled', unsafeFlags.earnEnabled === false);
check('expiry paid Club and Omakase stay hard-disabled', !unsafeFlags.expiryEnabled && !unsafeFlags.clubPaidEnabled && !unsafeFlags.omakaseEnabled);
check('redemption cannot activate without accountEnabled', unsafeFlags.redemptionEnabled === false);
check('redemption activates only with the account flag dependency', resolveLoyaltyFlags({ accountEnabled: true, redemptionEnabled: true }).redemptionEnabled === true);
check('customerOrderingOnly cannot be switched off by configuration', unsafeFlags.customerOrderingOnly === true);

const functionsIndex = readFileSync('functions/index.js', 'utf8');
const loyaltyBackend = readFileSync('functions/bondLoyalty.js', 'utf8');
const payAtCounterBackend = readFileSync('functions/index.js', 'utf8');
const razorpayBackend = readFileSync('functions/razorpayCheckout.js', 'utf8');
const posHome = readFileSync('frontend/pages/pos/POSHome.tsx', 'utf8');
const customerOrder = readFileSync('frontend/pages/customer/CustomerOrder.tsx', 'utf8');
const myOrders = readFileSync('frontend/pages/customer/CustomerMyOrders.tsx', 'utf8');
const customerApp = readFileSync('frontend/CustomerApp.tsx', 'utf8');
const bondLoyaltyUi = readFileSync('frontend/lib/bondLoyalty.ts', 'utf8');
const bondPreviewUi = readFileSync('frontend/lib/bondLoyaltyPreview.ts', 'utf8');
const bondPreviewDisabledUi = readFileSync('frontend/lib/bondLoyaltyPreviewDisabled.ts', 'utf8');
const bondDashboard = readFileSync('frontend/pages/customer/CustomerBondDashboard.tsx', 'utf8');
const customerViteConfig = readFileSync('vite.customer.config.ts', 'utf8');
const rules = readFileSync('firestore.rules', 'utf8');

check('order loyalty is a post-commit Firestore trigger', /onDocumentWritten[\s\S]*orders\/\{orderId\}/.test(functionsIndex));
check('pickup visits observe durable KOT completion', /onDocumentUpdated[\s\S]*kotItems\/\{kotId\}/.test(functionsIndex));
check('settlement transition rechecks an already-served pickup', loyaltyBackend.includes('processOrderFulfillmentIfReady({ orderId, order: after, flags })'));
check('customer source and linked online order are both required', loyaltyBackend.includes("order?.source !== 'CUSTOMER_WEB'") && loyaltyBackend.includes('ONLINE_ORDER_LINK_MISMATCH'));
check('checkout and acceptance transactions contain no point-ledger writes', !razorpayBackend.includes('loyaltyPointLedger'));
check('native POS UI contains no loyalty integration', !/BOND Points|loyaltyPointLedger|getCustomerBondSummary/.test(posHome));
check('verified pay-at-counter identity is optional and server-derived', payAtCounterBackend.includes('verifiedCustomerUidForPhone(request, customerPhone)') && customerOrder.includes('submitCustomerOrderCallable = httpsCallable') && customerOrder.includes('customerFunctions,'));
check('customer ordering includes a compact BOND summary', customerOrder.includes('CustomerBondSummaryCard'));
check('checkout estimate is informational and server-confirmed', customerOrder.includes('Final points are confirmed by the server'));
/* INTEGRATION AMENDMENT (Claude, 2026-08-20). Stage 5 split My Orders into a data
   container (CustomerMyOrders.tsx) plus a presentational screen/row, so the markup this
   assertion was written against now lives in CustomerOrderCard.tsx. The INTENT is
   unchanged and still fully enforced: posted, server-sourced points are rendered in My
   Orders, and the client never estimates them.
     - the container forwards the server field (listMyOrders -> pointsEarned)
     - the row renders "You earned N BOND Points"
     - the value is gated on being a real number > 0, so null never renders */
const bondOrderCard = readFileSync('frontend/components/customer/CustomerOrderCard.tsx', 'utf8');
const bondOrdersScreen = readFileSync('frontend/components/customer/CustomerOrdersScreen.tsx', 'utf8');
check('My Orders uses posted pointsEarned data',
  bondOrderCard.includes('You earned {pointsEarned} BOND Points')
  && bondOrderCard.includes("typeof pointsEarned === 'number' && pointsEarned > 0")
  && bondOrdersScreen.includes('pointsEarned={order.pointsEarned ?? null}')
  && myOrders.includes("pointsEarned: typeof order.pointsEarned === 'number' ? order.pointsEarned : null"));
check(
  'customer router exposes BOND with explicit preview-only demo gating',
  customerApp.includes('CustomerBondDashboard')
    && bondLoyaltyUi.includes("import.meta.env.MODE === 'customer-preview'")
    && bondLoyaltyUi.includes("import.meta.env.VITE_FIREBASE_PROJECT_ID === 'coffee-bond-pos-preview'")
    && bondLoyaltyUi.includes("new URLSearchParams(search).get('bondDemo')")
    && bondPreviewUi.includes('explicitBondDemoKey(search)')
    && bondPreviewDisabledUi.includes('BOND_PREVIEW_ORDER = null')
    && customerViteConfig.includes("mode === 'customer-preview'")
    && customerViteConfig.includes("env.VITE_FIREBASE_PROJECT_ID === 'coffee-bond-pos-preview'")
    && customerViteConfig.includes("'@bond-preview'")
    && bondDashboard.includes('demoRequested')
    && bondDashboard.includes('isDemo && <section className="cb-bond-month">')
    && bondDashboard.includes('formatBondDate(state.summary.lastQualifyingActivityAt)')
    && (
      customerOrder.includes('explicitBondDemoKey(location.search)')
      || customerOrder.includes('explicitBondDemoKey(routerLocation.search)')
    )
    && myOrders.includes('explicitBondDemoKey(location.search)'),
);

for (const collection of ['loyaltyAccounts', 'loyaltyPointLedger', 'qualifyingVisitEvents', 'qualifyingVisitDays', 'clubMemberships', 'loyaltyShadowLogs']) {
  const start = rules.indexOf(`match /${collection}/`);
  const block = start >= 0 ? rules.slice(start, rules.indexOf('\n    }', start) + 6) : '';
  check(`${collection} denies all client writes`, /allow create, update, delete: if false;/.test(block));
}

console.log(`\nBOND loyalty policy, firewall, UI and static security tests passed: ${passed.length}/${passed.length}.`);
