import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { AlertCircle, CheckCircle2, Eye, KeyRound, Loader2, Pencil, ShieldOff, UserPlus } from 'lucide-react';
import { functions } from '../../lib/firebase';
import { Store } from '../../types';

type FranchiseViewer = {
  uid: string;
  username: string;
  displayName: string;
  storeIds: string[];
  isActive: boolean;
  permissions: {
    viewDailySales: boolean;
    exportSales: boolean;
  };
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  authAccountPresent: boolean;
  updatedAt: string | null;
};

type ManageRequest = {
  action: 'LIST' | 'CREATE' | 'UPDATE' | 'RESET_PASSWORD' | 'REVOKE';
  uid?: string;
  username?: string;
  displayName?: string;
  storeIds?: string[];
  isActive?: boolean;
  temporaryPassword?: string;
  permissions?: { exportSales: boolean };
};

type ManageResponse = {
  ok?: boolean;
  viewers?: FranchiseViewer[];
};

type FormState = {
  uid: string | null;
  username: string;
  displayName: string;
  storeIds: string[];
  isActive: boolean;
  exportSales: boolean;
  temporaryPassword: string;
};

const EMPTY_FORM: FormState = {
  uid: null,
  username: '',
  displayName: '',
  storeIds: [],
  isActive: true,
  exportSales: true,
  temporaryPassword: '',
};

const manageFranchiseViewer = httpsCallable<ManageRequest, ManageResponse>(
  functions,
  'manageFranchiseViewer',
);

const friendlyError = (error: any) => {
  const message = String(error?.message || '');
  return message.replace(/^FirebaseError:\s*/i, '') || 'Franchise access could not be updated.';
};

