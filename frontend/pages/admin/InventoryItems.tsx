import React, { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { InventoryItem } from '../../types';
import { Package, Plus, Save, X, Edit } from 'lucide-react';

export default function InventoryItems() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [unit, setUnit] = useState<InventoryItem['unit']>('pcs');
  const [category, setCategory] = useState<InventoryItem['category']>('OTHER');
  const [costPerUnit, setCostPerUnit] = useState(0);
  const [isActive, setIsActive] = useState(true);

  const fetchItems = async () => {
    try {
      const snap = await getDocs(query(collection(db, 'inventoryItems'), orderBy('name')));
      setItems(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as InventoryItem)));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  const resetForm = () => {
    setName('');
    setCode('');
    setUnit('pcs');
    setCategory('OTHER');
    setCostPerUnit(0);
    setIsActive(true);
    setEditingItem(null);
    setIsFormOpen(false);
  };

  const openEdit = (item: InventoryItem) => {
    setName(item.name);
    setCode(item.code);
    setUnit(item.unit);
    setCategory(item.category);
    setCostPerUnit(item.costPerUnit || 0);
    setIsActive(item.isActive);
    setEditingItem(item);
    setIsFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const data = {
        name,
        code,
        unit,
        category,
        costPerUnit: Number(costPerUnit),
        isActive,
        updatedAt: serverTimestamp()
      };

      if (editingItem && editingItem.id) {
        await updateDoc(doc(db, 'inventoryItems', editingItem.id), data);
      } else {
        await addDoc(collection(db, 'inventoryItems'), {
          ...data,
          createdAt: serverTimestamp()
        });
      }
      resetForm();
      fetchItems();
    } catch (err) {
      console.error(err);
      alert('Failed to save item');
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-black text-neutral-900 flex items-center gap-2">
            <Package size={24} className="text-[#5c4033]" />
            Global Inventory Catalog
          </h1>
          <p className="text-sm font-medium text-neutral-500">Manage raw materials and retail products.</p>
        </div>
        <button
          onClick={() => { resetForm(); setIsFormOpen(true); }}
          className="flex items-center gap-2 bg-[#5c4033] text-white px-4 py-2 rounded-lg font-bold hover:bg-[#4a332a] transition-colors"
        >
          <Plus size={18} /> New Item
        </button>
      </div>

      {isFormOpen && (
        <form onSubmit={handleSave} className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold text-neutral-800">{editingItem ? 'Edit Item' : 'New Inventory Item'}</h2>
            <button type="button" onClick={resetForm} className="text-neutral-400 hover:text-neutral-600">
              <X size={20} />
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
            <div>
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2">Item Name</label>
              <input type="text" required value={name} onChange={e => setName(e.target.value)} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2 text-sm font-medium focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2">SKU Code</label>
              <input type="text" required value={code} onChange={e => setCode(e.target.value)} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2 text-sm font-medium focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none" placeholder="e.g. MILK_FULL_CREAM" />
            </div>
            <div>
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2">Measurement Unit</label>
              <select value={unit} onChange={e => setUnit(e.target.value as any)} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2 text-sm font-medium focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none">
                <option value="g">Grams (g)</option>
                <option value="kg">Kilograms (kg)</option>
                <option value="ml">Milliliters (ml)</option>
                <option value="l">Liters (l)</option>
                <option value="pcs">Pieces (pcs)</option>
                <option value="pack">Pack / Box</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2">Category</label>
              <select value={category} onChange={e => setCategory(e.target.value as any)} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2 text-sm font-medium focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none">
                <option value="COFFEE">Coffee Beans</option>
                <option value="MILK">Milk & Dairy</option>
                <option value="BAKERY">Bakery</option>
                <option value="PACKAGING">Packaging</option>
                <option value="RETAIL">Retail Goods</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2">Cost Per Unit</label>
              <input type="number" step="0.01" min="0" required value={costPerUnit} onChange={e => setCostPerUnit(Number(e.target.value))} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2 text-sm font-medium focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none" />
            </div>
            <div className="flex items-center pt-6">
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-5 h-5 rounded border-neutral-300 text-[#5c4033] focus:ring-[#5c4033]" />
                <span className="text-sm font-bold text-neutral-700">Item is Active</span>
              </label>
            </div>
          </div>
          
          <div className="flex justify-end gap-3">
            <button type="button" onClick={resetForm} className="px-5 py-2 rounded-lg font-bold text-neutral-600 hover:bg-neutral-100 transition-colors">Cancel</button>
            <button type="submit" className="flex items-center gap-2 bg-[#5c4033] text-white px-5 py-2 rounded-lg font-bold hover:bg-[#4a332a] transition-colors"><Save size={18} /> Save</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center py-12 text-neutral-400">Loading...</div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-neutral-50 text-neutral-500 font-bold text-xs uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">Name & Code</th>
                <th className="px-6 py-4">Category</th>
                <th className="px-6 py-4">Unit</th>
                <th className="px-6 py-4 text-right">Cost/Unit</th>
                <th className="px-6 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 font-medium text-neutral-900">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-neutral-50">
                  <td className="px-6 py-4">
                    <p className="font-bold">{item.name}</p>
                    <p className="text-xs text-neutral-400">{item.code}</p>
                  </td>
                  <td className="px-6 py-4">{item.category}</td>
                  <td className="px-6 py-4">{item.unit}</td>
                  <td className="px-6 py-4 text-right font-mono text-neutral-600">₹{item.costPerUnit?.toFixed(2) || '0.00'}</td>
                  <td className="px-6 py-4 text-center">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${item.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {item.isActive ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <button onClick={() => openEdit(item)} className="p-2 text-neutral-400 hover:text-[#5c4033] hover:bg-neutral-100 rounded transition-colors"><Edit size={16} /></button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-neutral-500 font-medium">No items found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
