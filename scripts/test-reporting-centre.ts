import fs from 'node:fs';
import path from 'node:path';
import {
  REPORT_REGISTRY,
  assignedStoreIds,
  buildFranchiseDailyDataset,
  buildReportDataset,
  maskIndianMobile,
  roleCanAccessReport,
  summarizeReportingRecords,
} from '../functions/reportingCore.mjs';
import { buildReportingCsv, buildReportingSheetRows } from '../frontend/lib/reportExports';
import type { ReportingResponse } from '../frontend/lib/reporting';

const passed: string[] = [];
const failures: string[] = [];

function test(name: string, condition: boolean) {
  if (condition) passed.push(name);
  else failures.push(name);
}

const createdAt = new Date('2026-07-24T06:30:00.000Z');
const secondDay = new Date('2026-07-23T10:30:00.000Z');

function record(order: Record<string, unknown>, items: Record<string, unknown>[] = [], payments: Record<string, unknown>[] = []) {
  return { order, items, payments };
}

const records = [
  record({
    id: 'paid-split',
    orderNumber: 'CB-GOLDEN_I-1001',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    storeCode: 'GOLDEN_I',
    createdByUserId: 'secret-staff-uid',
    createdByName: 'Golden Cashier',
    createdByEmail: 'cashier@private.example',
    createdByRole: 'CASHIER',
    customerName: 'Private Customer',
    customerPhone: '9999999999',
    orderType: 'DINE_IN',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    isSplitPayment: true,
    subtotal: 350,
    discountAmount: 35,
    taxableAmount: 315,
    gstTotal: 15.75,
    grandTotal: 330.75,
    discountReason: 'Launch offer',
    createdAt,
  }, [{
    id: 'line-1',
    itemCode: 'CAPPUCCINO',
    itemName: 'Cappuccino',
    categoryName: 'Coffee',
    categoryId: 'COFFEE',
    quantity: 1,
    baseUnitPrice: 250,
    unitPrice: 350,
    lineSubtotal: 350,
    lineDiscount: 35,
    lineTaxable: 315,
    lineTax: 15.75,
    lineTotal: 330.75,
    taxRate: 5,
    prepStation: 'BARISTA',
    status: 'SERVED',
    tags: ['Coffee'],
    addOns: [{
      groupId: 'beverage_add_on',
      groupName: 'Beverage Add On',
      optionId: 'OAT_MILK',
      optionName: 'Oat Milk',
      quantity: 1,
      unitPrice: 100,
      totalPrice: 100,
      taxRate: 5,
      inventoryTrackingStatus: 'NOT_CONFIGURED',
    }],
  }], [
    { method: 'CASH', amount: 100 },
    { method: 'UPI', amount: 230.75 },
  ]),
  record({
    id: 'paid-online',
    orderNumber: 'CB-UDAY_PARK-1002',
    storeId: 'UDAY_PARK',
    storeName: 'Uday Park',
    createdByName: 'Uday Cashier',
    orderType: 'TAKEAWAY',
    source: 'CUSTOMER_WEB',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentMethod: 'UPI',
    subtotal: 200,
    taxableAmount: 200,
    gstTotal: 10,
    grandTotal: 210,
    createdAt: secondDay,
  }, [{
    itemCode: 'AFFOGATO',
    itemName: 'Affogato',
    categoryName: 'Coffee',
    quantity: 1,
    unitPrice: 200,
    lineSubtotal: 200,
    lineTaxable: 200,
    lineTax: 10,
    lineTotal: 210,
    prepStation: 'BARISTA',
    status: 'SERVED',
  }], [{ method: 'UPI', amount: 210 }]),
  record({
    id: 'complimentary',
    orderNumber: 'CB-GOLDEN_I-COMP',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    createdByName: 'Golden Manager',
    orderType: 'DINE_IN',
    status: 'COMPLETED',
    commercialStatus: 'COMPLIMENTARY',
    paymentStatus: 'NOT_REQUIRED',
    paymentMethod: 'COMPLIMENTARY',
    customerName: 'Complimentary Guest',
    customerPhone: '9876543210',
    subtotal: 225,
    menuValue: 225,
    complimentaryDiscount: 225,
    complimentaryReason: 'Owner approved tasting',
    complimentaryOtpProvider: 'FIREBASE_PHONE_AUTH',
    complimentaryOtpVerified: true,
    complimentaryOtpCode: '123456',
    complimentaryAuthorizationId: 'private-auth-id',
    complimentaryAuthorisedByName: 'Golden Manager',
    taxableAmount: 0,
    gstTotal: 0,
    grandTotal: 0,
    cogsTotal: 70,
    createdAt,
  }, [{
    itemCode: 'CAPPUCCINO',
    itemName: 'Cappuccino',
    categoryName: 'Coffee',
    quantity: 1,
    unitPrice: 225,
    lineSubtotal: 225,
    lineTaxable: 0,
    lineTax: 0,
    lineTotal: 0,
    prepStation: 'BARISTA',
    status: 'SERVED',
  }]),
  record({
    id: 'voided',
    orderNumber: 'CB-GOLDEN_I-VOID',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    createdByName: 'Golden Cashier',
    orderType: 'TAKEAWAY',
    status: 'VOIDED',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    subtotal: 100,
    taxableAmount: 100,
    gstTotal: 5,
    grandTotal: 105,
    paymentReversalStatus: 'REFUNDED',
    paymentReversalTotal: 105,
    paymentReversalBreakdown: [{
      method: 'CASH',
      originalAmount: 105,
      amount: 105,
      reversalStatus: 'REFUNDED',
      reason: 'Cash returned',
    }],
    voidReason: 'Test bill',
    voidedByName: 'Golden Manager',
    stockMovementCount: 2,
    createdAt,
  }, [{
    itemCode: 'LATTE',
    itemName: 'Latte',
    categoryName: 'Coffee',
    quantity: 1,
    unitPrice: 100,
    lineSubtotal: 100,
    lineTaxable: 100,
    lineTax: 5,
    lineTotal: 105,
    prepStation: 'BARISTA',
    status: 'PENDING',
    addOns: [{
      groupId: 'beverage_add_on',
      groupName: 'Beverage Add On',
      optionId: 'OAT_MILK',
      optionName: 'Oat Milk',
      quantity: 1,
      unitPrice: 50,
      totalPrice: 50,
      taxRate: 5,
      inventoryTrackingStatus: 'NOT_CONFIGURED',
    }],
  }], [{ method: 'CASH', amount: 105 }]),
  record({
    id: 'unpaid',
    orderNumber: 'CB-GOLDEN_I-UNPAID',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    createdByName: 'Golden Cashier',
    orderType: 'PAY_AT_COUNTER',
    status: 'COMPLETED',
    paymentStatus: 'UNPAID',
    paymentMethod: 'PAY_AT_COUNTER',
    subtotal: 50,
    taxableAmount: 50,
    gstTotal: 2.5,
    grandTotal: 52.5,
    createdAt,
  }),
];

