import * as XLSX from 'xlsx';
import type { ReportColumn, ReportingResponse } from './reporting';
import { safeCell } from '../../functions/complianceCore.mjs';
import { groupedGstIssues, gstBillIssueDate, gstInvoiceBillNumber, gstReconciliation, type GstBill, type GstIssueGroup, type GstReportData, type GstRow } from './gstReporting';

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function metadataRows(report: ReportingResponse): Array<[string, string]> {
  return [
    ['Report', report.report.title],
    ['Generated', new Date(report.generatedAt).toLocaleString('en-IN')],
    ['Stores', report.accessibleStores.filter(store => report.selectedStoreIds.includes(store.id)).map(store => store.name).join(', ')],
    ['Date range', `${report.startDate} to ${report.endDate}`],
    ['Applied filters', Object.entries(report.filters)
      .filter(([key, value]) => key !== 'storeIds' && value && value !== 'ALL')
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || 'None'],
  ];
}

function exportRows(report: ReportingResponse): unknown[][] {
  return report.rows.map(row => report.columns.map(column => row[column.key] ?? ''));
}

export function buildReportingSheetRows(report: ReportingResponse): unknown[][] {
  return [
    ...metadataRows(report),
    [],
    report.columns.map((column: ReportColumn) => column.label),
    ...exportRows(report),
    [],
    ['Totals', `Net sales ₹${report.summary.netSales.toFixed(2)}`, `Collections ₹${report.summary.netCollections.toFixed(2)}`],
  ];
}

export function buildReportingCsv(report: ReportingResponse): string {
  const metadata = metadataRows(report).map(row => row.map(csvCell).join(','));
  const header = report.columns.map(column => csvCell(column.label)).join(',');
  const rows = exportRows(report).map(row => row.map(csvCell).join(','));
  const totals = [
    csvCell('Totals'),
    csvCell(`Net sales ${report.summary.netSales.toFixed(2)}`),
    csvCell(`Collections ${report.summary.netCollections.toFixed(2)}`),
  ].join(',');
  return [...metadata, '', header, ...rows, totals].join('\n');
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function downloadReportingCsv(report: ReportingResponse): void {
  const csv = buildReportingCsv(report);
  downloadBlob(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `coffee-bond-${safeFileName(report.report.title)}-${report.startDate}-${report.endDate}.csv`,
  );
}

export function downloadReportingXlsx(report: ReportingResponse): void {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(buildReportingSheetRows(report));
  worksheet['!cols'] = report.columns.map(column => ({ wch: Math.max(14, Math.min(36, column.label.length + 4)) }));
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
  XLSX.writeFile(
    workbook,
    `coffee-bond-${safeFileName(report.report.title)}-${report.startDate}-${report.endDate}.xlsx`,
  );
}

const EXCEL_MAX_ROWS = 1_048_576;
function gstCell(value: unknown): string | number | boolean {
  return safeCell(value && typeof value === 'object' ? JSON.stringify(value) : value);
}

/** Every input row is retained, splitting sheets before Excel's native row limit. */
export function appendGstSheets(workbook: XLSX.WorkBook, name: string, headers: string[], rows: unknown[][], rowLimit = EXCEL_MAX_ROWS): void {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 2 || rowLimit > EXCEL_MAX_ROWS) throw new Error('Invalid Excel sheet row limit.');
  const capacity = rowLimit - 1;
  const count = Math.max(1, Math.ceil(rows.length / capacity));
  for (let part = 0; part < count; part += 1) {
    const sheet = XLSX.utils.aoa_to_sheet([headers.map(gstCell), ...rows.slice(part * capacity, (part + 1) * capacity).map(row => row.map(gstCell))]);
    sheet['!cols'] = headers.map(header => ({ wch: Math.max(14, Math.min(42, header.length + 3)) }));
    XLSX.utils.book_append_sheet(workbook, sheet, count > 1 ? `${name.slice(0, 22)} ${part + 1}` : name.slice(0, 31));
  }
}

function appendGstObjects(workbook: XLSX.WorkBook, name: string, rows: GstRow[]): void {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  appendGstSheets(workbook, name, headers.length ? headers : ['No captured rows'], rows.map(row => headers.map(key => row[key])));
}

