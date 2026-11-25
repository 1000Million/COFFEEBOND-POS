import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileDown, Printer, Star } from 'lucide-react';
import { REPORT_REGISTRY } from '../../../functions/reportingCore.mjs';
import { useAuth } from '../../contexts/AuthContext';
import type { StaffProfile } from '../../types';
import { formatReportValue, getReportingExport, getReportingRows, reportingErrorMessage, type ReportColumn, type ReportDefinition } from '../../lib/reporting';
import { downloadReportingCsv, downloadReportingXlsx } from '../../lib/reportExports';
import { ensureCompleteReportingExport, reportCell, reportingAccessKey } from '../../lib/reportingUi';
import { useReportingResult, useReportingScope } from '../../lib/useReportingScope';
import { ReportingControls, ReportingMetrics, ReportingScopeLabel } from '../../components/reports/ReportingControls';
import GstReport from './GstReport';

const FAVOURITES_KEY = 'coffee-bond-report-favourites';
const RECENTS_KEY = 'coffee-bond-report-recents';
function readIds(key: string): string[] { try { const ids = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(ids) ? ids.filter(v => typeof v === 'string') : []; } catch { return []; } }
export default function ReportView() {
  const { reportId = '' } = useParams();
  const { staffProfile } = useAuth();
  const definition = (REPORT_REGISTRY as ReportDefinition[]).find(r => r.reportId === reportId);
  if (!staffProfile || staffProfile.isActive === false || !definition?.allowedRoles.includes(staffProfile.role as never)) return <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-6"><h1 className="text-xl font-bold">Report unavailable</h1><p className="mt-2">This report does not exist or is not available to your role.</p><Link to="/reports" className="mt-4 inline-block font-bold underline">Back to Overview</Link></div>;
  if (reportId === 'gst-report') return <GstReport key={`${reportingAccessKey(staffProfile)}:${reportId}`} profile={staffProfile} definition={definition}/>;
  return <Report key={`${reportingAccessKey(staffProfile)}:${reportId}`} profile={staffProfile} definition={definition}/>;
}
function Report({ profile, definition }: { profile: StaffProfile; definition: ReportDefinition }) {
  const scope = useReportingScope(profile, definition);
  const request = scope.request;
  const requestKey = JSON.stringify(request);
  const result = useReportingResult(requestKey, scope.canQuery, () => getReportingRows(request));
  const response = result.data;
  const [exporting, setExporting] = useState<'CSV' | 'XLSX' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [favourites, setFavourites] = useState(() => readIds(FAVOURITES_KEY));
  const liveExport = useRef({ key: requestKey, epoch: 0, mounted: true });
  if (liveExport.current.key !== requestKey) { liveExport.current.key = requestKey; liveExport.current.epoch += 1; }
  useLayoutEffect(() => { liveExport.current.mounted = true; return () => { liveExport.current.mounted = false; liveExport.current.epoch += 1; }; }, []);
  useEffect(() => { setExporting(null); setExportError(null); setNotice(null); }, [requestKey]);
  useEffect(() => {
    if (!response) return;
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify([definition.reportId, ...readIds(RECENTS_KEY).filter(id => id !== definition.reportId)].slice(0,8))); } catch { /* Report viewing also works when browser storage is unavailable. */ }
  }, [response, definition.reportId]);
  const q = scope.params.get('q') || '';
  const sortKey = scope.params.get('sort');
  const direction = scope.params.get('direction') === 'desc' ? 'desc' : 'asc';
  const rows = useMemo(() => {
    const filtered = (response?.rows || []).filter(row => !q || Object.values(row).some(v => String(v ?? '').toLowerCase().includes(q.toLowerCase())));
    if (!sortKey) return filtered;
    return [...filtered].sort((a,b) => { const x=a[sortKey], y=b[sortKey]; const comparison=typeof x === 'number' && typeof y === 'number' ? x-y : String(x ?? '').localeCompare(String(y ?? '')); return direction === 'asc' ? comparison : -comparison; });
  }, [response, q, sortKey, direction]);
  const selectedBill = scope.params.get('bill');
  const detail = response?.rows.find(row => row.orderNumber === selectedBill || row.invoiceNumber === selectedBill || row.reference === selectedBill);
  const toggleFavourite = () => setFavourites(current => { const next=current.includes(definition.reportId)?current.filter(id=>id!==definition.reportId):[...current,definition.reportId]; try { localStorage.setItem(FAVOURITES_KEY,JSON.stringify(next)); } catch { /* Keep the current session usable. */ } return next; });
  const handleExport = async (format: 'CSV' | 'XLSX') => {
    const key = requestKey;
    const epoch = liveExport.current.epoch;
    setExporting(format); setExportError(null); setNotice(null);
    try {
      const data = await getReportingExport({ ...request, page: undefined, pageSize: undefined });
      if (!liveExport.current.mounted || (liveExport.current.key !== key || liveExport.current.epoch !== epoch)) return;
      ensureCompleteReportingExport(data);
      if (format === 'CSV') downloadReportingCsv(data); else downloadReportingXlsx(data);
      setNotice(`Exported ${data.rows.length.toLocaleString('en-IN')} rows for ${data.startDate} to ${data.endDate}. All server-filtered rows; page search and sorting excluded.`);
    } catch (error) { if (liveExport.current.mounted && liveExport.current.key === key && liveExport.current.epoch === epoch) setExportError(reportingErrorMessage(error)); }
    finally { if (liveExport.current.mounted && liveExport.current.key === key && liveExport.current.epoch === epoch) setExporting(null); }
  };
  const columns = definition.reportId === 'orders-master' ? ['orderNumber', 'dateTime', 'store', 'source', 'table', 'paymentMethods', 'total', 'commercialStatus', 'paymentStatus'].flatMap(key => {
    const column = response?.columns.find(c => c.key === key);
    const label = ({ orderNumber: 'Bill', dateTime: 'Time (IST)', source: 'Source / type', total: 'Amount incl. GST', commercialStatus: 'Bill status' } as Record<string,string>)[key];
    return column ? [{ ...column, label: label || column.label }] : [];
  }) : response?.columns || [];
  const cell = (row: Record<string,unknown>, column: ReportColumn) => {
    if (definition.reportId === 'orders-master' && column.key === 'source') return `${row.source || '—'} / ${row.orderType || '—'}`;
    if (definition.reportId === 'orders-master' && column.key === 'commercialStatus' && ['VOIDED', 'CANCELLED'].includes(String(row.orderStatus))) return reportCell(row.orderStatus, 'orderStatus')!;
    return reportCell(row[column.key], column.key) || formatReportValue(row[column.key], column.type);
  };
  const title = definition.reportId === 'orders-master' ? 'Bills' : definition.title;
  const filtersText = Object.entries(scope.filters).filter(([,v])=>v!=='ALL').map(([k,v])=>`${k}: ${v}`).join(' · ') || 'All report filters';
  const reportLink = (id: string) => { const p=new URLSearchParams(scope.params); for(const key of ['page','bill','q','sort','direction'])p.delete(key);return `/reports/${id}?${p}`; };
  return <div className="min-w-0 space-y-5 pb-16 text-neutral-900">
    <header className="rounded-2xl border border-[#e5d9cd] bg-white p-5">
      <Link to={scope.urlFor('/reports')} className="inline-flex items-center gap-2 text-sm font-bold text-[#5c4033] print:hidden"><ArrowLeft size={16}/> Back to Overview</Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold text-neutral-500">{definition.group}</p><h1 className="mt-1 text-2xl font-black text-[#3e2723]">{title}</h1><ReportingScopeLabel scope={scope}/><p className="mt-2 text-sm text-neutral-500">{definition.description}</p></div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <button onClick={toggleFavourite} aria-pressed={favourites.includes(definition.reportId)} className="inline-flex h-11 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-bold"><Star size={16} className={favourites.includes(definition.reportId)?'fill-amber-400 text-amber-600':''}/> Favourite</button>
          {definition.supportsPrint && <button disabled={!response} onClick={() => window.print()} className="inline-flex h-11 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-bold disabled:opacity-50"><Printer size={16}/> Print page</button>}
          {definition.supportsExport && profile.role !== 'CASHIER' && <><button disabled={!response || Boolean(exporting)} onClick={()=>handleExport('CSV')} className="inline-flex h-11 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-bold disabled:opacity-50"><Download size={16}/>{exporting==='CSV'?'Exporting…':'CSV'}</button><button disabled={!response || Boolean(exporting)} onClick={()=>handleExport('XLSX')} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#3e2723] px-3 text-sm font-bold text-white disabled:opacity-50"><FileDown size={16}/>{exporting==='XLSX'?'Exporting…':'XLSX'}</button></>}
        </div>
      </div>
      <p className="mt-3 text-xs font-semibold text-neutral-500">{filtersText}</p>
      <p className="mt-2 text-xs text-neutral-500">CSV/XLSX: all server-filtered rows, subject to existing limits. Print: displayed page only. Page search and sorting do not change totals or export scope.</p>
    </header>
    <ReportingControls scope={scope} options={response?.filterOptions} refresh={result.refresh} loading={result.loading}/>
    {(scope.scopeError || result.error || exportError) && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{scope.scopeError || result.error || exportError}<button onClick={()=>{scope.retryStores();result.refresh();}} className="ml-2 font-bold underline">Retry</button></div>}
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}
    {(!scope.canQuery && !scope.scopeError || result.loading) && <p role="status" className="rounded-xl border border-[#e5d9cd] bg-white p-10 text-center">Loading report for {scope.storeLabel}…</p>}
    {response?.availabilityStatus === 'DATA_CAPTURE_REQUIRED' ? <section className="rounded-xl border border-amber-200 bg-amber-50 p-8"><h2 className="text-xl font-bold">Data capture required</h2><p className="mt-2">{response.unavailableReason}</p></section> : response && <>
      <ReportingMetrics summary={response.summary}/>
      <p className="text-xs text-neutral-600">Server totals for all matching records. Discounts {formatReportValue(response.summary.discounts,'money')} · GST included {formatReportValue(response.summary.gstCollected,'money')} · Complimentary {response.summary.complimentaryOrderCount} / menu value {formatReportValue(response.summary.complimentaryMenuValue,'money')} · Voided {response.summary.voidOrderCount} / value {formatReportValue(response.summary.voidedOrderValue,'money')} · Unpaid {response.summary.unpaidOrderCount} / {formatReportValue(response.summary.unpaidAmount,'money')}</p>
      <p className="text-xs text-neutral-500">A void is separate from its refund outcome. “Paid” alone does not confirm a refund. Data retrieved {new Date(response.generatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST.</p>
      {definition.reportId === 'orders-master' && <p className="rounded-xl bg-[#f3ece5] p-3 text-sm">Payment methods are shown on each bill. <Link to={reportLink('split-payment-detail')} className="font-bold underline">View split tender amounts</Link> for cash/UPI amounts. Bill status and payment outcome are shown separately.</p>}
      {detail && <section aria-label="Bill detail" className="rounded-xl border border-[#e5d9cd] bg-white p-4"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-black">Bill detail · {selectedBill}</h2><button onClick={()=>scope.update({bill:null},false)} className="rounded-lg border px-3 py-2 text-sm font-bold">Back to results</button></div><dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{response.columns.map(c=><div key={c.key}><dt className="text-xs font-bold text-neutral-500">{c.label}</dt><dd className="mt-1 break-words text-sm">{cell(detail,c)}</dd></div>)}</dl></section>}
      <section className="overflow-hidden rounded-2xl border border-[#e5d9cd] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 p-4"><div><h2 className="font-black">{title} results</h2><p className="mt-1 text-xs text-neutral-500">{response.pagination.totalRows.toLocaleString('en-IN')} server-filtered rows · page {response.pagination.page} of {response.pagination.totalPages} · {rows.length} of {response.rows.length} loaded rows shown</p></div><label className="text-xs font-bold text-neutral-600 print:hidden">Search this page only<input value={q} onChange={e=>scope.update({q:e.target.value},false)} placeholder="Bill number, payment or text" className="mt-1 block h-11 w-64 max-w-full rounded-lg border border-neutral-300 px-3 text-sm"/></label></div>
        <p className="border-b border-neutral-100 px-4 py-2 text-xs text-neutral-500">Column sorting and search cover this loaded page only. Use server filters above for the full report.</p>
        {rows.length === 0 ? <div role="status" className="p-10 text-center"><p className="font-bold">{response.pagination.totalRows === 0 ? 'No rows match the selected filters.' : 'No matches on this loaded page.'}</p><p className="mt-2 text-sm text-neutral-500">{q ? 'Clear the page search or try another page.' : 'Choose another date range or reset the filters.'}</p></div> : <div className="max-h-[65vh] overflow-auto print:max-h-none print:overflow-visible">{definition.reportId === 'orders-master' && <div aria-label="Bill list" className="divide-y divide-neutral-100 sm:hidden print:hidden">{rows.map((row,index) => <article key={index} className="space-y-2 p-4"><div className="flex items-start justify-between gap-3"><p className="font-bold">{String(row.orderNumber || 'Bill')}</p><p className="font-mono font-bold tabular-nums">{formatReportValue(row.total,'money')}</p></div><p className="text-xs text-neutral-500">{reportCell(row.dateTime,'dateTime')} · {String(row.store || '')}</p><p className="text-xs">{String(row.source || '')} / {String(row.orderType || '')}{row.table ? ` · Table ${row.table}` : ''}</p><p className="text-sm font-semibold">Bill: {reportCell(['VOIDED','CANCELLED'].includes(String(row.orderStatus)) ? row.orderStatus : row.commercialStatus,'commercialStatus')} · Payment: {reportCell(row.paymentStatus,'paymentStatus') || String(row.paymentStatus || '—')}</p><p className="text-sm">Payment: {String(row.paymentMethods || 'None')}</p><button onClick={()=>scope.update({bill:String(row.orderNumber)},false)} className="min-h-11 rounded-lg border px-3 text-xs font-bold">View bill details</button></article>)}</div>}<table className={`w-full min-w-max border-collapse text-left text-sm ${definition.reportId === 'orders-master' ? 'hidden sm:table print:table' : ''}`}><thead className="sticky top-0 z-10 bg-[#faf7f3]"><tr>{columns.map(column=><th key={column.key} aria-sort={sortKey===column.key?direction==='asc'?'ascending':'descending':'none'} className={`whitespace-nowrap border-b border-neutral-200 px-3 py-3 text-xs font-bold text-neutral-600 ${['money','number'].includes(column.type)?'text-right':''}`}><button title="Sort this loaded page only" onClick={()=>scope.update({sort:column.key,direction:sortKey===column.key&&direction==='asc'?'desc':'asc'},false)}>{column.label}{sortKey===column.key?(direction==='asc'?' ↑':' ↓'):''}</button></th>)}{definition.detailReport&&<th className="px-3 py-3 text-xs print:hidden">Details</th>}</tr></thead><tbody>{rows.map((row,index)=><tr key={index} className="border-b border-neutral-100 hover:bg-[#fffdf9]">{columns.map(column=><td key={column.key} className={`max-w-[320px] px-3 py-3 ${['money','number'].includes(column.type)?'text-right font-mono tabular-nums':'font-medium'}`}><span className={column.type==='text'?'block whitespace-normal':'whitespace-nowrap'}>{cell(row,column)}</span></td>)}{definition.detailReport&&<td className="px-3 py-3 print:hidden">{Boolean(row.orderNumber||row.invoiceNumber||row.reference)&&<button onClick={()=>scope.update({bill:String(row.orderNumber||row.invoiceNumber||row.reference)},false)} className="rounded-lg border px-3 py-2 text-xs font-bold">View details</button>}</td>}</tr>)}</tbody></table></div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 p-4 print:hidden"><p className="text-xs text-neutral-500">Page {response.pagination.page} of {response.pagination.totalPages}</p><div className="flex gap-2"><button disabled={scope.page<=1||result.loading} onClick={()=>scope.update({page:String(Math.max(1,scope.page-1)),bill:null},false)} className="inline-flex h-11 items-center gap-1 rounded-lg border px-3 text-sm font-bold disabled:opacity-40"><ChevronLeft size={16}/> Previous</button><button disabled={!response.pagination.hasNextPage||result.loading} onClick={()=>scope.update({page:String(scope.page+1),bill:null},false)} className="inline-flex h-11 items-center gap-1 rounded-lg border px-3 text-sm font-bold disabled:opacity-40">Next <ChevronRight size={16}/></button></div></div>
      </section>
    </>}
  </div>;
}
