import fs from 'node:fs';
import path from 'node:path';
import policy from '../functions/franchiseSalesPolicy.js';
import { buildFranchiseSalesCsv, FranchiseDailySalesResponse } from '../frontend/lib/franchiseSales';

const {
  canAccessRequestedStores,
  franchiseAuthEmail,
  maskIndianMobile,
  normalizeFranchiseUsername,
  summarizeFranchiseDailySales,
  validateFranchiseUsername,
} = policy;

const failures: string[] = [];
const passed: string[] = [];

function test(name: string, condition: boolean) {
  if (condition) passed.push(name);
  else failures.push(name);
}

function record(order: Record<string, unknown>, items: Record<string, unknown>[] = [], payments: Record<string, unknown>[] = []) {
  return { order, items, payments };
}

const createdAt = new Date('2026-07-22T06:30:00.000Z');
const records = [
  record({
    orderNumber: 'CB-GOLDEN_I-0001',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    customerName: 'Private Customer',
    customerPhone: '9999999999',
    createdByUserId: 'staff-secret',
    createdByEmail: 'staff@example.com',
    orderType: 'DINE_IN',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    subtotal: 100,
    discountAmount: 5,
    taxableAmount: 95,
    gstTotal: 4.75,
    grandTotal: 99.75,
    createdAt,
  }, [{ itemName: 'Hot Latte', categoryName: 'Coffee', quantity: 1, lineTax: 4.75, lineTotal: 99.75 }], [
    { method: 'CASH', amount: 99.75 },
  ]),
  record({
    orderNumber: 'CB-GOLDEN_I-0002',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    customerPhone: '9876543210',
    orderType: 'TAKEAWAY',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentMethod: 'UPI',
    subtotal: 200,
    taxableAmount: 200,
    gstTotal: 10,
    grandTotal: 210,
    source: 'CUSTOMER_WEB',
    createdAt,
  }, [{ itemName: 'Affogato', categoryName: 'Coffee', quantity: 1, lineTax: 10, lineTotal: 210 }], [
    { method: 'UPI', amount: 210 },
  ]),
  record({
    orderNumber: 'CB-GOLDEN_I-0003',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    orderType: 'TAKEAWAY',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    subtotal: 300,
    taxableAmount: 300,
    gstTotal: 15,
    grandTotal: 315,
    isSplitPayment: true,
    createdAt,
  }, [{ itemName: 'Pancakes', categoryName: 'Food', quantity: 1, lineTax: 15, lineTotal: 315 }], [
    { method: 'CASH', amount: 100 },
    { method: 'CARD', amount: 215 },
  ]),
  record({
    orderNumber: 'CB-GOLDEN_I-COMP',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    orderType: 'DINE_IN',
    status: 'COMPLETED',
    commercialStatus: 'COMPLIMENTARY',
    paymentStatus: 'NOT_REQUIRED',
    paymentMethod: 'COMPLIMENTARY',
    subtotal: 225,
    menuValue: 225,
    complimentaryDiscount: 225,
    taxableAmount: 0,
    gstTotal: 0,
    grandTotal: 0,
    cogsTotal: 70,
    createdAt,
  }),
  record({
    orderNumber: 'CB-GOLDEN_I-VOID',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
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
    createdAt,
  }, [], [{ method: 'CASH', amount: 105 }]),
  record({
    orderNumber: 'CB-GOLDEN_I-LEGACY',
    storeId: 'GOLDEN_I',
    storeName: 'Golden I',
    paymentStatus: 'UNPAID',
    paymentMethod: 'PAY_AT_COUNTER',
    subtotal: 50,
    taxableAmount: 50,
    gstTotal: 2.5,
    grandTotal: 52.5,
    createdAt,
  }),
];

const summary = summarizeFranchiseDailySales(records);
const viewer = {
  role: 'FRANCHISE_VIEWER',
  isActive: true,
  storeIds: ['GOLDEN_I'],
  permissions: { viewDailySales: true, exportSales: true },
};

test('active viewer can access an assigned store', canAccessRequestedStores(viewer, ['GOLDEN_I']) === true);
test('cross-store access is denied', canAccessRequestedStores(viewer, ['UDAY_PARK']) === false);
test('mixed assigned and unassigned store selection is denied', canAccessRequestedStores(viewer, ['GOLDEN_I', 'UDAY_PARK']) === false);
test('inactive viewer is denied', canAccessRequestedStores({ ...viewer, isActive: false }, ['GOLDEN_I']) === false);
test('viewer without view permission is denied', canAccessRequestedStores({ ...viewer, permissions: { viewDailySales: false } }, ['GOLDEN_I']) === false);
test('username is trimmed and case-normalized', normalizeFranchiseUsername('  GoldenI.Owner ') === 'goldeni.owner');
test('internal auth email is deterministic', franchiseAuthEmail('GoldenI.Owner') === 'goldeni.owner@franchise.pos.coffeebond.in');
test('reserved ADMIN username is rejected case-insensitively', validateFranchiseUsername(' ADMIN ').valid === false);
test('invalid username characters are rejected', validateFranchiseUsername('owner@example').valid === false);
test('Indian mobile numbers are masked', maskIndianMobile('9999999999') === '99******99');
test('commercial net sales exclude void and complimentary orders', summary.metrics.netSales === 677.25);
test('GST excludes void and complimentary orders', summary.metrics.gstCollected === 32.25);
test('discount totals use the Reports-compatible order fields', summary.metrics.discounts === 5);
test('paid transaction count excludes unpaid legacy order', summary.metrics.paidTransactionCount === 3);
test('complimentary metrics remain separate', summary.metrics.complimentaryOrderCount === 1 && summary.metrics.complimentaryMenuValue === 225 && summary.metrics.complimentaryCogs === 70);
test('void metrics remain separate', summary.metrics.voidOrderCount === 1 && summary.metrics.voidedOrderValue === 105);
test('split payment rows retain exact tender totals', summary.metrics.paymentBreakdown.CASH === 199.75 && summary.metrics.paymentBreakdown.CARD === 215 && summary.metrics.splitOrderCount === 1);
test('online and POS sales are separated', summary.metrics.onlineSales === 210 && summary.metrics.posSales === 467.25);
test('legacy missing status defaults to completed without being counted paid', summary.orders.some((order: any) => order.orderNumber === 'CB-GOLDEN_I-LEGACY' && order.status === 'COMPLETED' && order.paymentStatus === 'UNPAID'));
test('category summary uses only completed commercial order items', summary.categorySales.length === 2 && summary.categorySales.some((row: any) => row.categoryName === 'Coffee'));
test('hourly summary uses the India business timezone', summary.hourlySales.length === 1 && summary.hourlySales[0].hour === 12);

