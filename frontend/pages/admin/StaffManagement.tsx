import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, Edit3, Shield, Store as StoreIcon, UserPlus, Users } from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Role, StaffProfile, Store } from '../../types';

type StaffRecord = StaffProfile & { id: string };

type StaffFormState = {
  uid: string;
  displayName: string;
  email: string;
  role: Role;
  isActive: boolean;
  assignedStoreIds: string[];
};

const ROLE_OPTIONS: Role[] = ['ADMIN', 'STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN', 'TRAINEE'];
const STORE_REQUIRED_ROLES: Role[] = ['STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN'];

const EMPTY_FORM: StaffFormState = {
  uid: '',
  displayName: '',
  email: '',
  role: 'CASHIER',
  isActive: true,
  assignedStoreIds: [],
};

const roleLabel = (role: Role) => role.replace('_', ' ');

const normalizeStoreIds = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value.filter((storeId): storeId is string => typeof storeId === 'string');
};

const formatDate = (value: any) => {
  if (!value) return 'Not recorded';
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleString();
};

export default function StaffManagement() {
  const { firebaseUser, staffProfile } = useAuth();
  const [staff, setStaff] = useState<StaffRecord[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [form, setForm] = useState<StaffFormState>(EMPTY_FORM);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const unsubscribeStaff = onSnapshot(
      collection(db, 'users'),
      (snapshot) => {
        const nextStaff = snapshot.docs.map((staffDoc) => {
          const data = staffDoc.data();
          const assignedStoreIds = normalizeStoreIds(data.assignedStoreIds || data.storeIds);
          const displayName = typeof data.displayName === 'string' ? data.displayName : data.name || '';
          return {
            id: staffDoc.id,
            uid: typeof data.uid === 'string' ? data.uid : staffDoc.id,
            name: displayName,
            displayName,
            email: typeof data.email === 'string' ? data.email : '',
            role: ROLE_OPTIONS.includes(data.role) ? data.role : 'TRAINEE',
            isActive: data.isActive === true,
            storeIds: assignedStoreIds,
            assignedStoreIds,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
          } as StaffRecord;
        });

        nextStaff.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.email.localeCompare(b.email));
        setStaff(nextStaff);
        setLoading(false);
      },
      (err) => {
        setError(err.message || 'Unable to load staff profiles. Check admin permission for the users collection.');
        setLoading(false);
      },
    );

    const unsubscribeStores = onSnapshot(
      collection(db, 'stores'),
      (snapshot) => {
        const nextStores = snapshot.docs.map((storeDoc) => ({ id: storeDoc.id, ...storeDoc.data() }) as Store);
        nextStores.sort((a, b) => a.name.localeCompare(b.name));
        setStores(nextStores);
      },
      (err) => {
        setError(err.message || 'Unable to load stores for assignment.');
      },
    );

    return () => {
      unsubscribeStaff();
      unsubscribeStores();
    };
  }, []);

  const editingStaff = useMemo(
    () => staff.find((person) => person.uid === editingUid) || null,
    [editingUid, staff],
  );

  const validateForm = () => {
    const nextErrors: string[] = [];
    const uid = form.uid.trim();
    const displayName = form.displayName.trim();
    const email = form.email.trim();

    if (staffProfile?.role !== 'ADMIN') nextErrors.push('Only Admin users can manage staff profiles.');
    if (!uid) nextErrors.push('Firebase UID is required.');
    if (uid.includes('/')) nextErrors.push('Firebase UID cannot contain a slash.');
    if (!displayName) nextErrors.push('Display name is required.');
    if (!email) nextErrors.push('Email is required.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) nextErrors.push('Enter a valid email address.');
    if (staffProfile?.role !== 'ADMIN' && form.role === 'ADMIN') nextErrors.push('Store Managers cannot create Admin users.');
    if (STORE_REQUIRED_ROLES.includes(form.role) && form.assignedStoreIds.length === 0) {
      nextErrors.push(`${roleLabel(form.role)} staff must be assigned to at least one store.`);
    }
    if (editingUid === firebaseUser?.uid && form.role !== 'ADMIN') nextErrors.push('You cannot remove your own Admin role.');
    if (editingUid === firebaseUser?.uid && !form.isActive) nextErrors.push('You cannot deactivate your own active admin profile.');

    return nextErrors;
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingUid(null);
    setError(null);
    setSuccess(null);
  };

  const startEdit = (person: StaffRecord) => {
    setEditingUid(person.uid);
    setForm({
      uid: person.uid,
      displayName: person.displayName || person.name,
      email: person.email,
      role: person.role,
      isActive: person.isActive,
      assignedStoreIds: person.assignedStoreIds || person.storeIds || [],
    });
    setError(null);
    setSuccess(null);
  };

  const toggleStore = (storeId: string) => {
    setForm((current) => ({
      ...current,
      assignedStoreIds: current.assignedStoreIds.includes(storeId)
        ? current.assignedStoreIds.filter((id) => id !== storeId)
        : [...current.assignedStoreIds, storeId],
    }));
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const validationErrors = validateForm();
    if (validationErrors.length > 0) {
      setError(validationErrors.join(' '));
      return;
    }

    setSaving(true);
    try {
      const uid = form.uid.trim();
      const staffRef = doc(db, 'users', uid);
      const staffSnap = await getDoc(staffRef);

      if (!editingUid && staffSnap.exists()) {
        setError('A staff profile already exists for this Firebase UID. Use Edit instead.');
        return;
      }

      const assignedStoreIds = form.assignedStoreIds;
      const displayName = form.displayName.trim();
      const payload = {
        uid,
        displayName,
        name: displayName,
        email: form.email.trim().toLowerCase(),
        role: form.role,
        isActive: form.isActive,
        assignedStoreIds,
        storeIds: assignedStoreIds,
        updatedAt: serverTimestamp(),
      };

      if (editingUid) {
        await setDoc(staffRef, payload, { merge: true });
        setSuccess('Staff profile updated.');
      } else {
        await setDoc(staffRef, {
          ...payload,
          createdAt: serverTimestamp(),
        });
        setSuccess('Staff profile created. This maps an existing Firebase Auth UID to app access.');
      }

      setForm(EMPTY_FORM);
      setEditingUid(null);
    } catch (err: any) {
      setError(err.message || 'Unable to save staff profile. Check Firebase permissions and try again.');
    } finally {
      setSaving(false);
    }
  };

  const deactivateStaff = async (person: StaffRecord) => {
    if (person.uid === firebaseUser?.uid) {
      setError('You cannot deactivate your own active admin profile.');
      setSuccess(null);
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await setDoc(doc(db, 'users', person.uid), {
        isActive: false,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSuccess(`${person.displayName || person.email || person.uid} has been deactivated.`);
    } catch (err: any) {
      setError(err.message || 'Unable to deactivate this staff profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto w-full pb-20">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-[#5c4033] text-white rounded-xl flex items-center justify-center">
              <Users size={20} />
            </div>
            <h2 className="text-3xl font-black text-[#5c4033]">Staff Management</h2>
          </div>
          <p className="text-sm text-neutral-600">
            Map existing Firebase Auth users to Coffee Bond staff profiles. This screen does not create Firebase Auth accounts.
          </p>
        </div>
        <button
          onClick={resetForm}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-neutral-900 text-white text-sm font-bold hover:bg-neutral-800 transition-colors"
        >
          <UserPlus size={16} />
          New Staff Profile
        </button>
      </div>

      {(error || success) && (
        <div className={`mb-6 rounded-2xl border p-4 flex items-start gap-3 ${
          error ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
        }`}>
          {error ? <AlertCircle size={20} className="shrink-0 mt-0.5" /> : <CheckCircle2 size={20} className="shrink-0 mt-0.5" />}
          <p className="text-sm font-medium">{error || success}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">
        <form onSubmit={handleSave} className="bg-white border border-neutral-200 rounded-3xl p-5 md:p-6 shadow-sm h-fit">
          <div className="flex items-center gap-2 mb-5">
            <Shield size={18} className="text-[#5c4033]" />
            <h3 className="font-black text-neutral-900">{editingUid ? 'Edit Staff Profile' : 'Create Staff Profile'}</h3>
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Firebase UID</span>
              <input
                value={form.uid}
                onChange={(event) => setForm({ ...form, uid: event.target.value })}
                disabled={!!editingUid}
                placeholder="Paste Firebase Auth UID"
                className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm font-mono disabled:bg-neutral-100 disabled:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20"
              />
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Display Name</span>
                <input
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                  placeholder="Staff name"
                  className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                />
              </label>

              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Email</span>
                <input
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  placeholder="staff@example.com"
                  className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Role</span>
                <select
                  value={form.role}
                  onChange={(event) => setForm({ ...form, role: event.target.value as Role })}
                  className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                >
                  {ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>{roleLabel(role)}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Status</span>
                <select
                  value={form.isActive ? 'active' : 'inactive'}
                  onChange={(event) => setForm({ ...form, isActive: event.target.value === 'active' })}
                  className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">Assigned Stores</span>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, assignedStoreIds: stores.map((store) => store.id) })}
                  className="text-xs font-bold text-[#5c4033] hover:underline"
                >
                  Select all
                </button>
              </div>
              <div className="rounded-2xl border border-neutral-200 divide-y divide-neutral-100 max-h-56 overflow-y-auto">
                {stores.length === 0 ? (
                  <div className="p-4 text-sm text-neutral-500">No stores found yet.</div>
                ) : (
                  stores.map((store) => (
                    <label key={store.id} className="flex items-center gap-3 p-3 cursor-pointer hover:bg-neutral-50">
                      <input
                        type="checkbox"
                        checked={form.assignedStoreIds.includes(store.id)}
                        onChange={() => toggleStore(store.id)}
                        className="rounded border-neutral-300 text-[#5c4033] focus:ring-[#5c4033]"
                      />
                      <StoreIcon size={15} className="text-neutral-400" />
                      <span className="text-sm font-semibold text-neutral-800">{store.name}</span>
                      <span className="ml-auto text-[10px] font-mono text-neutral-400">{store.code}</span>
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                Admin and Trainee profiles may have no stores. Store Manager, Cashier, Barista, and Kitchen need at least one store.
              </p>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-3 rounded-xl bg-[#5c4033] hover:bg-[#4a332a] disabled:opacity-50 text-white font-black transition-colors"
            >
              {saving ? 'Saving...' : editingUid ? 'Save Staff Profile' : 'Create Staff Profile'}
            </button>

            {editingStaff && (
              <p className="text-xs text-neutral-500 text-center">
                Editing profile created {formatDate(editingStaff.createdAt)}.
              </p>
            )}
          </div>
        </form>

        <section className="bg-white border border-neutral-200 rounded-3xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-neutral-100">
            <h3 className="font-black text-neutral-900">Staff Profiles</h3>
            <p className="text-xs text-neutral-500">{staff.length} profile{staff.length === 1 ? '' : 's'} in Firestore users collection</p>
          </div>

          {loading ? (
            <div className="p-8 text-center text-neutral-500">Loading staff profiles...</div>
          ) : staff.length === 0 ? (
            <div className="p-8 text-center text-neutral-500">No staff profiles found.</div>
          ) : (
            <div className="divide-y divide-neutral-100">
              {staff.map((person) => {
                const assignedStores = stores.filter((store) => person.assignedStoreIds.includes(store.id));
                return (
                  <div key={person.uid} className="p-4 md:p-5 flex flex-col xl:flex-row xl:items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <h4 className="font-black text-neutral-900">{person.displayName || 'Unnamed staff'}</h4>
                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full ${
                          person.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                        }`}>
                          {person.isActive ? 'Active' : 'Inactive'}
                        </span>
                        <span className="text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                          {roleLabel(person.role)}
                        </span>
                      </div>
                      <p className="text-sm text-neutral-600 break-all">{person.email}</p>
                      <p className="text-xs font-mono text-neutral-400 break-all mt-1">{person.uid}</p>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {assignedStores.length > 0 ? assignedStores.map((store) => (
                          <span key={store.id} className="text-[10px] font-bold bg-neutral-100 text-neutral-600 px-2 py-1 rounded-full">
                            {store.name}
                          </span>
                        )) : (
                          <span className="text-[10px] font-bold bg-neutral-100 text-neutral-500 px-2 py-1 rounded-full">No stores assigned</span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                      <button
                        onClick={() => startEdit(person)}
                        className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-neutral-200 text-sm font-bold text-neutral-700 hover:bg-neutral-50 transition-colors"
                      >
                        <Edit3 size={15} />
                        Edit
                      </button>
                      <button
                        onClick={() => deactivateStaff(person)}
                        disabled={!person.isActive || person.uid === firebaseUser?.uid || saving}
                        className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-red-200 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-white transition-colors"
                      >
                        Deactivate
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
