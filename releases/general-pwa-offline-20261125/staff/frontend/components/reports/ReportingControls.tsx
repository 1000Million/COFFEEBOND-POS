import { useRef } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { useReportingScope } from '../../lib/useReportingScope';
import type { ReportingFilterOptions, ReportingSummary } from '../../lib/reporting';
import { formatReportValue } from '../../lib/reporting';
import { EMPTY_FILTERS, FILTER_LABELS, shiftReportingDate } from '../../lib/reportingUi';
type Scope = ReturnType<typeof useReportingScope>;
const inputClass = 'mt-1 h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm font-semibold';
export function ReportingControls({ scope, options, refresh, loading, scopeOnly = false }: { scope: Scope; options?: ReportingFilterOptions; refresh: () => void; loading?: boolean; scopeOnly?: boolean }) {
  const from = useRef<HTMLInputElement>(null);
  const presets = [['Today', scope.today, scope.today], ...(!scope.cashier ? [['Yesterday', shiftReportingDate(scope.today, -1), shiftReportingDate(scope.today, -1)], ['Last 7 Days', shiftReportingDate(scope.today, -6), scope.today], ['This Month', `${scope.today.slice(0, 7)}-01`, scope.today]] : [])];
  const filterOptions: Record<keyof typeof EMPTY_FILTERS, Array<{ value: string; label: string }>> = {
    source: (options?.sources || []).map(v => ({ value: v, label: v })), orderType: (options?.orderTypes || []).map(v => ({ value: v, label: v })), paymentMethod: (options?.paymentMethods || []).map(v => ({ value: v, label: v })), staffName: (options?.staff || []).map(v => ({ value: v, label: v })), category: (options?.categories || []).map(v => ({ value: v, label: v })), itemCode: (options?.items || []).map(v => ({ value: v.code, label: v.name })), orderStatus: ['COMPLETED', 'VOIDED', 'CANCELLED'].map(v => ({ value: v, label: v })), commercialStatus: ['PAID', 'COMPLIMENTARY', 'VOIDED', 'UNPAID'].map(v => ({ value: v, label: v })),
  };
  const selectedFilters = Object.entries(scope.filters).filter(([,v]) => v !== 'ALL');
  return <section aria-label="Reporting filters" className="rounded-2xl border border-[#e5d9cd] bg-white p-4 shadow-sm print:hidden">
    <div className="flex flex-wrap items-center gap-2">
      {presets.map(([label, start, end]) => <button key={label} aria-pressed={scope.startDate === start && scope.endDate === end} onClick={() => scope.update({ startDate: start, endDate: end })} className={`rounded-full border px-3 py-2 text-sm font-bold ${scope.startDate === start && scope.endDate === end ? 'border-[#3e2723] bg-[#3e2723] text-white' : 'border-neutral-200 text-neutral-600'}`}>{label}</button>)}
      {!scope.cashier && <button onClick={() => from.current?.focus()} className="rounded-full border border-neutral-200 px-3 py-2 text-sm font-bold">Custom</button>}
      <button onClick={scope.reset} className="ml-auto inline-flex items-center gap-1.5 px-2 py-2 text-sm font-bold text-[#5c4033]"><RotateCcw size={15}/> Reset filters</button>
      <button onClick={() => { scope.retryStores(); refresh(); }} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-bold disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''}/> Refresh</button>
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <label className="text-xs font-bold text-neutral-600">Store<select aria-label="Store" value={scope.storeId} disabled={scope.cashier} onChange={e => scope.update({ storeId: e.target.value })} className={inputClass}>{!scope.cashier && <option value="ALL">All accessible stores</option>}{scope.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="text-xs font-bold text-neutral-600">From<input ref={from} type="date" value={scope.startDate} max={scope.endDate} disabled={scope.cashier} onChange={e => scope.update({ startDate: e.target.value })} className={inputClass}/></label>
      <label className="text-xs font-bold text-neutral-600">To<input type="date" value={scope.endDate} min={scope.startDate} max={scope.today} disabled={scope.cashier} onChange={e => scope.update({ endDate: e.target.value })} className={inputClass}/></label>
    </div>
    {!scopeOnly && <details className="mt-3" open={selectedFilters.length > 0 || undefined}><summary className="cursor-pointer text-sm font-bold text-[#5c4033]">More filters · {selectedFilters.length ? `${selectedFilters.length} applied` : 'All sources, payments and statuses'}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Object.entries(FILTER_LABELS).map(([key, label]) => { const k = key as keyof typeof EMPTY_FILTERS; const values = filterOptions[k]; return <label key={key} className="text-xs font-bold text-neutral-600">{label}<select aria-label={label} value={scope.filters[k]} onChange={e => scope.update({ [key]: e.target.value })} className={inputClass}><option value="ALL">All</option>{scope.filters[k] !== 'ALL' && !values.some(v => v.value === scope.filters[k]) && <option value={scope.filters[k]}>{scope.filters[k]}</option>}{values.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label>; })}</div><p className="mt-2 text-xs text-neutral-500">These filters apply to POS bills. Online activity follows store and dates only. Reset clears dates, store and report filters.</p></details>}
  </section>;
}
export function ReportingMetrics({ summary }: { summary: ReportingSummary }) {
  return <section aria-label="Report totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
    ['Sales incl. GST', formatReportValue(summary.netSales, 'money'), 'Completed paid bills, after discounts'], ['Net collections', formatReportValue(summary.netCollections, 'money'), 'Server total after recorded reversals'], ['Paid bills', formatReportValue(summary.orderCount, 'number'), 'Completed commercial bills'], ['Average paid bill incl. GST', formatReportValue(summary.averageOrderValue, 'money'), 'Server average for completed paid bills'],
  ].map(([label, value, help]) => <div key={label} className="rounded-xl border border-[#e5d9cd] bg-white p-4"><p className="text-xs font-bold text-neutral-500">{label}</p><p className="mt-2 font-mono text-xl font-black tabular-nums text-[#3e2723]">{value}</p><p className="mt-1 text-xs text-neutral-500">{help}</p></div>)}</section>;
}
export function ReportingScopeLabel({ scope }: { scope: Scope }) { return <p className="mt-2 text-sm font-semibold text-neutral-600">{scope.storeLabel} · {scope.startDate} to {scope.endDate} · Asia/Kolkata (IST)</p>; }
