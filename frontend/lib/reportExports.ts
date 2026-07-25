import * as XLSX from 'xlsx';
import type { ReportColumn, ReportingResponse } from './reporting';

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
