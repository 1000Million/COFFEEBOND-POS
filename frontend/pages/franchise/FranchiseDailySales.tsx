import { useEffect, useMemo, useState } from 'react';
import { updatePassword } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  LockKeyhole,
  LogOut,
  Printer,
  RefreshCw,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { auth, functions } from '../../lib/firebase';
import {
  downloadFranchiseSalesCsv,
  FranchiseDailySalesResponse,
} from '../../lib/franchiseSales';

const getDailySales = httpsCallable<
  { date: string; storeIds: string[] },
  FranchiseDailySalesResponse
>(functions, 'getFranchiseDailySales');

const manageViewer = httpsCallable<
  { action: 'SELF_PASSWORD_CHANGED' },
  { ok: boolean }
>(functions, 'manageFranchiseViewer');

const money = (value: number) => `₹${Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const todayInIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

const shiftDate = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-[#e7ddd3] bg-white p-4 shadow-sm">
      <p className="text-[11px] font-black uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="mt-2 text-2xl font-black text-[#3e2723]">{value}</p>
      {note && <p className="mt-1 text-xs text-neutral-500">{note}</p>}
    </div>
  );
}

function PasswordChangeGate() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Use at least 12 characters for the new password.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    if (!auth.currentUser) {
      setError('Your session expired. Sign in again.');
      return;
    }

    setSaving(true);
    try {
      await updatePassword(auth.currentUser, password);
      await manageViewer({ action: 'SELF_PASSWORD_CHANGED' });
      setPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setError(err?.code === 'auth/requires-recent-login'
        ? 'Sign out and sign in again before changing the temporary password.'
        : 'The password could not be changed. Please retry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-[#f7f1ea] p-4 flex items-center justify-center">
      <form onSubmit={handleChange} className="w-full max-w-md rounded-2xl border border-[#e5d9cc] bg-white p-6 shadow-lg">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-[#f3e8dd] text-[#5c4033]">
          <LockKeyhole size={22} />
        </div>
        <h1 className="text-2xl font-black text-[#3e2723]">Choose a new password</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          Replace the temporary password before opening franchise sales.
        </p>
        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
        <label className="mt-5 block text-xs font-black uppercase tracking-wider text-neutral-500">
          New password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            className="mt-2 h-12 w-full rounded-xl border border-neutral-200 px-4 text-base normal-case tracking-normal outline-none focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
          />
        </label>
        <label className="mt-4 block text-xs font-black uppercase tracking-wider text-neutral-500">
          Confirm password
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            className="mt-2 h-12 w-full rounded-xl border border-neutral-200 px-4 text-base normal-case tracking-normal outline-none focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
          />
        </label>
        <button
          disabled={saving}
          className="mt-6 flex h-12 w-full items-center justify-center rounded-xl bg-[#3e2723] font-black text-white disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save password'}
        </button>
      </form>
    </main>
  );
}

export default function FranchiseDailySales() {
  const { staffProfile, logout } = useAuth();
  const assignedStores = useMemo(
    () => staffProfile?.assignedStoreIds?.length
      ? staffProfile.assignedStoreIds
      : staffProfile?.storeIds || [],
    [staffProfile],
  );
  const [date, setDate] = useState(todayInIndia);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>(assignedStores);
  const [report, setReport] = useState<FranchiseDailySalesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setSelectedStoreIds((current) => {
      const valid = current.filter((storeId) => assignedStores.includes(storeId));
      return valid.length > 0 ? valid : assignedStores;
    });
  }, [assignedStores]);

  useEffect(() => {
    let active = true;
    if (staffProfile?.mustChangePassword || selectedStoreIds.length === 0) return undefined;
    setLoading(true);
    setError(null);
    getDailySales({ date, storeIds: selectedStoreIds })
      .then((result) => {
        if (active) setReport(result.data);
      })
      .catch((err: any) => {
        if (active) {
          setReport(null);
          setError(err?.message || 'Daily sales could not be loaded.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date, refreshKey, selectedStoreIds, staffProfile?.mustChangePassword]);

  if (!staffProfile) return null;
  if (staffProfile.mustChangePassword) return <PasswordChangeGate />;

  const storeNames = new Map(report?.stores.map((store) => [store.id, store.name]) || []);
  const toggleStore = (storeId: string) => {
    setSelectedStoreIds((current) => {
      if (!current.includes(storeId)) return [...current, storeId];
      if (current.length === 1) return current;
      return current.filter((id) => id !== storeId);
    });
  };
  const metrics = report?.metrics;

  return (
    <main className="min-h-[100dvh] bg-[#f7f1ea] text-neutral-900 print:bg-white">
      <header className="border-b border-[#e4d8cb] bg-white px-4 py-3 md:px-6 print:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <p className="text-lg font-black text-[#3e2723]">Coffee Bond</p>
            <p className="text-xs font-semibold text-neutral-500">Franchise Daily Sales</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700 sm:inline-flex">
              Read only
            </span>
            <button onClick={logout} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100" title="Sign out">
              <LogOut size={19} />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 md:px-6">
        <section className="rounded-2xl border border-[#e4d8cb] bg-white p-4 shadow-sm print:border-neutral-300 print:shadow-none">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck size={20} className="text-emerald-700" />
                <h1 className="text-2xl font-black text-[#3e2723]">Daily sales summary</h1>
              </div>
              <p className="mt-1 text-sm text-neutral-500">
                {staffProfile.displayName} · assigned stores only · {report?.timeZone || 'Asia/Kolkata'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <button
                onClick={() => setDate(shiftDate(date, -1))}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 bg-white"
                title="Previous day"
              >
                <ChevronLeft size={18} />
              </button>
              <label className="relative">
                <CalendarDays size={16} className="pointer-events-none absolute left-3 top-3 text-neutral-400" />
                <input
                  type="date"
                  value={date}
                  max={todayInIndia()}
                  onChange={(event) => setDate(event.target.value)}
                  className="h-10 rounded-xl border border-neutral-200 bg-white pl-9 pr-3 text-sm font-bold"
                />
              </label>
              <button
                onClick={() => setDate(shiftDate(date, 1))}
                disabled={date >= todayInIndia()}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 bg-white disabled:opacity-35"
                title="Next day"
              >
                <ChevronRight size={18} />
              </button>
              <button
                onClick={() => setRefreshKey((value) => value + 1)}
                disabled={loading}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-bold"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
              <button
                onClick={() => window.print()}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-bold"
              >
                <Printer size={16} />
                Print
              </button>
              {report?.permissions.exportSales && (
                <button
                  onClick={() => downloadFranchiseSalesCsv(report)}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#3e2723] px-3 text-sm font-bold text-white"
                >
                  <Download size={16} />
                  CSV
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 print:hidden">
            {assignedStores.length === 1 ? (
              <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[#d8c3b2] bg-[#fffaf5] px-3 text-sm font-bold text-[#5c4033]">
                <Store size={15} />
                {storeNames.get(assignedStores[0]) || assignedStores[0]}
              </span>
            ) : assignedStores.map((storeId) => (
              <button
                key={storeId}
                onClick={() => toggleStore(storeId)}
                className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-3 text-sm font-bold ${
                  selectedStoreIds.includes(storeId)
                    ? 'border-[#5c4033] bg-[#5c4033] text-white'
                    : 'border-neutral-200 bg-white text-neutral-600'
                }`}
              >
                <Store size={15} />
                {storeNames.get(storeId) || storeId}
              </button>
            ))}
          </div>
        </section>

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
            <AlertCircle size={19} className="shrink-0" />
            {error}
          </div>
        )}

        {loading && !report ? (
          <div className="flex min-h-64 items-center justify-center gap-3 text-sm font-bold text-neutral-500">
            <Loader2 className="animate-spin" size={20} />
            Loading assigned-store sales...
          </div>
        ) : metrics ? (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <MetricCard label="Gross menu value" value={money(metrics.grossMenuValue)} />
              <MetricCard label="Discounts" value={money(metrics.discounts)} />
              <MetricCard label="Net sales" value={money(metrics.netSales)} />
              <MetricCard label="Taxable sales" value={money(metrics.taxableSales)} />
              <MetricCard label="GST collected" value={money(metrics.gstCollected)} />
              <MetricCard label="Total collected" value={money(metrics.totalCollected)} />
              <MetricCard label="Paid transactions" value={String(metrics.paidTransactionCount)} />
              <MetricCard label="Average order value" value={money(metrics.averageOrderValue)} />
              <MetricCard label="Complimentary orders" value={String(metrics.complimentaryOrderCount)} note={money(metrics.complimentaryMenuValue)} />
              <MetricCard label="Voided orders" value={String(metrics.voidOrderCount)} note={money(metrics.voidedOrderValue)} />
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-[#e4d8cb] bg-white p-4">
                <h2 className="font-black text-[#3e2723]">Collections by tender</h2>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {Object.entries(metrics.paymentBreakdown).map(([method, total]) => (
                    <div key={method} className="rounded-xl bg-neutral-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-wider text-neutral-500">{method.replaceAll('_', ' ')}</p>
                      <p className="mt-1 font-black">{money(total)}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-neutral-500">{metrics.splitOrderCount} split-payment order(s)</p>
              </div>
              <div className="rounded-2xl border border-[#e4d8cb] bg-white p-4">
                <h2 className="font-black text-[#3e2723]">Sales source</h2>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <MetricCard label="POS sales" value={money(metrics.posSales)} />
                  <MetricCard label="Online sales" value={money(metrics.onlineSales)} />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Net collections after voided payments: <strong>{money(metrics.netCollections)}</strong>
                </p>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-hidden rounded-2xl border border-[#e4d8cb] bg-white">
                <div className="border-b border-neutral-100 p-4"><h2 className="font-black">Hourly sales</h2></div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead className="bg-neutral-50 text-left text-[10px] font-black uppercase text-neutral-500">
                      <tr><th className="p-3">Hour</th><th className="p-3">Orders</th><th className="p-3 text-right">Net sales</th></tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {report.hourlySales.length ? report.hourlySales.map((row) => (
                        <tr key={row.hour}>
                          <td className="p-3 font-bold">{String(row.hour).padStart(2, '0')}:00</td>
                          <td className="p-3">{row.orderCount}</td>
                          <td className="p-3 text-right font-mono font-bold">{money(row.netSales)}</td>
                        </tr>
                      )) : <tr><td colSpan={3} className="p-6 text-center text-neutral-500">No commercial sales</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-[#e4d8cb] bg-white">
                <div className="border-b border-neutral-100 p-4"><h2 className="font-black">Category summary</h2></div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead className="bg-neutral-50 text-left text-[10px] font-black uppercase text-neutral-500">
                      <tr><th className="p-3">Category</th><th className="p-3">Qty</th><th className="p-3 text-right">GST</th><th className="p-3 text-right">Sales</th></tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {report.categorySales.length ? report.categorySales.map((row) => (
                        <tr key={row.categoryName}>
                          <td className="p-3 font-bold">{row.categoryName}</td>
                          <td className="p-3">{row.quantity}</td>
                          <td className="p-3 text-right font-mono">{money(row.gst)}</td>
                          <td className="p-3 text-right font-mono font-bold">{money(row.netSales)}</td>
                        </tr>
                      )) : <tr><td colSpan={4} className="p-6 text-center text-neutral-500">No category sales</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-[#e4d8cb] bg-white">
              <div className="border-b border-neutral-100 p-4">
                <h2 className="font-black">Sanitized order drilldown</h2>
                <p className="mt-1 text-xs text-neutral-500">Customer mobile numbers are masked. Staff and operational metadata are not included.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1320px] text-sm">
                  <thead className="bg-neutral-50 text-left text-[10px] font-black uppercase text-neutral-500">
                    <tr>
                      <th className="p-3">Order / time</th><th className="p-3">Store</th><th className="p-3">Type / source</th>
                      <th className="p-3">Items</th><th className="p-3">Mobile</th><th className="p-3">Status</th>
                      <th className="p-3">Payment</th><th className="p-3 text-right">Menu value</th>
                      <th className="p-3 text-right">Discount</th><th className="p-3 text-right">GST</th>
                      <th className="p-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {report.orders.length ? report.orders.map((order) => (
                      <tr key={`${order.storeId}-${order.orderNumber}`}>
                        <td className="p-3">
                          <p className="font-mono font-bold">{order.orderNumber}</p>
                          <p className="mt-1 text-xs text-neutral-500">
                            {order.createdAt ? new Date(order.createdAt).toLocaleString('en-IN') : 'Time not recorded'}
                          </p>
                        </td>
                        <td className="p-3">{order.storeName}</td>
                        <td className="p-3">
                          <p className="font-bold">{order.orderType.replaceAll('_', ' ')}</p>
                          <p className="mt-1 text-xs text-neutral-500">{order.source}</p>
                        </td>
                        <td className="p-3">
                          <p className="max-w-[260px] whitespace-normal leading-5">
                            {order.items.length
                              ? order.items.map((item) => `${item.quantity}x ${item.name}`).join(', ')
                              : 'Items not recorded'}
                          </p>
                        </td>
                        <td className="p-3 font-mono">{order.customerPhoneMasked || 'Walk-in'}</td>
                        <td className="p-3 font-bold">
                          {order.status}{order.complimentary ? ' · COMPLIMENTARY' : ''}
                        </td>
                        <td className="p-3">
                          <p className="font-bold">{order.paymentMethods.join(' + ') || 'NO PAYMENT'}</p>
                          <p className="mt-1 text-xs text-neutral-500">{order.paymentStatus}</p>
                        </td>
                        <td className="p-3 text-right font-mono">{money(order.grossMenuValue)}</td>
                        <td className="p-3 text-right font-mono">{money(order.discount)}</td>
                        <td className="p-3 text-right font-mono">{money(order.gst)}</td>
                        <td className="p-3 text-right font-mono font-bold">{money(order.total)}</td>
                      </tr>
                    )) : <tr><td colSpan={11} className="p-8 text-center text-neutral-500">No orders for this day</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
