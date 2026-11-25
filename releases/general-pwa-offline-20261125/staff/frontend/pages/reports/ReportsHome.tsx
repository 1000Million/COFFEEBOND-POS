import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, Search, Star } from 'lucide-react';
import { REPORT_REGISTRY } from '../../../functions/reportingCore.mjs';
import { useAuth } from '../../contexts/AuthContext';
import type { StaffProfile } from '../../types';
import { getReportingSummary, formatReportValue, type ReportDefinition } from '../../lib/reporting';
import { reportingAccessKey } from '../../lib/reportingUi';
import { useReportingResult, useReportingScope } from '../../lib/useReportingScope';
import { ReportingControls, ReportingScopeLabel } from '../../components/reports/ReportingControls';
import PerformanceDashboard from '../../components/reports/PerformanceDashboard';

const FAVOURITES_KEY = 'coffee-bond-report-favourites';
const RECENTS_KEY = 'coffee-bond-report-recents';
function readIds(key: string): string[] { try { const ids = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(ids) ? ids.filter(v => typeof v === 'string') : []; } catch { return []; } }
export default function ReportsHome() {
  const { staffProfile } = useAuth();
  if (!staffProfile || staffProfile.isActive === false || !['ADMIN', 'STORE_MANAGER', 'CASHIER'].includes(staffProfile.role)) return <p role="alert">Your account cannot access the internal Reporting Centre.</p>;
  return <Overview key={reportingAccessKey(staffProfile)} profile={staffProfile}/>;
}
function Overview({ profile }: { profile: StaffProfile }) {
  const definition = (REPORT_REGISTRY as ReportDefinition[]).find(r => r.reportId === 'payment-collection')!;
  const scope = useReportingScope(profile, definition);
  const summaryRequest = { ...scope.request, summaryOnly: true, includeDashboard: false, page: undefined, pageSize: undefined };
  const result = useReportingResult(JSON.stringify(summaryRequest), scope.canQuery, () => getReportingSummary(summaryRequest));
  const [dashboardScope,setDashboardScope]=useState('');
  const dashboardKey=JSON.stringify(scope.request);
  const dashboard=useReportingResult(dashboardKey,scope.canQuery&&dashboardScope===dashboardKey&&!!result.data,()=>getReportingSummary({...scope.request,includeDashboard:true}));
  const [search, setSearch] = useState('');
  const [favourites, setFavourites] = useState(() => readIds(FAVOURITES_KEY));
  const [recents] = useState(() => readIds(RECENTS_KEY));
  const allowed = useMemo(() => (REPORT_REGISTRY as ReportDefinition[]).filter(r => r.allowedRoles.includes(profile.role as never)), [profile.role]);
  const filtered = allowed.filter(r => `${r.title} ${r.description} ${r.group}`.toLowerCase().includes(search.trim().toLowerCase()));
  const groups = [...new Set(filtered.map(r => r.group))];
  const url = (path: string) => { const p = new URLSearchParams(scope.params); for (const key of ['page', 'bill', 'q', 'sort', 'direction']) p.delete(key); return `${path}?${p}`; };
  const reportUrl = (id: string) => url(`/reports/${id}`);
  const toggle = (id: string) => setFavourites(current => { const next = current.includes(id) ? current.filter(v => v !== id) : [...current, id]; try { localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next)); } catch { /* Keep the current session usable. */ } return next; });
  const quick = [['orders-master', 'Bills', 'Review bills and payment status'], ['payment-collection', 'Payments', 'Tender receipts, reversals and collections'], ['item-wise-all-restaurants', 'Product Sales', 'Item quantities, sales and GST'], ['discount-report', 'Discounts', 'Discounted bills and captured reasons'], ['cancel-void-orders', 'Voids', 'Voided values and payment outcomes'], ['complimentary-orders', 'Complimentary', 'Menu value shown separately from sales']].filter(([id]) => allowed.some(r => r.reportId === id));
  const summary = result.data?.summary;
  return <div className="min-w-0 space-y-5 pb-16 text-neutral-900">
    <header className="rounded-2xl border border-[#e5d9cd] bg-[#fffdf9] p-5">
      <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#5c4033]"><BarChart3 size={18}/> Reporting Centre</p>
      <h1 className="mt-2 text-3xl font-black text-[#321f1b]">Overview</h1>
      <ReportingScopeLabel scope={scope}/>
      <p className="mt-2 text-xs text-neutral-500">{profile.displayName || profile.name} · {profile.role.replaceAll('_', ' ')}</p>
    </header>
    <ReportingControls scope={scope} options={result.data?.filterOptions} refresh={result.refresh} loading={result.loading}/>
    {(scope.scopeError || result.error) && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{scope.scopeError || result.error} <button onClick={() => { scope.retryStores(); result.refresh(); }} className="ml-2 font-bold underline">Retry</button></div>}
    {(!scope.canQuery && !scope.scopeError || result.loading) && <div role="status" className="rounded-xl border border-[#e5d9cd] bg-white p-8 text-center text-sm">Loading overview for {scope.storeLabel}…</div>}
    {summary && <>
      <PerformanceDashboard detailsPending={dashboardScope!==dashboardKey||dashboard.loading} data={dashboard.data?.dashboard} summary={summary} storeId={scope.storeId} storeLabel={scope.storeLabel} startDate={scope.startDate} endDate={scope.endDate}/>
      <div className="rounded-xl border border-[#e5d9cd] bg-white p-4 text-sm">
        <button className="min-h-11 rounded-lg border px-4 font-bold" disabled={dashboard.loading} onClick={()=>{setDashboardScope(dashboardKey);if(dashboardScope===dashboardKey)dashboard.refresh();}}>{dashboard.loading?'Loading comparisons and activity…':dashboard.data?'Refresh comparisons and activity':'Load comparisons and activity'}</button>
        {dashboard.error&&<p role="alert">{dashboard.error}</p>}
        {result.data?.summarySource==='SERVER_DAILY_EVENTUAL'&&<p className="mt-2 text-xs text-neutral-600">Server-maintained summary · updates may arrive after billing. Detailed rows and exports use canonical records. Summary projection as of {result.data.summaryAsOf?new Date(result.data.summaryAsOf).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}):'unavailable'} IST.</p>}
      </div>
      <div className="rounded-xl border border-[#e5d9cd] bg-white p-4 text-sm">
        <p className="font-semibold">Discounts {formatReportValue(summary.discounts, 'money')} · GST in sales {formatReportValue(summary.gstCollected, 'money')}</p>
        <p className="mt-2 text-neutral-600">{summary.complimentaryOrderCount} complimentary · menu value {formatReportValue(summary.complimentaryMenuValue, 'money')} &nbsp; {summary.voidOrderCount} voided · value {formatReportValue(summary.voidedOrderValue, 'money')} &nbsp; {summary.unpaidOrderCount} unpaid · {formatReportValue(summary.unpaidAmount, 'money')}</p>
        <p className="mt-2 text-xs text-neutral-500">Complimentary, voided and unpaid values are separate from sales. A void does not establish a completed refund. Collections include eligible unlinked online receipts.</p>
        <p className="mt-2 text-xs text-neutral-500">Data retrieved {new Date(result.data!.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · server totals for the selected scope</p>
        {result.data?.sourceOrderCount === 0 && <p role="status" className="mt-3 font-bold">No POS bills in this scope. Online collections, if present, remain included.</p>}
      </div>
    </>}
    <section aria-label="Daily reporting"><h2 className="mb-3 text-lg font-black text-[#3e2723]">Daily reporting</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{quick.map(([id,label,help]) => <Link key={id} to={reportUrl(id)} className="flex items-center justify-between rounded-xl border border-[#e5d9cd] bg-white p-4"><span><span className="block font-bold text-[#3e2723]">{label}</span><span className="mt-1 block text-xs text-neutral-500">{help}</span></span><ArrowRight size={18}/></Link>)}{profile.role !== 'CASHIER' && <Link to={url('/reports/day-close')} className="flex items-center justify-between rounded-xl bg-[#3e2723] p-4 text-white"><span><span className="block font-bold">Day Close</span><span className="mt-1 block text-xs">Open the existing day-closing workflow</span></span><ArrowRight size={18}/></Link>}</div></section>
    <details open={scope.params.get('catalogue') === 'open' || undefined} className="rounded-2xl border border-[#e5d9cd] bg-white p-4"><summary className="cursor-pointer text-lg font-black text-[#3e2723]">All reports · {allowed.length}</summary>
      <div className="relative mt-4"><Search className="absolute left-3 top-3 text-neutral-400" size={18}/><input aria-label="Search all reports" placeholder="Search all reports by name or purpose" value={search} onChange={e => setSearch(e.target.value)} className="h-11 w-full rounded-xl border border-neutral-300 pl-10 pr-3 text-sm"/></div>
      {!search && <div className="mt-3 flex flex-wrap gap-2">{allowed.filter(r => favourites.includes(r.reportId) || recents.includes(r.reportId)).slice(0,8).map(r => <Link key={r.reportId} to={reportUrl(r.reportId)} className="rounded-lg bg-[#f5eee7] px-3 py-2 text-xs font-bold">{favourites.includes(r.reportId) ? '★ ' : 'Recent · '}{r.title}</Link>)}</div>}
      {groups.map(group => <section key={group} className="mt-5"><h3 className="mb-2 text-sm font-black text-[#5c4033]">{group}</h3><div className="divide-y divide-neutral-100">{filtered.filter(r => r.group === group).map(r => <article key={r.reportId} className="flex items-center gap-3 py-3"><Link to={reportUrl(r.reportId)} className="min-w-0 flex-1"><span className="block text-sm font-bold">{r.title}</span><span className="mt-1 block text-xs text-neutral-500">{r.description}{r.availabilityStatus !== 'AVAILABLE' ? ' · Requires captured data' : ''}</span></Link><button onClick={() => toggle(r.reportId)} aria-label={`${favourites.includes(r.reportId) ? 'Remove' : 'Add'} ${r.title} favourite`} className="p-3 text-amber-600"><Star size={17} className={favourites.includes(r.reportId) ? 'fill-amber-400' : ''}/></button></article>)}</div></section>)}
      {!filtered.length && <p className="py-6 text-sm text-neutral-500">No reports match this search.</p>}
      {profile.role !== 'CASHIER' && <Link to={url('/reports/audit-control')} className="mt-4 inline-block text-sm font-bold text-[#5c4033] underline">Audit &amp; Control</Link>}
    </details>
  </div>;
}
