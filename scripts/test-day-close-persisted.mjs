#!/usr/bin/env node
// G7.4: proves the CORRECTED RAZORPAY breakdown survives the round trip into the persisted
// dayClosings document - not just the in-memory helper. Writes the same payload shape
// DayClose.handleSave writes, then reads it back and reconciles in integer paise.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ID = 'demo-coffee-bond-g74';
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('BLOCKED: FIRESTORE_EMULATOR_HOST is required.'); process.exit(1); }
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

// Bundle the real Day Close aggregation so the test uses the SAME implementation the page does.
const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g74-')), 'dayclose.cjs');
const entry = path.join(path.dirname(bundle), 'entry.ts');
fs.writeFileSync(entry, "export { buildDayCloseSummary } from '" + path.resolve('frontend/lib/dayCloseTotals') + "';\nexport { calculateTotals, quantizeMoney } from '" + path.resolve('frontend/lib/posPricing') + "';\n");
execFileSync('npx', ['esbuild', entry, '--bundle', '--platform=node', '--format=cjs', '--outfile=' + bundle], { stdio: 'pipe' });
const { buildDayCloseSummary, calculateTotals, quantizeMoney } = require(bundle);

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const paise = (v) => Math.round(quantizeMoney(v) * 100);
const dayClosingId = (storeId, businessDate) => `${storeId}_${businessDate}`;

const B = calculateTotals([{ price: 299, quantity: 1, addOns: [], taxRate: 5 }], 10, 5);
const A = calculateTotals([{ price: 375, quantity: 1, addOns: [], taxRate: 5 }], 10, 5);
const STORE = 'GOLDEN_I';
const DATE = '2026-09-06';

const posOrder = (id, t, method) => ({
  id, orderNumber: id, storeId: STORE, status: 'COMPLETED', paymentStatus: 'PAID',
  paymentMethod: method, subtotal: t.subtotal, menuValue: t.subtotal,
  discountAmount: t.discountAmount, discountTotal: t.discountAmount, discount: t.discountAmount,
  taxableAmount: t.taxableAmount, taxTotal: t.taxTotal, gstTotal: t.taxTotal,
  grandTotal: t.grandTotal, paymentBreakdown: [{ method, amount: t.grandTotal }],
});
const gwOrder = (grandTotal) => ({ id: `GW-${grandTotal}`, paymentProvider: 'RAZORPAY', paymentStatus: 'PAID', linkedOrderId: null, grandTotal });

/** Mirrors DayClose.handleSave: same doc id, same field set, merge:false. */
async function saveClosing(label, orders, onlineOrders) {
  const summary = buildDayCloseSummary(orders, onlineOrders);
  const ref = db.collection('dayClosings').doc(dayClosingId(`${STORE}_${label}`, DATE));
  await ref.set({
    storeId: STORE, storeName: 'Golden I', businessDate: DATE,
    completedBillCount: summary.completedBillCount, voidedBillCount: summary.voidedBillCount,
    grossSales: summary.grossSales, voidedSales: summary.voidedSales, netSales: summary.netSales,
    gstTotal: summary.gstTotal, discountTotal: summary.discountTotal,
    paymentBreakdown: summary.paymentBreakdown, expectedCash: summary.expectedCash,
    grossPaymentsReceived: summary.grossPaymentsReceived,
    voidedPaymentTotal: summary.voidedPaymentTotal,
    refundedOrReversedPayments: summary.refundedOrReversedPayments,
    refundPendingPayments: summary.refundPendingPayments,
    manualRefundRequiredPayments: summary.manualRefundRequiredPayments,
    netCollections: summary.netCollections,
    actualCash: 0, cashVariance: 0, notes: '', closedBy: 'g74', closedByName: 'QA',
    closedByEmail: null, closedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'CLOSED',
  }, { merge: false });
  return { summary, stored: (await ref.get()).data() };
}

// ---- ORIGINAL DEFECT FIXTURE, persisted -----------------------------------------------------
const defect = await saveClosing('defect', [posOrder('B', B, 'UPI')], [gwOrder(500)]);
eq(paise(defect.stored.paymentBreakdown.UPI), paise(282.56), 'PERSISTED: UPI = 282.56');
eq(paise(defect.stored.paymentBreakdown.RAZORPAY), paise(500), 'PERSISTED: RAZORPAY = 500.00 (the defect wrote 0 here)');
eq(paise(defect.stored.grossPaymentsReceived), paise(782.56), 'PERSISTED: grossPaymentsReceived = 782.56');
const storedBuckets = Object.values(defect.stored.paymentBreakdown).reduce((s, v) => s + paise(v), 0);
eq(storedBuckets, paise(782.56), 'PERSISTED: stored breakdown total = 782.56');
eq(storedBuckets - paise(defect.stored.grossPaymentsReceived), 0, 'PERSISTED: difference = 0.00');
eq(paise(defect.stored.paymentBreakdown.RAZORPAY), paise(defect.summary.paymentBreakdown.RAZORPAY), 'PERSISTED: stored value === in-memory value');

// ---- MIXED FIXTURE, persisted ------------------------------------------------------------------
const mixed = await saveClosing('mixed', [posOrder('R', A, 'RAZORPAY')], [gwOrder(500)]);
eq(paise(mixed.stored.paymentBreakdown.RAZORPAY), paise(854.38), 'PERSISTED MIXED: RAZORPAY = 854.38 (354.38 POS + 500.00 gateway)');
const mixedBuckets = Object.values(mixed.stored.paymentBreakdown).reduce((s, v) => s + paise(v), 0);
eq(mixedBuckets, paise(mixed.stored.grossPaymentsReceived), 'PERSISTED MIXED: buckets reconcile to grossPaymentsReceived');

// ---- CASE A / B, persisted ----------------------------------------------------------------------
const caseA = await saveClosing('caseA', [posOrder('B', B, 'UPI')], []);
eq(paise(caseA.stored.paymentBreakdown.RAZORPAY), 0, 'PERSISTED CASE A: RAZORPAY = 0');
const caseB = await saveClosing('caseB', [posOrder('R', A, 'RAZORPAY')], []);
eq(paise(caseB.stored.paymentBreakdown.RAZORPAY), paise(354.38), 'PERSISTED CASE B: RAZORPAY = 354.38');
for (const [label, c] of [['A', caseA], ['B', caseB]]) {
  const b = Object.values(c.stored.paymentBreakdown).reduce((s, v) => s + paise(v), 0);
  eq(b, paise(c.stored.grossPaymentsReceived), `PERSISTED CASE ${label}: buckets reconcile`);
}

// ---- every persisted money field is canonical 2dp ------------------------------------------------
const moneyFields = ['grossSales', 'voidedSales', 'netSales', 'gstTotal', 'discountTotal', 'expectedCash', 'grossPaymentsReceived', 'netCollections'];
for (const f of moneyFields) {
  const v = mixed.stored[f];
  assert.ok(Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, `persisted ${f} is not 2dp: ${v}`);
}
n += 1; console.log(`PASS ${n}. PERSISTED: every money field on the stored document is canonical 2dp`);
for (const [m, v] of Object.entries(mixed.stored.paymentBreakdown)) {
  assert.ok(Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, `persisted paymentBreakdown.${m} not 2dp: ${v}`);
  assert.ok(Number.isFinite(v), `persisted paymentBreakdown.${m} is not finite: ${v}`);
}
n += 1; console.log(`PASS ${n}. PERSISTED: every tender bucket is finite and canonical 2dp (no NaN reaches Firestore)`);

console.log(`\n${n} persisted day close reconciliation checks passed.`);
