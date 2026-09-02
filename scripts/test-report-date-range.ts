import fs from 'node:fs';
import path from 'node:path';
import {
  createReportDateRange,
  dateIsInReportRange,
  reportFileName,
  resolveReportDateRange,
} from '../frontend/lib/reportDateRange';
import { createInventoryEventQueryPlans } from '../frontend/lib/inventoryReportQueries';

const failures: string[] = [];
const passed: string[] = [];

function test(name: string, condition: boolean) {
  if (condition) passed.push(name);
  else failures.push(name);
}

function custom(start: string, end: string) {
  return resolveReportDateRange({ preset: 'CUSTOM', customStart: start, customEnd: end });
}

const istAfterMidnight = new Date('2026-09-01T18:40:00.000Z');
const today = createReportDateRange('TODAY', { now: istAfterMidnight });
test('Today uses the Asia/Kolkata calendar date', today.startKey === '2026-09-02' && today.endKey === '2026-09-02');
test('Today starts at IST midnight', today.startInclusive.toISOString() === '2026-09-01T18:30:00.000Z');
test('Today ends at the next IST midnight', today.endExclusive.toISOString() === '2026-09-02T18:30:00.000Z');

const sameDay = custom('2026-09-01', '2026-09-01');
test('Custom same-day range resolves', sameDay.ok && sameDay.range.label === '2026-09-01');
test(
  'Custom same-day range uses a half-open query boundary',
  sameDay.ok
    && dateIsInReportRange(new Date('2026-08-31T18:30:00.000Z'), sameDay.range)
    && dateIsInReportRange(new Date('2026-09-01T18:29:59.999Z'), sameDay.range)
    && !dateIsInReportRange(new Date('2026-09-01T18:30:00.000Z'), sameDay.range),
);

const multiDay = custom('2026-08-30', '2026-09-02');
test(
  'Multi-day range preserves both inclusive calendar keys',
  multiDay.ok && multiDay.range.startKey === '2026-08-30' && multiDay.range.endKey === '2026-09-02',
);

const monthBoundary = custom('2026-01-31', '2026-02-01');
test(
  'Month-boundary custom range ends at the following midnight',
  monthBoundary.ok && monthBoundary.range.endExclusive.toISOString() === '2026-02-01T18:30:00.000Z',
);

const thisWeek = createReportDateRange('THIS_WEEK', { now: new Date('2026-09-03T06:30:00.000Z') });
test('This week starts on Monday', thisWeek.startKey === '2026-08-31' && thisWeek.endKey === '2026-09-03');

const thisMonth = createReportDateRange('THIS_MONTH', { now: new Date('2026-09-03T06:30:00.000Z') });
test('This month starts on calendar day one', thisMonth.startKey === '2026-09-01' && thisMonth.endKey === '2026-09-03');

const invalidOrder = custom('2026-09-03', '2026-09-02');
test('End-before-start is rejected', invalidOrder.ok === false && invalidOrder.error.includes('before'));

const missingEnd = custom('2026-09-03', '');
test('Missing custom boundary is rejected', missingEnd.ok === false && missingEnd.error.includes('both'));

const malformed = custom('2026-02-30', '2026-03-01');
test('Impossible calendar date is rejected', malformed.ok === false && malformed.error.includes('valid'));

const emptyRange = custom('', '');
test('Empty custom date range is rejected', emptyRange.ok === false && emptyRange.error.includes('both'));

test(
  'Export filename includes the exact active range',
  multiDay.ok && reportFileName('Sales Report', multiDay.range) === 'coffee-bond-sales-report-2026-08-30_to_2026-09-02.csv',
);

const repoRoot = process.cwd();
const reportsSource = fs.readFileSync(path.join(repoRoot, 'frontend/pages/reports/ReportsHome.tsx'), 'utf8');
test(
  'Sales report Firestore queries use the shared half-open range',
  reportsSource.includes("Timestamp.fromDate(dateRange.startInclusive)")
    && reportsSource.includes("Timestamp.fromDate(dateRange.endExclusive)")
    && reportsSource.includes("where('createdAt', '<', endExclusiveTs)"),
);
const multiDayRange = multiDay.ok ? multiDay.range : null;
const inventoryPlans = multiDayRange ? createInventoryEventQueryPlans('AUTHORIZED_STORE', multiDayRange) : null;
test('Inventory event query construction includes all three report collections',
  !!inventoryPlans
    && inventoryPlans.orders.collectionName === 'orders'
    && inventoryPlans.kotItems.collectionName === 'kotItems'
    && inventoryPlans.stockMovements.collectionName === 'stockMovements');
test('Inventory event queries preserve authorized store scoping',
  !!inventoryPlans && Object.values(inventoryPlans).every((plan) => plan.storeId === 'AUTHORIZED_STORE'));
test('Inventory event queries preserve inclusive-start and exclusive-end boundaries',
  !!inventoryPlans && !!multiDayRange && Object.values(inventoryPlans).every((plan) => (
    plan.startInclusive.toISOString() === multiDayRange.startInclusive.toISOString()
    && plan.endExclusive.toISOString() === multiDayRange.endExclusive.toISOString()
  )));
test('Stock movement reporting uses the deployed descending index direction',
  inventoryPlans?.stockMovements.createdAtOrder === 'desc');
test(
  'Sales exports use the active range filename helper',
  reportsSource.includes('reportFileName(`${type}-report`, dateRange)'),
);
test(
  'Sales report time labels use the business timezone',
  reportsSource.includes("timeZone: REPORTING_TIME_ZONE")
    && !reportsSource.includes('date.getHours()')
    && !reportsSource.includes('d?.toLocaleDateString()'),
);

if (failures.length > 0) {
  console.error('Report date-range tests failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Report date-range tests passed (${passed.length}):`);
for (const name of passed) console.log(`- ${name}`);
