import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { LockKeyhole, LogOut } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { functions } from '../../lib/firebase';

const confirmPasswordChanged = httpsCallable<
  { action: 'SELF_PASSWORD_CHANGED'; newPassword: string },
  { ok: boolean }
>(functions, 'manageFranchiseViewer');

export default function FranchisePasswordChangeGate() {
  const { logout } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Use at least 12 characters for the new password.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await confirmPasswordChanged({ action: 'SELF_PASSWORD_CHANGED', newPassword: password });
      setPassword('');
      setConfirmation('');
    } catch (err: any) {
      const message = String(err?.message || '').replace(/^FirebaseError:\s*/i, '');
      setError(message || 'The password could not be changed. Please retry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-[#f7f1ea] p-4 flex items-center justify-center">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-2xl border border-[#e5d9cc] bg-white p-6 shadow-lg">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f3e8dd] text-[#5c4033]">
            <LockKeyhole size={22} />
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm font-black text-neutral-600"
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
        <h1 className="text-2xl font-black text-[#3e2723]">Choose a new password</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          Replace the temporary password before opening your assigned franchise workspace.
        </p>
        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
        <label className="mt-5 block text-xs font-black uppercase tracking-wider text-neutral-500">
          New password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            className="mt-2 h-12 w-full rounded-xl border border-neutral-200 px-4 text-base normal-case tracking-normal outline-none focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
            required
          />
          <span className="mt-1 block text-[11px] normal-case tracking-normal text-neutral-500">
            At least 12 characters with uppercase, lowercase, number, and symbol characters.
          </span>
        </label>
        <label className="mt-4 block text-xs font-black uppercase tracking-wider text-neutral-500">
          Confirm password
          <input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            className="mt-2 h-12 w-full rounded-xl border border-neutral-200 px-4 text-base normal-case tracking-normal outline-none focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
            required
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
