import { createComplianceAccumulator } from '../../functions/complianceCore.mjs';

export type GstRow = Record<string, unknown>;
export type GstBill = GstRow & {
  orderId: string | null; onlineOrderId: string | null; storeId: string | null;
  billNumber: string | null; invoiceNumber: string | null; periodDate: string | null;
  provisional: boolean; inPeriod: boolean; eligibleSale: boolean; complimentary: boolean;
  documentType: string; status: string; paymentStatus: string;
  grandTotal: number | null; taxableAmount: number | null; gstTotal: number | null;
  cgst: number | null; sgst: number | null; igst: number | null; cess: number | null;
  menuValue: number | null; subtotal: number | null; reconciliationStatus: string;
};
export type GstRecord = {
  bill: GstBill; lines: GstRow[]; exceptions: GstRow[]; audit: GstRow[];
  classifications: GstRow[]; coverage: GstRow;
};
export type GstAggregate = {
  totals: Record<string, number | boolean | null> & {
    billCount: number; saleCount: number; provisionalCount: number; voidCount: number;
    complimentaryCount: number; exceptionCount: number; errorCount: number;
  };
  coverage: GstRow; entitySummaries: GstRow[]; rateSummaries: GstRow[];
  hsnSummaries: GstRow[]; gstr3bSummaries: GstRow[]; gstr1Schedules: GstRow[];
  documentCounts: GstRow[]; numberingGaps: GstRow[]; exceptions: GstRow[]; audit: GstRow[];
};
export type GstReportingRequest = {
  reportId: 'gst-report'; storeIds: string[]; startDate: string; endDate: string;
  gstCursor?: string; pageSize: 20;
};
export type GstReportingPage = {
  reportId: 'gst-report'; records: GstRecord[]; nextCursor: string | null;
  scannedCount: number; coverage: GstRow; selectedStoreIds: string[];
  accessibleStores: Array<{ id: string; name: string; code: string }>;
  startDate: string; endDate: string; timeZone: string; generatedAt: string;
};
export type GstReportData = Omit<GstReportingPage, 'records' | 'nextCursor'> & {
  records: GstRecord[]; aggregate: GstAggregate; pageCount: number; complete: true;
};
export type GstPageLoader = (request: GstReportingRequest) => Promise<GstReportingPage>;

const incomplete = () => new Error('The complete GST report could not be verified. No totals or file were produced. Refresh and retry.');
function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('GST report request was cancelled.');
}
function stableIds(ids: string[]) { return JSON.stringify([...ids].sort()); }

// Match the unchanged compliance accumulator's exact ID precedence for the bill register.
// Approximate matches (bill numbers, amounts, dates) never merge independent records.
export function distinctGstRecords(records: GstRecord[]): GstRecord[] {
  const committed: GstRecord[] = [], pending = new Map<number, GstRecord>();
  const orderIds = new Set<string>(), onlineIds = new Set<string>();
  const pendingOrders = new Map<string, number>(), pendingOnline = new Map<string, number>();
  const remove = (index: number | undefined) => {
    if (index === undefined) return;
    const record = pending.get(index);
    if (!record) return;
    pending.delete(index);
    if (record.bill.orderId) pendingOrders.delete(record.bill.orderId);
    if (record.bill.onlineOrderId) pendingOnline.delete(record.bill.onlineOrderId);
  };
  records.forEach((record, index) => {
    const bill = record.bill;
    if (bill.orderId && orderIds.has(bill.orderId) || bill.onlineOrderId && onlineIds.has(bill.onlineOrderId)) return;
    if (bill.provisional) {
      if (bill.orderId && pendingOrders.has(bill.orderId) || bill.onlineOrderId && pendingOnline.has(bill.onlineOrderId)) return;
      pending.set(index, record);
      if (bill.orderId) pendingOrders.set(bill.orderId, index);
      if (bill.onlineOrderId) pendingOnline.set(bill.onlineOrderId, index);
    } else {
      if (bill.orderId) remove(pendingOrders.get(bill.orderId));
      if (bill.onlineOrderId) remove(pendingOnline.get(bill.onlineOrderId));
      if (bill.orderId) orderIds.add(bill.orderId);
      if (bill.onlineOrderId) onlineIds.add(bill.onlineOrderId);
      committed.push(record);
    }
  });
  return [...committed, ...pending.values()];
}