export default function FranchiseAccessPanel({ stores }: { stores: Store[] }) {
  const [viewers, setViewers] = useState<FranchiseViewer[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [resetUid, setResetUid] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadViewers = async () => {
    setLoading(true);
    try {
      const result = await manageFranchiseViewer({ action: 'LIST' });
      setViewers(result.data.viewers || []);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadViewers();
  }, []);

  const toggleStore = (storeId: string) => {
    setForm((current) => ({
      ...current,
      storeIds: current.storeIds.includes(storeId)
        ? current.storeIds.filter((id) => id !== storeId)
        : [...current.storeIds, storeId],
    }));
  };

  const editViewer = (viewer: FranchiseViewer) => {
    setForm({
      uid: viewer.uid,
      username: viewer.username,
      displayName: viewer.displayName,
      storeIds: viewer.storeIds,
      isActive: viewer.isActive,
      exportSales: viewer.permissions.exportSales,
      temporaryPassword: '',
    });
    setError(null);
    setSuccess(null);
  };

  const saveViewer = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    if (form.storeIds.length === 0) {
      setError('Assign at least one store.');
      return;
    }
    setSaving(true);
    try {
      if (form.uid) {
        await manageFranchiseViewer({
          action: 'UPDATE',
          uid: form.uid,
          displayName: form.displayName,
          storeIds: form.storeIds,
          isActive: form.isActive,
          permissions: { exportSales: form.exportSales },
        });
        setSuccess('Franchise access updated.');
      } else {
        await manageFranchiseViewer({
          action: 'CREATE',
          username: form.username,
          displayName: form.displayName,
          storeIds: form.storeIds,
          temporaryPassword: form.temporaryPassword,
          permissions: { exportSales: form.exportSales },
        });
        setSuccess('Franchise account created. Share the temporary password outside the POS.');
      }
      setForm(EMPTY_FORM);
      await loadViewers();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  const resetViewerPassword = async () => {
    if (!resetUid) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await manageFranchiseViewer({
        action: 'RESET_PASSWORD',
        uid: resetUid,
        temporaryPassword: resetPassword,
      });
      setResetUid(null);
      setResetPassword('');
      setSuccess('Temporary password reset. The password was not displayed or stored by this screen.');
      await loadViewers();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  const revokeViewer = async (viewer: FranchiseViewer) => {
    if (!window.confirm(`Revoke franchise access for ${viewer.username}?`)) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await manageFranchiseViewer({ action: 'REVOKE', uid: viewer.uid });
      setSuccess(`Access revoked for ${viewer.username}.`);
      await loadViewers();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-8 overflow-hidden rounded-3xl border border-[#d8c3b2] bg-[#fffaf5] shadow-sm">
      <div className="border-b border-[#eadfd4] p-5 md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Eye size={19} className="text-[#5c4033]" />
              <h3 className="text-xl font-black text-[#3e2723]">Franchise Access</h3>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-neutral-600">
              Admin-managed, read-only daily sales accounts. These users cannot access POS, KOT, customers, inventory, or Admin.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setForm(EMPTY_FORM)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#3e2723] px-4 text-sm font-black text-white"
          >
            <UserPlus size={16} />
            New franchise viewer
          </button>
        </div>
      </div>

      {(error || success) && (
        <div className={`m-5 flex items-start gap-2 rounded-xl border p-3 text-sm font-bold ${
          error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}>
          {error ? <AlertCircle size={18} className="shrink-0" /> : <CheckCircle2 size={18} className="shrink-0" />}
          {error || success}
        </div>
      )}

      <div className="grid gap-5 p-5 md:p-6 xl:grid-cols-[390px_1fr]">
        <form onSubmit={saveViewer} className="h-fit space-y-4 rounded-2xl border border-neutral-200 bg-white p-4">
          <h4 className="font-black text-neutral-900">{form.uid ? 'Edit franchise viewer' : 'Create franchise viewer'}</h4>
          <label className="block">
            <span className="text-xs font-black uppercase tracking-wider text-neutral-500">Username</span>
            <input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              disabled={Boolean(form.uid)}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="goldeni.owner"
              className="mt-1 h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm disabled:bg-neutral-100"
              required
            />
            <p className="mt-1 text-[11px] text-neutral-500">4-40 lowercase letters, numbers, dots, dashes, or underscores.</p>
          </label>
          <label className="block">
            <span className="text-xs font-black uppercase tracking-wider text-neutral-500">Display name</span>
            <input
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              placeholder="Golden I Franchise"
              className="mt-1 h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm"
              required
            />
          </label>
          {!form.uid && (
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wider text-neutral-500">Temporary password</span>
              <input
                type="password"
                value={form.temporaryPassword}
                onChange={(event) => setForm({ ...form, temporaryPassword: event.target.value })}
                autoComplete="new-password"
                className="mt-1 h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm"
                minLength={12}
                required
              />
              <p className="mt-1 text-[11px] text-neutral-500">At least 12 characters. It is sent only to Firebase Authentication.</p>
            </label>
          )}
          <div>
            <span className="text-xs font-black uppercase tracking-wider text-neutral-500">Assigned stores</span>
            <div className="mt-2 max-h-52 divide-y divide-neutral-100 overflow-y-auto rounded-xl border border-neutral-200">
              {stores.map((store) => (
                <label key={store.id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm font-bold">
                  <input
                    type="checkbox"
                    checked={form.storeIds.includes(store.id)}
                    onChange={() => toggleStore(store.id)}
                  />
                  <span>{store.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-neutral-400">{store.code}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-3 rounded-xl bg-neutral-50 p-3 text-sm font-bold">
            <input
              type="checkbox"
              checked={form.exportSales}
              onChange={(event) => setForm({ ...form, exportSales: event.target.checked })}
            />
            Allow CSV export
          </label>
          {form.uid && (
            <label className="flex items-center gap-3 rounded-xl bg-neutral-50 p-3 text-sm font-bold">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
              />
              Active access
            </label>
          )}
          <button
            disabled={saving}
            className="flex h-11 w-full items-center justify-center rounded-xl bg-[#5c4033] font-black text-white disabled:opacity-50"
          >
            {saving ? <Loader2 size={18} className="animate-spin" /> : form.uid ? 'Save access' : 'Create account'}
          </button>
        </form>

        <div className="min-w-0">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm font-bold text-neutral-500">
              <Loader2 size={18} className="animate-spin" />
              Loading franchise viewers...
            </div>
          ) : viewers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-500">
              No franchise viewers have been created.
            </div>
          ) : (
            <div className="grid gap-3">
              {viewers.map((viewer) => (
                <article key={viewer.uid} className="rounded-2xl border border-neutral-200 bg-white p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-black text-neutral-900">{viewer.displayName}</h4>
                        <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase ${
                          viewer.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                        }`}>
                          {viewer.isActive ? 'Active' : 'Revoked'}
                        </span>
                        {viewer.mustChangePassword && (
                          <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black uppercase text-amber-700">
                            Temporary password
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-sm text-[#5c4033]">{viewer.username}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {viewer.storeIds.map((storeId) => (
                          <span key={storeId} className="rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-bold text-neutral-600">
                            {stores.find((store) => store.id === storeId)?.name || storeId}
                          </span>
                        ))}
                      </div>
                      <p className="mt-3 text-xs text-neutral-500">
                        Last login: {viewer.lastLoginAt ? new Date(viewer.lastLoginAt).toLocaleString() : 'Never'}
                        {' · '}
                        CSV: {viewer.permissions.exportSales ? 'Allowed' : 'Disabled'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => editViewer(viewer)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-xs font-black"
                      >
                        <Pencil size={14} /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetUid(viewer.uid);
                          setResetPassword('');
                        }}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-xs font-black"
                      >
                        <KeyRound size={14} /> Reset password
                      </button>
                      <button
                        type="button"
                        onClick={() => void revokeViewer(viewer)}
                        disabled={!viewer.isActive || saving}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-xs font-black text-red-700 disabled:opacity-40"
                      >
                        <ShieldOff size={14} /> Revoke
                      </button>
                    </div>
                  </div>
                  {resetUid === viewer.uid && (
                    <div className="mt-4 flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 sm:flex-row">
                      <input
                        type="password"
                        value={resetPassword}
                        onChange={(event) => setResetPassword(event.target.value)}
                        minLength={12}
                        autoComplete="new-password"
                        placeholder="New temporary password"
                        className="h-10 min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-3 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => void resetViewerPassword()}
                        disabled={saving || resetPassword.length < 12}
                        className="h-10 rounded-lg bg-[#3e2723] px-4 text-sm font-black text-white disabled:opacity-40"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => setResetUid(null)}
                        className="h-10 rounded-lg px-3 text-sm font-bold text-neutral-600"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