const metrics = summarizeReportingRecords(records);
test('paid sales exclude voided and complimentary orders', metrics.netSales === 540.75 && metrics.orderCount === 2);
test('complimentary values remain separate', metrics.complimentaryOrderCount === 1 && metrics.complimentaryMenuValue === 225 && metrics.complimentaryCogs === 70);
test('voided values remain separate', metrics.voidOrderCount === 1 && metrics.voidedOrderValue === 105);
test('payment reversals reduce net collections', metrics.grossPaymentsReceived === 645.75 && metrics.voidedPaymentTotal === 105 && metrics.netCollections === 540.75);
test('split payments reconcile exactly', metrics.paymentBreakdown.CASH === 100 && metrics.paymentBreakdown.UPI === 440.75);
test('GST matches completed commercial order values', metrics.gstCollected === 25.75);
test('unpaid orders are separated from commercial sales', metrics.unpaidOrderCount === 1 && metrics.unpaidAmount === 52.5);

const addOnReport = buildReportDataset('addon-sales', records);
test('add-on values are included in commercial reporting', addOnReport.rows.length === 1 && addOnReport.rows[0].grossValue === 100);
test('add-on sales exclude voided orders', addOnReport.rows[0].quantity === 1 && addOnReport.rows[0].netSales === 94.5);

const itemReport = buildReportDataset('order-item-wise', records);
const commercialItemTotals = itemReport.rows
  .filter((row: any) => ['CB-GOLDEN_I-1001', 'CB-UDAY_PARK-1002'].includes(row.orderNumber))
  .reduce((sum: number, row: any) => sum + row.lineTotal, 0);
