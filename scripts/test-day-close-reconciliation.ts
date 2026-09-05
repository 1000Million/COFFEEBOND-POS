// G7.3 PART A: runtime proof that Day Close, reporting and the reversal audit reconcile to the
// SAME canonical paise for persisted orders, including after a void.
// PART B: drift guard proving the four surviving money helpers are no-ops on canonical values.
// Every assertion calls the REAL implementation each surface uses. No arithmetic is re-derived.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildDayCloseSummary, moneyNumber } from '../frontend/lib/dayCloseTotals';
import { buildPaymentReversalAudit, summarizeCollections, money as reversalMoney } from '../frontend/lib/paymentReversal';
import { calculateTotals, quantizeMoney } from '../frontend/lib/posPricing';
import { money as reportingMoney, summarizeReportingRecords } from '../functions/reportingCore.mjs';
import { financialNumber } from '../frontend/lib/financialNumber';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };
/** Compare in integer paise - never accept a float residual as reconciliation. */
const paise = (v: number) => Math.round(quantizeMoney(v) * 100);

// ---- canonical totals from the REAL pricing helper ------------------------------------------
const totalsFor = (price: number, pct: number) =>
  calculateTotals([{ price, quantity: 1, addOns: [], taxRate: 5 }], pct, 5);
const A = totalsFor(375, 10);
const B = totalsFor(299, 10);
const C = totalsFor(333, 10);
eq(A.grandTotal, 354.38, 'FIXTURE A: Rs375 @10% -> canonical 354.38');
eq(B.grandTotal, 282.56, 'FIXTURE B: Rs299 @10% -> canonical 282.56');
eq(C.grandTotal, 314.69, 'FIXTURE C: Rs333 @10% -> canonical 314.69');

// ---- persisted-order shaped fixtures ---------------------------------------------------------
type AnyOrder = Record<string, unknown>;
const order = (id: string, t: typeof A, payments: { method: string; amount: number }[], status = 'COMPLETED'): AnyOrder => ({
  id, orderNumber: id, storeId: 'GOLDEN_I', status,
  paymentStatus: 'PAID', paymentMethod: payments.length === 1 ? payments[0].method : 'SPLIT',
  isSplitPayment: payments.length > 1,
  subtotal: t.subtotal, menuValue: t.subtotal,
  discountAmount: t.discountAmount, discountTotal: t.discountAmount, discount: t.discountAmount,
  discountPercent: t.discountPercent,
  taxableAmount: t.taxableAmount, taxTotal: t.taxTotal, gstTotal: t.taxTotal,
  grandTotal: t.grandTotal,
  paymentBreakdown: payments.map(p => ({ method: p.method, amount: p.amount })),
  createdAt: { toMillis: () => 1_700_000_000_000 },
});
const splitC = [{ method: 'CASH', amount: 200 }, { method: 'UPI', amount: quantizeMoney(C.grandTotal - 200) }];
eq(splitC[1].amount, 114.69, 'FIXTURE C: split remainder is exactly 114.69');
eq(paise(splitC[0].amount + splitC[1].amount), paise(C.grandTotal), 'FIXTURE C: split components total the canonical payable in paise');

const oA = order('A', A, [{ method: 'CASH', amount: A.grandTotal }]);
const oB = order('B', B, [{ method: 'UPI', amount: B.grandTotal }]);
const oC = order('C', C, splitC);

// ---- PRE-VOID: Day Close vs reporting -----------------------------------------------------------
const pre = buildDayCloseSummary([oA, oB, oC] as never, [] as never);
const preMetrics = summarizeReportingRecords([oA, oB, oC].map(o => ({ order: o, items: [], payments: [] })));
const expectedGross = paise(A.grandTotal) + paise(B.grandTotal) + paise(C.grandTotal);
eq(paise(pre.netSales), expectedGross, `PRE-VOID: Day Close netSales === sum of canonical payables (${expectedGross} paise)`);
eq(paise(pre.netSales), paise(preMetrics.netSales), 'PRE-VOID: Day Close === reporting netSales (same paise)');
eq(pre.completedBillCount, 3, 'PRE-VOID: 3 completed bills');
eq(paise(pre.gstTotal), paise(A.taxTotal) + paise(B.taxTotal) + paise(C.taxTotal), 'PRE-VOID: GST total reconciles in paise');
eq(paise(pre.discountTotal), paise(A.discountAmount) + paise(B.discountAmount) + paise(C.discountAmount), 'PRE-VOID: discount total reconciles in paise');

