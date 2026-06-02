import React, { useState, useEffect } from 'react';
import { X, Save, Loader2 } from 'lucide-react';
import { RawIngredient } from '../../../types/menu-management';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../../lib/firebase';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  item: RawIngredient | null;
}

const DEFAULT_ITEM: Partial<RawIngredient> = {
  code: '',
  name: '',
  category: 'OTHER',
  purchaseUOM: 'kg',
  usageUOM: 'g',
  conversionFactor: 1000,
  purchaseCost: 0,
  costPerUsageUnit: 0,
  supplierName: '',
  isActive: true,
};

export default function RawIngredientModal({ isOpen, onClose, item }: Props) {
  const [formData, setFormData] = useState<Partial<RawIngredient>>(DEFAULT_ITEM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (item) {
      setFormData(item);
    } else {
      setFormData(DEFAULT_ITEM);
    }
  }, [item, isOpen]);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target as HTMLInputElement;
    let finalValue: any = value;
    if (type === 'number') {
      finalValue = value === '' ? 0 : parseFloat(value);
    } else if (type === 'checkbox') {
      finalValue = (e.target as HTMLInputElement).checked;
    }
    setFormData(prev => ({ ...prev, [name]: finalValue }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!formData.name) {
      setError('Name is required.');
      return;
    }

    const finalCode = formData.code ? 
      formData.code.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '') : 
      formData.name.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');

    if (!finalCode) {
      setError('Code could not be generated and is required.');
      return;
    }

    if (!formData.purchaseUOM) {
      setError('Purchase UOM is required.');
      return;
    }

    if (!formData.usageUOM) {
      setError('Usage UOM is required.');
      return;
    }

    const conversionFactor = Number(formData.conversionFactor) || 0;
    if (conversionFactor <= 0) {
      setError('Conversion Factor must be greater than 0.');
      return;
    }

    const purchaseCost = Number(formData.purchaseCost) || 0;
    if (purchaseCost < 0) {
      setError('Purchase Cost cannot be negative.');
      return;
    }

    setSubmitting(true);
    try {
      const costPerUsageUnit = purchaseCost / conversionFactor;

      const payload: Record<string, any> = {
        name: formData.name,
        code: finalCode,
        category: formData.category || 'OTHER',
        purchaseUOM: formData.purchaseUOM,
        usageUOM: formData.usageUOM,
        conversionFactor,
        purchaseCost,
        costPerUsageUnit,
        isActive: formData.isActive ?? true,
        updatedAt: serverTimestamp(),
      };
      
      if (formData.supplierName) {
         payload.supplierName = formData.supplierName;
      }
      
      if (!item) {
         payload.createdAt = serverTimestamp();
      }

      await setDoc(doc(db, 'rawIngredients', finalCode), payload, { merge: true });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <h2 className="text-xl font-bold text-neutral-800">
            {item ? 'Edit Raw Ingredient' : 'New Raw Ingredient'}
          </h2>
          <button onClick={onClose} className="p-2 text-neutral-400 hover:bg-neutral-100 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto custom-scrollbar flex-1">
          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100">
              {error}
            </div>
          )}

          <form id="ingredient-form" onSubmit={handleSave} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Code <span className="text-neutral-400 font-normal">(Auto-generated if empty)</span></label>
                <input
                  type="text"
                  name="code"
                  value={formData.code}
                  onChange={handleChange}
                  disabled={!!item}
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] disabled:opacity-50"
                  placeholder="e.g. ROASTED_BEANS"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Name <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  required
                />
              </div>
            </div>

            <div>
               <label className="block text-sm font-bold text-neutral-700 mb-2">Category</label>
               <input
                  type="text"
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
               />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Purchase UOM</label>
                <input
                  type="text"
                  name="purchaseUOM"
                  value={formData.purchaseUOM}
                  onChange={handleChange}
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  placeholder="e.g. kg, L, Box"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Usage UOM</label>
                <input
                  type="text"
                  name="usageUOM"
                  value={formData.usageUOM}
                  onChange={handleChange}
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  placeholder="e.g. g, ml, pcs"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Conv. Factor</label>
                <input
                  type="number"
                  name="conversionFactor"
                  value={formData.conversionFactor}
                  onChange={handleChange}
                  min="0.001"
                  step="0.001"
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                />
                <p className="text-xs text-neutral-500 mt-1">1 Purchase UOM = X Usage UOM</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-[#5c4033]/5 p-4 rounded-xl border border-[#5c4033]/20">
               <div>
                  <label className="block text-sm font-bold text-[#3e2723] mb-2">Purchase Cost</label>
                  <input
                     type="number"
                     name="purchaseCost"
                     value={formData.purchaseCost}
                     onChange={handleChange}
                     min="0"
                     step="0.01"
                     className="w-full p-3 bg-white border border-[#5c4033]/30 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  />
               </div>
               <div>
                  <label className="block text-sm font-bold text-[#3e2723] mb-2">Cost per Usage Unit</label>
                  <div className="w-full p-3 bg-white/50 border border-[#5c4033]/30 rounded-xl text-[#3e2723] font-mono font-medium">
                     {((Number(formData.purchaseCost) || 0) / (Number(formData.conversionFactor) || 1)).toFixed(4)}
                  </div>
                  <p className="text-xs text-[#5c4033]/70 mt-1">Auto-calculated</p>
               </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Supplier Name</label>
                <input
                  type="text"
                  name="supplierName"
                  value={formData.supplierName}
                  onChange={handleChange}
                  className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                />
              </div>
              <div className="flex items-center pt-8">
                <label className="relative flex items-center cursor-pointer gap-3">
                  <input
                    type="checkbox"
                    name="isActive"
                    checked={formData.isActive}
                    onChange={handleChange}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-neutral-200 peer-focus:outline-none ring-0 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                  <span className="font-bold text-sm text-neutral-700">Active Component</span>
                </label>
              </div>
            </div>
          </form>
        </div>

        <div className="p-6 border-t border-neutral-100 bg-neutral-50/50 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 font-bold text-neutral-600 bg-white border border-neutral-200 rounded-xl hover:bg-neutral-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="ingredient-form"
            disabled={submitting}
            className="px-6 py-2.5 font-bold text-white bg-[#5c4033] rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            {item ? 'Save Changes' : 'Create Ingredient'}
          </button>
        </div>
      </div>
    </div>
  );
}