test('item totals reconcile with paid order totals', commercialItemTotals === metrics.netSales);
const invoiceDetails = buildReportDataset('item-invoice-details', records);
const splitInvoiceTotal = invoiceDetails.rows
  .filter((row: any) => row.orderNumber === 'CB-GOLDEN_I-1001')
  .reduce((sum: number, row: any) => sum + row.total, 0);
test('invoice item and add-on lines reconcile to the parent invoice', splitInvoiceTotal === 330.75);

const dayWise = buildReportDataset('all-restaurant-day-wise', records);
test('day-wise totals reconcile to all-restaurant totals', dayWise.rows.reduce((sum: number, row: any) => sum + row.netSales, 0) === metrics.netSales);
test('store comparison produces only represented stores', buildReportDataset('outlet-comparison', records).rows.length === 2);

test('Admin can access all internal reports', REPORT_REGISTRY.every(report => report.allowedRoles.includes('ADMIN')));
test('registry contains all 29 requested reports in six groups', REPORT_REGISTRY.length === 29 && new Set(REPORT_REGISTRY.map(report => report.group)).size === 6);
test('Manager can access assigned-store reporting catalogue', roleCanAccessReport('STORE_MANAGER', 'orders-master'));
test('Cashier receives only basic approved reports', roleCanAccessReport('CASHIER', 'all-restaurant-sales') && roleCanAccessReport('CASHIER', 'payment-collection') && !roleCanAccessReport('CASHIER', 'orders-master'));
test('Franchise Viewer cannot access internal Reports Centre', !roleCanAccessReport('FRANCHISE_VIEWER', 'all-restaurant-sales'));
test('assigned store aliases are deduplicated', assignedStoreIds({ assignedStoreIds: ['GOLDEN_I', 'GOLDEN_I'] }).length === 1);
test('customer phones are masked', maskIndianMobile('9999999999') === '99******99');

const masterReport = buildReportDataset('orders-master', records);
const serializedMaster = JSON.stringify(masterReport.rows);
test('staff UID and email are never returned', !serializedMaster.includes('secret-staff-uid') && !serializedMaster.includes('cashier@private.example'));
test('orders master includes only masked customer phone', serializedMaster.includes('99******99') && !serializedMaster.includes('9999999999'));

const billerReport = buildReportDataset('day-sales-biller-wise', records);
test('biller report uses display name only', billerReport.rows.some((row: any) => row.staff === 'Golden Cashier') && !JSON.stringify(billerReport.rows).includes('createdByUserId'));

const discountReport = buildReportDataset('discounted-orders-with-reason', records);
test('discount report preserves stored reason', discountReport.rows.length === 1 && discountReport.rows[0].reason === 'Launch offer');