// ---- PAYMENT SUMMARY -----------------------------------------------------------------------------
eq(paise(pre.paymentBreakdown.CASH), paise(A.grandTotal) + paise(200), 'PAYMENT: CASH = A full + C cash leg');
eq(paise(pre.paymentBreakdown.UPI), paise(B.grandTotal) + paise(114.69), 'PAYMENT: UPI = B full + C UPI leg');
eq(paise(pre.expectedCash), paise(pre.paymentBreakdown.CASH), 'PAYMENT: expectedCash === CASH breakdown');
const tenderSum = Object.values(pre.paymentBreakdown).reduce((s, v) => s + paise(v), 0);
eq(tenderSum, expectedGross, 'PAYMENT: every tender bucket sums to gross sales, to the paise');

// ---- VOID A ---------------------------------------------------------------------------------------
const oAVoid = { ...oA, status: 'VOIDED', voidReason: 'QA void', paymentReversalTotal: A.grandTotal };
const post = buildDayCloseSummary([oAVoid, oB, oC] as never, [] as never);
const expectedNet = paise(B.grandTotal) + paise(C.grandTotal);
eq(paise(post.netSales), expectedNet, `POST-VOID: netSales === B + C (${expectedNet} paise)`);
eq(paise(post.voidedSales), paise(A.grandTotal), 'POST-VOID: voidedSales === A canonical payable');
eq(post.voidedBillCount, 1, 'POST-VOID: exactly one voided bill');
eq(post.completedBillCount, 2, 'POST-VOID: two completed bills remain');
eq(paise(post.netSales) + paise(post.voidedSales), expectedGross, 'POST-VOID: net + voided === original gross, no paise lost');
eq(paise(post.paymentBreakdown.CASH), paise(200), 'POST-VOID: only C cash leg remains in CASH');
eq(paise(post.paymentBreakdown.UPI), paise(B.grandTotal) + paise(114.69), 'POST-VOID: UPI unchanged');

// ---- REVERSAL AUDIT: the real implementation the void writer uses ------------------------------------
const rev = buildPaymentReversalAudit(oAVoid as never, (oA.paymentBreakdown as never));
eq(paise(rev.paymentReversalTotal), paise(A.grandTotal), 'REVERSAL: reversal total === original canonical payable');
eq(paise(rev.netCollectionAmount), 0, 'REVERSAL: net collection is exactly 0 paise');
eq(
  paise(rev.refundedAmount) + paise(rev.reversedAmount) + paise(rev.refundPendingAmount) + paise(rev.manualRefundRequiredAmount),
  paise(rev.paymentReversalTotal),
  'REVERSAL: the four buckets partition the total exactly',
);
eq(paise(A.grandTotal) - paise(rev.paymentReversalTotal), 0, 'VOID_REVERSAL_NET: sale - reversal === 0 paise');

// ---- AUDIT CONTROL: its one exported aggregate ---------------------------------------------------------
const collections = summarizeCollections([oAVoid, oB, oC] as never);
ok(collections && typeof collections === 'object', 'AUDIT: summarizeCollections returns a summary for the same order set');
eq(paise(collections.grossPaymentsReceived), expectedGross, 'AUDIT: grossPaymentsReceived === original gross in paise');
eq(paise(collections.netCollections), expectedNet, 'AUDIT: netCollections === B + C, matching Day Close netSales');
eq(paise(collections.netCollections), paise(post.netSales), 'AUDIT: Audit Control netCollections === Day Close netSales (same paise)');

// ---- PART B: money helper drift guard ------------------------------------------------------------------
const CANONICAL = [0, 0.01, 1.01, 2.68, 16.88, 210.35, 282.56, 305.03, 314.69, 354.38, 999.99, -1.01, -16.88, -354.38];
const helpers: [string, (v: number) => number][] = [
  ['reportingCore.money', reportingMoney],
  ['paymentReversal.money', reversalMoney],
  ['financialNumber (shared by RunningOrders + Day Close)', financialNumber],
  ['dayCloseTotals.moneyNumber', moneyNumber],
];
for (const [name, fn] of helpers) {
  for (const v of CANONICAL) {
    assert.equal(fn(v), v, `${name} drifted on canonical ${v}: got ${fn(v)}`);
  }
  n += 1; console.log(`PASS ${n}. DRIFT GUARD: ${name} is a no-op on all ${CANONICAL.length} canonical values`);
}
// posRazorpay is CommonJS and declares Firebase params at module scope, so it is exercised in a
// separate node process rather than bundled into this test.
const rzpProbe = `
const { roundMoney } = require(${JSON.stringify(path.resolve('functions/posRazorpay.js'))});
const canonical = ${JSON.stringify(CANONICAL)};
const drifted = canonical.filter(v => roundMoney(v) !== v);
process.stdout.write(JSON.stringify(drifted));
`;
const rzpDrifted = JSON.parse(execFileSync('node', ['-e', rzpProbe], { encoding: 'utf8' }));
eq(rzpDrifted, [], 'DRIFT GUARD: posRazorpay.roundMoney is a no-op on all canonical values');