const serializedOrders = JSON.stringify(summary.orders);
for (const forbidden of ['Private Customer', 'staff-secret', 'staff@example.com', 'createdByUserId', 'customerName']) {
  test(`sanitized drilldown excludes ${forbidden}`, !serializedOrders.includes(forbidden));
}
test('sanitized drilldown exposes only the masked mobile field', serializedOrders.includes('customerPhoneMasked') && !serializedOrders.includes('"customerPhone":'));

const report = {
  date: '2026-07-22',
  timeZone: 'Asia/Kolkata',
  generatedAt: new Date().toISOString(),
  stores: [{ id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I' }],
  permissions: { viewDailySales: true, exportSales: true },
  ...summary,
} as FranchiseDailySalesResponse;
const csv = buildFranchiseSalesCsv(report);
test('CSV contains sanitized order references', csv.includes('CB-GOLDEN_I-0001'));
test('CSV contains only masked customer mobile values', csv.includes('99******99') && !csv.includes('9999999999'));
test('CSV does not expose staff identifiers or customer names', !csv.includes('staff-secret') && !csv.includes('Private Customer'));

const repoRoot = process.cwd();
const functionSource = fs.readFileSync(path.join(repoRoot, 'functions/franchiseSales.js'), 'utf8');
const rulesSource = fs.readFileSync(path.join(repoRoot, 'firestore.rules'), 'utf8');
const appSource = fs.readFileSync(path.join(repoRoot, 'frontend/App.tsx'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(repoRoot, 'frontend/pages/franchise/FranchiseDailySales.tsx'), 'utf8');

test('daily sales callable requires an active viewer profile', functionSource.includes('requireActiveViewer(db, request)'));
test('daily sales callable validates every requested store', functionSource.includes('canAccessRequestedStores(profile, requestedStoreIds)'));
test('Admin can create a Franchise Viewer through the secured callable', functionSource.includes("if (action === 'CREATE')") && functionSource.includes('requireActiveAdmin(db, request)'));
test('Store Manager cannot create a Franchise Viewer', functionSource.includes("profile.role !== 'ADMIN'"));
test('Cashier cannot create a Franchise Viewer', functionSource.includes("profile.role !== 'ADMIN'"));
test('inactive Admin cannot manage Franchise Viewers', functionSource.includes('!isActiveProfile(profile)'));
test('Admin SDK manages Auth users without exposing passwords to Firestore', functionSource.includes('auth.createUser') && !functionSource.includes('temporaryPassword: request.data?.temporaryPassword'));
test('duplicate usernames are rejected by normalized username and Auth email', functionSource.includes("where('usernameNormalized', '==', username)") && functionSource.includes('getUserByEmail(email)'));
test('franchise report access is logged without order payloads', functionSource.includes("'franchise-daily-sales-access'") && !functionSource.includes('console.info(order'));
test('viewer has dedicated routes', appSource.includes('/franchise/login') && appSource.includes('/franchise/daily-sales'));
test('viewer route is isolated from operational layout', appSource.indexOf('path="/franchise/daily-sales"') < appSource.indexOf('Main App Layout'));
test('dashboard has no direct Firestore import', !dashboardSource.includes('firebase/firestore') && !dashboardSource.includes("collection(db"));
test('viewer role is excluded from active operational staff', rulesSource.includes("userData().role in ['ADMIN', 'STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN', 'TRAINEE']"));
test('viewer cannot create, void, or settle orders', rulesSource.includes('allow create: if isValidOrderCreate(orderId);') && rulesSource.includes('allow update: if isOrderSettlementUpdate() || isOrderVoidUpdate();'));
test('viewer cannot read supplier or inventory cost data', rulesSource.includes('match /purchaseEntries/{purchaseId}') && rulesSource.includes('allow read: if isActiveStaff()') && !rulesSource.match(/FRANCHISE_VIEWER[\s\S]{0,200}purchaseEntries/));
test('franchise profiles cannot be managed by direct client writes', rulesSource.includes('!isFranchiseProfile(request.resource.data)') && rulesSource.includes('!isFranchiseProfile(resource.data)'));
test('franchise access audit is append-only from client perspective', rulesSource.includes('match /franchiseAccessAudit/{auditId}') && rulesSource.includes('allow create, update, delete: if false;'));

if (failures.length > 0) {
  console.error('Franchise viewer tests failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Franchise viewer tests passed (${passed.length}):`);
for (const name of passed) console.log(`- ${name}`);