const discountRegressionRecords = [
  record({
    id: 'zero-discount-with-reason',
    orderNumber: 'CB-GOLDEN_I-ZERO-REASON',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    subtotal: 225,
    discountAmount: 0,
    discountTotal: 0,
    discount: 225,
    discountReason: 'Stale reason must not qualify',
    taxableAmount: 225,
    gstTotal: 11.25,
    grandTotal: 236.25,
    createdAt,
  }, [{
    itemCode: 'CAPPUCCINO',
    itemName: 'Cappuccino',
    quantity: 1,
    unitPrice: 225,
    lineSubtotal: 225,
    lineDiscount: 0,
    lineTaxable: 225,
    lineTax: 11.25,
    lineTotal: 236.25,
  }]),
  record({
    id: 'zero-discount-percent',
    orderNumber: 'CB-GOLDEN_I-ZERO-PERCENT',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    subtotal: 200,
    discountPercent: 0,
    discountAmount: 0,
    taxableAmount: 200,
    gstTotal: 10,
    grandTotal: 210,
    createdAt,
  }, [{
    itemCode: 'AFFOGATO',
    itemName: 'Affogato',
    quantity: 1,
    unitPrice: 200,
    lineSubtotal: 200,
    lineDiscount: 0,
    lineTaxable: 200,
    lineTax: 10,
    lineTotal: 210,
  }]),
  record({
    id: 'positive-discount',
    orderNumber: 'CB-GOLDEN_I-POSITIVE',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    subtotal: 250,
    discountAmount: 25,
    discountReason: 'Approved offer',
    taxableAmount: 225,
    gstTotal: 11.25,
    grandTotal: 236.25,
    createdAt,
  }, [{
    itemCode: 'HOT_LATTE',
    itemName: 'Hot Latte',
    quantity: 1,
    unitPrice: 250,
    lineSubtotal: 250,
    lineDiscount: 25,
    lineTaxable: 225,
    lineTax: 11.25,
    lineTotal: 236.25,
  }]),
  record({
    id: 'voided-discount',
    orderNumber: 'CB-GOLDEN_I-VOID-DISCOUNT',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    status: 'VOIDED',
    paymentStatus: 'PAID',
    subtotal: 250,
    discountAmount: 25,
    discountReason: 'Voided offer',
    taxableAmount: 225,
    gstTotal: 11.25,
    grandTotal: 236.25,
    createdAt,
  }, [{
    itemCode: 'HOT_LATTE',
    itemName: 'Hot Latte',
    quantity: 1,
    unitPrice: 250,
    lineSubtotal: 250,
    lineDiscount: 25,
    lineTaxable: 225,
    lineTax: 11.25,
    lineTotal: 236.25,
  }]),
  record({
    id: 'complimentary-discount',
    orderNumber: 'CB-GOLDEN_I-COMP-DISCOUNT',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    status: 'COMPLETED',
    commercialStatus: 'COMPLIMENTARY',
    paymentStatus: 'NOT_REQUIRED',
    paymentMethod: 'COMPLIMENTARY',
    subtotal: 225,
    menuValue: 225,
    complimentaryDiscount: 225,
    discountAmount: 225,
    taxableAmount: 0,
    gstTotal: 0,
    grandTotal: 0,
    createdAt,
  }, [{
    itemCode: 'CAPPUCCINO',
    itemName: 'Cappuccino',
    quantity: 1,
    unitPrice: 225,
    lineSubtotal: 225,
    lineDiscount: 225,
    lineTaxable: 0,
    lineTax: 0,
    lineTotal: 0,
  }]),
];
const detailedDiscountRegression = buildReportDataset('discount-report', discountRegressionRecords);
const orderDiscountRegression = buildReportDataset('discounted-orders-with-reason', discountRegressionRecords);
test(
  'zero discount with a reason is excluded',
  !JSON.stringify(orderDiscountRegression.rows).includes('CB-GOLDEN_I-ZERO-REASON'),
);
test(
  'zero discount percent is excluded',
  !JSON.stringify(orderDiscountRegression.rows).includes('CB-GOLDEN_I-ZERO-PERCENT'),
);
test(
  'a real positive monetary discount is included',
  orderDiscountRegression.rows.length === 1
    && orderDiscountRegression.rows[0].orderNumber === 'CB-GOLDEN_I-POSITIVE'
    && orderDiscountRegression.rows[0].discountAmount === 25,
);
test(
  'voided and complimentary discounts are excluded from commercial discount rows',
  detailedDiscountRegression.rows.length === 1
    && detailedDiscountRegression.rows[0].orderNumber === 'CB-GOLDEN_I-POSITIVE',
);
test(
  'discount report totals reconcile with canonical commercial sales calculations',
  detailedDiscountRegression.summary.discounts === 25
    && orderDiscountRegression.summary.discounts === 25,
);
const discountExport = {
  report: REPORT_REGISTRY.find(report => report.reportId === 'discount-report'),
  summary: detailedDiscountRegression.summary,
  availabilityStatus: detailedDiscountRegression.availabilityStatus,
  unavailableReason: detailedDiscountRegression.unavailableReason,
  columns: detailedDiscountRegression.columns,
  rows: detailedDiscountRegression.rows,
  accessibleStores: [{ id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I' }],
  selectedStoreIds: ['GOLDEN_I'],
  startDate: '2026-07-24',
  endDate: '2026-07-24',
  timeZone: 'Asia/Kolkata',
  filters: { storeIds: ['GOLDEN_I'] },
  filterOptions: { sources: [], orderTypes: [], paymentMethods: [], staff: [], categories: [], items: [] },
  sourceOrderCount: discountRegressionRecords.length,
  generatedAt: createdAt.toISOString(),
  pagination: {
    page: 1,
    pageSize: 50,
    totalRows: detailedDiscountRegression.rows.length,
    totalPages: 1,
    hasNextPage: false,
  },
} as unknown as ReportingResponse;
const discountCsv = buildReportingCsv(discountExport);
const discountSheet = buildReportingSheetRows(discountExport);
test(
  'discount CSV and spreadsheet exports contain only positive commercial discount rows',
  discountCsv.includes('CB-GOLDEN_I-POSITIVE')
    && !discountCsv.includes('CB-GOLDEN_I-ZERO-REASON')
    && discountSheet.flat().includes('CB-GOLDEN_I-POSITIVE')
    && !discountSheet.flat().includes('CB-GOLDEN_I-VOID-DISCOUNT'),
);

const complimentaryReport = buildReportDataset('complimentary-orders', records);
const serializedComplimentary = JSON.stringify(complimentaryReport.rows);
test('complimentary report contains no OTP code, token, or authorization ID', !serializedComplimentary.includes('123456') && !serializedComplimentary.includes('private-auth-id') && !serializedComplimentary.includes('complimentaryOtpCode'));

const onlineOrders = [
  { publicOrderReference: 'CBWEB-ACCEPTED', storeId: 'GOLDEN_I', storeName: 'Golden I', status: 'CONVERTED', source: 'CUSTOMER_WEB', customerPhone: '9999999999', grandTotal: 210, createdAt, convertedAt: new Date(createdAt.getTime() + 5 * 60000) },
  { publicOrderReference: 'CBWEB-REJECTED', storeId: 'GOLDEN_I', storeName: 'Golden I', status: 'REJECTED', source: 'CUSTOMER_WEB', customerPhone: '9876543210', rejectReason: 'Store busy', grandTotal: 100, createdAt },
  { publicOrderReference: 'CBWEB-PAID', storeId: 'GOLDEN_I', storeName: 'Golden I', status: 'PAID_PENDING_ACCEPTANCE', paymentStatus: 'PAID', paymentProvider: 'RAZORPAY', providerMethod: 'UPI', source: 'CUSTOMER_WEB', customerPhone: '9123456789', grandTotal: 350, createdAt, paymentCapturedAt: createdAt },
  { publicOrderReference: 'CBWEB-REFUNDED', storeId: 'GOLDEN_I', storeName: 'Golden I', status: 'CANCELLED_REFUNDED', paymentStatus: 'REFUNDED', paymentProvider: 'RAZORPAY', providerMethod: 'CARD', source: 'CUSTOMER_WEB', customerPhone: '9234567890', grandTotal: 200, createdAt, paymentCapturedAt: createdAt },
];
const onlineReport = buildReportDataset('online-order', records, { onlineOrders });
test('online accepted and rejected counts are accurate', onlineReport.rows.filter((row: any) => row.accepted).length === 1 && onlineReport.rows.filter((row: any) => row.rejected).length === 1);
test('paid pending acceptance is distinct from accepted online orders', onlineReport.rows.some((row: any) => row.paidPendingAcceptance && row.paymentCaptured && !row.accepted));
test('online report does not expose tracking tokens or private document IDs', !JSON.stringify(onlineReport.rows).includes('trackingToken') && !JSON.stringify(onlineReport.rows).includes('"id"'));
const gatewayCollectionReport = buildReportDataset('payment-collection', records, { onlineOrders });
test('captured unlinked Razorpay money appears in gateway collections', gatewayCollectionReport.rows.some((row: any) => row.method === 'RAZORPAY' && row.grossPayments === 350));
test('processed unlinked Razorpay refund reduces gateway collections once', gatewayCollectionReport.rows.some((row: any) => row.method === 'RAZORPAY' && row.reversals === 200 && row.netCollections === 0));

for (const reportId of ['locality-wise', 'corporate-customer-gst', 'advance-order-summary']) {
  const unavailable = buildReportDataset(reportId, records);
  test(`${reportId} is unavailable instead of fabricated`, unavailable.availabilityStatus === 'DATA_CAPTURE_REQUIRED' && unavailable.rows.length === 0);
}

const franchise = buildFranchiseDailyDataset(records);
test('Franchise summary uses the same canonical net sales', franchise.metrics.netSales === metrics.netSales);
test('Franchise summary uses the same canonical GST', franchise.metrics.gstCollected === metrics.gstCollected);
const franchiseWithGateway = buildFranchiseDailyDataset(records, 'Asia/Kolkata', onlineOrders);
test('Franchise gateway collections include unlinked captures without changing sales', franchiseWithGateway.metrics.gatewayPaymentsCaptured === 550 && franchiseWithGateway.metrics.netSales === metrics.netSales);

const fakeExport = {
  report: REPORT_REGISTRY[10],
  summary: metrics,
  availabilityStatus: 'AVAILABLE',
  unavailableReason: null,
  columns: masterReport.columns,
  rows: masterReport.rows,
  accessibleStores: [{ id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I' }],
  selectedStoreIds: ['GOLDEN_I'],
  startDate: '2026-07-24',
  endDate: '2026-07-24',
  timeZone: 'Asia/Kolkata',
  filters: { storeIds: ['GOLDEN_I'] },
  filterOptions: { sources: [], orderTypes: [], paymentMethods: [], staff: [], categories: [], items: [] },
  sourceOrderCount: records.length,
  generatedAt: createdAt.toISOString(),
  pagination: { page: 1, pageSize: 50, totalRows: masterReport.rows.length, totalPages: 1, hasNextPage: false },
} as unknown as ReportingResponse;
const csv = buildReportingCsv(fakeExport);
test('CSV contains only allowed sanitized report fields', csv.includes('CB-GOLDEN_I-1001') && !csv.includes('secret-staff-uid') && !csv.includes('cashier@private.example') && !csv.includes('9999999999'));
const xlsxRows = JSON.stringify(buildReportingSheetRows(fakeExport));
test('XLSX rows contain only allowed sanitized report fields', xlsxRows.includes('CB-GOLDEN_I-1001') && !xlsxRows.includes('secret-staff-uid') && !xlsxRows.includes('cashier@private.example') && !xlsxRows.includes('9999999999'));

const root = process.cwd();
const backendSource = fs.readFileSync(path.join(root, 'functions/reporting.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'frontend/App.tsx'), 'utf8');
const dayCloseSource = fs.readFileSync(path.join(root, 'frontend/pages/reports/DayClose.tsx'), 'utf8');
const reportViewSource = fs.readFileSync(path.join(root, 'frontend/pages/reports/ReportView.tsx'), 'utf8');
const rulesSource = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const gitignoreSource = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

test('backend validates role and every selected store', backendSource.includes("['ADMIN', 'STORE_MANAGER', 'CASHIER']") && backendSource.includes('selected.every((storeId) => allowedIds.has(storeId))'));
test('Cashier cannot query historical or all-store reports', backendSource.includes("profile.role === 'CASHIER'") && backendSource.includes('Cashier reports are limited to today') && backendSource.includes('Cashier reports are limited to one assigned store'));
test('summary and detailed date limits are enforced', backendSource.includes('core.DETAIL_MAX_DAYS') && backendSource.includes('core.SUMMARY_MAX_DAYS'));
test('detailed rows are paginated', backendSource.includes('pageSize') && backendSource.includes('hasNextPage'));
test('oversized exports require narrower filters', backendSource.includes('core.MAX_EXPORT_ROWS'));
test('report access is logged without report contents', backendSource.includes("collection('reportAccessAudit')") && !backendSource.includes('rows, createdAt'));
test('all reporting callables are exported', ['getReportingSummary', 'getReportingRows', 'exportReportingData'].every(name => indexSource.includes(`exports.${name}`)));
test('internal Reports Centre excludes Franchise Viewer at route level', appSource.includes("allowedRoles={['ADMIN', 'STORE_MANAGER', 'CASHIER']}") && !appSource.includes("allowedRoles={['ADMIN', 'STORE_MANAGER', 'CASHIER', 'FRANCHISE_VIEWER']}"));
test('Day Close uses the canonical reporting calculation core', dayCloseSource.includes('summarizeReportingRecords'));
test('browser report view has no direct Firestore order reads', !reportViewSource.includes('firebase/firestore') && !reportViewSource.includes("collection(db, 'orders')"));
test('CSV and XLSX export are built from callable-sanitized rows', reportViewSource.includes('getReportingExport') && reportViewSource.includes('downloadReportingXlsx'));
test('report access audit is server-write-only', rulesSource.includes('match /reportAccessAudit/{auditId}') && rulesSource.includes('allow create, update, delete: if false;'));
test('new report routes are not hidden by the generated-report ignore rule', gitignoreSource.includes('/reports/') && !gitignoreSource.split('\n').includes('reports/'));

if (failures.length > 0) {
  console.error('Reporting Centre tests failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Reporting Centre tests passed (${passed.length}):`);
passed.forEach(name => console.log(`- ${name}`));