const GST_REGISTER_FIELDS = [
  ['Store', 'storeName'], ['Store Code', 'storeCode'], ['Document Type', 'documentType'],
  ['Bill Status', 'status'], ['Commercial Status', 'commercialStatus'], ['Payment Status', 'paymentStatus'],
  ['Payment Method', 'paymentMethod'], ['Recorded Payment Methods', 'paymentMethods'], ['Source', 'source'],
  ['Subtotal', 'subtotal'], ['Discount', 'discount'], ['Taxable Amount', 'taxableAmount'],
  ['GST', 'gstTotal'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst'], ['Cess', 'cess'],
  ['Rounding Adjustment', 'roundingAdjustment'], ['Total', 'grandTotal'], ['Menu Value', 'menuValue'],
  ['Complimentary Discount', 'complimentaryDiscount'], ['Collected Amount', 'collectedAmount'],
  ['Credit Placeholder Amount', 'creditPlaceholderAmount'], ['Credit Outstanding', 'creditOutstanding'],
  ['Refunded Amount', 'refundedAmount'], ['Pending Refund Amount', 'pendingRefundAmount'],
  ['Net Collected Amount', 'netCollectedAmount'], ['Order ID', 'orderId'],
  ['Online Order ID', 'onlineOrderId'], ['Offline ID', 'offlineId'],
] as const;
const GST_REGISTER_HEADERS = ['Invoice / Bill Number', 'Issue Date (IST)', 'Bill Date (IST)', ...GST_REGISTER_FIELDS.map(([label]) => label)];

function gstRegisterRow(bill: GstBill): unknown[] {
  return [gstInvoiceBillNumber(bill), gstBillIssueDate(bill), bill.periodDate, ...GST_REGISTER_FIELDS.map(([, field]) => bill[field])];
}

// Leave room for safeCell's formula-protection prefix within Excel's 32,767-character limit.
const GST_DETAIL_CELL_LENGTH = 30_000;
function gstTextParts(value: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + GST_DETAIL_CELL_LENGTH, value.length);
    // Keep a supplementary Unicode character intact across continuation cells.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end -= 1;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts.length ? parts : [''];
}

function appendGstIssues(workbook: XLSX.WorkBook, groups: GstIssueGroup[]): void {
  const headers = ['Issue description', 'Affected bills', 'Store', 'Severity', 'Action',
    'Row Type', 'Group', 'Issue Code', 'Store ID', 'Invoice / Bill Number', 'Bill Key', 'Evidence ID',
    'Part', 'Parts', 'Source Detail (JSON)'];
  const rows: unknown[][] = [];
  const rowInfo: XLSX.RowInfo[] = [];
  const addRow = (values: unknown[]) => {
    const parts = values.map(value => typeof value === 'string' ? gstTextParts(value) : [value]);
    const count = Math.max(...parts.map(value => value.length));
    const referenceColumns = new Set([2, 3, 5, 6, 7, 8, 9, 10, 11]);
    for (let part = 0; part < count; part += 1) {
      const row = parts.map((value, index) => value[part] ?? (referenceColumns.has(index) && value.length === 1 ? value[0] : ''));
      row.splice(12, 0, part + 1, count);
      rows.push(row);
      const supportingDetail = values[5] === 'DETAIL' || values[5] === 'BILL' || part > 0;
      rowInfo.push(supportingDetail ? { level: 1, hidden: true } : { level: 0, hidden: false });
    }
  };
  groups.forEach((group, groupIndex) => {
    const groupId = `G${groupIndex + 1}`;
    addRow([group.description, group.affectedBillCount, group.storeName, group.severity, group.actionRequired,
      'GROUP', groupId, group.code, group.storeId, '', '', groupId, '']);
    group.bills.forEach((bill, billIndex) => {
      const billId = `${groupId}:B${billIndex + 1}`;
      if (!bill.details.length) addRow(['', '', group.storeName, group.severity, '',
        'BILL', groupId, group.code, group.storeId, bill.number, bill.key, billId, '']);
      bill.details.forEach((detail, detailIndex) => addRow(['', '', group.storeName, group.severity, '',
        'DETAIL', groupId, group.code, group.storeId, bill.number, bill.key, `${billId}:D${detailIndex + 1}`, JSON.stringify(detail)]));
    });
  });
  if (!rows.length) addRow(['No errors or warnings in the selected records.', 0, '', '', '', 'SUMMARY', '', '', '', '', '', '', '']);

  const appendPart = (name: string, start: number, end: number) => {
    appendGstSheets(workbook, name, headers, rows.slice(start, end));
    const sheet = workbook.Sheets[name];
    sheet['!cols'] = [{ wch: 56 }, { wch: 16 }, { wch: 24 }, { wch: 12 }, { wch: 56 },
      ...headers.slice(5).map(header => ({ wch: Math.max(14, Math.min(42, header.length + 3)) }))];
    sheet['!rows'] = [{ level: 0, hidden: false }, ...rowInfo.slice(start, end)];
    // Standard Excel outlines: summary above, supporting rows collapsed until expanded.
    sheet['!outline'] = { above: true };
  };

  // Keep every supporting row and make the main, exactly named sheet the final tab.
  const capacity = EXCEL_MAX_ROWS - 1;
  for (let offset = capacity; offset < rows.length; offset += capacity) {
    appendPart(`Errors & Warnings ${offset / capacity + 1}`, offset, offset + capacity);
  }
  appendPart('Errors & Warnings', 0, capacity);
}

