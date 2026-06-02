import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, Loader2 } from 'lucide-react';
import { StoreStock } from '../../../types/menu-management';
import { submitStockMovement } from '../../../lib/stockManagement';
import { useAuth } from '../../../contexts/AuthContext';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  stockItem: StoreStock | null;
}

export default function StockAdjustmentModal({ isOpen, onClose, stockItem }: Props) {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';

  const [movementType, setMovementType] = useState<'PURCHASE' | 'WASTAGE' | 'ADJUSTMENT' | 'OPENING_STOCK'>('PURCHASE');
  const [quantity, setQuantity] = useState<number | ''>('');
  const [minimumStock, setMinimumStock] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmOverride, setConfirmOverride] = useState(false);

  useEffect(() => {
    if (stockItem) {
      setMinimumStock(stockItem.minimumStock || 0);
      setQuantity('');
      setNotes('');
      setMovementType('PURCHASE');
      setConfirmOverride(false);
      setError('');
    }
  }, [stockItem, isOpen]);

  if (!isOpen || !stockItem) return null;

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staffProfile) return;
    setError('');

    const qty = Number(quantity);
    if (!qty || qty === 0) {
      setError('Quantity cannot be zero.');
      return;
    }

    if (minimumStock < 0) {
      setError('Minimum stock cannot be negative.');
      return;
    }

    let actualChange = 0;
    if (movementType === 'PURCHASE' || movementType === 'OPENING_STOCK') {
      if (qty < 0) {
        setError('Quantity must be positive for Purchase and Opening Stock.');
        return;
      }
      actualChange = qty;
    } else if (movementType === 'WASTAGE') {
      if (qty < 0) {
        setError('Quantity must be positive for Wastage.');
        return;
      }
      actualChange = -qty;
    } else if (movementType === 'ADJUSTMENT') {
      actualChange = qty;
    }

    const newStock = stockItem.currentStock + actualChange;
    if (newStock < 0 && !isAdmin) {
      setError('Stock cannot go below 0.');
      return;
    }
    if (newStock < 0 && isAdmin && !confirmOverride) {
       setError('Stock will go below 0. Please check "Confirm Override" to proceed.');
       return;
    }

    setSubmitting(true);
    try {
      await submitStockMovement(
        stockItem.storeId,
        stockItem.storeName,
        stockItem,
        movementType,
        qty,
        notes,
        staffProfile.uid,
        staffProfile.name,
        minimumStock
      );
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update stock');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg overflow-hidden flex flex-col shadow-2xl">
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <div>
            <h2 className="text-xl font-bold text-neutral-800">Manage Stock</h2>
            <p className="text-sm text-neutral-500 font-medium">{stockItem.stockItemName} (in {stockItem.uom})</p>
          </div>
          <button onClick={onClose} className="p-2 text-neutral-400 hover:bg-neutral-100 rounded-full transition-colors">
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

          <div className="bg-neutral-100 p-4 rounded-xl flex justify-between items-center mb-6">
            <div>
              <p className="text-xs font-bold text-neutral-500 uppercase">Current Stock</p>
              <p className="text-2xl font-black text-neutral-800">{stockItem.currentStock.toFixed(2)} <span className="text-sm text-neutral-500 font-medium">{stockItem.uom}</span></p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold text-neutral-500 uppercase">Cost / Unit</p>
              <p className="text-lg font-bold text-neutral-800">${stockItem.costPerUnit?.toFixed(4)}</p>
            </div>
          </div>

          <form id="stock-form" onSubmit={handleExecute} className="space-y-5">
            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">Action</label>
              <select
                value={movementType}
                onChange={(e) => setMovementType(e.target.value as any)}
                className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] font-medium"
              >
                <option value="PURCHASE">Record Purchase (+)</option>
                <option value="WASTAGE">Record Wastage (-)</option>
                <option value="ADJUSTMENT">Adjust Stock (+ or -)</option>
                <option value="OPENING_STOCK">Set Opening Stock (+)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">
                  Quantity 
                  {movementType === 'ADJUSTMENT' && ' (+/-)'}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.01"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value ? parseFloat(e.target.value) : '')}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400 font-bold">{stockItem.uom}</span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-neutral-700 mb-2">Minimum Stock</label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={minimumStock}
                    onChange={(e) => setMinimumStock(parseFloat(e.target.value) || 0)}
                    disabled={!isAdmin}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] disabled:opacity-50"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400 font-bold">{stockItem.uom}</span>
                </div>
              </div>
            </div>

            {isAdmin && (
              <div className="pt-2">
                <label className="flex items-center cursor-pointer gap-2">
                  <input 
                    type="checkbox" 
                    checked={confirmOverride}
                    onChange={(e) => setConfirmOverride(e.target.checked)}
                    className="w-4 h-4 text-[#5c4033] rounded border-neutral-300 focus:ring-[#5c4033]"
                  />
                  <span className="text-sm font-medium text-neutral-700">Confirm Override <span className="text-neutral-400 font-normal">(Allow Negative Stock)</span></span>
                </label>
              </div>
            )}

            <div>
              <label className="block text-sm font-bold text-neutral-700 mb-2">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] resize-none h-24"
                placeholder="Required for wastage and adjustments..."
                required={movementType === 'WASTAGE' || movementType === 'ADJUSTMENT'}
              />
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
            form="stock-form"
            disabled={submitting}
            className="px-6 py-2.5 font-bold text-white bg-[#5c4033] rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Execute
          </button>
        </div>
      </div>
    </div>
  );
}
