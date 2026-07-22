import fs from 'node:fs';
import path from 'node:path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const REPORT_DIR = path.resolve('reports');
const JSON_PATH = path.join(REPORT_DIR, 'complimentary-order-repair-dry-run.json');
const CSV_PATH = path.join(REPORT_DIR, 'complimentary-order-repair-dry-run.csv');

if (process.argv.includes('--apply')) {
  console.error('This audit is read-only. --apply is not supported and no Firestore writes were attempted.');
  process.exit(1);
}

function credential() {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) return applicationDefault();
  const serviceAccount = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  return cert(serviceAccount);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function isComplimentary(data) {
  if (data.commercialStatus === 'COMPLIMENTARY' || data.paymentMethod === 'COMPLIMENTARY') return true;
  return Array.isArray(data.paymentBreakdown)
    && data.paymentBreakdown.some((payment) => payment?.method === 'COMPLIMENTARY');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

if (getApps().length === 0) {
  initializeApp({ credential: credential(), projectId: PROJECT_ID });
}

const db = getFirestore();
const ordersSnapshot = await db.collection('orders').get();
const candidateOrders = ordersSnapshot.docs.filter((orderDoc) => isComplimentary(orderDoc.data()));

const orders = await Promise.all(candidateOrders.map(async (orderDoc) => {
  const data = orderDoc.data();
  const paymentsSnapshot = await orderDoc.ref.collection('payments').get();
  const paymentRows = paymentsSnapshot.docs.map((paymentDoc) => paymentDoc.data());
  const paymentAmount = number(paymentRows.reduce((sum, payment) => sum + number(payment.amount), 0));
  const taxableAmount = number(data.taxableAmount ?? (number(data.subtotal) - number(data.discountAmount ?? data.discountTotal ?? data.discount)));
  const gstTotal = number(data.gstTotal ?? data.taxTotal);
  const grandTotal = number(data.grandTotal);

  return {
    orderPath: orderDoc.ref.path,
    orderNumber: data.orderNumber || orderDoc.id,
    storeId: data.storeId || null,
    orderStatus: data.status || 'COMPLETED',
    commercialStatus: data.commercialStatus || 'LEGACY_COMPLIMENTARY_TENDER',
    paymentStatus: data.paymentStatus || null,
    paymentMethod: data.paymentMethod || null,
    menuValue: number(data.menuValue ?? data.subtotal),
    taxableAmount,
    gstTotal,
    grandTotal,
    paymentRecordCount: paymentRows.length,
    paymentRecordAmount: paymentAmount,
    incorrectSalesContribution: grandTotal,
    incorrectTaxableContribution: taxableAmount,
    incorrectGstContribution: gstTotal,
    proposedRepair: {
      commercialStatus: 'COMPLIMENTARY',
      paymentStatus: 'NOT_REQUIRED',
      taxableAmount: 0,
      gstTotal: 0,
      grandTotal: 0,
      paymentRecords: 'REVIEW_ONLY_DO_NOT_DELETE_AUTOMATICALLY',
    },
  };
}));

const totals = orders.reduce((summary, order) => {
  summary.legacyOrderCount += 1;
  summary.incorrectSalesContribution += order.incorrectSalesContribution;
  summary.incorrectTaxableContribution += order.incorrectTaxableContribution;
  summary.incorrectGstContribution += order.incorrectGstContribution;
  summary.paymentRecordCount += order.paymentRecordCount;
  summary.paymentRecordAmount += order.paymentRecordAmount;
  return summary;
}, {
  legacyOrderCount: 0,
  incorrectSalesContribution: 0,
  incorrectTaxableContribution: 0,
  incorrectGstContribution: 0,
  paymentRecordCount: 0,
  paymentRecordAmount: 0,
});

const report = {
  mode: 'DRY_RUN_READ_ONLY',
  projectId: PROJECT_ID,
  generatedAt: new Date().toISOString(),
  firestoreWrites: 0,
  summary: totals,
  orders,
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);

const columns = [
  'orderPath',
  'orderNumber',
  'storeId',
  'orderStatus',
  'commercialStatus',
  'paymentStatus',
  'paymentMethod',
  'menuValue',
  'taxableAmount',
  'gstTotal',
  'grandTotal',
  'paymentRecordCount',
  'paymentRecordAmount',
  'incorrectSalesContribution',
];
const csv = [
  columns.join(','),
  ...orders.map((order) => columns.map((column) => csvCell(order[column])).join(',')),
].join('\n');
fs.writeFileSync(CSV_PATH, `${csv}\n`);

console.log(JSON.stringify({
  mode: report.mode,
  firestoreWrites: report.firestoreWrites,
  legacyOrdersFound: totals.legacyOrderCount,
  incorrectSalesContribution: totals.incorrectSalesContribution,
  incorrectGstContribution: totals.incorrectGstContribution,
  jsonReport: JSON_PATH,
  csvReport: CSV_PATH,
}, null, 2));