export function buildGstWorkbook(report: GstReportData): XLSX.WorkBook {
  if (report.complete !== true || !report.aggregate || !Array.isArray(report.records)) throw new Error('The complete GST export could not be verified. No file was downloaded.');
  const workbook = XLSX.utils.book_new();
  const reconciliation = gstReconciliation(report);
  const issues = groupedGstIssues(report);
  const affectedBills = new Set(issues.flatMap(group => group.bills.filter(bill => bill.identified)
    .map(bill => JSON.stringify([group.storeId, bill.key]))));
  const metadata: unknown[][] = [
    ['Report', 'GST Report — captured working papers'],
    ['Stores', report.accessibleStores.filter(store => report.selectedStoreIds.includes(store.id)).map(store => `${store.name} (${store.code || store.id})`).join(', ')],
    ['Date range', `${report.startDate} to ${report.endDate}`], ['Time zone', report.timeZone],
    ['Period basis', 'Recorded order creation date (IST)'], ['Generated', report.generatedAt],
    ['Traversal', `Complete cursor traversal: ${report.pageCount} batches; ${report.scannedCount} source documents scanned`],
    ['Consistency', 'Each bill was read consistently. The selected period is not an atomic snapshot; subsequent source changes may affect a refreshed report.'],
    ['Coverage', 'Server-visible POS, online and synchronized offline sources only. Unsynchronized browser journals are unavailable.'],
    ['Unknown values', 'Blank means not captured / unknown. No GST component split, current tax rate or historical legal detail was inferred.'],
    ['Invoice / Bill Number', 'The saved Bill Number is the invoice identifier under Coffee Bond policy. It is shown first; a captured invoiceNumber is used only when Bill Number is absent.'],
    ['Dates', 'Issue Date uses only the captured invoice issuance timestamp. Bill Date retains the recorded order creation date used for the selected period; it is not substituted for Issue Date.'],
    ['Scope', 'Recorded working papers for review; Errors & Warnings shows grouped issues. Expand its Excel row groups to view complete supporting details. Numbered continuation tabs are used if Excel row limits require them.'],
    ['Error groups', issues.filter(group => group.severity === 'ERROR').length],
    ['Warning groups', issues.filter(group => group.severity === 'WARNING').length],
    ['Bills with errors or warnings', affectedBills.size],
    ...Object.entries({ ...report.aggregate.totals, complimentaryMenuValue: reconciliation.complimentaryMenuValue })
      .filter(([key]) => key !== 'exceptionCount' && key !== 'errorCount').map(([key, value]) => [key, value]),
    ...Object.entries(reconciliation).map(([key, value]) => [`reconciliation.${key}`, value]),
  ];
  appendGstSheets(workbook, 'GST summary', ['Metric / note', 'Recorded value'], metadata);
  const register = report.records.filter(record => !record.bill.provisional).map(record => gstRegisterRow(record.bill));
  const provisional = report.records.filter(record => record.bill.provisional)
    .map(record => [...gstRegisterRow(record.bill), 'PROVISIONAL — EXCLUDED FROM SALES AND GST TOTALS']);
  appendGstSheets(workbook, 'Bill register', GST_REGISTER_HEADERS, register);
  appendGstSheets(workbook, 'Provisional sources', [...GST_REGISTER_HEADERS, 'Sales Treatment'], provisional);
  appendGstObjects(workbook, 'Recorded line snapshots', report.records.flatMap(record => record.lines));
  appendGstObjects(workbook, 'GST by entity', report.aggregate.entitySummaries);
  appendGstObjects(workbook, 'GST by captured rate', report.aggregate.rateSummaries);
  appendGstIssues(workbook, issues);
  return workbook;
}

export function downloadGstXlsx(report: GstReportData): void {
  XLSX.writeFile(buildGstWorkbook(report), `coffee-bond-gst-report-${report.startDate}-${report.endDate}.xlsx`);
}
