import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, onSnapshot, orderBy, doc, setDoc, serverTimestamp, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { PrepItem, RawIngredient } from '../../../types/menu-management';
import { Store } from '../../../types';
import { Edit2, Loader2, PackageSearch, Search, DatabaseZap, Play } from 'lucide-react';
import PrepItemModal from './PrepItemModal';
import PrepProductionModal from './PrepProductionModal';
import { useAuth } from '../../../contexts/AuthContext';

function parseCSV(text: string) {
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (inQuotes && text[i+1] === '"') {
                currentCell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            currentRow.push(currentCell);
            currentCell = '';
        } else if ((c === '\n' || c === '\r') && !inQuotes) {
            if (c === '\r' && text[i+1] === '\n') {
                i++;
            }
            currentRow.push(currentCell);
            rows.push(currentRow);
            currentRow = [];
            currentCell = '';
        } else {
            currentCell += c;
        }
    }
    if (currentCell || currentRow.length > 0 || text.endsWith(',') || text.endsWith('\n')) {
        currentRow.push(currentCell);
        rows.push(currentRow);
    }
    return rows;
}

export default function PrepItemsTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';
  const isManager = staffProfile?.role === 'STORE_MANAGER';

  const [items, setItems] = useState<PrepItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PrepItem | null>(null);

  const [isProduceModalOpen, setIsProduceModalOpen] = useState(false);
  const [producingItem, setProducingItem] = useState<PrepItem | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('');

  const [searchTerm, setSearchTerm] = useState('');
  const [isSeeding, setIsSeeding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importPreview, setImportPreview] = useState<{
    total: number,
    valid: number,
    invalid: number,
    invalidRows: {row: number, code: string, name: string, error: string}[],
    itemsToImport: any[]
  } | null>(null);

  useEffect(() => {
    const q = query(collection(db, 'prepItems'), orderBy('name', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setItems(snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as PrepItem)));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const fetchStores = async () => {
      const q = query(collection(db, 'stores'), orderBy('name', 'asc'));
      const snap = await getDocs(q);
      const data = snap.docs.map(d => ({ ...d.data(), id: d.id } as Store));
      
      let allowedStores = data;
      if (isManager && staffProfile?.storeIds) {
        allowedStores = data.filter(s => staffProfile.storeIds.includes(s.id));
      } else if (!isAdmin && !isManager) {
        if (staffProfile?.storeIds) {
          allowedStores = data.filter(s => staffProfile.storeIds.includes(s.id));
        } else {
          allowedStores = [];
        }
      }
      
      setStores(allowedStores);
      if (allowedStores.length > 0) {
        setSelectedStoreId(allowedStores[0].id);
      }
    };
    fetchStores();
  }, [isAdmin, isManager, staffProfile]);

  const handleEdit = (item: PrepItem) => {
    if (!isAdmin) return;
    setEditingItem(item);
    setIsModalOpen(true);
  };

  const handleProduce = (item: PrepItem) => {
    if (!isAdmin && !isManager) return;
    setProducingItem(item);
    setIsProduceModalOpen(true);
  };

  const handleAddNew = () => {
    if (!isAdmin) return;
    setEditingItem(null);
    setIsModalOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
       try {
           const csv = event.target?.result as string;
           console.log("[PREP IMPORT] CSV selected");
           processCSV(csv);
       } catch (err) {
           console.error(err);
           alert("Failed to parse CSV");
       }
    };
    reader.readAsText(file);
    e.target.value = ''; // reset
  };

  const processCSV = (csvStr: string) => {
      const rows = parseCSV(csvStr);
      if (rows.length < 2) {
         alert("CSV is empty or missing data rows");
         return;
      }
      
      console.log(`[PREP IMPORT] Parsed ${rows.length - 1} rows`);

      const headers = rows[0].map((h: string | undefined) => h ? h.trim() : '');
      const requiredHeaders = ['prepCode', 'prepName', 'outputUOM', 'defaultBatchSize', 'yieldQuantity', 'yieldUOM'];
      const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
      
      if (missingHeaders.length > 0) {
          alert(`CSV headers missing: ${missingHeaders.join(', ')}`);
          return;
      }
      
      const validRows: any[] = [];
      const invalidRows: any[] = [];

      // Group rows by prepCode
      const itemsMap = new Map<string, any>();
      
      for (let i = 1; i < rows.length; i++) {
         const row = rows[i];
         if (row.length === 1 && (!row[0] || !row[0].trim())) continue;
         
         const obj: any = {};
         headers.forEach((h: string, idx: number) => {
             obj[h] = row[idx]?.trim() || '';
         });

         const code = obj.prepCode;
         const name = obj.prepName;
         
         if (!code) {
             invalidRows.push({ row: i+1, code: 'N/A', name: name || 'N/A', error: 'prepCode required' });
             continue;
         }
         if (!name) {
             invalidRows.push({ row: i+1, code, name: 'N/A', error: 'prepName required' });
             continue;
         }
         
         const snakeCaseRegex = /^[A-Z0-9_]+$/;
         if (!snakeCaseRegex.test(code)) {
             invalidRows.push({ row: i+1, code, name, error: 'prepCode must be uppercase snake case' });
             continue;
         }

         if (!obj.outputUOM) {
             invalidRows.push({ row: i+1, code, name, error: 'outputUOM required' });
             continue;
         }

         const batchSize = Number(obj.defaultBatchSize);
         if (isNaN(batchSize) || batchSize <= 0) {
             invalidRows.push({ row: i+1, code, name, error: 'defaultBatchSize > 0 required' });
             continue;
         }

         const yieldQty = Number(obj.yieldQuantity);
         if (isNaN(yieldQty) || yieldQty <= 0) {
             invalidRows.push({ row: i+1, code, name, error: 'yieldQuantity > 0 required' });
             continue;
         }
         
         if (!obj.yieldUOM) {
             invalidRows.push({ row: i+1, code, name, error: 'yieldUOM required' });
             continue;
         }

         let isActive = true;
         if (obj.isActive) {
             const lower = obj.isActive.toLowerCase();
             if (['false', 'no', '0'].includes(lower)) isActive = false;
         }

         let isStockTracked = false;
         if (obj.isStockTracked) {
             const lower = obj.isStockTracked.toLowerCase();
             if (['true', 'yes', '1'].includes(lower)) isStockTracked = true;
         }

         if (!itemsMap.has(code)) {
             itemsMap.set(code, {
                 code,
                 name,
                 outputUOM: obj.outputUOM,
                 defaultBatchSize: batchSize,
                 yieldQuantity: yieldQty,
                 yieldUOM: obj.yieldUOM,
                 isStockTracked,
                 isActive,
                 bom: [],
                 bomVersion: 1, // initialize version
                 costPerUnit: 0 // to be computed later if we have costs
             });
         }

         const item = itemsMap.get(code);

         // Add BOM Component if exists
         const bomComponentType = obj.bomComponentType;
         const bomComponentCode = obj.bomComponentCode;
         
         if (bomComponentType && bomComponentCode) {
             if (bomComponentType !== 'RAW' && bomComponentType !== 'PREP') {
                 invalidRows.push({ row: i+1, code, name, error: 'bomComponentType must be RAW or PREP' });
                 continue;
             }
             
             const bName = obj.bomComponentName || bomComponentCode;
             const bQty = Number(obj.bomQuantity);
             if (isNaN(bQty) || bQty <= 0) {
                 invalidRows.push({ row: i+1, code, name, error: 'bomQuantity > 0 required' });
                 continue;
             }
             
             const bUOM = obj.bomUOM;
             if (!bUOM) {
                 invalidRows.push({ row: i+1, code, name, error: 'bomUOM required' });
                 continue;
             }

             // We don't have cost directly here unless we look it up, so setting cost to 0
             // Real cost application should happen in a secondary step or standard costing recalculation
             item.bom.push({
                 componentType: bomComponentType === 'RAW' ? 'RAW_INGREDIENT' : 'PREP_ITEM',
                 componentCode: bomComponentCode,
                 componentName: bName,
                 quantity: bQty,
                 uom: bUOM,
                 costPerUnit: 0,
                 lineCost: 0
             });
         }
      }
      
      const itemsToImport = Array.from(itemsMap.values());
      const totalErrors = invalidRows.length;

      console.log(`[PREP IMPORT] Valid prep items: ${itemsToImport.length}`);
      console.log(`[PREP IMPORT] Invalid rows: ${totalErrors}`);

      // We only consider the valid items grouped
      setImportPreview({
          total: rows.length - 1,
          valid: itemsToImport.length,
          invalid: totalErrors,
          invalidRows,
          itemsToImport
      });
  };

  const executeImport = async () => {
    if (!isAdmin || !importPreview) return;
    setIsSeeding(true);
    
    try {
        const chunks = [];
        for (let i = 0; i < importPreview.itemsToImport.length; i += 300) {
            chunks.push(importPreview.itemsToImport.slice(i, i + 300));
        }
        
        for (const chunk of chunks) {
            const batch = writeBatch(db);
            for (const item of chunk) {
               console.log(`[PREP IMPORT] Importing row ${item.code}`);
               const ref = doc(db, 'prepItems', item.code);
               batch.set(ref, {
                   ...item,
                   updatedAt: serverTimestamp(),
                   createdAt: serverTimestamp() // merge will keep original if exists
               }, { merge: true });
            }
            await batch.commit();
        }
        
        console.log(`[PREP IMPORT] Import complete`);
        alert(`Imported ${importPreview.valid} prep items successfully.`);
        setImportPreview(null);
    } catch (err: any) {
        console.error("Import failed:", err);
        alert(`Import Failed\nCode: ${err.code || 'UNKNOWN'}\nMessage: ${err.message || err.toString()}\nCollection: prepItems\nRole: ${staffProfile?.role}\nUID: ${staffProfile?.uid}`);
    } finally {
        setIsSeeding(false);
    }
  };

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      return item.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
             item.code.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [items, searchTerm]);

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#5c4033]" />
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full">
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full min-w-0">
        <h3 className="text-lg font-bold text-neutral-800 shrink-0">Batch Prep / Components</h3>
        
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-start xl:justify-end gap-3 w-full xl:w-auto min-w-0">
          <div className="relative w-full lg:w-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input 
              type="text" 
              placeholder="Search prep item..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] w-full lg:min-w-[200px]"
            />
          </div>
          
          {isAdmin && (
            <>
              <input 
                type="file" 
                accept=".csv" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={isSeeding || !!importPreview}
                className="w-full lg:w-auto px-4 py-2 bg-amber-100 text-amber-800 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-amber-200 transition-colors text-sm border border-amber-300 whitespace-nowrap disabled:opacity-50"
              >
                {isSeeding ? <Loader2 size={16} className="animate-spin" /> : <DatabaseZap size={16} />}
                Import Prep Items CSV
              </button>
              <button 
                onClick={() => {
                  const csv = `prepCode,prepName,outputUOM,defaultBatchSize,yieldQuantity,yieldUOM,isStockTracked,isActive,bomComponentType,bomComponentCode,bomComponentName,bomQuantity,bomUOM
BATCH_BREW_1L,Batch Brew 1L,L,1000,1000,ml,TRUE,TRUE,RAW,ROASTED_COFFEE_BEANS,Roasted Coffee Beans,60,g
BATCH_BREW_1L,Batch Brew 1L,L,1000,1000,ml,TRUE,TRUE,RAW,WATER,Water,1000,ml
VANILLA_SWEET_CREAM,Vanilla Sweet Cream,L,1000,1000,ml,TRUE,TRUE,RAW,CREAM,Cream,500,ml
VANILLA_SWEET_CREAM,Vanilla Sweet Cream,L,1000,1000,ml,TRUE,TRUE,RAW,FRESH_MILK,Fresh Milk,300,ml
VANILLA_SWEET_CREAM,Vanilla Sweet Cream,L,1000,1000,ml,TRUE,TRUE,RAW,VANILLA_SYRUP,Vanilla Syrup,200,ml
ICE_CUBES_BATCH,Ice Cubes Batch,kg,10,10,kg,TRUE,TRUE,RAW,WATER,Water,10,L
ALMOND_CROISSANT_BAKED,Baked Almond Croissant,pcs,10,10,pcs,TRUE,TRUE,RAW,CROISSANT_READY,Croissant Ready,10,pcs
ALMOND_CROISSANT_BAKED,Baked Almond Croissant,pcs,10,10,pcs,TRUE,TRUE,RAW,ALMOND_FLAKES,Almond Flakes,100,g
ALMOND_CROISSANT_BAKED,Baked Almond Croissant,pcs,10,10,pcs,TRUE,TRUE,RAW,BUTTER,Butter,50,g`;
                  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'Prep_Items_BOM_Import_Template.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="w-full lg:w-auto px-4 py-2 bg-neutral-100 text-neutral-800 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-neutral-200 transition-colors text-sm border border-neutral-300 whitespace-nowrap"
              >
                Download CSV Template
              </button>
              <button 
                onClick={handleAddNew}
                className="w-full lg:w-auto px-4 py-2 bg-[#5c4033] text-white font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-[#3e2723] transition-colors text-sm whitespace-nowrap"
              >
                Create New
              </button>
            </>
          )}
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
          <PackageSearch size={48} className="mb-4 opacity-30 text-[#5c4033]" />
          <p className="font-bold text-lg text-neutral-600 mb-2">No prep items found</p>
          <p className="text-sm max-w-md text-center">
            {items.length === 0 
              ? "Add your first Prep Item to set up intermediate recipes." 
              : "No items match your search."}
          </p>
        </div>
      ) : (
        <div className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <div className="w-full overflow-x-auto">
            <table className="min-w-[800px] w-full text-left border-collapse">
              <thead>
                <tr className="bg-neutral-50/50 border-b border-neutral-200">
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Prep Item</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Output UOM</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Default Batch</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Yield</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Cost Per Unit</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-center">BOM Size</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-center">Status</th>
                  {(isAdmin || isManager) && <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredItems.map(item => (
                  <tr key={item.code} className="hover:bg-neutral-50/50 transition-colors">
                    <td className="p-4">
                      <div className="font-bold text-neutral-800">{item.name}</div>
                      <div className="text-xs text-neutral-500 font-mono">{item.code}</div>
                    </td>
                    <td className="p-4 font-medium text-neutral-600">{item.outputUOM}</td>
                    <td className="p-4 text-right font-medium text-neutral-600">{item.defaultBatchSize}</td>
                    <td className="p-4 text-right font-medium text-neutral-600">{item.yieldQuantity} <span className="text-xs">{item.yieldUOM}</span></td>
                    <td className="p-4 text-right font-bold text-emerald-600">
                       ${item.costPerUnit?.toFixed(4)}
                    </td>
                    <td className="p-4 text-center font-medium text-neutral-600">
                      <span className="bg-neutral-100 text-neutral-600 px-2 py-1 rounded-md text-xs font-bold">
                        {item.bom?.length || 0} lines
                      </span>
                    </td>
                    <td className="p-4 text-center">
                       <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${item.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'}`}>
                         {item.isActive ? 'Active' : 'Inactive'}
                       </span>
                    </td>
                    {(isAdmin || isManager) && (
                    <td className="p-4 whitespace-nowrap text-right space-x-2">
                       <button 
                         onClick={() => handleProduce(item)}
                         className="px-3 py-1.5 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 font-bold rounded-lg transition-colors inline-flex items-center gap-1.5 text-xs"
                       >
                         <Play size={14} /> Produce Batch
                       </button>
                       {isAdmin && (
                         <button 
                           onClick={() => handleEdit(item)}
                           className="p-2 text-neutral-400 hover:text-[#5c4033] hover:bg-neutral-100 rounded-lg transition-colors inline-flex"
                         >
                           <Edit2 size={16} />
                         </button>
                       )}
                    </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isAdmin && (
        <PrepItemModal 
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          item={editingItem}
        />
      )}

      {(isAdmin || isManager) && (
        <PrepProductionModal
          isOpen={isProduceModalOpen}
          onClose={() => setIsProduceModalOpen(false)}
          prepItem={producingItem}
          storeId={selectedStoreId}
          stores={stores}
        />
      )}

      {importPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50">
           <div className="bg-white rounded-2xl p-6 shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
               <h2 className="text-xl font-black text-neutral-900 mb-4">Import Preview</h2>
               
               <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-200">
                     <div className="text-xs text-neutral-500 uppercase font-bold">Total Rows Parsed</div>
                     <div className="text-2xl font-black text-neutral-800">{importPreview.total}</div>
                  </div>
                  <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-200">
                     <div className="text-xs text-emerald-800 uppercase font-bold">Valid Prep Items</div>
                     <div className="text-2xl font-black text-emerald-600">{importPreview.valid}</div>
                  </div>
                  <div className="bg-red-50 p-4 rounded-xl border border-red-200">
                     <div className="text-xs text-red-800 uppercase font-bold">Invalid Rows (Skipped)</div>
                     <div className="text-2xl font-black text-red-600">{importPreview.invalid}</div>
                  </div>
               </div>

               {importPreview.invalidRows.length > 0 && (
                   <div className="mb-6">
                      <h3 className="text-sm font-bold text-red-800 mb-2">Invalid Rows</h3>
                      <div className="border border-red-200 rounded-xl overflow-hidden w-full">
                         <div className="overflow-x-auto w-full">
                           <table className="w-full text-left text-sm min-w-[600px]">
                              <thead className="bg-red-50 text-red-800 border-b border-red-200">
                                 <tr>
                                    <th className="p-3 font-bold">Row</th>
                                    <th className="p-3 font-bold">Code</th>
                                    <th className="p-3 font-bold">Name</th>
                                    <th className="p-3 font-bold">Error</th>
                                 </tr>
                              </thead>
                              <tbody className="divide-y divide-red-100">
                                 {importPreview.invalidRows.map((ir, idx) => (
                                    <tr key={idx} className="bg-white">
                                       <td className="p-3">{ir.row}</td>
                                       <td className="p-3 font-mono text-xs">{ir.code}</td>
                                       <td className="p-3">{ir.name}</td>
                                       <td className="p-3 text-red-600 font-medium">{ir.error}</td>
                                    </tr>
                                 ))}
                              </tbody>
                           </table>
                         </div>
                      </div>
                   </div>
               )}

               <div className="flex gap-3 justify-end mt-8">
                   <button 
                      onClick={() => setImportPreview(null)}
                      disabled={isSeeding}
                      className="px-6 py-2 bg-neutral-100 text-neutral-700 font-bold rounded-xl hover:bg-neutral-200 transition-colors"
                   >
                       Cancel
                   </button>
                   <button 
                      onClick={executeImport}
                      disabled={isSeeding || importPreview.valid === 0}
                      className="px-6 py-2 bg-[#5c4033] text-white font-bold rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
                   >
                       {isSeeding ? <Loader2 size={16} className="animate-spin" /> : null}
                       Confirm Import
                   </button>
               </div>
           </div>
        </div>
      )}
    </div>
  );
}
