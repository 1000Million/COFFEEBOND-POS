import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, Loader2 } from 'lucide-react';
import { PrepItem } from '../../../types/menu-management';
import { Store } from '../../../types';
import { producePrepItem } from '../../../lib/production';
import { useAuth } from '../../../contexts/AuthContext';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  prepItem: PrepItem | null;
  storeId: string;
  stores: Store[];
}

export default function PrepProductionModal({ isOpen, onClose, prepItem, storeId, stores }: Props) {
  const { staffProfile } = useAuth();
  
  const [selectedStoreId, setSelectedStoreId] = useState(storeId);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (isOpen) {
      setSelectedStoreId(storeId);
      if (prepItem) {
        setQuantity(prepItem.yieldQuantity || 1);
      } else {
        setQuantity('');
      }
      setNotes('');
      setError('');
      setSuccessMsg('');
    }
  }, [isOpen, prepItem, storeId]);

  if (!isOpen || !prepItem) return null;

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staffProfile) return;
    setError('');
    setSuccessMsg('');

    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setError('Output quantity must be greater than 0.');
      return;
    }

    const store = stores.find(s => s.id === selectedStoreId);
    if (!store) {
      setError('Please select a valid store.');
      return;
    }

    setSubmitting(true);
    try {
      await producePrepItem(
        store.id,
        store.name,
        prepItem,
        qty,
        notes,
        staffProfile.uid,
        staffProfile.name
      );
      setSuccessMsg(`Successfully produced ${qty}${prepItem.outputUOM} ${prepItem.name}.`);
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to produce prep item');
      setSubmitting(false);
    }
  };

  const scaleFactor = (Number(quantity) || 0) / (prepItem.yieldQuantity || 1);
  const plannedCost = (prepItem.costPerUnit || 0) * (Number(quantity) || 0);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg flex flex-col shadow-2xl max-h-[90vh]">
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <div>
            <h2 className="text-xl font-bold text-neutral-800">Produce Prep Item</h2>
            <p className="text-sm text-neutral-500 font-medium">{prepItem.name}</p>
          </div>
          <button onClick={onClose} className="p-2 text-neutral-400 hover:bg-neutral-100 rounded-full transition-colors" disabled={submitting}>
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100 flex gap-3 items-start">
               <AlertCircle size={18} className="shrink-0 mt-0.5" />
               <p>{error}</p>
            </div>
          )}
          {successMsg && (
            <div className="mb-6 p-4 bg-emerald-50 text-emerald-700 rounded-xl text-sm font-bold border border-emerald-100">
               {successMsg}
            </div>
          )}

          <form id="production-form" onSubmit={handleExecute} className="space-y-5">
            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">Store</label>
              <select
                value={selectedStoreId}
                onChange={(e) => setSelectedStoreId(e.target.value)}
                className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] font-medium"
                required
                disabled={submitting}
              >
                <option value="">Select a store...</option>
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">
                Output Quantity
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value ? parseFloat(e.target.value) : '')}
                  className="w-full p-3 pr-16 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  required
                  disabled={submitting}
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-neutral-400 font-bold">{prepItem.outputUOM}</span>
              </div>
            </div>

            {quantity && quantity > 0 ? (
               <div className="bg-neutral-100 rounded-xl p-4 border border-neutral-200">
                 <h4 className="text-sm font-bold text-neutral-700 mb-3">Estimated Component Usage</h4>
                 <div className="space-y-2">
                   {prepItem.bom?.map((line, idx) => {
                     const expectedQty = line.quantity * scaleFactor;
                     return (
                       <div key={idx} className="flex justify-between items-center text-sm">
                         <span className="text-neutral-600">{line.componentName}</span>
                         <span className="font-bold text-neutral-800">{expectedQty.toFixed(2)} {line.uom}</span>
                       </div>
                     );
                   })}
                 </div>
                 <div className="mt-3 pt-3 border-t border-neutral-200 flex justify-between items-center text-sm font-bold">
                   <span className="text-neutral-700">Estimated Total Cost</span>
                   <span className="text-[#5c4033]">${plannedCost.toFixed(2)}</span>
                 </div>
               </div>
            ) : null}

            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">Notes (Optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] resize-none h-20"
                placeholder="E.g. Morning batch"
                disabled={submitting}
              />
            </div>
          </form>
        </div>

        <div className="p-6 border-t border-neutral-100 bg-neutral-50/50 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 font-bold text-neutral-600 bg-white border border-neutral-200 rounded-xl hover:bg-neutral-50 transition-colors"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="production-form"
            disabled={submitting || !!successMsg}
            className="px-6 py-2.5 font-bold text-white bg-[#5c4033] rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Confirm Production
          </button>
        </div>
      </div>
    </div>
  );
}
