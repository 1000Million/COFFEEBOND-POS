import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  Search,
  Star,
  Store as StoreIcon,
} from 'lucide-react';
import { REPORT_REGISTRY } from '../../../functions/reportingCore.mjs';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import type { Store } from '../../types';
import type { ReportDefinition } from '../../lib/reporting';
import { accessiblePosStores, assignedStoreIdentifiers } from '../../lib/posStoreAccess';

const FAVOURITES_KEY = 'coffee-bond-report-favourites';
const RECENTS_KEY = 'coffee-bond-report-recents';

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

function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function readIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

const groupTone: Record<string, string> = {
  Sales: 'bg-emerald-50 text-emerald-800',
  'Items & Categories': 'bg-amber-50 text-amber-800',
  'Orders & Invoices': 'bg-blue-50 text-blue-800',
  Payments: 'bg-violet-50 text-violet-800',
  'Discounts & Exceptions': 'bg-rose-50 text-rose-800',
  'Online & Customers': 'bg-cyan-50 text-cyan-800',
};

export default function ReportsHome() {
  const { staffProfile } = useAuth();
  const today = todayIso();
  const isCashier = staffProfile?.role === 'CASHIER';
  const [search, setSearch] = useState('');
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('ALL');
  const [startDate, setStartDate] = useState(isCashier ? today : shiftIso(today, -6));
  const [endDate, setEndDate] = useState(today);
  const [favourites, setFavourites] = useState<string[]>(() => readIds(FAVOURITES_KEY));
  const [recents] = useState<string[]>(() => readIds(RECENTS_KEY));

  useEffect(() => {
    let active = true;
    const loadStores = async () => {
      if (!staffProfile) return [];
      if (staffProfile.role === 'ADMIN') {
        const snapshot = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        return snapshot.docs.map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
      }
      const snapshots = await Promise.all(
        assignedStoreIdentifiers(staffProfile)
          .map(storeId => getDoc(doc(db, 'stores', storeId)).catch(() => null)),
      );
      return snapshots
        .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot?.exists()))
        .map(snapshot => ({ id: snapshot.id, ...snapshot.data() } as Store));
    };
    loadStores()
      .then(loaded => {
        if (!active) return;
        setStores(loaded);
      })
      .catch(error => console.error('Failed to load report stores', error));
    return () => { active = false; };
  }, [staffProfile]);

  const accessibleStores = useMemo(() => {
    return accessiblePosStores(stores, staffProfile);
  }, [staffProfile, stores]);

  useEffect(() => {
    if (!isCashier || accessibleStores.length === 0) return;
    setSelectedStoreId(accessibleStores[0].id);
    setStartDate(today);
    setEndDate(today);
  }, [accessibleStores, isCashier, today]);

  const allowedReports = useMemo(() => {
    if (!staffProfile) return [];
    const normalizedSearch = search.trim().toLowerCase();
    return (REPORT_REGISTRY as ReportDefinition[]).filter(report => (
      report.allowedRoles.includes(staffProfile.role as 'ADMIN' | 'STORE_MANAGER' | 'CASHIER')
      && (!normalizedSearch || `${report.title} ${report.description} ${report.group}`.toLowerCase().includes(normalizedSearch))
    ));
  }, [search, staffProfile]);

  const groupedReports = useMemo(() => {
    return allowedReports.reduce<Record<string, ReportDefinition[]>>((groups, report) => {
      if (!groups[report.group]) groups[report.group] = [];
      groups[report.group].push(report);
      return groups;
    }, {});
  }, [allowedReports]);

  const favouriteReports = allowedReports.filter(report => favourites.includes(report.reportId));
  const recentReports = recents
    .map(reportId => allowedReports.find(report => report.reportId === reportId))
    .filter((report): report is ReportDefinition => Boolean(report))
    .slice(0, 4);

  const toggleFavourite = (reportId: string) => {
    setFavourites(current => {
      const next = current.includes(reportId)
        ? current.filter(value => value !== reportId)
        : [...current, reportId];
      localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
      return next;
    });
  };

  const reportUrl = (reportId: string) => {
    const queryParams = new URLSearchParams({
      startDate,
      endDate,
      storeId: selectedStoreId,
    });
    return `/reports/${reportId}?${queryParams.toString()}`;
  };

  const applyPreset = (preset: 'TODAY' | 'YESTERDAY' | 'LAST_7' | 'CURRENT_MONTH' | 'PREVIOUS_MONTH') => {
    if (preset === 'TODAY') {
      setStartDate(today);
      setEndDate(today);
    } else if (preset === 'YESTERDAY') {
      const yesterday = shiftIso(today, -1);
      setStartDate(yesterday);
      setEndDate(yesterday);
    } else if (preset === 'LAST_7') {
      setStartDate(shiftIso(today, -6));
      setEndDate(today);
    } else if (preset === 'CURRENT_MONTH') {
      setStartDate(monthStart(today));
      setEndDate(today);
    } else {
      const currentStart = new Date(`${monthStart(today)}T12:00:00Z`);
      currentStart.setUTCDate(0);
      const previousEnd = currentStart.toISOString().slice(0, 10);
      setStartDate(monthStart(previousEnd));
      setEndDate(previousEnd);
    }
  };

  if (!staffProfile) return null;

  return (
    <div className="min-w-0 space-y-6 pb-20 text-neutral-900">
      <section className="overflow-hidden rounded-2xl border border-[#e5d9cd] bg-white shadow-sm">
        <div className="flex flex-col gap-5 border-b border-[#eadfd5] bg-[#fffdf9] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[#5c4033]">
              <BarChart3 size={21} />
              <p className="text-xs font-black uppercase tracking-[0.2em]">Coffee Bond Operations</p>
            </div>
            <h1 className="mt-2 text-3xl font-black text-[#321f1b]">Reporting Centre</h1>
            <p className="mt-1 max-w-2xl text-sm font-medium text-neutral-500">
              Reconciled sales, items, invoices, payments, exceptions, and customer-order reporting.
            </p>
            <p className="mt-1 text-xs font-semibold text-neutral-400">
              Add-on Sales: Voided and complimentary orders are excluded from commercial sales and shown separately.
            </p>
          </div>
          <div className="rounded-xl border border-[#eadfd5] bg-white px-4 py-3 text-sm">
            <p className="font-black text-[#3e2723]">{staffProfile.displayName || staffProfile.name}</p>
            <p className="text-xs font-semibold text-neutral-500">{staffProfile.role.replace('_', ' ')} · store-scoped access</p>
          </div>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr]">
          <label className="text-xs font-black uppercase tracking-wider text-neutral-500">
            From
            <div className="relative mt-1.5">
              <CalendarDays className="absolute left-3 top-3 text-neutral-400" size={17} />
              <input
                type="date"
                value={startDate}
                max={endDate}
                disabled={isCashier}
                onChange={event => setStartDate(event.target.value)}
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white pl-10 pr-3 text-sm font-bold outline-none focus:border-[#5c4033]"
              />
            </div>
          </label>
          <label className="text-xs font-black uppercase tracking-wider text-neutral-500">
            To
            <div className="relative mt-1.5">
              <CalendarDays className="absolute left-3 top-3 text-neutral-400" size={17} />
              <input
                type="date"
                value={endDate}
                min={startDate}
                max={today}
                disabled={isCashier}
                onChange={event => setEndDate(event.target.value)}
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white pl-10 pr-3 text-sm font-bold outline-none focus:border-[#5c4033]"
              />
            </div>
          </label>
          <label className="text-xs font-black uppercase tracking-wider text-neutral-500">
            Store
            <div className="relative mt-1.5">
              <StoreIcon className="absolute left-3 top-3 text-neutral-400" size={17} />
              <select
                value={selectedStoreId}
                disabled={isCashier}
                onChange={event => setSelectedStoreId(event.target.value)}
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white pl-10 pr-8 text-sm font-bold outline-none focus:border-[#5c4033]"
              >
                {!isCashier && <option value="ALL">All accessible stores</option>}
                {accessibleStores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </div>
          </label>
        </div>

        {!isCashier && (
          <div className="flex flex-wrap gap-2 border-t border-neutral-100 px-4 py-3">
            {[
              ['TODAY', 'Today'],
              ['YESTERDAY', 'Yesterday'],
              ['LAST_7', 'Last 7 days'],
              ['CURRENT_MONTH', 'Current month'],
              ['PREVIOUS_MONTH', 'Previous month'],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => applyPreset(value as Parameters<typeof applyPreset>[0])}
                className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs font-black text-neutral-600 hover:border-[#5c4033]/30 hover:text-[#5c4033]"
              >
                {label}
              </button>
            ))}
            <Link to="/reports/day-close" className="ml-auto rounded-full bg-[#3e2723] px-3 py-1.5 text-xs font-black text-white">
              Day Close
            </Link>
            <Link to="/reports/audit-control" className="rounded-full border border-[#5c4033]/25 px-3 py-1.5 text-xs font-black text-[#5c4033]">
              Audit & Control
            </Link>
          </div>
        )}
      </section>

      <div className="relative">
        <Search className="absolute left-4 top-3.5 text-neutral-400" size={20} />
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search reports by title, group, or purpose"
          className="h-12 w-full rounded-xl border border-[#e5d9cd] bg-white pl-12 pr-4 text-sm font-semibold shadow-sm outline-none focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
        />
      </div>

      {(favouriteReports.length > 0 || recentReports.length > 0) && !search && (
        <div className="grid gap-4 lg:grid-cols-2">
          {favouriteReports.length > 0 && (
            <section className="rounded-2xl border border-[#e6dacd] bg-white p-4">
              <div className="mb-3 flex items-center gap-2">
                <Star className="fill-amber-400 text-amber-500" size={18} />
                <h2 className="font-black text-[#3e2723]">Favourites</h2>
              </div>
              <div className="space-y-2">
                {favouriteReports.slice(0, 4).map(report => (
                  <Link key={report.reportId} to={reportUrl(report.reportId)} className="flex items-center justify-between rounded-xl bg-[#faf7f3] px-3 py-2.5 text-sm font-bold hover:bg-[#f4ece4]">
                    <span>{report.title}</span><ChevronRight size={16} />
                  </Link>
                ))}
              </div>
            </section>
          )}
          {recentReports.length > 0 && (
            <section className="rounded-2xl border border-[#e6dacd] bg-white p-4">
              <div className="mb-3 flex items-center gap-2">
                <Clock3 className="text-[#5c4033]" size={18} />
                <h2 className="font-black text-[#3e2723]">Recent reports</h2>
              </div>
              <div className="space-y-2">
                {recentReports.map(report => (
                  <Link key={report.reportId} to={reportUrl(report.reportId)} className="flex items-center justify-between rounded-xl bg-[#faf7f3] px-3 py-2.5 text-sm font-bold hover:bg-[#f4ece4]">
                    <span>{report.title}</span><ChevronRight size={16} />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {Object.entries(groupedReports).map(([group, reports]) => (
        <section key={group}>
          <div className="mb-3 flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-xs font-black ${groupTone[group] || 'bg-neutral-100 text-neutral-700'}`}>{group}</span>
            <div className="h-px flex-1 bg-neutral-200" />
            <span className="text-xs font-bold text-neutral-400">{reports.length} reports</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {reports.map(report => (
              <article key={report.reportId} className="flex min-h-44 flex-col rounded-2xl border border-[#e6dacd] bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f5eee7] text-[#5c4033]">
                    <FileSpreadsheet size={19} />
                  </div>
                  <button
                    onClick={() => toggleFavourite(report.reportId)}
                    aria-label={`${favourites.includes(report.reportId) ? 'Remove' : 'Add'} ${report.title} favourite`}
                    className="rounded-lg p-2 text-neutral-400 hover:bg-amber-50 hover:text-amber-500"
                  >
                    <Star size={18} className={favourites.includes(report.reportId) ? 'fill-amber-400 text-amber-500' : ''} />
                  </button>
                </div>
                <h3 className="mt-3 text-base font-black text-[#321f1b]">{report.title}</h3>
                <p className="mt-1 flex-1 text-sm leading-5 text-neutral-500">{report.description}</p>
                {report.availabilityStatus === 'CONDITIONAL' && (
                  <p className="mt-2 text-xs font-bold text-amber-700">Availability depends on captured source fields.</p>
                )}
                <Link
                  to={reportUrl(report.reportId)}
                  className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#3e2723] px-4 text-sm font-black text-white hover:bg-[#2a1714]"
                >
                  Open report <ChevronRight size={16} />
                </Link>
              </article>
            ))}
          </div>
        </section>
      ))}

      {allowedReports.length === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <Search className="mx-auto text-neutral-300" size={30} />
          <p className="mt-3 font-black">No reports match this search.</p>
          <p className="mt-1 text-sm text-neutral-500">Try a report title, group, or business topic.</p>
        </div>
      )}
    </div>
  );
}
