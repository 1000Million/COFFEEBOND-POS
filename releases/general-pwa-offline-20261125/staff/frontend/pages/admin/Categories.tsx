import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, setDoc, Timestamp, orderBy } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Tags, Plus, Edit2, Check, X, Loader2 } from 'lucide-react';
import { Category } from '../../types';

export default function Categories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [sortOrder, setSortOrder] = useState<number>(0);
  const [isActive, setIsActive] = useState(true);
  const [defaultPrepStation, setDefaultPrepStation] = useState<string>('NONE');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      const q = query(collection(db, 'categories'), orderBy('sortOrder', 'asc'));
      const snapshot = await getDocs(q);
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Category));
      setCategories(list);
    } catch (error) {
      console.error("Error fetching categories:", error);
    } finally {
      setLoading(false);
    }
  };

  const openNewForm = () => {
    setEditingId(null);
    setName('');
    setCode('');
    setSortOrder(categories.length * 10);
    setIsActive(true);
    setDefaultPrepStation('NONE');
    setIsFormOpen(true);
  };

  const openEditForm = (cat: Category) => {
    setEditingId(cat.id);
    setName(cat.name);
    setCode(cat.code);
    setSortOrder(cat.sortOrder || 0);
    setIsActive(cat.isActive);
    setDefaultPrepStation(cat.defaultPrepStation || 'NONE');
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    
    try {
      const catRef = editingId ? doc(db, 'categories', editingId) : doc(collection(db, 'categories'));
      const now = Timestamp.now();
      
      const data: any = {
        name,
        code,
        sortOrder: Number(sortOrder),
        isActive,
        defaultPrepStation,
        updatedAt: now,
      };

      if (!editingId) {
        data.createdAt = now;
      }

      await setDoc(catRef, data, { merge: true });
      closeForm();
      fetchCategories();
    } catch (error) {
      console.error("Error saving category:", error);
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
    <div className="max-w-4xl mx-auto w-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-[#3e2723]">Categories</h2>
          <p className="text-sm text-neutral-500">Manage menu categories and ordering</p>
        </div>
        <button
          onClick={openNewForm}
          className="bg-[#3e2723] hover:bg-[#2d1c19] text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm"
        >
          <Plus size={16} />
          Add Category
        </button>
      </div>

      {isFormOpen && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 mb-6 font-sans">
          <h3 className="text-lg font-bold mb-4">{editingId ? 'Edit Category' : 'New Category'}</h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Name</label>
                <input required value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" placeholder="Hot Coffee" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Code</label>
                <input required value={code} onChange={e => setCode(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" placeholder="HOT_COFFEE" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Sort Order</label>
                <input type="number" required value={sortOrder} onChange={e => setSortOrder(Number(e.target.value))} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" placeholder="0" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Default Prep Station</label>
                <select value={defaultPrepStation} onChange={e => setDefaultPrepStation(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]">
                  <option value="BARISTA">Barista</option>
                  <option value="KITCHEN">Kitchen</option>
                  <option value="BOTH">Both</option>
                  <option value="NONE">None</option>
                </select>
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input type="checkbox" id="isActive" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-4 h-4 text-[#5c4033] rounded border-neutral-300" />
                <label htmlFor="isActive" className="text-sm font-medium text-neutral-700">Category is Active</label>
              </div>
            </div>
            
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-100">
              <button type="button" onClick={closeForm} className="px-4 py-2 text-neutral-600 hover:bg-neutral-100 rounded-lg text-sm font-medium transition-colors">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-[#3e2723] hover:bg-[#2d1c19] text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
                {submitting && <Loader2 size={16} className="animate-spin" />}
                Save Category
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-neutral-50 border-b border-neutral-200 text-xs uppercase tracking-wider text-neutral-500 font-bold">
            <tr>
              <th className="px-6 py-4 w-16">Sort</th>
              <th className="px-6 py-4">Name</th>
              <th className="px-6 py-4 hidden sm:table-cell">Code</th>
              <th className="px-6 py-4">Prep Station</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4 w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 text-neutral-700">
            {categories.map(cat => (
               <tr key={cat.id} className="hover:bg-neutral-50 transition-colors">
                 <td className="px-6 py-4 text-neutral-400 font-mono">{cat.sortOrder}</td>
                 <td className="px-6 py-4 font-medium">{cat.name}</td>
                 <td className="px-6 py-4 hidden sm:table-cell font-mono text-xs">{cat.code}</td>
                 <td className="px-6 py-4">
                   <span className="text-xs font-medium text-neutral-500">{cat.defaultPrepStation || 'NONE'}</span>
                 </td>
                 <td className="px-6 py-4">
                   {cat.isActive ? (
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
                   <button onClick={() => openEditForm(cat)} className="p-1.5 text-neutral-400 hover:text-[#5c4033] hover:bg-neutral-100 rounded transition-colors">
                     <Edit2 size={16} />
                   </button>
                 </td>
               </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-neutral-500">
                  No categories found. Set up your first category.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
