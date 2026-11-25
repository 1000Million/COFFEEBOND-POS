import React, { useState, useEffect, useMemo } from 'react';
import { X, Save, Loader2, Plus, Trash2, AlertCircle } from 'lucide-react';
import { PrepItem, BOMComponent, RawIngredient, BOMComponentType } from '../../../types/menu-management';
import { collection, doc, setDoc, getDocs, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { validateBOM } from '../../../lib/bomValidation';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  item: PrepItem | null;
}

const DEFAULT_ITEM: Partial<PrepItem> = {
  code: '',
  name: '',
  outputUOM: 'g',
  defaultBatchSize: 1000,
  yieldQuantity: 1000,
  yieldUOM: 'g',
  isStockTracked: false,
  bom: [],
  isActive: true,
};

export default function PrepItemModal({ isOpen, onClose, item }: Props) {
  const [formData, setFormData] = useState<Partial<PrepItem>>(DEFAULT_ITEM);
  const [bom, setBom] = useState<BOMComponent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  
  const [rawIngredients, setRawIngredients] = useState<RawIngredient[]>([]);
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [loadingLookups, setLoadingLookups] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoadingLookups(true);
      Promise.all([
        getDocs(query(collection(db, 'rawIngredients'), where('isActive', '==', true))),
        getDocs(query(collection(db, 'prepItems'), where('isActive', '==', true)))
      ]).then(([rawSnap, prepSnap]) => {
        setRawIngredients(rawSnap.docs.map(d => ({ ...d.data(), id: d.id } as RawIngredient)));
        setPrepItems(prepSnap.docs.map(d => ({ ...d.data(), id: d.id } as PrepItem)));
      }).catch(err => {
        console.error("Failed to load component list", err);
        setError("Failed to load components for BOM.");
      }).finally(() => {
        setLoadingLookups(false);
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (item) {
      setFormData(item);
      setBom(item.bom || []);
    } else {
      setFormData(DEFAULT_ITEM);
      setBom([]);
    }
    setError('');
  }, [item, isOpen]);

  const availableComponents = useMemo(() => {
    const raw: { type: BOMComponentType, code: string, name: string, uom: string, cost: number }[] = 
      rawIngredients.map(r => ({ type: 'RAW_INGREDIENT', code: r.code, name: r.name, uom: r.usageUOM, cost: r.costPerUsageUnit || 0 }));
    const prep: { type: BOMComponentType, code: string, name: string, uom: string, cost: number }[] = 
      prepItems.filter(p => !formData.code || p.code !== formData.code)
               .map(p => ({ type: 'PREP_ITEM', code: p.code, name: p.name, uom: p.outputUOM, cost: p.costPerUnit || 0 }));
    
    return [...raw, ...prep].sort((a, b) => a.name.localeCompare(b.name));
  }, [rawIngredients, prepItems, formData.code]);

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

  const handleAddBomLine = () => {
    setBom(prev => [...prev, {
      componentType: 'RAW_INGREDIENT',
      componentCode: '',
      componentName: '',
      quantity: 0,
      uom: '',
      costPerUnit: 0,
      lineCost: 0
    }]);
  };

  const handleRemoveBomLine = (index: number) => {
    setBom(prev => prev.filter((_, i) => i !== index));
  };

  const handleBomChange = (index: number, field: keyof BOMComponent, value: any) => {
    setBom(prev => {
      const updated = [...prev];
      const line = { ...updated[index], [field]: value };
      
      if (field === 'componentCode') {
        const comp = availableComponents.find(c => c.code === value);
        if (comp) {
          line.componentType = comp.type;
          line.componentCode = comp.code;
          line.componentName = comp.name;
          line.uom = comp.uom;
          line.costPerUnit = comp.cost;
        } else {
          line.componentName = '';
          line.uom = '';
          line.costPerUnit = 0;
        }
      }
      
      line.lineCost = (line.quantity || 0) * (line.costPerUnit || 0);
      updated[index] = line;
      return updated;
    });
  };

  // Prevent circular dependency recursively
  const checkCircularParams = (targetCode: string, components: BOMComponent[]): boolean => {
      for (const line of components) {
          if (line.componentType === 'PREP_ITEM') {
              if (line.componentCode === targetCode) return true;
              const subPrep = prepItems.find(p => p.code === line.componentCode);
              if (subPrep && subPrep.bom) {
                  if (checkCircularParams(targetCode, subPrep.bom)) return true;
              }
          }
      }
      return false;
  };

  const totalBomCost = bom.reduce((sum, line) => sum + (line.lineCost || 0), 0);
  const yieldQuantity = Number(formData.yieldQuantity) || 1;
  const costPerUnit = totalBomCost / yieldQuantity;

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
      setError('Code is required.');
      return;
    }

    if (!formData.outputUOM) {
      setError('Output UOM is required.');
      return;
    }

    const defaultBatchSize = Number(formData.defaultBatchSize) || 0;
    if (defaultBatchSize <= 0) {
      setError('Default Batch Size must be greater than 0.');
      return;
    }

    if (yieldQuantity <= 0) {
      setError('Yield Quantity must be greater than 0.');
      return;
    }

    if (!formData.yieldUOM) {
      setError('Yield UOM is required.');
      return;
    }

    const bomErrors = validateBOM(bom, finalCode);
    if (bomErrors.length > 0) {
      setError(bomErrors[0]);
      return;
    }

    // Circular check
    if (checkCircularParams(finalCode, bom)) {
       setError('Circular dependency detected in BOM.');
       return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        name: formData.name,
        code: finalCode,
        outputUOM: formData.outputUOM,
        defaultBatchSize,
        yieldQuantity,
        yieldUOM: formData.yieldUOM,
        isStockTracked: !!formData.isStockTracked,
        bom,
        bomVersion: (item?.bomVersion || 0) + 1,
        costPerUnit: costPerUnit,
        lastCostedAt: serverTimestamp(),
        isActive: formData.isActive ?? true,
        updatedAt: serverTimestamp(),
      };
      
      if (!item) {
         payload.createdAt = serverTimestamp();
      }

      await setDoc(doc(db, 'prepItems', finalCode), payload, { merge: true });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <h2 className="text-xl font-bold text-neutral-800">
            {item ? 'Edit Prep Item' : 'New Prep Item'}
          </h2>
          <button onClick={onClose} className="p-2 text-neutral-400 hover:bg-neutral-100 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 bg-white">
          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100 flex gap-3 items-start">
               <AlertCircle size={18} className="shrink-0 mt-0.5" />
               <p>{error}</p>
            </div>
          )}

          <form id="prep-form" onSubmit={handleSave} className="space-y-8">
            <section>
              <h3 className="text-lg font-black text-neutral-800 mb-4">Basic Details</h3>
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
                    placeholder="e.g. COLD_FOAM"
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
                    placeholder="e.g. Cold Foam"
                  />
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-lg font-black text-neutral-800 mb-4">Production & Yield</h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Output UOM</label>
                  <input
                    type="text"
                    name="outputUOM"
                    value={formData.outputUOM}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    placeholder="e.g. g, ml"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Default Batch Size</label>
                  <input
                    type="number"
                    name="defaultBatchSize"
                    value={formData.defaultBatchSize}
                    onChange={handleChange}
                    min="0.001"
                    step="0.001"
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Yield Quantity</label>
                  <input
                    type="number"
                    name="yieldQuantity"
                    value={formData.yieldQuantity}
                    onChange={handleChange}
                    min="0.001"
                    step="0.001"
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">Yield UOM</label>
                  <input
                    type="text"
                    name="yieldUOM"
                    value={formData.yieldUOM}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    placeholder="e.g. g, ml"
                    required
                  />
                </div>
              </div>
            </section>

            <section>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-black text-neutral-800">Bill of Materials (BOM)</h3>
                <button
                  type="button"
                  onClick={handleAddBomLine}
                  className="px-3 py-1.5 bg-[#5c4033]/10 text-[#5c4033] font-bold rounded-lg flex items-center gap-1.5 hover:bg-[#5c4033]/20 transition-colors text-sm"
                >
                  <Plus size={16} /> Add Ingredient
                </button>
              </div>

              {loadingLookups ? (
                <div className="p-8 text-center text-neutral-400">Loading components...</div>
              ) : (
                <div className="bg-neutral-50 border border-neutral-200 rounded-2xl overflow-hidden">
                  {bom.length === 0 ? (
                    <div className="p-8 text-center text-neutral-400 font-medium">
                      No components added to BOM yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto w-full">
                      <table className="w-full text-left border-collapse min-w-[600px]">
                        <thead>
                        <tr className="bg-neutral-100 border-b border-neutral-200">
                          <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider">Component</th>
                          <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider w-32">Quantity</th>
                          <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider w-24">UOM</th>
                          <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right w-32">Line Cost</th>
                          <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider w-16"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {bom.map((line, idx) => (
                          <tr key={idx} className="bg-white">
                            <td className="p-3">
                              <select
                                value={line.componentCode}
                                onChange={(e) => handleBomChange(idx, 'componentCode', e.target.value)}
                                className="w-full p-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                              >
                                <option value="">Select a component...</option>
                                {availableComponents.map(c => (
                                  <option key={c.code} value={c.code}>
                                    {c.name} ({c.type === 'RAW_INGREDIENT' ? 'Raw' : 'Prep'})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="p-3">
                              <input
                                type="number"
                                min="0.001"
                                step="0.001"
                                value={line.quantity || ''}
                                onChange={(e) => handleBomChange(idx, 'quantity', parseFloat(e.target.value) || 0)}
                                className="w-full p-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                              />
                            </td>
                            <td className="p-3 text-sm font-medium text-neutral-600">
                              {line.uom || '-'}
                            </td>
                            <td className="p-3 text-sm font-bold text-neutral-800 text-right">
                              ${line.lineCost?.toFixed(4) || '0.0000'}
                            </td>
                            <td className="p-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveBomLine(idx)}
                                className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="bg-[#5c4033]/5 p-6 rounded-2xl border border-[#5c4033]/20">
               <h3 className="text-lg font-black text-[#3e2723] mb-4">Costing Summary</h3>
               <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                 <div>
                    <label className="block text-sm font-bold text-[#3e2723] mb-1">Total BOM Cost</label>
                    <div className="text-2xl font-black text-[#5c4033]">${totalBomCost.toFixed(4)}</div>
                 </div>
                 <div>
                    <label className="block text-sm font-bold text-[#3e2723] mb-1">Yield Quantity</label>
                    <div className="text-xl font-bold text-neutral-700">{yieldQuantity} {formData.yieldUOM}</div>
                 </div>
                 <div>
                    <label className="block text-sm font-bold text-[#3e2723] mb-1">Cost Per {formData.outputUOM}</label>
                    <div className="text-2xl font-black text-emerald-600">${costPerUnit.toFixed(4)}</div>
                 </div>
               </div>
            </section>

            <section className="flex items-center gap-8 pt-4">
               <label className="relative flex items-center cursor-pointer gap-3">
                 <input
                   type="checkbox"
                   name="isStockTracked"
                   checked={formData.isStockTracked}
                   onChange={handleChange}
                   className="sr-only peer"
                 />
                 <div className="w-11 h-6 bg-neutral-200 peer-focus:outline-none ring-0 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#5c4033]"></div>
                 <span className="font-bold text-sm text-neutral-700">Track in Store Stock</span>
               </label>

               <label className="relative flex items-center cursor-pointer gap-3">
                 <input
                   type="checkbox"
                   name="isActive"
                   checked={formData.isActive}
                   onChange={handleChange}
                   className="sr-only peer"
                 />
                 <div className="w-11 h-6 bg-neutral-200 peer-focus:outline-none ring-0 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                 <span className="font-bold text-sm text-neutral-700">Active Prep Item</span>
               </label>
            </section>
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
            form="prep-form"
            disabled={submitting}
            className="px-6 py-2.5 font-bold text-white bg-[#5c4033] rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            {item ? 'Save Changes' : 'Create Prep Item'}
          </button>
        </div>
      </div>
    </div>
  );
}
