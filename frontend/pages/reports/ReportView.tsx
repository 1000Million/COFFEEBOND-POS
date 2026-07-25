import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  Filter,
  Loader2,
  Printer,
  RefreshCw,
  Star,
} from 'lucide-react';
import { REPORT_REGISTRY } from '../../../functions/reportingCore.mjs';
import { useAuth } from '../../contexts/AuthContext';
import {
  formatReportValue,
  getReportingExport,
  getReportingRows,
  reportingErrorMessage,
  type ReportColumn,
  type ReportDefinition,
  type ReportingRequest,
  type ReportingResponse,
} from '../../lib/reporting';
import { downloadReportingCsv, downloadReportingXlsx } from '../../lib/reportExports';

const FAVOURITES_KEY = 'coffee-bond-report-favourites';
const RECENTS_KEY = 'coffee-bond-report-recents';
const PAGE_SIZE = 50;

function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shiftIso(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function readIds(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(reportId: string) {
  const next = [reportId, ...readIds(RECENTS_KEY).filter(value => value !== reportId)].slice(0, 8);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'green' | 'amber' | 'red' }) {
  const styles = {
    default: 'border-[#e5d9cd] bg-white text-[#3e2723]',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-rose-200 bg-rose-50 text-rose-900',
  }[tone];
  return (
    <div className={`rounded-xl border p-3.5 ${styles}`}>
      <p className="text-[10px] font-black uppercase tracking-wider opacity-60">{label}</p>
      <p className="mt-1.5 font-mono text-xl font-black">{value}</p>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0 text-[10px] font-black uppercase tracking-wider text-neutral-500">
      {label}
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-xs font-bold normal-case tracking-normal outline-none focus:border-[#5c4033]"
      >
        <option value="ALL">All</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

export default function ReportView() {
  const { reportId = '' } = useParams();
  const { staffProfile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayIso();
  const isCashier = staffProfile?.role === 'CASHIER';
  const definition = (REPORT_REGISTRY as ReportDefinition[]).find(report => report.reportId === reportId) || null;
  const [startDate, setStartDate] = useState(searchParams.get('startDate') || (isCashier ? today : shiftIso(today, -6)));
  const [endDate, setEndDate] = useState(searchParams.get('endDate') || today);
  const [storeId, setStoreId] = useState(searchParams.get('storeId') || 'ALL');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    source: 'ALL',
    orderType: 'ALL',
    paymentMethod: 'ALL',
    staffName: 'ALL',
    category: 'ALL',
    itemCode: 'ALL',
    orderStatus: 'ALL',
    commercialStatus: 'ALL',
  });
  const [response, setResponse] = useState<ReportingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'CSV' | 'XLSX' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [favourites, setFavourites] = useState<string[]>(() => readIds(FAVOURITES_KEY));

  const request = useMemo<ReportingRequest>(() => ({
    reportId,
    storeIds: storeId === 'ALL' ? [] : [storeId],
    startDate: isCashier ? today : startDate,
    endDate: isCashier ? today : endDate,
    page,
    pageSize: PAGE_SIZE,
    filters,
  }), [endDate, filters, isCashier, page, reportId, startDate, storeId, today]);

  const loadReport = useCallback(async () => {
    if (!definition || !staffProfile) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getReportingRows(request);
      setResponse(data);
      rememberRecent(reportId);
      if (isCashier && storeId === 'ALL' && data.selectedStoreIds.length === 1) {
        setStoreId(data.selectedStoreIds[0]);
      }
      setSearchParams({
        startDate: data.startDate,
        endDate: data.endDate,
        storeId: data.selectedStoreIds.length === data.accessibleStores.length ? 'ALL' : data.selectedStoreIds[0] || 'ALL',
      }, { replace: true });
    } catch (loadError) {
      setResponse(null);
      setError(reportingErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [definition, isCashier, reportId, request, setSearchParams, staffProfile, storeId]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  useEffect(() => {
    setPage(1);
  }, [endDate, filters, startDate, storeId]);

  const sortedRows = useMemo(() => {
    if (!response || !sort) return response?.rows || [];
    return [...response.rows].sort((left, right) => {
      const leftValue = left[sort.key];
      const rightValue = right[sort.key];
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [response, sort]);

  const appliedFilterChips = useMemo(() => Object.entries(filters)
    .filter(([, value]) => value !== 'ALL')
    .map(([key, value]) => ({
      key,
      label: `${key.replace(/([A-Z])/g, ' $1')}: ${value}`,
    })), [filters]);

  const toggleFavourite = () => {
    setFavourites(current => {
      const next = current.includes(reportId)
        ? current.filter(value => value !== reportId)
        : [...current, reportId];
      localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
      return next;
    });
  };

  const handleExport = async (format: 'CSV' | 'XLSX') => {
    setExporting(format);
    setError(null);
    try {
      const data = await getReportingExport({ ...request, page: undefined, pageSize: undefined });
      if (format === 'CSV') downloadReportingCsv(data);
      else downloadReportingXlsx(data);
    } catch (exportError) {
      setError(reportingErrorMessage(exportError));
    } finally {
      setExporting(null);
    }
  };

  const updateFilter = (key: keyof typeof filters, value: string) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const toggleSort = (column: ReportColumn) => {
    setSort(current => current?.key === column.key
      ? { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key: column.key, direction: 'asc' });
  };

  if (!definition || !staffProfile) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center">
        <AlertTriangle className="mx-auto text-rose-600" />
        <h1 className="mt-3 text-xl font-black">Report not found</h1>
        <Link to="/reports" className="mt-4 inline-flex rounded-xl bg-[#3e2723] px-4 py-2 text-sm font-black text-white">Back to Reports</Link>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4 pb-20 print:p-0">
      <header className="rounded-2xl border border-[#e4d8cb] bg-white p-4 shadow-sm print:border-0 print:p-0 print:shadow-none">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-3">
            <Link to="/reports" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-600 print:hidden">
              <ArrowLeft size={19} />
            </Link>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-wider text-[#7a5a48]">{definition.group}</p>
              <h1 className="mt-1 text-2xl font-black text-[#321f1b]">{definition.title}</h1>
              <p className="mt-1 text-sm text-neutral-500">{definition.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <button onClick={toggleFavourite} className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-black">
              <Star size={16} className={favourites.includes(reportId) ? 'fill-amber-400 text-amber-500' : ''} />
              Favourite
            </button>
            <button onClick={() => window.print()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-black">
              <Printer size={16} /> Print
            </button>
            {definition.supportsExport && staffProfile.role !== 'CASHIER' && (
              <>
                <button disabled={Boolean(exporting)} onClick={() => handleExport('CSV')} className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-black disabled:opacity-50">
                  {exporting === 'CSV' ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />} CSV
                </button>
                <button disabled={Boolean(exporting)} onClick={() => handleExport('XLSX')} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#3e2723] px-3 text-sm font-black text-white disabled:opacity-50">
                  {exporting === 'XLSX' ? <Loader2 className="animate-spin" size={16} /> : <FileDown size={16} />} XLSX
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-3 border-t border-neutral-100 pt-4 sm:grid-cols-2 lg:grid-cols-4 print:hidden">
          <label className="text-[10px] font-black uppercase tracking-wider text-neutral-500">
            From
            <input type="date" value={isCashier ? today : startDate} disabled={isCashier} max={endDate} onChange={event => setStartDate(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-neutral-200 px-3 text-xs font-bold normal-case tracking-normal" />
          </label>
          <label className="text-[10px] font-black uppercase tracking-wider text-neutral-500">
            To
            <input type="date" value={isCashier ? today : endDate} disabled={isCashier} min={startDate} max={today} onChange={event => setEndDate(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-neutral-200 px-3 text-xs font-bold normal-case tracking-normal" />
          </label>
          <label className="text-[10px] font-black uppercase tracking-wider text-neutral-500">
            Store
            <select value={storeId} disabled={isCashier} onChange={event => setStoreId(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-xs font-bold normal-case tracking-normal">
              {!isCashier && <option value="ALL">All accessible stores</option>}
              {(response?.accessibleStores || []).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </label>
          <button onClick={loadReport} disabled={loading} className="mt-auto inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#5c4033]/25 text-xs font-black text-[#5c4033] disabled:opacity-50">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800">
          <AlertTriangle className="mt-0.5 shrink-0" size={18} /> {error}
        </div>
      )}

      {loading && !response ? (
        <div className="flex min-h-72 items-center justify-center rounded-2xl border border-[#e4d8cb] bg-white">
          <Loader2 className="animate-spin text-[#5c4033]" size={30} />
        </div>
      ) : response?.availabilityStatus === 'DATA_CAPTURE_REQUIRED' ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center">
          <AlertTriangle className="mx-auto text-amber-600" size={30} />
          <h2 className="mt-3 text-xl font-black text-amber-950">Data capture required</h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm font-semibold text-amber-800">{response.unavailableReason}</p>
        </div>
      ) : response ? (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Metric label="Net sales" value={formatReportValue(response.summary.netSales, 'money')} tone="green" />
            <Metric label="Collections" value={formatReportValue(response.summary.netCollections, 'money')} />
            <Metric label="Orders" value={formatReportValue(response.summary.orderCount, 'number')} />
            <Metric label="Average order" value={formatReportValue(response.summary.averageOrderValue, 'money')} />
            <Metric label="Complimentary" value={`${response.summary.complimentaryOrderCount} · ${formatReportValue(response.summary.complimentaryMenuValue, 'money')}`} tone="amber" />
            <Metric label="Voided" value={`${response.summary.voidOrderCount} · ${formatReportValue(response.summary.voidedOrderValue, 'money')}`} tone="red" />
          </section>

          <section className="rounded-2xl border border-[#e4d8cb] bg-white shadow-sm print:hidden">
            <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3">
              <Filter size={16} className="text-[#5c4033]" />
              <h2 className="text-sm font-black">Report filters</h2>
              <span className="ml-auto text-xs font-semibold text-neutral-400">Filters apply on the server</span>
            </div>
            <div className="grid gap-3 p-4 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-8">
              <SelectFilter label="Source" value={filters.source} options={response.filterOptions.sources.map(value => ({ value, label: value }))} onChange={value => updateFilter('source', value)} />
              <SelectFilter label="Order type" value={filters.orderType} options={response.filterOptions.orderTypes.map(value => ({ value, label: value }))} onChange={value => updateFilter('orderType', value)} />
              <SelectFilter label="Payment" value={filters.paymentMethod} options={response.filterOptions.paymentMethods.map(value => ({ value, label: value }))} onChange={value => updateFilter('paymentMethod', value)} />
              <SelectFilter label="Biller" value={filters.staffName} options={response.filterOptions.staff.map(value => ({ value, label: value }))} onChange={value => updateFilter('staffName', value)} />
              <SelectFilter label="Category" value={filters.category} options={response.filterOptions.categories.map(value => ({ value, label: value }))} onChange={value => updateFilter('category', value)} />
              <SelectFilter label="Item" value={filters.itemCode} options={response.filterOptions.items.map(item => ({ value: item.code, label: item.name }))} onChange={value => updateFilter('itemCode', value)} />
              <SelectFilter label="Order status" value={filters.orderStatus} options={['COMPLETED', 'VOIDED', 'CANCELLED'].map(value => ({ value, label: value }))} onChange={value => updateFilter('orderStatus', value)} />
              <SelectFilter label="Commercial" value={filters.commercialStatus} options={['PAID', 'COMPLIMENTARY', 'VOIDED', 'UNPAID'].map(value => ({ value, label: value }))} onChange={value => updateFilter('commercialStatus', value)} />
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#e4d8cb] bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
              <div>
                <h2 className="font-black text-[#3e2723]">{response.report.title}</h2>
                <p className="text-xs text-neutral-500">
                  {response.startDate} to {response.endDate} · {response.pagination.totalRows.toLocaleString('en-IN')} filtered rows
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {response.selectedStoreIds.map(storeId => (
                  <span key={storeId} className="rounded-full bg-[#f3ece5] px-2.5 py-1 text-[10px] font-black text-[#5c4033]">
                    {response.accessibleStores.find(store => store.id === storeId)?.name || storeId}
                  </span>
                ))}
                {appliedFilterChips.map(chip => (
                  <span key={chip.key} className="rounded-full bg-neutral-100 px-2.5 py-1 text-[10px] font-black capitalize text-neutral-600">
                    {chip.label}
                  </span>
                ))}
              </div>
            </div>

            {sortedRows.length === 0 ? (
              <div className="p-12 text-center">
                <p className="font-black">No rows match the selected filters.</p>
                <p className="mt-1 text-sm text-neutral-500">Try a wider date range or clear a report filter.</p>
              </div>
            ) : (
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-left text-xs">
                  <thead className="bg-[#faf7f3]">
                    <tr>
                      {response.columns.map(column => (
                        <th key={column.key} className="whitespace-nowrap border-b border-neutral-200 px-3 py-3 font-black text-neutral-600">
                          <button onClick={() => toggleSort(column)} className="inline-flex items-center gap-1 hover:text-[#3e2723]">
                            {column.label}
                            {sort?.key === column.key && <span>{sort.direction === 'asc' ? '↑' : '↓'}</span>}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, rowIndex) => (
                      <tr key={`${page}-${rowIndex}`} className="border-b border-neutral-100 last:border-0 hover:bg-[#fffdf9]">
                        {response.columns.map(column => (
                          <td key={column.key} className={`max-w-[320px] px-3 py-3 ${column.type === 'money' || column.type === 'number' ? 'text-right font-mono font-bold' : 'font-medium'}`}>
                            <span className={column.type === 'text' ? 'block whitespace-normal' : 'whitespace-nowrap'}>
                              {formatReportValue(row[column.key], column.type)}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 print:hidden">
              <p className="text-xs font-semibold text-neutral-500">Page {response.pagination.page} of {response.pagination.totalPages}</p>
              <div className="flex gap-2">
                <button disabled={page <= 1 || loading} onClick={() => setPage(current => Math.max(1, current - 1))} className="flex h-9 items-center gap-1 rounded-lg border border-neutral-200 px-3 text-xs font-black disabled:opacity-35">
                  <ChevronLeft size={15} /> Previous
                </button>
                <button disabled={!response.pagination.hasNextPage || loading} onClick={() => setPage(current => current + 1)} className="flex h-9 items-center gap-1 rounded-lg border border-neutral-200 px-3 text-xs font-black disabled:opacity-35">
                  Next <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
