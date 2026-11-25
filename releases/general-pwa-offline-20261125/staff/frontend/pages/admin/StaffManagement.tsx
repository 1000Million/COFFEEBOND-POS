import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, Edit3, KeyRound, Shield, Store as StoreIcon, UserPlus, Users, X } from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Role, StaffProfile, Store } from '../../types';
import FranchiseAccessPanel from '../../components/admin/FranchiseAccessPanel';
import { assignedStoreIdentifiers } from '../../lib/posStoreAccess';
import { confirmOwnSignIn, passwordAuthError, passwordProblem, reauthenticationMethods, staffAccess, staffAccessError } from '../../lib/staffAccess';

type StaffRecord = StaffProfile & { id: string };
type StaffFormState = { displayName: string; email: string; role: Role; isActive: boolean; storeIds: string[] };
const ROLE_OPTIONS: Role[] = ['ADMIN', 'STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN', 'TRAINEE'];
const STORE_REQUIRED_ROLES: Role[] = ['STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN'];
const EMPTY_FORM: StaffFormState = { displayName: '', email: '', role: 'CASHIER', isActive: true, storeIds: [] };
const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin', STORE_MANAGER: 'Store Manager', CASHIER: 'POS User / Cashier',
  BARISTA: 'KOT User / Barista', KITCHEN: 'KOT User / Kitchen',
  TRAINEE: 'Trainee / No live access', FRANCHISE_VIEWER: 'Franchise Viewer',
};
const ROLE_MODULES: Record<Role, string> = {
  ADMIN: 'All stores and all modules.',
  STORE_MANAGER: 'Assigned stores: POS, Running Orders, Online Orders, Reports, Inventory, Purchases, Stock Correction, Day Close, KOT.',
  CASHIER: 'Assigned stores: POS billing, Running Orders, Online Orders, Reprint/Hold/Recall, Pay-at-counter settlement, all KOT views.',
  BARISTA: 'Assigned stores: Barista, Kitchen, and Ready KOT only.',
  KITCHEN: 'Assigned stores: Barista, Kitchen, and Ready KOT only.',
  TRAINEE: 'No live operational workspace until promoted.',
  FRANCHISE_VIEWER: 'Assigned stores: read-only daily sales through the franchise workspace.',
};
const inputClass = 'mt-1 w-full rounded-xl border border-neutral-200 px-3 py-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#5c4033]/30 disabled:bg-neutral-100 disabled:text-neutral-500';
const actionClass = 'min-h-[44px] inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-neutral-200 text-sm font-bold text-neutral-700 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5c4033] disabled:opacity-40';
const primaryClass = 'min-h-[44px] w-full py-3 px-4 rounded-xl bg-[#5c4033] hover:bg-[#4a332a] disabled:opacity-50 text-white font-black transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5c4033]';
const timestampIso = (value: unknown): string | undefined => typeof (value as { toDate?: unknown })?.toDate === 'function'
  ? (value as { toDate: () => Date }).toDate().toISOString() : undefined;

