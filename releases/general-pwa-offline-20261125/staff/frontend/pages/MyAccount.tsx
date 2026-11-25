import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';
import { auth } from '../lib/firebase';
import { useAuth } from '../contexts/AuthContext';
import { confirmOwnSignIn, passwordAuthError, passwordProblem, staffAccess, staffAccessError } from '../lib/staffAccess';

type PasswordNotice = 'CHANGED' | 'CHANGED_SESSIONS_UNKNOWN' | 'UNKNOWN';
const inputClass = 'mt-1 w-full rounded-xl border border-neutral-200 px-3 py-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#5c4033]/30 disabled:bg-neutral-100';
const buttonClass = 'min-h-[44px] w-full rounded-xl bg-[#5c4033] px-4 py-3 text-sm font-bold text-white hover:bg-[#4a332a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5c4033] disabled:opacity-50';

export default function MyAccount() {
  const { firebaseUser, staffProfile } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<PasswordNotice | null>(null);
  const inFlight = useRef(false);
  // This retry identity contains no password or password-derived value.
  const requestId = useRef(crypto.randomUUID());
  const supportsPassword = firebaseUser?.providerData.some(provider => provider.providerId === 'password');
  const clear = () => { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); };
  const returnToSignIn = async (notice: PasswordNotice) => {
    clear(); setCompleted(notice);
    try {
      await signOut(auth);
      const destination = notice === 'UNKNOWN' ? '/login?passwordChange=unknown'
        : notice === 'CHANGED_SESSIONS_UNKNOWN' ? '/login?passwordChanged=1&sessionStatus=unknown'
          : '/login?passwordChanged=1';
      window.location.replace(destination);
    } catch {
      setError('The password operation finished, but this device could not sign out. Use Sign out below before signing in again.');
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (inFlight.current || !firebaseUser || !supportsPassword || completed) return;
    const problem = passwordProblem(newPassword, confirmation);
    if (problem) { setError(problem); return; }
    if (!currentPassword) { setError('Enter your current password.'); return; }
    inFlight.current = true; setBusy(true); setError('');
    let confirmed = false;
    try {
      await confirmOwnSignIn(firebaseUser, 'password', currentPassword); confirmed = true; setCurrentPassword('');
      const result = await staffAccess({ action: 'SELF_PASSWORD', password: newPassword, requestId: requestId.current });
      await returnToSignIn(result.status !== 'PASSWORD_CHANGED' ? 'UNKNOWN'
        : result.sessionInvalidation === 'UNKNOWN' ? 'CHANGED_SESSIONS_UNKNOWN' : 'CHANGED');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (confirmed && ['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal', 'unavailable', 'deadline-exceeded', 'internal'].includes(code || '')) {
        await returnToSignIn('UNKNOWN');
      } else setError(confirmed ? staffAccessError(err) : passwordAuthError(err));
    } finally { clear(); inFlight.current = false; setBusy(false); }
  };

  return <section className="w-full max-w-xl mx-auto bg-white border border-neutral-200 rounded-3xl p-5 md:p-7 shadow-sm">
    <div className="flex items-center gap-3 mb-5"><KeyRound size={23} className="text-[#5c4033]" /><h2 className="text-2xl font-black text-[#5c4033]">My account</h2></div>
    <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 mb-6"><p className="font-bold text-neutral-900">{staffProfile?.displayName || staffProfile?.name}</p><p className="text-sm text-neutral-600 break-all">{firebaseUser?.email}</p></div>
    {error && <div role="alert" className="mb-5 flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertCircle size={18} className="shrink-0 mt-0.5" /><p>{error}</p></div>}
    {completed ? <div className="space-y-4"><p role="status" className="text-sm text-neutral-700 flex gap-2"><CheckCircle2 size={18} className="shrink-0" />{completed === 'UNKNOWN' ? 'The password change could not be confirmed. Sign out and check your sign-in before submitting another change.' : 'Password changed. Sign out on this device and sign in again.'}</p><button type="button" disabled={busy} onClick={() => void returnToSignIn(completed)} className={buttonClass}>Sign out</button></div>
      : !supportsPassword ? <p className="text-sm text-neutral-600">This account uses another sign-in provider. Change its password with that provider. A password will not be added here.</p>
      : <form onSubmit={submit} autoComplete="off" className="space-y-4"><h3 className="font-black text-neutral-900">Change my password</h3><p className="text-sm text-neutral-600">Confirm your current password, then choose a new one. You will be signed out on this device and asked to sign in again.</p><fieldset disabled={busy} className="space-y-4">
        <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Current password</span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} className={inputClass} /></label>
        <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">New password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={newPassword} onChange={event => setNewPassword(event.target.value)} className={inputClass} /><span className="mt-1 block text-xs text-neutral-500">Use 12–128 characters.</span></label>
        <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Confirm new password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={event => setConfirmation(event.target.value)} className={inputClass} /></label>
        <button type="submit" disabled={busy} className={buttonClass}>{busy ? 'Confirming and changing…' : 'Change my password'}</button>
        <button type="button" disabled={busy} onClick={() => { clear(); navigate('/'); }} className="min-h-[44px] w-full rounded-xl border border-neutral-200 px-4 py-3 text-sm font-bold text-neutral-700 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5c4033]">Cancel</button>
      </fieldset><p className="text-xs text-neutral-500">Other signed-in devices may remain signed in until their current session expires.</p></form>}
  </section>;
}
