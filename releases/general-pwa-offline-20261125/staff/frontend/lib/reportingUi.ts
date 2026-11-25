import type { StaffProfile } from '../types';
import type { ReportingRequest } from './reporting';

export const FILTER_LABELS = { source: 'Source', orderType: 'Order type', paymentMethod: 'Payment', staffName: 'Biller', category: 'Category', itemCode: 'Item', orderStatus: 'Order status', commercialStatus: 'Commercial status' } as const;
export const EMPTY_FILTERS = { source: 'ALL', orderType: 'ALL', paymentMethod: 'ALL', staffName: 'ALL', category: 'ALL', itemCode: 'ALL', orderStatus: 'ALL', commercialStatus: 'ALL' };
export function reportingToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function shiftReportingDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function reportingAccessKey(profile: StaffProfile): string {
  return JSON.stringify([profile.uid, profile.role, profile.isActive, profile.assignedStoreIds, profile.storeIds]);
}
export function reportingRangeError(start: string, end: string, maxDays: number): string | null {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end)) return 'Choose valid start and end dates.';
  if (end < start) return 'End date must be on or after start date.';
  if ((Date.parse(end) - Date.parse(start)) / 86400000 + 1 > maxDays) return `This report supports at most ${maxDays} days. Choose a narrower date range.`;
  return null;
}
export function reportingParams(request: ReportingRequest, current = new URLSearchParams()): URLSearchParams {
  const params = new URLSearchParams(current);
  params.set('storeId', request.storeIds[0] || 'ALL'); params.set('startDate', request.startDate); params.set('endDate', request.endDate);
  for (const [key, value] of Object.entries(request.filters || {})) { if (value !== 'ALL') params.set(key, value); else params.delete(key); }
  if ((request.page || 1) > 1) params.set('page', String(request.page)); else params.delete('page');
  return params;
}
export function reportCell(value: unknown, key: string): string | null {
  if (['dateTime', 'voidedAt', 'scheduledAt'].includes(key) && value) {
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST';
  }
  const labels: Record<string, string> = { 'VOIDED / NO PAYMENT': 'Voided · no payment', 'VOIDED / CASH REFUNDED': 'Refund completed (cash)', 'VOIDED / PAYMENT REVERSED': 'Reversal completed', 'VOIDED / REFUND PENDING': 'Refund pending', 'VOIDED / MANUAL REFUND REQUIRED': 'Manual refund required', 'VOIDED / PAYMENT REVIEW': 'Voided · payment review required', NOT_REQUIRED: 'No payment required', PAID: 'Paid', UNPAID: 'Unpaid', VOIDED: 'Voided', COMPLIMENTARY: 'Complimentary', REFUND_PENDING: 'Refund pending', REFUNDED: 'Refund completed', REVERSED: 'Reversal completed', MANUAL_REFUND_REQUIRED: 'Manual refund required', REFUND_FAILED: 'Refund failed', COMPLETED: 'Completed', CANCELLED: 'Cancelled', PARTIALLY_REFUNDED: 'Partially refunded' };
  return /status$|outcome$/i.test(key) ? labels[String(value)] || null : null;
}
export function ensureCompleteReportingExport(data: { rows: unknown[]; totalRows?: number }): void {
  if (data.totalRows === undefined || data.totalRows !== data.rows.length) throw new Error('Export completeness could not be verified. No file was downloaded; retry or narrow the filters.');
}
