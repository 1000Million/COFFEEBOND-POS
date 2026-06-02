import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, setDoc, Timestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Store, Plus, Edit2, Check, X, Loader2 } from 'lucide-react';
import { Store as StoreType } from '../../types';

export default function Stores() {
  const [stores, setStores] = useState<StoreType[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchStores();
  }, []);

  const fetchStores = async () => {
    try {
      const q = query(collection(db, 'stores'));
      const snapshot = await getDocs(q);
      const storesList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StoreType));
      setStores(storesList);
    } catch (error) {
      console.error("Error fetching stores:", error);
    } finally {
      setLoading(false);
    }
  };

  const openNewForm = () => {
    setEditingId(null);
    setName('');
    setCode('');
    setAddress('');
    setIsActive(true);
    setIsFormOpen(true);
  };

  const openEditForm = (store: StoreType) => {
    setEditingId(store.id);
    setName(store.name);
    setCode(store.code);
    setAddress(store.address);
    setIsActive(store.isActive);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    
    try {
      const storeRef = editingId ? doc(db, 'stores', editingId) : doc(collection(db, 'stores'));
      const now = Timestamp.now();
      
      const storeData: any = {
        name,
        code,
        address,
        isActive,
        updatedAt: now,
      };

      if (!editingId) {
        storeData.createdAt = now;
      }

      await setDoc(storeRef, storeData, { merge: true });
      closeForm();
      fetchStores();
    } catch (error) {
      console.error("Error saving store:", error);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#5c4033]" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto w-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-[#3e2723]">Stores</h2>
          <p className="text-sm text-neutral-500">Manage your retail locations</p>
        </div>
        <button
          onClick={openNewForm}
          className="bg-[#3e2723] hover:bg-[#2d1c19] text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm"
        >
          <Plus size={16} />
          Add Store
        </button>
      </div>

      {isFormOpen && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 mb-6 font-sans">
          <h3 className="text-lg font-bold mb-4">{editingId ? 'Edit Store' : 'New Store'}</h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Name</label>
                <input required value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" placeholder="Uday Park" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Code</label>
                <input required value={code} onChange={e => setCode(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" placeholder="UDAY_PARK" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Address</label>
                <input required value={address} onChange={e => setAddress(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" placeholder="123 Main St, New Delhi" />
              </div>
              <div className="md:col-span-2 flex items-center gap-2">
                <input type="checkbox" id="isActive" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-4 h-4 text-[#5c4033] rounded border-neutral-300" />
                <label htmlFor="isActive" className="text-sm font-medium text-neutral-700">Store is Active</label>
              </div>
            </div>
            
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-100">
              <button type="button" onClick={closeForm} className="px-4 py-2 text-neutral-600 hover:bg-neutral-100 rounded-lg text-sm font-medium transition-colors">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-[#3e2723] hover:bg-[#2d1c19] text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
                {submitting && <Loader2 size={16} className="animate-spin" />}
                Save Store
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-neutral-50 border-b border-neutral-200 text-xs uppercase tracking-wider text-neutral-500 font-bold">
            <tr>
              <th className="px-6 py-4">Name</th>
              <th className="px-6 py-4">Code</th>
              <th className="px-6 py-4 hidden md:table-cell">Address</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4 w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 text-neutral-700">
            {stores.map(store => (
               <tr key={store.id} className="hover:bg-neutral-50 transition-colors">
                 <td className="px-6 py-4 font-medium">{store.name}</td>
                 <td className="px-6 py-4 font-mono text-xs">{store.code}</td>
                 <td className="px-6 py-4 hidden md:table-cell text-neutral-500 truncate max-w-[200px]">{store.address}</td>
                 <td className="px-6 py-4">
                   {store.isActive ? (
                     <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold bg-green-50 text-green-700 px-2 py-0.5 rounded">
                       <Check size={12} /> Active
                     </span>
                   ) : (
                     <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded">
                       <X size={12} /> Inactive
                     </span>
                   )}
                 </td>
                 <td className="px-6 py-4 text-right">
                   <button onClick={() => openEditForm(store)} className="p-1.5 text-neutral-400 hover:text-[#5c4033] hover:bg-neutral-100 rounded transition-colors">
                     <Edit2 size={16} />
                   </button>
                 </td>
               </tr>
            ))}
            {stores.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-neutral-500">
                  No stores found. Set up your first store.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
