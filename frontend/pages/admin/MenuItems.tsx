import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, setDoc, Timestamp, orderBy } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { MenuSquare, Plus, Edit2, Loader2, Check, X, Search, Filter } from 'lucide-react';
import { MenuItem, Category, Store, PrepStation } from '../../types';
import { useAuth } from '../../contexts/AuthContext';

export default function MenuItems() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';

  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('ALL');

  // Form
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form Fields
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState<number>(0);
  const [taxRate, setTaxRate] = useState<number>(5);
  const [prepStation, setPrepStation] = useState<PrepStation>('BARISTA');
  const [isActive, setIsActive] = useState(true);
  const [availableStoreIds, setAvailableStoreIds] = useState<string[]>([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [itemsSnap, catSnap, storesSnap] = await Promise.all([
        getDocs(query(collection(db, 'menuItems'))),
        getDocs(query(collection(db, 'categories'), orderBy('sortOrder', 'asc'))),
        getDocs(query(collection(db, 'stores')))
      ]);

      setItems(itemsSnap.docs.map(d => ({ id: d.id, ...d.data() } as MenuItem)));
      setCategories(catSnap.docs.map(d => ({ id: d.id, ...d.data() } as Category)));
      setStores(storesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Store)));
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const openNewForm = () => {
    if (!isAdmin) return;
    setEditingId(null);
    setName('');
    setCode('');
    setCategoryId(categories[0]?.id || '');
    setDescription('');
    setPrice(0);
    setTaxRate(5);
    setPrepStation('BARISTA');
    setIsActive(true);
    setAvailableStoreIds(stores.map(s => s.id));
    setIsFormOpen(true);
  };

  const openEditForm = (item: MenuItem) => {
    setEditingId(item.id);
    setName(item.name);
    setCode(item.code);
    setCategoryId(item.categoryId);
    setDescription(item.description || '');
    setPrice(item.price);
    setTaxRate(item.taxRate);
    setPrepStation(item.prepStation);
    setIsActive(item.isActive);
    setAvailableStoreIds(item.availableStoreIds || []);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
  };

  const toggleStoreAvailability = (storeId: string) => {
    // If not admin, check if user is allowed to toggle this store
    if (!isAdmin && !staffProfile?.storeIds.includes(storeId)) return;

    setAvailableStoreIds(prev => 
      prev.includes(storeId) 
        ? prev.filter(id => id !== storeId)
        : [...prev, storeId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    
    try {
      const itemRef = editingId ? doc(db, 'menuItems', editingId) : doc(collection(db, 'menuItems'));
      const now = Timestamp.now();
      
      const selectedCat = categories.find(c => c.id === categoryId);

      let dataToUpdate: any;

      if (isAdmin) {
        dataToUpdate = {
          name,
          code,
          categoryId,
          categoryCode: selectedCat?.code || '',
          categoryName: selectedCat?.name || '',
          description,
          price: Number(price),
          taxRate: Number(taxRate),
          prepStation,
          isActive,
          availableStoreIds,
          updatedAt: now,
        };
        if (!editingId) {
          dataToUpdate.createdAt = now;
        }
      } else {
        // Store Manager can only update availableStoreIds
        dataToUpdate = {
          availableStoreIds,
          updatedAt: now,
        };
      }

      await setDoc(itemRef, dataToUpdate, { merge: true });
      closeForm();
      fetchData();
    } catch (error) {
      console.error("Error saving menu item:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const filteredItems = items.filter(item => {
    const nameMatch = (item.name || '').toLowerCase().includes(searchQuery.toLowerCase());
    const codeMatch = (item.code || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSearch = nameMatch || codeMatch;
    const matchesCategory = filterCategory === 'ALL' || item.categoryId === filterCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#5c4033]" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-[#3e2723]">Menu Items</h2>
          <p className="text-sm text-neutral-500">Manage products, pricing, and availability</p>
        </div>
        {isAdmin && (
          <button
            onClick={openNewForm}
            className="bg-[#3e2723] hover:bg-[#2d1c19] text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm"
          >
            <Plus size={16} />
            Add Item
          </button>
        )}
      </div>

      {isFormOpen && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 mb-6 font-sans">
          <h3 className="text-lg font-bold mb-4">{editingId ? 'Edit Item' : 'New Item'}</h3>
          <form onSubmit={handleSubmit} className="space-y-6">
            
            {/* Core Details (Admin Only for Edit) */}
            <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 ${!isAdmin ? 'opacity-50 pointer-events-none' : ''}`}>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Name</label>
                <input required value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Code</label>
                <input required value={code} onChange={e => setCode(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Category</label>
                <select required value={categoryId} onChange={e => {
                  setCategoryId(e.target.value);
                  if (!editingId) {
                    const selectedCat = categories.find(c => c.id === e.target.value);
                    if (selectedCat && selectedCat.defaultPrepStation) setPrepStation(selectedCat.defaultPrepStation);
                  }
                }} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]">
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Price (₹)</label>
                <input type="number" required value={price} onChange={e => setPrice(Number(e.target.value))} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Tax Rate (%)</label>
                <input type="number" required value={taxRate} onChange={e => setTaxRate(Number(e.target.value))} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Prep Station</label>
                <select value={prepStation} onChange={e => setPrepStation(e.target.value as PrepStation)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]">
                  <option value="BARISTA">Barista</option>
                  <option value="KITCHEN">Kitchen</option>
                  <option value="BOTH">Both</option>
                  <option value="NONE">None</option>
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Description (Optional)</label>
                <input value={description} onChange={e => setDescription(e.target.value)} className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="isActive" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-4 h-4" />
                <label htmlFor="isActive" className="text-sm font-medium">Item is Active</label>
              </div>
            </div>

            {/* Store Availability (Editable by Managers too, but only for their assigned stores) */}
            <div className="pt-4 border-t border-neutral-100">
              <label className="block text-xs font-bold text-neutral-800 uppercase tracking-widest mb-3">Available at Stores</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {stores.map(store => {
                  const canToggle = isAdmin || staffProfile?.storeIds.includes(store.id);
                  const isAvailable = availableStoreIds.includes(store.id);
                  
                  return (
                    <button
                      key={store.id}
                      type="button"
                      disabled={!canToggle}
                      onClick={() => toggleStoreAvailability(store.id)}
                      className={`text-left px-3 py-2 rounded-lg border text-sm transition-all flex items-center justify-between
                        ${isAvailable 
                          ? 'bg-[#5c4033] border-[#5c4033] text-[#f9f5f0]' 
                          : 'bg-neutral-50 border-neutral-200 text-neutral-500'}
                        ${!canToggle ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}
                      `}
                    >
                      <span className="truncate">{store.name}</span>
                      {isAvailable && <Check size={14} />}
                    </button>
                  );
                })}
              </div>
              {!isAdmin && <p className="text-xs text-neutral-500 mt-2">You can only manage availability for stores you are assigned to.</p>}
            </div>
            
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-100">
              <button type="button" onClick={closeForm} className="px-4 py-2 text-neutral-600 hover:bg-neutral-100 rounded-lg text-sm font-medium transition-colors">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-[#3e2723] hover:bg-[#2d1c19] text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
                {submitting && <Loader2 size={16} className="animate-spin" />}
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-4 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input 
            type="text" 
            placeholder="Search items..." 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-white border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] text-sm"
          />
        </div>
        <div className="flex items-center gap-2 bg-white border border-neutral-200 rounded-lg px-3 lg:w-64">
          <Filter size={14} className="text-neutral-400" />
          <select 
            value={filterCategory} 
            onChange={e => setFilterCategory(e.target.value)}
            className="w-full py-2 bg-transparent text-sm focus:outline-none text-neutral-700"
          >
            <option value="ALL">All Categories</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-neutral-50 border-b border-neutral-200 text-xs uppercase tracking-wider text-neutral-500 font-bold">
              <tr>
                <th className="px-6 py-4">Item</th>
                <th className="px-6 py-4">Category</th>
                <th className="px-6 py-4">Price</th>
                <th className="px-6 py-4">Station</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-700">
              {filteredItems.map(item => (
                 <tr key={item.id} className="hover:bg-neutral-50 transition-colors">
                   <td className="px-6 py-4">
                     <div className="font-medium">{item.name}</div>
                     <div className="text-xs font-mono text-neutral-400">{item.code}</div>
                   </td>
                   <td className="px-6 py-4">
                     <span className="bg-neutral-100 text-neutral-600 px-2 py-1 rounded text-xs font-medium">
                       {item.categoryName}
                     </span>
                   </td>
                   <td className="px-6 py-4 font-mono">₹{item.price.toFixed(2)}</td>
                   <td className="px-6 py-4 text-xs font-medium text-neutral-500">{item.prepStation}</td>
                   <td className="px-6 py-4">
                     {item.isActive ? (
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
                     <button onClick={() => openEditForm(item)} className="p-1.5 text-neutral-400 hover:text-[#5c4033] hover:bg-neutral-100 rounded transition-colors">
                       <Edit2 size={16} />
                     </button>
                   </td>
                 </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-neutral-500">
                    No items found matching criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
