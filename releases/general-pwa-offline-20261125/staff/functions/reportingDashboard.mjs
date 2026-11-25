import { normalizeRecords, filterNormalizedRecords, summarizeNormalizedRecords, buildReportDataset, dateKey } from './reportingCore.mjs';

export const DAY = 86400000;
export const ZONE = 'Asia/Kolkata';
export const shiftDate = (value, days) => new Date(Date.parse(value + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
export const midnightIST = value => new Date(value + 'T00:00:00+05:30');
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;
const range = (startDate, endDate, endBefore = null) => ({ startDate, endDate, endBefore });
export const unavailable = reason => ({ status: 'UNAVAILABLE', reason });
export function eligibleRecords(records, filters = {}) {
  return filterNormalizedRecords(normalizeRecords(records), filters).filter(r => r.status === 'COMPLETED' && r.commercial === 'PAID');
}
export function windowRecords(records, window) {
  const start = +midnightIST(window.startDate);
  const end = window.endBefore ? Date.parse(window.endBefore) : +midnightIST(shiftDate(window.endDate, 1));
  return records.filter(r => {
    const value = r.order?.createdAt;
    const time = value?.toDate ? +value.toDate() : +new Date(value);
    return time >= start && time < end;
  });
}
export function dashboardPlan(startDate, endDate, now = new Date()) {
  const today = dateKey(now, ZONE), [year, month, day] = today.split('-').map(Number);
  const thisMonth = today.slice(0, 7) + '-01';
  const previousMonth = shiftDate(thisMonth, -1).slice(0, 7) + '-01';
  const priorMonthDays = Number(shiftDate(thisMonth, -1).slice(-2));
  const completedDays = Math.min(day - 1, priorMonthDays);
  const monthWindow = completedDays ? {
    days: completedDays, omittedCompletedDays: day - 1 - completedDays,
    current: range(thisMonth, shiftDate(thisMonth, completedDays - 1)),
    previous: range(previousMonth, shiftDate(previousMonth, completedDays - 1)),
  } : null;
  const reference = endDate, [ry, rm, rd] = reference.split('-').map(Number);
  const previousFirst = new Date(Date.UTC(ry, rm - 2, 1)).toISOString().slice(0, 10);
  const match = shiftDate(previousFirst, rd - 1);
  const matchingDate = match.slice(0, 7) === previousFirst.slice(0, 7) ? match : null;
  const elapsed = +now - +midnightIST(today);
  const partial = reference === today;
  const cutoff = date => partial ? new Date(+midnightIST(date) + elapsed).toISOString() : null;
  const length = daysBetween(startDate, endDate);
  const previousEnd = shiftDate(startDate, -1), previousStart = shiftDate(startDate, -length);
  const weekday = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const monday = shiftDate(today, -weekday);
  return {
    today, asOf: now.toISOString(), future: endDate > today,
    selected: range(startDate, endDate, partial ? now.toISOString() : null),
    month: monthWindow,
    sameDate: { current: range(reference, reference, cutoff(reference)), previous: matchingDate ? range(matchingDate, matchingDate, cutoff(matchingDate)) : null, partial },
    trend: { current: range(startDate, endDate, partial ? now.toISOString() : null), previous: range(previousStart, previousEnd, cutoff(previousEnd)), days: length, partial },
    activity: range(shiftDate(monday, -56), shiftDate(monday, -1)),
  };
}
export function difference(current, previous) {
  const amount = money(current - previous);
  return { amount, percent: previous === 0 ? null : money((current - previous) * 100 / previous), direction: current > previous ? 'Increase' : current < previous ? 'Decrease' : 'No change' };
}
const total = (records, filters) => summarizeNormalizedRecords(filterNormalizedRecords(normalizeRecords(records), filters));
const failureReason = error => error?.code === 'resource-exhausted' ? error.message : error?.code === 'failed-precondition' ? 'Required reporting query/index is unavailable. ' + error.message : 'Read failed; coverage could not be established. Retry this report.';

// Classify structured SDK/gRPC codes, never exception message text. Successful
// incomplete lookups retain the identity helper's history/coverage result.
function returningReadFailure(error) {
  const code = typeof error?.code === 'string' ? error.code.replace(/^functions\//, '') : error?.code;
  if (code === 'failed-precondition' || code === 9) return { errorCode: 'QUERY_UNAVAILABLE', reason: 'Customer history lookup is unavailable. Ask an administrator to check the reporting query configuration.' };
  if (code === 'permission-denied' || code === 7 || code === 'unauthenticated' || code === 16) return { errorCode: 'ACCESS_DENIED', reason: 'Customer history could not be accessed with the current permissions. Ask an administrator to check access; restricted data remains unavailable.' };
  if (code === 'deadline-exceeded' || code === 4) return { errorCode: 'TIMEOUT', reason: 'Customer history lookup timed out. You can refresh the report later.' };
  if (code === 'resource-exhausted' || code === 8) return { errorCode: 'READ_LIMIT', reason: 'Customer history lookup reached a read or service limit. Ask an administrator to check reporting capacity.' };
  return { errorCode: 'SERVICE_ERROR', reason: 'Customer history is temporarily unavailable because the lookup failed. You can refresh the report later; contact an administrator if it continues.' };
}

// Only server-loaded records enter here. Each window is bounded by the existing reporting loader.
// Sections fail independently; an incomplete query never becomes a zero-valued series.
export async function buildPerformanceDashboard({ records, filters, startDate, endDate, role, storeIds, loadRange, loadReturning, now = new Date(), logger = console }) {
  const plan = dashboardPlan(startDate, endDate, now);
  const restricted = role === 'CASHIER';
  const guarded = async action => { try { return await action(); } catch (error) { return unavailable(failureReason(error)); } };
  const fetchWindow = async window => windowRecords(await loadRange(window), window);
  const selectedRecords = windowRecords(records, plan.selected);
  const selectedSummary = total(selectedRecords, filters);
  const selected = plan.future ? unavailable('The selected range includes a future date; complete coverage is unavailable.') : {
    status: 'AVAILABLE', ...plan.selected, summary: selectedSummary,
    paymentMix: Object.entries(selectedSummary.paymentBreakdown).map(([method, amount]) => ({ method, amount })),
    topProducts: restricted ? null : buildReportDataset('item-wise-all-restaurants', selectedRecords, { filters }).rows
      .filter(row => Number(row.quantitySold) > 0).sort((a, b) => b.netSales - a.netSales || String(a.itemName).localeCompare(String(b.itemName))).slice(0, 5),
  };
  const historyRestricted = unavailable('Cashier reports are limited to today. Historical comparisons and activity are not requested.');
  const monthly = restricted ? historyRestricted : !plan.month ? unavailable('No completed days in this month yet; denominator is 0 days.') : await guarded(async () => {
    const [a, b] = await Promise.all([fetchWindow(plan.month.current), fetchWindow(plan.month.previous)]);
    const currentTotal = total(a, filters).netSales, previousTotal = total(b, filters).netSales;
    const currentAverage = money(currentTotal / plan.month.days), previousAverage = money(previousTotal / plan.month.days);
    return { status: 'AVAILABLE', ...plan.month, current: { ...plan.month.current, total: currentTotal, average: currentAverage }, previous: { ...plan.month.previous, total: previousTotal, average: previousAverage }, difference: difference(currentTotal / plan.month.days, previousTotal / plan.month.days) };
  });
  const sameDate = restricted ? historyRestricted : plan.future ? unavailable('The selected end date is in the future.') : !plan.sameDate.previous ? unavailable('No matching calendar date exists in the previous month for ' + endDate + '.') : await guarded(async () => {
    const [a, b] = await Promise.all([fetchWindow(plan.sameDate.current), fetchWindow(plan.sameDate.previous)]);
    const currentTotal = total(a, filters).netSales, previousTotal = total(b, filters).netSales;
    return { status: 'AVAILABLE', current: { ...plan.sameDate.current, total: currentTotal }, previous: { ...plan.sameDate.previous, total: previousTotal }, partial: plan.sameDate.partial, difference: difference(currentTotal, previousTotal) };
  });
  const trend = plan.future ? unavailable('Daily sales coverage is unavailable for future dates.') : await guarded(async () => {
    let previousRecords = null, reason = restricted ? historyRestricted.reason : null;
    if (!restricted) { try { previousRecords = await fetchWindow(plan.trend.previous); } catch (error) { reason = failureReason(error); } }
    const currentNormalized = filterNormalizedRecords(normalizeRecords(selectedRecords), filters);
    const previousNormalized = previousRecords ? filterNormalizedRecords(normalizeRecords(previousRecords), filters) : null;
    const daySummary = (rows, date) => summarizeNormalizedRecords(rows.filter(row => dateKey(row.createdAt, ZONE) === date));
    const points = Array.from({ length: plan.trend.days }, (_, i) => {
      const date = shiftDate(startDate, i), comparableDate = shiftDate(plan.trend.previous.startDate, i);
      const current = daySummary(currentNormalized, date);
      const previous = previousNormalized ? daySummary(previousNormalized, comparableDate) : null;
      return { date, comparableDate, netSales: current.netSales, eligibleBills: current.orderCount, comparableSales: previous?.netSales ?? null };
    });
    return { status: 'AVAILABLE', ...plan.trend, previous: previousRecords ? plan.trend.previous : null, reason, points };
  });
  const activity = restricted ? historyRestricted : await guarded(async () => {
    const data = eligibleRecords(await fetchWindow(plan.activity), filters);
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const rows = weekdays.map(weekday => ({ weekday, counts: Array(24).fill(0), occurrences: 8, peakHours: [], peakCount: 0 }));
    for (const record of data) {
      const date = dateKey(record.createdAt, ZONE);
      if (!date) throw Error('Missing timestamp');
      const day = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date(record.createdAt)));
      rows[day].counts[hour]++;
    }
    for (const row of rows) { row.peakCount = Math.max(...row.counts); row.peakHours = row.peakCount ? row.counts.flatMap((n, h) => n === row.peakCount ? [h] : []) : []; }
    return { status: 'AVAILABLE', ...plan.activity, coveredDays: 56, expectedDays: 56, eligibleBills: data.length, rows };
  });
  let returning;
  if (plan.future) returning = { ...unavailable('Selected dates include a future day.'), eligibleBills: null };
  else if (restricted) returning = { ...historyRestricted, eligibleBills: selectedSummary.orderCount };
  else {
    try { returning = await loadReturning(selectedRecords, filters); }
    catch (error) {
      const failure = returningReadFailure(error);
      // Fixed event/category only: no raw exception, identifiers or query values.
      logger.error('reporting.returning_lookup_failed', { errorCode: failure.errorCode });
      returning = { status: 'UNAVAILABLE', eligibleBills: selectedSummary.orderCount, ...failure };
    }
  }
  return { version: 1, generatedAt: plan.asOf, timeZone: ZONE, storeIds, selected, monthly, sameDate, trend, activity, returning };
}
