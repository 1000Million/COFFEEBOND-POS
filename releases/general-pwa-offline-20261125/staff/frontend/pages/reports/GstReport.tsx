import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, FileDown } from 'lucide-react';
import type { StaffProfile } from '../../types';
import { ReportingControls, ReportingScopeLabel } from '../../components/reports/ReportingControls';
import { formatReportValue, getReportingExport, getReportingRows, reportingErrorMessage, type ReportDefinition } from '../../lib/reporting';
import { useReportingScope } from '../../lib/useReportingScope';
import { downloadGstXlsx } from '../../lib/reportExports';
import { groupedGstIssues, gstBillIssueDate, gstInvoiceBillNumber, gstReconciliation, loadCompleteGstReport, type GstIssueGroup, type GstRecord, type GstReportData, type GstReportingRequest } from '../../lib/gstReporting';

const PAGE_SIZE = 50;
const money = (value: unknown) => value === null || value === undefined ? 'Not captured' : formatReportValue(value, 'money');
const text = (value: unknown) => value === null || value === undefined || value === '' ? 'Not captured' : String(value);
const financialColumns = ['subtotal', 'discount', 'taxableAmount', 'gstTotal', 'cgst', 'sgst', 'igst', 'cess', 'grandTotal'];
const cellClass = 'border-b border-neutral-100 px-3 py-3';
const moneyClass = (value: unknown) => value === null || value === undefined ? 'font-semibold text-amber-800' : 'font-mono tabular-nums';