async function boundedPage(load: GstPageLoader, request: GstReportingRequest, signal: AbortSignal | undefined, timeoutMs: number) {
  assertActive(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      load(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('A GST report batch timed out. No partial totals or file were produced. Refresh and retry.')), timeoutMs);
        cancel = () => reject(new Error('GST report request was cancelled.'));
        signal?.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

/** Cursor exhaustion, never row counts, proves traversal completion. No transaction limit. */
export async function loadCompleteGstReport(
  request: Omit<GstReportingRequest, 'gstCursor'>,
  load: GstPageLoader,
  options: { signal?: AbortSignal; onProgress?: (progress: { pageCount: number; scannedCount: number }) => void; timeoutMs?: number } = {},
): Promise<GstReportData> {
  const records: GstRecord[] = [], seenCursors = new Set<string>();
  const accumulator = createComplianceAccumulator({ startDate: request.startDate, endDate: request.endDate, periodBasis: 'createdAt', collectDetails: false });
  let cursor: string | undefined, first: GstReportingPage | undefined, last: GstReportingPage | undefined;
  let pageCount = 0, scannedCount = 0;
  const notes = new Set<string>();
  do {
    const page = await boundedPage(load, { ...request, gstCursor: cursor }, options.signal, options.timeoutMs ?? 90_000);
    assertActive(options.signal);
    if (page?.reportId !== 'gst-report' || !Array.isArray(page.records) || !Array.isArray(page.selectedStoreIds)
      || !Array.isArray(page.accessibleStores) || !page.coverage || typeof page.coverage !== 'object'
      || !Number.isSafeInteger(page.scannedCount) || page.scannedCount < 0
      || page.startDate !== request.startDate || page.endDate !== request.endDate || page.timeZone !== 'Asia/Kolkata'
      || !Number.isFinite(Date.parse(page.generatedAt))
      || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor)
      || page.coverage.incomplete === true || page.coverage.truncated === true || page.coverage.complete === false || page.coverage.childrenLoaded === false) throw incomplete();
    if (request.storeIds.length && stableIds(page.selectedStoreIds) !== stableIds(request.storeIds)) throw incomplete();
    if (first && stableIds(first.selectedStoreIds) !== stableIds(page.selectedStoreIds)) throw incomplete();
    if (page.selectedStoreIds.some(id => typeof id !== 'string' || !page.accessibleStores.some(store => store.id === id))) throw incomplete();
    for (const record of page.records) {
      if (!record?.bill || typeof record.bill !== 'object' || !Array.isArray(record.lines)
        || !Array.isArray(record.exceptions) || !Array.isArray(record.audit) || !Array.isArray(record.classifications)
        || !record.coverage || record.coverage.childrenLoaded === false || !record.bill.storeId || !page.selectedStoreIds.includes(record.bill.storeId)) throw incomplete();
      accumulator.add(record);
      records.push(record);
    }
    for (const note of Array.isArray(page.coverage.notes) ? page.coverage.notes : []) if (typeof note === 'string') notes.add(note);
    first ||= page; last = page; pageCount += 1; scannedCount += page.scannedCount;
    options.onProgress?.({ pageCount, scannedCount });
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) throw new Error('GST pagination repeated a cursor. No partial totals or file were produced. Refresh and retry.');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  assertActive(options.signal);
  const aggregate = accumulator.finish();
  return { ...last!, records: distinctGstRecords(records), aggregate, pageCount, scannedCount, coverage: { ...last!.coverage, notes: [...notes] }, complete: true };
}