// quantizeMoney must also be idempotent - it is the producer of these values.
for (const v of CANONICAL) assert.equal(quantizeMoney(v), v, `quantizeMoney not idempotent on ${v}`);
n += 1; console.log(`PASS ${n}. DRIFT GUARD: quantizeMoney is idempotent on every canonical value`);

// ---- G7.4: RAZORPAY breakdown reconciliation (was the G7.3 defect) ----------------------------
// reportingCore seeds paymentBreakdown as {} and only adds keys for methods actually paid, so the
// POS term must be coerced BEFORE gatewayGross is added. Four cases, no double counting.
const gwOrder = (grandTotal: number, paymentStatus = 'PAID'): AnyOrder => ({
  id: `GW-${grandTotal}-${paymentStatus}`, paymentProvider: 'RAZORPAY', paymentStatus,
  linkedOrderId: null, grandTotal,
});
const rzpPos = order('R', A, [{ method: 'RAZORPAY', amount: A.grandTotal }]);
const bucketOf = (orders: AnyOrder[], online: AnyOrder[]) =>
  buildDayCloseSummary(orders as never, online as never);

// CASE A - no POS Razorpay, no gateway
const caseA = bucketOf([oB], []);
eq(paise(caseA.paymentBreakdown.RAZORPAY), 0, 'CASE A: no POS Razorpay + no gateway -> RAZORPAY 0');

// CASE B - POS Razorpay only
const caseB = bucketOf([rzpPos], []);
eq(paise(caseB.paymentBreakdown.RAZORPAY), paise(A.grandTotal), 'CASE B: POS Razorpay only -> RAZORPAY 354.38');

// CASE C - gateway only (the original defect condition)
const caseC = bucketOf([oB], [gwOrder(500)]);
eq(paise(caseC.paymentBreakdown.RAZORPAY), paise(500), 'CASE C: gateway only -> RAZORPAY 500.00 (was 0 before the fix)');

// CASE D - both, added exactly once
const caseD = bucketOf([rzpPos], [gwOrder(500)]);
eq(paise(caseD.paymentBreakdown.RAZORPAY), paise(A.grandTotal) + paise(500), 'CASE D: POS Razorpay + gateway -> RAZORPAY 854.38');
eq(paise(caseD.paymentBreakdown.RAZORPAY), paise(854.38), 'CASE D: MIXED fixture expects exactly 854.38');
ok(paise(caseD.paymentBreakdown.RAZORPAY) !== paise(A.grandTotal) + paise(1000), 'CASE D: gatewayGross counted ONCE, not twice');

// Every case must reconcile: tender buckets === grossPaymentsReceived, to the paise.
for (const [label, sum] of [['A', caseA], ['B', caseB], ['C', caseC], ['D', caseD]] as [string, typeof caseA][]) {
  const buckets = Object.values(sum.paymentBreakdown).reduce((acc, v) => acc + paise(v), 0);
  eq(buckets, paise(sum.grossPaymentsReceived), `CASE ${label}: tender buckets === grossPaymentsReceived (${buckets} paise)`);
}

// ORIGINAL DEFECT FIXTURE - now asserted as PREVENTED, not reproduced.
const fixed = bucketOf([oB], [gwOrder(500)]);
const fixedBuckets = Object.values(fixed.paymentBreakdown).reduce((acc, v) => acc + paise(v), 0);
eq(paise(fixed.paymentBreakdown.UPI), paise(282.56), 'DEFECT PREVENTED: UPI = 282.56');
eq(paise(fixed.paymentBreakdown.RAZORPAY), paise(500), 'DEFECT PREVENTED: RAZORPAY = 500.00');
eq(paise(fixed.grossPaymentsReceived), paise(782.56), 'DEFECT PREVENTED: grossPaymentsReceived = 782.56');
eq(fixedBuckets, paise(782.56), 'DEFECT PREVENTED: breakdown total = 782.56');
eq(fixedBuckets - paise(fixed.grossPaymentsReceived), 0, 'DEFECT PREVENTED: difference = 0.00 (was a 50000 paise hole)');

// Refund/pending gateway states must not disturb the bucket identity either.
const caseRefunded = bucketOf([oB], [gwOrder(500, 'REFUNDED')]);
eq(paise(caseRefunded.paymentBreakdown.RAZORPAY), paise(500), 'GATEWAY REFUNDED: still counted in the RAZORPAY tender bucket');
eq(
  Object.values(caseRefunded.paymentBreakdown).reduce((acc, v) => acc + paise(v), 0),
  paise(caseRefunded.grossPaymentsReceived),
  'GATEWAY REFUNDED: buckets still reconcile to grossPaymentsReceived',
);
eq(paise(caseRefunded.netCollections), paise(oB.grandTotal as number), 'GATEWAY REFUNDED: netCollections excludes the refunded gateway money');

console.log(`\n${n} day close reconciliation + drift guard checks passed.`);
