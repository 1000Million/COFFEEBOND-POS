import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, onSnapshot, orderBy, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { RawIngredient } from '../../../types/menu-management';
import { Edit2, Loader2, PackageSearch, Search, Filter, DatabaseZap } from 'lucide-react';
import RawIngredientModal from './RawIngredientModal';
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

export default function RawIngredientsTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';

  const [ingredients, setIngredients] = useState<RawIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<RawIngredient | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
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
    const q = query(collection(db, 'rawIngredients'), orderBy('name', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as RawIngredient));
      setIngredients(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleEdit = (item: RawIngredient) => {
    if (!isAdmin) return;
    setEditingItem(item);
    setIsModalOpen(true);
  };

  const handleAddNew = () => {
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
           console.log("[RAW IMPORT] CSV selected");
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
      
      console.log(`[RAW IMPORT] Parsed ${rows.length - 1} rows`);

      const headers = rows[0].map(h => h.trim());
      const requiredHeaders = ['code', 'name', 'category', 'purchaseUOM', 'usageUOM', 'conversionFactor', 'purchaseCost'];
      const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
      
      if (missingHeaders.length > 0) {
          alert(`CSV headers missing: ${missingHeaders.join(', ')}`);
          return;
      }
      
      const validRows: any[] = [];
      const invalidRows: any[] = [];
      
      for (let i = 1; i < rows.length; i++) {
         const row = rows[i];
         if (row.length === 1 && !row[0].trim()) continue; // skip empty lines
         
         const obj: any = {};
         headers.forEach((h, idx) => {
             obj[h] = row[idx]?.trim() || '';
         });

         const code = obj.code;
         const name = obj.name;
         
         if (!code) {
             invalidRows.push({ row: i+1, code: 'N/A', name: name || 'N/A', error: 'code required' });
             continue;
         }
         if (!name) {
             invalidRows.push({ row: i+1, code, name: 'N/A', error: 'name required' });
             continue;
         }
         
         const snakeCaseRegex = /^[A-Z0-9_]+$/;
         if (!snakeCaseRegex.test(code)) {
             invalidRows.push({ row: i+1, code, name, error: 'code must be uppercase snake case' });
             continue;
         }

         if (!obj.category) {
             invalidRows.push({ row: i+1, code, name, error: 'category required' });
             continue;
         }
         if (!obj.purchaseUOM) {
             invalidRows.push({ row: i+1, code, name, error: 'purchaseUOM required' });
             continue;
         }
         if (!obj.usageUOM) {
             invalidRows.push({ row: i+1, code, name, error: 'usageUOM required' });
             continue;
         }
         
         const conv = Number(obj.conversionFactor);
         if (isNaN(conv) || conv <= 0) {
             invalidRows.push({ row: i+1, code, name, error: 'conversionFactor > 0' });
             continue;
         }
         
         const pCost = Number(obj.purchaseCost);
         if (isNaN(pCost) || pCost < 0) {
             invalidRows.push({ row: i+1, code, name, error: 'purchaseCost >= 0' });
             continue;
         }
         
         let cUsage = Number(obj.costPerUsageUnit);
         if (obj.costPerUsageUnit === undefined || obj.costPerUsageUnit === '') {
             cUsage = pCost / conv;
         } else if (isNaN(cUsage) || cUsage < 0) {
             invalidRows.push({ row: i+1, code, name, error: 'costPerUsageUnit >= 0' });
             continue;
         }
         
         let isActive = true;
         if (obj.isActive) {
             const lower = obj.isActive.toLowerCase();
             if (['false', 'no', '0'].includes(lower)) isActive = false;
         }
         
         validRows.push({
             code,
             name,
             category: obj.category || 'OTHER',
             purchaseUOM: obj.purchaseUOM,
             usageUOM: obj.usageUOM,
             conversionFactor: conv,
             purchaseCost: pCost,
             costPerUsageUnit: cUsage,
             supplierName: obj.supplierName || '',
             notes: obj.notes || '',
             isActive,
             importedFrom: "CSV"
         });
      }
      
      console.log(`[RAW IMPORT] Valid rows ${validRows.length}`);
      console.log(`[RAW IMPORT] Invalid rows ${invalidRows.length}`);

      setImportPreview({
          total: validRows.length + invalidRows.length,
          valid: validRows.length,
          invalid: invalidRows.length,
          invalidRows,
          itemsToImport: validRows
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
               console.log(`[RAW IMPORT] Importing row ${item.code}`);
               const ref = doc(db, 'rawIngredients', item.code);
               batch.set(ref, {
                   ...item,
                   updatedAt: serverTimestamp(),
                   createdAt: serverTimestamp()
               }, { merge: true });
            }
            await batch.commit();
        }
        
        console.log(`[RAW IMPORT] Import complete`);
        alert(`Imported ${importPreview.valid} raw ingredients successfully.`);
        setImportPreview(null);
    } catch (err: any) {
        console.error("Import failed:", err);
        alert(`Import Failed\nCode: ${err.code || 'UNKNOWN'}\nMessage: ${err.message || err.toString()}\nCollection: rawIngredients\nRole: ${staffProfile?.role}\nUID: ${staffProfile?.uid}`);
    } finally {
        setIsSeeding(false);
    }
  };

  const categories = useMemo(() => Array.from(new Set(ingredients.map(i => i.category || 'OTHER'))).sort(), [ingredients]);

  const filteredIngredients = useMemo(() => {
    return ingredients.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            item.code.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = categoryFilter ? item.category === categoryFilter : true;
      return matchesSearch && matchesCategory;
    });
  }, [ingredients, searchTerm, categoryFilter]);

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
        <h3 className="text-lg font-bold text-neutral-800 shrink-0">Raw Ingredients</h3>
        
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-start xl:justify-end gap-3 w-full xl:w-auto min-w-0">
          <div className="relative w-full lg:w-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input 
              type="text" 
              placeholder="Search by name or code..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] w-full lg:min-w-[200px]"
            />
          </div>
          
          <div className="relative w-full lg:w-auto">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="pl-10 pr-8 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] appearance-none w-full lg:w-auto"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
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
                Import Raw Ingredients CSV
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

      {filteredIngredients.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
          <PackageSearch size={48} className="mb-4 opacity-30 text-[#5c4033]" />
          <p className="font-bold text-lg text-neutral-600 mb-2">No raw ingredients found</p>
          <p className="text-sm max-w-md text-center">
            {ingredients.length === 0 
              ? "Add your first raw ingredient to start building your internal supply chain." 
              : "No ingredients match your current search/filter."}
          </p>
        </div>
      ) : (
        <div className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <div className="w-full overflow-x-auto">
            <table className="min-w-[720px] w-full text-left border-collapse">
              <thead>
                <tr className="bg-neutral-50/50 border-b border-neutral-200">
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Code</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Name</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Category</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Cost (Usage)</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-center">Status</th>
                  {isAdmin && <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredIngredients.map(item => (
                  <tr key={item.code} className="hover:bg-neutral-50/50 transition-colors">
                    <td className="p-4 whitespace-nowrap font-mono text-sm text-neutral-600">{item.code}</td>
                    <td className="p-4 whitespace-nowrap font-bold text-neutral-800">{item.name}</td>
                    <td className="p-4 whitespace-nowrap text-sm text-neutral-600">{item.category}</td>
                    <td className="p-4 whitespace-nowrap text-sm font-medium text-neutral-800 text-right">
                       ${item.costPerUsageUnit?.toFixed(4)} / {item.usageUOM}
                    </td>
                    <td className="p-4 whitespace-nowrap text-center">
                       <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${item.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
                         {item.isActive ? 'Active' : 'Inactive'}
                       </span>
                    </td>
                    {isAdmin && (
                    <td className="p-4 whitespace-nowrap text-right">
                       <button 
                         onClick={() => handleEdit(item)}
                         className="p-2 text-[#5c4033] hover:bg-[#5c4033]/10 rounded-lg transition-colors"
                       >
                         <Edit2 size={16} />
                       </button>
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
        <RawIngredientModal 
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          item={editingItem}
        />
      )}

      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
           <div className="bg-white rounded-2xl p-6 shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
               <h2 className="text-xl font-black text-neutral-900 mb-4">Import Preview</h2>
               
               <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-200">
                     <div className="text-xs text-neutral-500 uppercase font-bold">Total Rows</div>
                     <div className="text-2xl font-black text-neutral-800">{importPreview.total}</div>
                  </div>
                  <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-200">
                     <div className="text-xs text-emerald-800 uppercase font-bold">Valid Rows (To Import/Update)</div>
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