// Supplemental reconciliation adds only captured values. Unknown values stay unknown.
export function recordedGstAmount(records: GstRecord[], field: string): number | null {
  let total = 0;
  for (const { bill } of records) {
    const value = bill[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += value;
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

export function gstReconciliation(data: GstReportData) {
  const selected = data.records.filter(record => record.bill.inPeriod);
  const voids = selected.filter(record => record.bill.documentType === 'INTERNAL_VOID');
  const complimentary = selected.filter(record => record.bill.complimentary);
  const provisional = selected.filter(record => record.bill.provisional);
  return {
    voidValue: recordedGstAmount(voids, 'grandTotal'),
    complimentaryMenuValue: complimentary.every(({ bill }) => typeof (bill.menuValue ?? bill.subtotal) === 'number')
      ? recordedGstAmount(complimentary.map(record => ({ ...record, bill: { ...record.bill, capturedMenuValue: record.bill.menuValue ?? record.bill.subtotal } })), 'capturedMenuValue') : null,
    provisionalRecordedValue: recordedGstAmount(provisional, 'grandTotal'),
    reconciledCount: selected.filter(({ bill }) => bill.reconciliationStatus === 'RECONCILED').length,
    mismatchCount: selected.filter(({ bill }) => bill.reconciliationStatus === 'MISMATCH').length,
    incompleteCount: selected.filter(({ bill }) => !['RECONCILED', 'MISMATCH'].includes(bill.reconciliationStatus)).length,
    billDelta: recordedGstAmount(selected, 'reconciliationDelta'),
    lineTaxableDelta: recordedGstAmount(selected, 'lineTaxableDelta'),
    lineTaxDelta: recordedGstAmount(selected, 'lineTaxDelta'),
    lineTotalDelta: recordedGstAmount(selected, 'lineTotalDelta'),
  };
}

// Presentation policy only. Captured source fields and financial calculations stay intact.
export function gstInvoiceBillNumber(bill: GstBill): string | null {
  for (const value of [bill.billNumber, bill.invoiceNumber]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function gstBillIssueDate(bill: GstBill): string | null {
  const value = bill.invoiceIssuedAtISO;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const calendarDate = new Date(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value)) + ' IST';
}

export type GstIssueGroup = {
  code: string; description: string; severity: 'ERROR' | 'WARNING';
  storeId: string | null; storeName: string; affectedBillCount: number;
  actionRequired: string; bills: Array<{ key: string; number: string; identified: boolean; details: GstRow[] }>;
};

function issueAction(code: string): string {
  if (code === 'MISSING_INVOICE_NUMBER') return 'Locate the original saved bill reference; do not invent an identifier.';
  if (code === 'MISSING_INVOICE_ISSUED_AT') return 'Confirm the original bill issue date from saved receipt or issuance evidence.';
  if (code === 'TAX_COMPONENTS_MISSING') return 'Obtain captured CGST, SGST, IGST and cess evidence; do not infer a tax split.';
  if (/MISMATCH|RECONCILIATION/.test(code)) return 'Reconcile original bill, line and payment evidence before relying on the affected figures.';
  if (/REFUND|PAYMENT/.test(code)) return 'Review original payment and refund evidence and confirm the recorded outcome.';
  if (/LEGAL|GSTIN|ENTITY/.test(code)) return 'Verify the historical supplier, registration and legal-entity evidence.';
  if (/HSN|CLASSIFICATION|RATE|GST_TREATMENT/.test(code)) return 'Confirm the historical tax classification from original supporting evidence.';
  if (/DUPLICATE/.test(code)) return 'Review the referenced source identities and numbering; do not delete or combine financial records.';
  return 'Review the original source and supporting details; do not infer missing information.';
}

const issueSignature = (value: unknown): string => {
  const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : input;
  return JSON.stringify(ordered(value));
};

/** Counts distinct source identities, not repeated line flags or potentially reused bill numbers. */
export function groupedGstIssues(report: GstReportData): GstIssueGroup[] {
  const groups = new Map<string, GstIssueGroup>();
  const identified = new Map<string, GstRecord>();
  report.records.forEach(record => {
    if (record.bill.orderId) identified.set(`order:${record.bill.orderId}`, record);
    if (record.bill.onlineOrderId) identified.set(`online:${record.bill.onlineOrderId}`, record);
  });
  const detailKeys = new Map<string, Set<string>>();
  const groupBills = new Map<string, Map<string, GstIssueGroup['bills'][number]>>();
  const add = (detail: GstRow, record?: GstRecord, index?: number) => {
    const bill = record?.bill;
    if (bill && !bill.inPeriod && bill.periodDate) return;
    const storeId = bill?.storeId || (typeof detail.storeId === 'string' ? detail.storeId : null);
    if (storeId && !report.selectedStoreIds.includes(storeId)) return;
    const code = typeof detail.code === 'string' && detail.code ? detail.code : 'UNCLASSIFIED_SOURCE_ISSUE';
    // The saved bill identifier is the invoice identifier under the approved Coffee Bond policy.
    if (code === 'MISSING_INVOICE_NUMBER' && bill && gstInvoiceBillNumber(bill)) return;
    const severity = detail.severity === 'WARNING' ? 'WARNING' : 'ERROR';
    const groupKey = JSON.stringify([code, severity, storeId]);
    if (!groups.has(groupKey)) groups.set(groupKey, {
      code, severity, storeId,
      storeName: (typeof bill?.storeName === 'string' && bill.storeName) || report.accessibleStores.find(store => store.id === storeId)?.name || storeId || 'Store not captured',
      description: code === 'MISSING_INVOICE_NUMBER' ? 'Invoice / bill number is missing.' : typeof detail.message === 'string' && detail.message ? detail.message : code.replace(/_/g, ' '),
      affectedBillCount: 0, actionRequired: issueAction(code), bills: [],
    });
    const group = groups.get(groupKey)!;
    const sourceId = bill?.orderId ? `order:${bill.orderId}` : bill?.onlineOrderId ? `online:${bill.onlineOrderId}`
      : typeof detail.orderId === 'string' && detail.orderId ? `order:${detail.orderId}` : typeof detail.onlineOrderId === 'string' && detail.onlineOrderId ? `online:${detail.onlineOrderId}` : undefined;
    const key = `${storeId || 'unknown'}:${sourceId || (record ? `record:${index}` : 'unidentified-source')}`;
    if (!groupBills.has(groupKey)) groupBills.set(groupKey, new Map());
    let affected = groupBills.get(groupKey)!.get(key);
    if (!affected) {
      affected = { key, identified: Boolean(sourceId || record), number: bill && gstInvoiceBillNumber(bill) || (sourceId ? 'Bill number not captured' : 'Source-level issue (bill unidentified)'), details: [] };
      group.bills.push(affected);
      groupBills.get(groupKey)!.set(key, affected);
      if (sourceId || record) group.affectedBillCount += 1;
    }
    const uniqueKey = JSON.stringify([groupKey, key]);
    if (!detailKeys.has(uniqueKey)) detailKeys.set(uniqueKey, new Set());
    const signature = issueSignature(detail);
    if (!detailKeys.get(uniqueKey)!.has(signature)) {
      affected.details.push(detail);
      detailKeys.get(uniqueKey)!.add(signature);
    }
  };
  report.records.forEach((record, index) => record.exceptions.forEach(detail => add(detail, record, index)));
  // Include cross-bill errors generated by the existing accumulator, not just bill-level flags.
  report.aggregate.exceptions.forEach(detail => {
    const record = typeof detail.orderId === 'string' ? identified.get(`order:${detail.orderId}`)
      : typeof detail.onlineOrderId === 'string' ? identified.get(`online:${detail.onlineOrderId}`) : undefined;
    add(detail, record, record ? report.records.indexOf(record) : undefined);
  });
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'ERROR' ? -1 : 1)
    || a.storeName.localeCompare(b.storeName) || a.code.localeCompare(b.code));
}