export default function StaffManagement() {
  const { firebaseUser, staffProfile } = useAuth();
  const navigate = useNavigate();
  const [staff, setStaff] = useState<StaffRecord[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [form, setForm] = useState<StaffFormState>(EMPTY_FORM);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [existingStaffUid, setExistingStaffUid] = useState<string | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<StaffRecord | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [targetPassword, setTargetPassword] = useState('');
  const [targetConfirmation, setTargetConfirmation] = useState('');
  const [reauthMethod, setReauthMethod] = useState('password');
  const [passwordError, setPasswordError] = useState('');
  const passwordDialog = useRef<HTMLDialogElement>(null);
  const firstPasswordInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const createRequest = useRef({ signature: '', id: crypto.randomUUID() });
  const passwordRequests = useRef(new Map<string, string>());
  const editUpdatedAt = useRef<string | undefined>(undefined);
  const methods = reauthenticationMethods(firebaseUser);
  const editingStaff = useMemo(() => staff.find(p => p.uid === editingUid) || null, [editingUid, staff]);

  useEffect(() => {
    if (staffProfile?.role !== 'ADMIN' || !staffProfile.isActive) return;
    const failed = () => { setError('Unable to load staff access. Check your connection and Admin access.'); setLoading(false); };
    const stopStaff = onSnapshot(collection(db, 'users'), snapshot => {
      const next = snapshot.docs.filter(d => ROLE_OPTIONS.includes(d.data().role)).map(d => {
        const data = d.data(), displayName = typeof data.displayName === 'string' ? data.displayName : data.name || '';
        const ids = assignedStoreIdentifiers(data);
        return { ...data, id: d.id, uid: d.id, name: displayName, displayName, email: typeof data.email === 'string' ? data.email : '',
          role: data.role, isActive: data.isActive === true, assignedStoreIds: ids, storeIds: ids } as StaffRecord;
      });
      next.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.email.localeCompare(b.email)); setStaff(next); setLoading(false);
    }, failed);
    const stopStores = onSnapshot(collection(db, 'stores'), snapshot => {
      const next = snapshot.docs.map(d => ({ ...d.data(), id: d.id }) as Store); next.sort((a, b) => a.name.localeCompare(b.name)); setStores(next);
    }, failed);
    return () => { stopStaff(); stopStores(); };
  }, [staffProfile?.role, staffProfile?.isActive]);

  useEffect(() => {
    if (passwordTarget && passwordDialog.current && !passwordDialog.current.open) {
      passwordDialog.current.showModal(); firstPasswordInput.current?.focus();
    }
  }, [passwordTarget]);

  const resetForm = () => {
    if (submitting.current) return;
    setPassword(''); setConfirmation(''); setForm(EMPTY_FORM); setEditingUid(null); setError(null); setSuccess(null); setExistingStaffUid(null);
    createRequest.current = { signature: '', id: crypto.randomUUID() };
  };
  const startEdit = (person: StaffRecord) => {
    if (submitting.current) return;
    setPassword(''); setConfirmation(''); editUpdatedAt.current = timestampIso(person.updatedAt);
    setEditingUid(person.uid); setForm({ displayName: person.displayName || person.name || '', email: person.email,
      role: person.role, isActive: person.isActive, storeIds: person.assignedStoreIds || person.storeIds || [] });
    setError(null); setSuccess(null); setExistingStaffUid(null);
  };
  const begin = () => {
    if (submitting.current) return false;
    submitting.current = true; setSaving(true); setError(null); setSuccess(null); setExistingStaffUid(null); return true;
  };
  const end = () => { submitting.current = false; setSaving(false); };
  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault(); if (submitting.current) return;
    const errors: string[] = [];
    if (staffProfile?.role !== 'ADMIN' || !staffProfile.isActive) errors.push('Only active Admin users can manage staff access.');
    if (!form.displayName.trim()) errors.push('Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.push('Enter a valid email address.');
    if (!editingUid) { const problem = passwordProblem(password, confirmation); if (problem) errors.push(problem); }
    if (STORE_REQUIRED_ROLES.includes(form.role) && !form.storeIds.length) errors.push('Assign at least one store for this role.');
    if (editingUid === firebaseUser?.uid && (!form.isActive || form.role !== 'ADMIN')) errors.push('You cannot remove your own active Admin access.');
    if (errors.length) { setError(errors.join(' ')); return; }
    if (!begin()) return;
    try {
      if (editingUid) {
        await staffAccess({ action: 'UPDATE', uid: editingUid, displayName: form.displayName.trim(), role: form.role,
          storeIds: form.storeIds, isActive: form.isActive, expectedUpdatedAt: editUpdatedAt.current });
        setSuccess('Staff access updated.'); setForm(EMPTY_FORM); setEditingUid(null);
      } else {
        const details = { displayName: form.displayName.trim(), email: form.email.trim().toLowerCase(), role: form.role, storeIds: form.storeIds };
        // No password or password-derived value is retained in the retry reference.
        const signature = JSON.stringify(details);
        if (createRequest.current.signature !== signature) createRequest.current = { signature, id: crypto.randomUUID() };
        const result = await staffAccess({ action: 'CREATE', ...details, password, requestId: createRequest.current.id });
        if (result.status !== 'CREATED' && result.status !== 'ALREADY_CREATED') setError('Staff creation could not be confirmed. Check the staff list before retrying this same form. No password will be changed by a retry.');
        else {
          setSuccess(result.status === 'ALREADY_CREATED' ? 'The original staff creation was already completed and its password was preserved. This retry did not set the password just entered.' : 'Staff member added. They can sign in with the assigned email and password.');
          setForm(EMPTY_FORM); createRequest.current = { signature: '', id: crypto.randomUUID() };
        }
      }
    } catch (err: unknown) {
      setError(staffAccessError(err));
      const match = staff.find(p => p.email.toLowerCase() === form.email.trim().toLowerCase()); if (match) setExistingStaffUid(match.uid);
    } finally { setPassword(''); setConfirmation(''); end(); }
  };
  const pauseStaff = async (person: StaffRecord) => {
    if (!begin()) return;
    try { await staffAccess({ action: 'PAUSE', uid: person.uid }); setSuccess('Staff access paused. The employee’s customer account remains available.'); }
    catch (err: unknown) { setError(staffAccessError(err)); }
    finally { end(); }
  };
  const openPassword = (person: StaffRecord) => {
    if (submitting.current) return;
    if (person.uid === firebaseUser?.uid) { navigate('/account'); return; }
    setPassword(''); setConfirmation(''); setAdminPassword(''); setTargetPassword(''); setTargetConfirmation(''); setPasswordError('');
    setReauthMethod(methods.some(m => m.id === 'password') ? 'password' : methods[0]?.id || ''); setPasswordTarget(person);
  };
  const closePassword = () => {
    setAdminPassword(''); setTargetPassword(''); setTargetConfirmation(''); setPasswordError(''); setPasswordTarget(null);
    if (passwordDialog.current?.open) passwordDialog.current.close();
  };
  const changeStaffPassword = async (event: React.FormEvent) => {
    event.preventDefault(); if (submitting.current || !passwordTarget || !firebaseUser) return;
    const problem = passwordProblem(targetPassword, targetConfirmation);
    if (problem) { setPasswordError(problem); return; }
    if (!methods.some(m => m.id === reauthMethod) || (reauthMethod === 'password' && !adminPassword)) { setPasswordError('Confirm your own Admin sign-in before changing this password.'); return; }
    if (!begin()) return;
    let reauthenticated = false;
    try {
      await confirmOwnSignIn(firebaseUser, reauthMethod, adminPassword); reauthenticated = true; setAdminPassword('');
      const uid = passwordTarget.uid;
      if (!passwordRequests.current.has(uid)) passwordRequests.current.set(uid, crypto.randomUUID());
      const result = await staffAccess({ action: 'ADMIN_PASSWORD', uid, password: targetPassword, requestId: passwordRequests.current.get(uid)! });
      if (result.status !== 'PASSWORD_CHANGED') setError('The password change could not be confirmed. Check the employee’s sign-in before requesting another change.');
      else if (result.alreadyApplied) {
        setSuccess('The original password change was already completed. This retry did not set another password.'
          + (result.sessionInvalidation === 'UNKNOWN' ? ' Ending other sessions could not be confirmed; do not assume those devices are signed out.'
            : ' Other signed-in devices may stay signed in until their current session expires.'));
        passwordRequests.current.delete(uid);
      }
      else if (result.sessionInvalidation === 'UNKNOWN') setSuccess('Password changed. Ending other sessions could not be confirmed; do not assume those devices are signed out.');
      else { setSuccess('Password changed. Other signed-in devices may stay signed in until their current session expires.'); passwordRequests.current.delete(uid); }
      closePassword();
    } catch (err: unknown) { setPasswordError(reauthenticated ? staffAccessError(err) : passwordAuthError(err)); }
    finally { setAdminPassword(''); setTargetPassword(''); setTargetConfirmation(''); end(); }
  };
  const storeNames = (ids: string[]) => ids.map(id => stores.find(s => s.id === id)?.name || id).join(', ') || 'No stores assigned';

  return <div className="max-w-6xl mx-auto w-full pb-20">
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
      <div><div className="flex items-center gap-3 mb-2"><div className="w-10 h-10 bg-[#5c4033] text-white rounded-xl flex items-center justify-center"><Users size={20} /></div><h2 className="text-3xl font-black text-[#5c4033]">Staff Management</h2></div><p className="text-sm text-neutral-600">Add staff and manage their role, stores and password.</p></div>
      <button type="button" onClick={resetForm} disabled={saving} className={actionClass}><UserPlus size={16} />Add staff</button>
    </div>
    {(error || success) && <div role={error ? 'alert' : 'status'} className={`mb-6 rounded-2xl border p-4 flex items-start gap-3 ${error ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
      {error ? <AlertCircle size={20} className="shrink-0 mt-0.5" /> : <CheckCircle2 size={20} className="shrink-0 mt-0.5" />}<div><p className="text-sm font-medium">{error || success}</p>{existingStaffUid && <button type="button" className={actionClass + ' mt-3'} onClick={() => startEdit(staff.find(p => p.uid === existingStaffUid)!)}>Edit existing staff member</button>}</div>
    </div>}
    <FranchiseAccessPanel stores={stores} />
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
      <form onSubmit={handleSave} autoComplete="off" className="bg-white border border-neutral-200 rounded-3xl p-5 md:p-6 shadow-sm h-fit">
        <div className="flex items-center gap-2 mb-5"><Shield size={18} className="text-[#5c4033]" /><h3 className="font-black text-neutral-900">{editingUid ? 'Edit staff access' : 'Add staff'}</h3></div>
        <fieldset disabled={saving} className="space-y-4">
          <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Name</span><input autoComplete="off" required maxLength={80} value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} className={inputClass} /></label>
          <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Email</span><input type="email" autoComplete="off" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={!!editingUid} placeholder="staff@example.com" className={inputClass} /></label>
          {!editingUid && <><label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} className={inputClass} /><span className="mt-1 block text-xs text-neutral-500">Use 12–128 characters.</span></label><label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Confirm password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={e => setConfirmation(e.target.value)} className={inputClass} /></label></>}
          <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Role</span><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Role })} className={inputClass}>{ROLE_OPTIONS.map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select><p className="mt-2 rounded-xl bg-neutral-50 px-3 py-2 text-xs font-semibold text-neutral-600">{ROLE_MODULES[form.role]}</p></label>
          <div><div className="flex items-center justify-between gap-3 mb-2"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Store(s)</span><button type="button" onClick={() => setForm({ ...form, storeIds: stores.map(s => s.id) })} className="text-xs font-bold text-[#5c4033] hover:underline">Select all</button></div><div className="rounded-2xl border border-neutral-200 divide-y divide-neutral-100 max-h-56 overflow-y-auto">{!stores.length ? <p className="p-4 text-sm text-neutral-500">No stores available.</p> : stores.map(store => <label key={store.id} className="flex items-center gap-3 p-3 cursor-pointer hover:bg-neutral-50"><input type="checkbox" checked={form.storeIds.includes(store.id)} onChange={() => setForm({ ...form, storeIds: form.storeIds.includes(store.id) ? form.storeIds.filter(id => id !== store.id) : [...form.storeIds, store.id] })} className="rounded border-neutral-300 text-[#5c4033] focus:ring-[#5c4033]" /><StoreIcon size={15} className="text-neutral-400 shrink-0" /><span className="text-sm font-semibold text-neutral-800">{store.name}</span></label>)}</div><p className="text-xs text-neutral-500 mt-2">Admin and Trainee may have no stores. Other staff roles need at least one store.</p></div>
          {editingUid && <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Staff access</span><select value={form.isActive ? 'active' : 'paused'} onChange={e => setForm({ ...form, isActive: e.target.value === 'active' })} className={inputClass}><option value="active">Active</option><option value="paused">Paused</option></select></label>}
          <button type="submit" disabled={saving} className={primaryClass}>{saving ? 'Working…' : editingUid ? 'Save staff access' : 'Add staff member'}</button>
          <button type="button" onClick={resetForm} disabled={saving} className={actionClass + ' w-full'}>Cancel</button>
          {!editingUid && <p className="text-xs text-neutral-500">This creates staff sign-in directly. Existing email accounts are preserved and will not be overwritten.</p>}
          {editingStaff && <p className="text-xs text-neutral-500">Use Change password in the staff list to update sign-in separately.</p>}
        </fieldset>
      </form>
      <section className="bg-white border border-neutral-200 rounded-3xl shadow-sm overflow-hidden h-fit min-w-0" aria-labelledby="staff-heading">
        <div className="p-5 border-b border-neutral-100"><h3 id="staff-heading" className="font-black text-neutral-900">Staff access</h3><p className="text-xs text-neutral-500">{staff.length} staff member{staff.length === 1 ? '' : 's'}. Passwords are never displayed.</p></div>
        {loading ? <p className="p-8 text-center text-neutral-500">Loading staff access…</p> : !staff.length ? <p className="p-8 text-neutral-500">No staff members found.</p> : <div className="overflow-x-auto"><table className="min-w-[620px] w-full text-left text-sm"><thead className="bg-neutral-50 text-[10px] font-black uppercase tracking-widest text-neutral-500"><tr><th className="px-4 py-3">Name / email</th><th className="px-4 py-3">Role / stores</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th></tr></thead><tbody className="divide-y divide-neutral-100">{staff.map(person => <tr key={person.id} className="align-top" data-staff-email={person.email}><td className="px-4 py-4"><p className="font-black text-neutral-900">{person.displayName || 'Unnamed staff'}</p><p className="text-neutral-700 break-all">{person.email || 'No email recorded'}</p></td><td className="px-4 py-4"><p className="font-bold text-neutral-800">{ROLE_LABELS[person.role]}</p><p className="text-xs text-neutral-600 mt-1">{storeNames(person.assignedStoreIds)}</p></td><td className="px-4 py-4"><span className={`text-xs font-bold px-2 py-1 rounded-full ${person.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-600'}`}>{person.isActive ? 'Active' : 'Paused'}</span></td><td className="px-4 py-4"><div className="flex flex-col gap-2"><button type="button" disabled={saving} onClick={() => startEdit(person)} className={actionClass}><Edit3 size={15} />Edit</button><button type="button" disabled={saving} onClick={() => openPassword(person)} className={actionClass}><KeyRound size={15} />Change password</button><button type="button" disabled={saving || !person.isActive || person.uid === firebaseUser?.uid} onClick={() => pauseStaff(person)} className={actionClass}>Pause access</button></div></td></tr>)}</tbody></table></div>}
      </section>
    </div>
    <dialog ref={passwordDialog} aria-labelledby="staff-password-heading" aria-describedby="staff-password-target" onCancel={event => { if (saving) event.preventDefault(); else closePassword(); }} onClose={closePassword} className="m-auto w-[calc(100%_-_2rem)] max-w-lg rounded-3xl border border-neutral-200 bg-white p-5 md:p-6 text-neutral-800 shadow-xl">
      <div className="flex justify-between items-start gap-4 mb-4"><h3 id="staff-password-heading" className="font-black text-xl text-[#5c4033]">Change staff password</h3><button type="button" onClick={closePassword} disabled={saving} aria-label="Close password dialog" className={actionClass}><X size={18} /></button></div>
      {passwordTarget && <form onSubmit={changeStaffPassword} autoComplete="off" className="space-y-4"><div id="staff-password-target" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><p className="font-bold">{passwordTarget.displayName || passwordTarget.name}</p><p className="text-sm break-all">{passwordTarget.email}</p></div><p className="text-sm text-neutral-600">Set a new password for this staff member. Confirm your own Admin sign-in below.</p>{passwordError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{passwordError}</p>}<fieldset disabled={saving} className="space-y-4"><label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">New staff password</span><input ref={firstPasswordInput} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={targetPassword} onChange={e => setTargetPassword(e.target.value)} className={inputClass} /></label><label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Confirm new staff password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={targetConfirmation} onChange={e => setTargetConfirmation(e.target.value)} className={inputClass} /></label>{methods.length > 1 && <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Confirm your Admin sign-in with</span><select value={reauthMethod} onChange={e => { setReauthMethod(e.target.value); setAdminPassword(''); }} className={inputClass}>{methods.map(method => <option key={method.id} value={method.id}>{method.label}</option>)}</select></label>}{reauthMethod === 'password' ? <label className="block"><span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Your current Admin password</span><input type="password" autoComplete="current-password" required value={adminPassword} onChange={e => setAdminPassword(e.target.value)} className={inputClass} /></label> : methods.length ? <p className="text-sm text-neutral-600">Continue to confirm your existing {methods.find(m => m.id === reauthMethod)?.label} sign-in. The staff member’s old password is not required.</p> : <p className="text-sm text-red-800">This Admin account has no supported linked sign-in method for confirmation here. No provider or password will be added.</p>}<button type="submit" disabled={saving || !methods.length} className={primaryClass}>{saving ? 'Confirming and changing…' : reauthMethod === 'password' ? 'Confirm and change password' : 'Confirm sign-in and change password'}</button><button type="button" onClick={closePassword} disabled={saving} className={actionClass + ' w-full'}>Cancel</button></fieldset></form>}
    </dialog>
  </div>;
}