export default function GstReport({ profile, definition }: { profile: StaffProfile; definition: ReportDefinition }) {
  const scope = useReportingScope(profile, definition);
  const request = useMemo<Omit<GstReportingRequest, 'gstCursor'>>(() => ({ reportId: 'gst-report', storeIds: scope.request.storeIds, startDate: scope.startDate, endDate: scope.endDate, pageSize: 20 }), [scope.storeId, scope.startDate, scope.endDate]);
  const requestKey = JSON.stringify(request);
  const [refresh, setRefresh] = useState(0);
  const generation = `${requestKey}:${scope.canQuery}:${refresh}`;
  const [state, setState] = useState<{ generation: string; data?: GstReportData; error?: string; pageCount?: number; scannedCount?: number }>({ generation: '' });
  const [exportState, setExportState] = useState<{ generation: string; busy?: boolean; error?: string; notice?: string; scannedCount?: number }>({ generation: '' });
  const exportAbort = useRef<AbortController | null>(null);
  const live = useRef({ generation, mounted: true });
  live.current.generation = generation;
  useLayoutEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; exportAbort.current?.abort(); }; }, []);
  useEffect(() => {
    exportAbort.current?.abort();
    if (!scope.canQuery) return;
    const controller = new AbortController();
    setState({ generation });
    loadCompleteGstReport(request, page => getReportingRows(page), {
      signal: controller.signal,
      onProgress: progress => setState({ generation, ...progress }),
    }).then(data => { if (!controller.signal.aborted) setState({ generation, data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ generation, error: reportingErrorMessage(error) }); });
    return () => { controller.abort(); exportAbort.current?.abort(); };
  }, [generation]);
  const current = scope.canQuery && state.generation === generation ? state : undefined;
  const data = current?.data;
  const exporting = exportState.generation === generation && exportState.busy;
  const exportError = exportState.generation === generation ? exportState.error : undefined;
  const notice = exportState.generation === generation ? exportState.notice : undefined;
  const loading = scope.canQuery && !data && !current?.error;
  const reconciliation = useMemo(() => data ? gstReconciliation(data) : null, [data]);
  const issues = useMemo(() => data ? groupedGstIssues(data) : [], [data]);
  const affectedBillCount = useMemo(() => new Set(issues.flatMap(group => group.bills.filter(bill => bill.identified).map(bill => bill.key))).size, [issues]);
  const q = scope.params.get('q') || '';
  const selected = data?.records.filter(record => record.bill.inPeriod) || [];
  const bills = selected.filter(record => !record.bill.provisional);
  const provisional = selected.filter(record => record.bill.provisional);
  const matches = bills.filter(record => !q || Object.values(record.bill).some(value => String(value ?? '').toLowerCase().includes(q.toLowerCase())));
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(scope.page, pageCount);
  const rows = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const handleExport = async () => {
    if (!data || exporting) return;
    const token = generation;
    const controller = new AbortController();
    exportAbort.current?.abort(); exportAbort.current = controller;
    const active = () => !controller.signal.aborted && live.current.mounted && live.current.generation === token;
    setExportState({ generation: token, busy: true });
    try {
      const report = await loadCompleteGstReport(request, batch => getReportingExport(batch), {
        signal: controller.signal,
        onProgress: progress => { if (active()) setExportState({ generation: token, busy: true, scannedCount: progress.scannedCount }); },
      });
      if (!active()) return;
      downloadGstXlsx(report);
      setExportState({ generation: token, notice: `Exported the complete selected scope: ${report.records.length.toLocaleString('en-IN')} distinct captured records. Search and table pagination do not change the export.` });
    } catch (error) {
      if (active()) setExportState({ generation: token, error: reportingErrorMessage(error) });
    }
  };
  return <div className="min-w-0 space-y-5 pb-16 text-neutral-900">
    <header className="rounded-2xl border border-[#e5d9cd] bg-white p-5">
      <Link to={scope.urlFor('/reports')} className="inline-flex items-center gap-2 text-sm font-bold text-[#5c4033]"><ArrowLeft size={16}/> Back to Overview</Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-xs font-bold text-neutral-500">{definition.group}</p><h1 className="mt-1 text-2xl font-black text-[#3e2723]">GST Report</h1><ReportingScopeLabel scope={scope}/><p className="mt-2 text-sm text-neutral-500">Captured sales, GST, voids and complimentary bills for the complete selected scope.</p></div>
        {definition.supportsExport && profile.role !== 'CASHIER' && <button disabled={!data || Boolean(exporting)} onClick={handleExport} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#3e2723] px-3 text-sm font-bold text-white disabled:opacity-50"><FileDown size={16}/>{exporting ? 'Preparing Excel…' : 'Export Excel'}</button>}
      </div>
      <p className="mt-3 text-xs text-neutral-500">Order creation dates use IST. All accessible stores and any valid date range are supported. Sales and GST use captured completed commercial bills; provisional sources, voids and complimentary bills appear separately. Unknown values are never inferred.</p>
    </header>
    <ReportingControls scope={scope} scopeOnly refresh={() => setRefresh(value => value + 1)} loading={loading}/>
    {(scope.scopeError || current?.error || exportError) && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{scope.scopeError || current?.error || exportError}<button onClick={() => { scope.retryStores(); setRefresh(value => value + 1); }} className="ml-2 font-bold underline">Retry</button></div>}
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}
    {exporting && <p role="status" className="rounded-xl bg-[#f3ece5] p-4 text-sm">Preparing the complete Excel workbook… {(exportState.scannedCount || 0).toLocaleString('en-IN')} source documents scanned. A failed or incomplete batch produces no file.</p>}
    {(!scope.canQuery && !scope.scopeError || loading) && <p role="status" className="rounded-xl border border-[#e5d9cd] bg-white p-10 text-center">Loading the complete GST scope for {scope.storeLabel}… {current?.pageCount ? `${current.pageCount} batches; ${current.scannedCount?.toLocaleString('en-IN')} source documents scanned.` : ''} Totals appear after every batch succeeds.</p>}
    {data && reconciliation && <>
      <section aria-label="GST totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
        ['Sales incl. recorded GST', data.aggregate.totals.grandTotal], ['Taxable sales', data.aggregate.totals.taxableAmount],
        ['Recorded GST', data.aggregate.totals.gstTotal], ['CGST captured', data.aggregate.totals.cgst],
        ['SGST captured', data.aggregate.totals.sgst], ['IGST captured', data.aggregate.totals.igst],
        ['Cess captured', data.aggregate.totals.cess], ['Net recorded collections', data.aggregate.totals.netCollectedAmount],
      ].map(([label, value]) => <div key={String(label)} className={`rounded-xl border p-4 ${value === null || value === undefined ? 'border-amber-300 bg-amber-50' : 'border-[#e5d9cd] bg-white'}`}><p className="text-xs font-bold text-neutral-500">{String(label)}</p><p className={`mt-2 text-xl font-black ${moneyClass(value)}`}>{money(value)}</p></div>)}</section>
      <p className="text-xs text-neutral-500">Totals cover the complete selected scope using captured values. “Not captured” means one or more selected records lack that value. Review Errors &amp; Warnings below for affected bills.</p>
      <p className="text-xs text-neutral-600">{data.aggregate.totals.saleCount.toLocaleString('en-IN')} completed commercial bills · {data.aggregate.totals.billCount.toLocaleString('en-IN')} distinct selected records · {data.pageCount.toLocaleString('en-IN')} completed batches · {text(data.aggregate.coverage.duplicateSourcesExcluded)} explicitly linked duplicate sources excluded.</p>
      <section aria-label="GST reconciliation" className="rounded-2xl border border-[#e5d9cd] bg-white p-5"><h2 className="font-black">Voids, complimentary bills and reconciliation</h2><dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[
        ['Voided / cancelled bills', data.aggregate.totals.voidCount.toLocaleString('en-IN')], ['Recorded void value', money(reconciliation.voidValue)],
        ['Complimentary bills', data.aggregate.totals.complimentaryCount.toLocaleString('en-IN')], ['Complimentary menu value', money(reconciliation.complimentaryMenuValue)],
        ['Reconciled bills', reconciliation.reconciledCount.toLocaleString('en-IN')], ['Mismatched bills', reconciliation.mismatchCount.toLocaleString('en-IN')],
        ['Incomplete / unchecked bills', reconciliation.incompleteCount.toLocaleString('en-IN')], ['Bill arithmetic delta', money(reconciliation.billDelta)],
        ['Line taxable delta', money(reconciliation.lineTaxableDelta)], ['Line GST delta', money(reconciliation.lineTaxDelta)], ['Line total delta', money(reconciliation.lineTotalDelta)],
      ].map(([label, value]) => <div key={label}><dt className="text-xs font-bold text-neutral-500">{label}</dt><dd className={`mt-1 text-sm font-bold ${value === 'Not captured' ? 'text-amber-800' : ''}`}>{value}</dd></div>)}</dl><p className="mt-4 text-xs text-neutral-500">Deltas compare captured values only; a net zero can contain individual mismatches. Voids are excluded from sales; their refund outcome is separate. Complimentary menu value is separate from sales.</p></section>
      <section aria-label="Provisional source records" className="rounded-2xl border border-amber-300 bg-amber-50 p-5"><h2 className="font-black text-amber-950">Provisional sources · excluded from sales and GST</h2><p className="mt-2 text-sm text-amber-900">{provisional.length.toLocaleString('en-IN')} unlinked online / offline sources · recorded source value {money(reconciliation.provisionalRecordedValue)}. Paid online sources remain provisional until linked to a committed POS bill. Explicit linked IDs prevent counting an accepted online source twice.</p>{provisional.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-sm font-bold text-amber-950">View provisional sources</summary><div className="mt-3 max-h-64 overflow-auto"><table className="w-full min-w-max text-left text-sm"><thead><tr>{['Source ID', 'Store', 'Payment status', 'Recorded source value'].map(label => <th key={label} className="px-3 py-2">{label}</th>)}</tr></thead><tbody>{provisional.map((record, index) => <tr key={index}><td className={cellClass}>{text(record.bill.onlineOrderId || record.bill.orderId)}</td><td className={cellClass}>{text(record.bill.storeName)}</td><td className={cellClass}>{text(record.bill.paymentStatus)}</td><td className={cellClass}>{money(record.bill.grandTotal)}</td></tr>)}</tbody></table></div></details>}</section>
      <section className="overflow-hidden rounded-2xl border border-[#e5d9cd] bg-white"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 p-4"><div><h2 className="font-black">Captured bill register</h2><p className="mt-1 text-xs text-neutral-500">{matches.length.toLocaleString('en-IN')} of {bills.length.toLocaleString('en-IN')} committed bills shown by search. Totals and Excel always cover the selected store and dates.</p></div><label className="text-xs font-bold text-neutral-600">Search captured bills<input value={q} onChange={event => scope.update({ q: event.target.value })} className="mt-1 block h-11 w-64 max-w-full rounded-lg border border-neutral-300 px-3 text-sm" placeholder="Bill, store or captured text"/></label></div>
        {rows.length ? <BillTable rows={rows}/> : <p role="status" className="p-10 text-center text-sm">{q ? 'No captured bills match this search.' : 'No committed bills in the selected scope.'}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 p-4"><p className="text-xs text-neutral-500">Page {page} of {pageCount}</p><div className="flex gap-2"><button disabled={page <= 1} onClick={() => scope.update({ page: String(page - 1) }, false)} className="inline-flex h-11 items-center gap-1 rounded-lg border px-3 text-sm font-bold disabled:opacity-40"><ChevronLeft size={16}/> Previous</button><button disabled={page >= pageCount} onClick={() => scope.update({ page: String(page + 1) }, false)} className="inline-flex h-11 items-center gap-1 rounded-lg border px-3 text-sm font-bold disabled:opacity-40">Next <ChevronRight size={16}/></button></div></div>
      </section>
      <p className="text-xs text-neutral-500">Each bill was read consistently; the selected period is not an atomic snapshot. Refreshed results can change as source records change. Captured server sources include POS, online and synchronized offline activity; unsynchronized browser journals are unavailable. Retrieved {new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. This report contains recorded working papers for review.</p>
      <ErrorsAndWarnings groups={issues} affectedBillCount={affectedBillCount}/>
    </>}
  </div>;
}

function BillTable({ rows }: { rows: GstRecord[] }) {
  return <div className="max-h-[65vh] overflow-auto"><table className="w-full min-w-max border-collapse text-left text-sm"><thead className="sticky top-0 z-10 bg-[#faf7f3]"><tr>{['Invoice / Bill Number', 'Bill Issue Date (IST)', 'Recorded Bill Date (IST)', 'Store', 'Bill status', 'Payment', 'Subtotal', 'Discount', 'Taxable', 'GST recorded', 'CGST', 'SGST', 'IGST', 'Cess', 'Total'].map(label => <th key={label} className="whitespace-nowrap border-b border-neutral-200 px-3 py-3 text-xs font-bold text-neutral-600">{label}</th>)}</tr></thead><tbody>{rows.map((record, index) => <tr key={index} className="hover:bg-[#fffdf9]">{[gstInvoiceBillNumber(record.bill), gstBillIssueDate(record.bill), record.bill.createdDate, record.bill.storeName, `${record.bill.status} / ${text(record.bill.commercialStatus)}`, record.bill.paymentStatus].map((value, i) => <td key={i} className={cellClass}>{text(value)}</td>)}{financialColumns.map(field => <td key={field} className={`${cellClass} text-right ${moneyClass(record.bill[field])}`}>{money(record.bill[field])}</td>)}</tr>)}</tbody></table></div>;
}

function ErrorsAndWarnings({ groups, affectedBillCount }: { groups: GstIssueGroup[]; affectedBillCount: number }) {
  return <section aria-label="Errors & Warnings" className="overflow-hidden rounded-2xl border border-[#e5d9cd] bg-white">
    <div className="border-b border-neutral-100 p-4"><h2 className="font-black">Errors &amp; Warnings</h2><p className="mt-1 text-xs text-neutral-500">{groups.length.toLocaleString('en-IN')} grouped issues affecting {affectedBillCount.toLocaleString('en-IN')} distinct identified bills in the complete selected scope. Expand a group to review every affected bill and its captured details.</p></div>
    {groups.length === 0 ? <p className="p-5 text-sm text-neutral-600">No errors or warnings for the selected scope.</p> : <details className="p-4"><summary className="cursor-pointer text-sm font-bold text-[#5c4033]">View grouped issues ({groups.length.toLocaleString('en-IN')})</summary><div className="mt-4 max-h-[65vh] overflow-auto"><table className="w-full min-w-[850px] border-collapse text-left text-sm"><thead className="sticky top-0 bg-[#faf7f3]"><tr>{['Code / description', 'Severity', 'Store', 'Affected bills', 'Action required', 'Bill details'].map(label => <th key={label} className="border-b border-neutral-200 px-3 py-3 text-xs font-bold text-neutral-600">{label}</th>)}</tr></thead><tbody>{groups.map(group => <tr key={`${group.code}:${group.severity}:${group.storeId || ''}`} className="align-top">
      <td className={`${cellClass} max-w-sm`}><p className="text-xs font-bold">{group.code}</p><p className="mt-1 text-xs text-neutral-600">{group.description}</p></td>
      <td className={cellClass}><span className={`inline-block rounded-full px-2 py-1 text-xs font-bold ${group.severity === 'ERROR' ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-900'}`}>{group.severity === 'ERROR' ? 'Error' : 'Warning'}</span></td>
      <td className={cellClass}>{group.storeName}</td><td className={`${cellClass} text-right font-mono tabular-nums`}>{group.affectedBillCount.toLocaleString('en-IN')}</td>
      <td className={`${cellClass} max-w-sm text-xs`}>{group.actionRequired}</td>
      <td className={`${cellClass} min-w-64`}><details><summary className="cursor-pointer text-xs font-bold text-[#5c4033]">{group.affectedBillCount ? `View all ${group.affectedBillCount.toLocaleString('en-IN')} bills` : 'View source details'}</summary><ul className="mt-3 space-y-3">{group.bills.map(bill => <li key={bill.key} className="rounded-lg bg-neutral-50 p-3"><p className="break-words text-xs font-bold">{bill.number}</p><ul className="mt-2 space-y-2 text-xs text-neutral-600">{bill.details.map((detail, index) => <li key={index}><p>{text(detail.message)}</p>{Object.entries(detail).filter(([key, value]) => !['code', 'severity', 'message', 'storeId', 'orderId'].includes(key) && value !== null && value !== undefined && value !== '').map(([key, value]) => <p key={key} className="mt-1 break-words"><span className="font-semibold">{key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}:</span> {typeof value === 'object' ? JSON.stringify(value) : text(value)}</p>)}</li>)}</ul></li>)}</ul></details></td>
    </tr>)}</tbody></table></div></details>}
  </section>;
}
