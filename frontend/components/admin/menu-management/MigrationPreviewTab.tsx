import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, setDoc, writeBatch, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { useAuth } from '../../../contexts/AuthContext';
import { Download, CheckCircle, AlertTriangle, XCircle, ArrowRightLeft, ShieldAlert, Loader2, PlayCircle } from 'lucide-react';
import { FinishedGood } from '../../../types/menu-management';
import { MenuItem, Store } from '../../../types';

export default function MigrationPreviewTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';

  const [posSource, setPosSource] = useState<'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS'>('LEGACY_MENU_ITEMS');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [stockIds, setStockIds] = useState<Set<string>>(new Set());

  // Results
  const [matchedItems, setMatchedItems] = useState<any[]>([]);
  const [legacyOnly, setLegacyOnly] = useState<MenuItem[]>([]);
  const [fgOnly, setFgOnly] = useState<FinishedGood[]>([]);
  const [criticalIssues, setCriticalIssues] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [storeReadiness, setStoreReadiness] = useState<any[]>([]);
  
  const [activeTab, setActiveTab] = useState<'overview' | 'matched' | 'legacy' | 'fg' | 'critical' | 'store'>('overview');
  const [mappingReviewed, setMappingReviewed] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'appSettings', 'posMenuSource'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const src = data.globalSource || data.source;
        if (src === 'FINISHED_GOODS') {
          setPosSource('FINISHED_GOODS');
        } else {
          setPosSource('LEGACY_MENU_ITEMS');
        }
      } else {
          setPosSource('LEGACY_MENU_ITEMS');
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const [miSnap, fgSnap, storesSnap, stockSnap] = await Promise.all([
        getDocs(query(collection(db, 'menuItems'))),
        getDocs(query(collection(db, 'finishedGoods'))),
        getDocs(query(collection(db, 'stores'))),
        getDocs(query(collection(db, 'storeStock')))
      ]);

      const miData = miSnap.docs.map(d => ({ id: d.id, ...d.data() } as MenuItem));
      const fgData = fgSnap.docs.map(d => ({ ...d.data(), id: d.id } as FinishedGood));
      const sData = storesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Store)).filter(s => s.isActive);
      const stockSet = new Set(stockSnap.docs.map(d => d.id));

      setMenuItems(miData);
      setFinishedGoods(fgData);
      setStores(sData);
      setStockIds(stockSet);

      runAnalysis(miData, fgData, sData, stockSet);
    } catch (error) {
      console.error(error);
      alert("Failed to run analysis.");
    } finally {
      setAnalyzing(false);
    }
  };

  const runAnalysis = (legacy: MenuItem[], fgs: FinishedGood[], activeStores: Store[], stock: Set<string>) => {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    let matched: any[] = [];
    let legOnly: MenuItem[] = [];
    let fgsOnly = [...fgs];
    
    let criticals: string[] = [];
    let warns: string[] = [];

    // Matching
    legacy.forEach(lItem => {
      let matchIdx = fgsOnly.findIndex(fg => fg.code === lItem.code);
      if (matchIdx === -1) {
        matchIdx = fgsOnly.findIndex(fg => normalize(fg.name || '') === normalize(lItem.name));
      }
      
      if (matchIdx !== -1) {
        const matchingFg = fgsOnly[matchIdx];
        fgsOnly.splice(matchIdx, 1);
        
        matched.push({
          legacy: lItem,
          fg: matchingFg,
          priceDiff: (matchingFg.salePrice || 0) - (lItem.price || 0),
          catDiff: (matchingFg.posCategoryName || 'Misc') !== lItem.categoryName,
          prepDiff: matchingFg.prepStation !== lItem.prepStation,
        });

        if (Math.abs((matchingFg.salePrice || 0) - (lItem.price || 0)) > 20) {
          warns.push(`Price diff > 20 for ${lItem.name}. Legacy: ₹${lItem.price}, New: ₹${matchingFg.salePrice}`);
        }
        if ((matchingFg.posCategoryName || 'Misc') !== lItem.categoryName) {
           warns.push(`Category mismatch for ${lItem.name}. Legacy: ${lItem.categoryName}, New: ${matchingFg.posCategoryName || 'Misc'}`);
        }
        if (matchingFg.prepStation !== lItem.prepStation) {
           warns.push(`Prep station mismatch for ${lItem.name}.`);
        }
      } else {
        if (lItem.isActive) {
          warns.push(`Legacy item active but has no Finished Good equivalent: ${lItem.name}`);
        }
        legOnly.push(lItem);
      }
    });

    // Validating all active sellable FGs
    const activeSellableFGs = fgs.filter(f => f.isActive && f.isSellable);
    
    if (activeSellableFGs.length === 0) {
      criticals.push("No active and sellable finished goods found.");
    }

    activeSellableFGs.forEach(item => {
      if ((item.salePrice || 0) <= 0 && item.itemType !== 'NO_STOCK') {
        criticals.push(`${item.name} (${item.code}): Sale price is missing or zero.`);
      }
      if (!item.prepStation) {
        criticals.push(`${item.name} (${item.code}): Prep station is missing.`);
      }
      if (!item.posCategoryName) {
         criticals.push(`${item.name} (${item.code}): POS category is missing.`);
      }
      if (!item.availableStoreIds || item.availableStoreIds.length === 0) {
        criticals.push(`${item.name} (${item.code}): Not available in any stores.`);
      } else if (item.availableStoreIds.length < activeStores.length) {
        warns.push(`${item.name} (${item.code}): Available only in selected stores.`);
      }

      if (item.itemType === 'MADE_TO_ORDER') {
        if (!item.bom || item.bom.length === 0) {
          criticals.push(`${item.name} (${item.code}): MADE_TO_ORDER item is missing BOM.`);
        }
      }

      if (item.itemType === 'DIRECT_STOCK') {
        // Needs storeStock in all its available stores
        item.availableStoreIds.forEach(stId => {
           const id1 = `${stId}_FINISHED_GOOD_${item.code}`;
           if (!stock.has(id1)) {
              criticals.push(`${item.name} (${item.code}): Missing store stock row for store ${stId}.`);
           }
        });
      }
      
      if (!item.isActive && item.isSellable) {
        criticals.push(`${item.name}: Sellable but inactive.`);
      }

      if (item.cogsPercent > 40) {
        warns.push(`${item.name} (${item.code}): High COGS percent (${item.cogsPercent.toFixed(1)}%).`);
      }
      if (!(item as any).imageUrl) {
        warns.push(`${item.name} (${item.code}): Missing image.`);
      }
    });

    // Store Readiness
    const readiness = activeStores.map(store => {
       const missingAvailIds = activeSellableFGs.filter(f => !f.availableStoreIds?.includes(store.id)).length;
       const missingStock = activeSellableFGs.filter(f => f.itemType === 'DIRECT_STOCK').filter(f => !stock.has(`${store.id}_FINISHED_GOOD_${f.code}`)).length;
       
       let missingBom = 0;
       activeSellableFGs.filter(f => f.itemType === 'MADE_TO_ORDER' && f.bom).forEach(fg => {
          fg.bom?.forEach((bomItem: any) => {
             const stId = `${store.id}_${bomItem.componentType}_${bomItem.componentCode}`;
             const altId = bomItem.componentType === 'PACKAGING' ? `${store.id}_RAW_INGREDIENT_${bomItem.componentCode}` : null;
             if (!stock.has(stId) && !(altId && stock.has(altId))) {
               missingBom++;
             }
          });
       });

       return {
         storeName: store.name,
         storeId: store.id,
         totalSellable: activeSellableFGs.length,
         missingAvail: missingAvailIds,
         missingStock,
         missingBom,
         ready: missingAvailIds === 0 && missingStock === 0 && missingBom === 0
       };
    });

    setMatchedItems(matched);
    setLegacyOnly(legOnly);
    setFgOnly(fgsOnly);
    setCriticalIssues(criticals);
    setWarnings(warns);
    setStoreReadiness(readiness);
  };

  const handleSwitchSource = async (newSource: 'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS') => {
    if (!isAdmin) return;
    
    if (newSource === 'FINISHED_GOODS') {
      const allReady = storeReadiness.every(s => s.ready);
      if (criticalIssues.length > 0 || !allReady) {
         alert("Please resolve all critical issues and store readiness before switching to Finished Goods.");
         return;
      }
      if (!mappingReviewed) {
         alert("Please mark mapping as reviewed before switching.");
         return;
      }
    }
    if (!window.confirm(`Switch POS to use ${newSource}?`)) return;

    setSaving(true);
    try {
      await setDoc(doc(db, 'appSettings', 'posMenuSource'), {
        globalSource: newSource,
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile?.uid || '',
        updatedByName: staffProfile?.name || ''
      }, { merge: true });
    } catch (err) {
      console.error(err);
      alert("Failed to switch POS source.");
    } finally {
      setSaving(false);
    }
  };

  const exportCSV = () => {
    let csv = "Match Status,Legacy Name,Legacy Code,Legacy Price,Legacy Category,New Name,New Code,New Price,New Category,Price Diff\n";
    matchedItems.forEach(m => {
       csv += `Matched,"${m.legacy.name}","${m.legacy.code || ''}",${m.legacy.price},"${m.legacy.categoryName}","${m.fg.name}","${m.fg.code}",${m.fg.salePrice},"${m.fg.posCategoryName}",${m.priceDiff}\n`;
    });
    legacyOnly.forEach(m => {
       csv += `Legacy Only,"${m.name}","${m.code || ''}",${m.price},"${m.categoryName}",,,,,\n`;
    });
    fgOnly.forEach(m => {
       csv += `FG Only,,,,,,"${m.name}","${m.code}",${m.salePrice},"${m.posCategoryName}",\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "Migration_Preview.csv";
    a.click();
  };

  const createMissingStock = async (type: 'FINISHED_GOODS' | 'BOM_COMPONENTS') => {
    if (!isAdmin) return;
    try {
      setSaving(true);
      const batch = writeBatch(db);
      let count = 0;
      
      const activeSellableFGs = finishedGoods.filter(f => f.isActive && f.isSellable);

      stores.forEach(store => {
         if (type === 'FINISHED_GOODS') {
           activeSellableFGs.forEach(fg => {
             if (fg.itemType === 'DIRECT_STOCK') {
               const stId = `${store.id}_FINISHED_GOOD_${fg.code}`;
               if (!stockIds.has(stId)) {
                 batch.set(doc(db, 'storeStock', stId), {
                    storeId: store.id,
                    stockItemType: 'FINISHED_GOOD',
                    componentCode: fg.code,
                    componentName: fg.name,
                    uom: 'pcs',
                    currentStock: 0,
                    minimumLevel: 10,
                    lastUpdated: serverTimestamp()
                 });
                 count++;
               }
             }
           });
         } else if (type === 'BOM_COMPONENTS') {
           activeSellableFGs.forEach(fg => {
             if (fg.itemType === 'MADE_TO_ORDER' && fg.bom) {
               fg.bom.forEach((bomItem: any) => {
                 let typeCode = bomItem.componentType;
                 // If PACKAGING, check both PACKAGING and RAW_INGREDIENT, but fallback to creating PACKAGING if both missing.
                 const stId = `${store.id}_${typeCode}_${bomItem.componentCode}`;
                 const altId = typeCode === 'PACKAGING' ? `${store.id}_RAW_INGREDIENT_${bomItem.componentCode}` : null;
                 
                 if (!stockIds.has(stId) && !(altId && stockIds.has(altId))) {
                   batch.set(doc(db, 'storeStock', stId), {
                      storeId: store.id,
                      stockItemType: typeCode,
                      componentCode: bomItem.componentCode,
                      componentName: bomItem.componentName,
                      uom: bomItem.uom,
                      currentStock: 0,
                      minimumLevel: 10,
                      lastUpdated: serverTimestamp()
                   });
                   // add to set so we don't duplicate within loop
                   stockIds.add(stId);
                   count++;
                 }
               });
             }
           });
         }
      });
      
      if (count > 0) {
        await batch.commit();
        alert(`Created ${count} missing stock rows.`);
        analyze();
      } else {
        alert("No missing stock rows found.");
      }
    } catch(e) {
       console.error(e);
       alert("Error creating stock rows.");
    } finally {
       setSaving(false);
    }
  };

  if (loading) {
     return <div className="p-8 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-neutral-400" /></div>;
  }

  const score = matchedItems.length && menuItems.length 
    ? Math.round((matchedItems.length / menuItems.length) * 100) 
    : 0;

  const isReady = criticalIssues.length === 0 && storeReadiness.every(s => s.ready);
  const statusColor = isReady ? 'text-emerald-600 bg-emerald-50 border-emerald-200' : 'text-red-600 bg-red-50 border-red-200';

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      
      {/* Header controls */}
      <div className={`p-6 rounded-2xl flex flex-col sm:flex-row items-center justify-between shadow-sm border min-w-0 w-full ${posSource === 'FINISHED_GOODS' ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-neutral-200'}`}>
        <div>
           <div className="flex items-center gap-3 mb-1">
             <ArrowRightLeft size={24} className={posSource === 'FINISHED_GOODS' ? 'text-emerald-600' : 'text-neutral-400'} />
             <h3 className="text-xl font-black text-neutral-800">POS Migration Mode</h3>
           </div>
           <p className="text-sm font-medium text-neutral-600">
             Current Source: <strong className={posSource === 'FINISHED_GOODS' ? 'text-emerald-700' : 'text-neutral-800'}>{posSource === 'FINISHED_GOODS' ? 'Finished Goods Collection' : 'Legacy Menu Items'}</strong>
           </p>
        </div>
        <div className="flex gap-2">
           {posSource === 'FINISHED_GOODS' ? (
              <button 
                onClick={() => handleSwitchSource('LEGACY_MENU_ITEMS')}
                disabled={saving}
                className="px-4 py-2 bg-red-100 text-red-700 font-bold rounded-xl hover:bg-red-200 flex items-center justify-center gap-2 text-sm"
              >
                <ShieldAlert size={18} /> Revert to Legacy
              </button>
           ) : (
              <button 
                onClick={() => handleSwitchSource('FINISHED_GOODS')}
                disabled={saving || !isReady || !mappingReviewed}
                className="px-4 py-2 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
              >
                Switch to Finished Goods
              </button>
           )}
           <button onClick={analyze} disabled={analyzing} className="px-4 py-2 bg-neutral-800 text-white font-bold rounded-xl flex items-center gap-2 text-sm">
             {analyzing ? <Loader2 size={16} className="animate-spin"/> : <PlayCircle size={16}/>} 
             Run Analysis
           </button>
        </div>
      </div>

      {menuItems.length > 0 && (
         <div className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
            
            <div className="border-b border-neutral-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
               <div>
                  <h3 className="text-lg font-black text-neutral-800">Migration Readiness</h3>
                  <p className="text-sm text-neutral-500 font-medium">Readiness Score: {score}% Matches</p>
               </div>
               <div className="flex items-center gap-4">
                  {posSource === 'LEGACY_MENU_ITEMS' && (
                     <label className="flex items-center gap-2 text-sm font-bold text-neutral-600 cursor-pointer">
                        <input type="checkbox" checked={mappingReviewed} onChange={e => setMappingReviewed(e.target.checked)} className="w-4 h-4 text-[#5c4033] rounded border-neutral-300" />
                        Mark Mapping as Reviewed
                     </label>
                  )}
                  <div className={`px-4 py-2 rounded-lg border font-bold text-sm uppercase tracking-wider flex items-center gap-2 ${statusColor}`}>
                     {isReady ? <CheckCircle size={16}/> : <XCircle size={16} />}
                     {isReady ? 'Ready for Migration' : `${criticalIssues.length} Critical Issues Found`}
                  </div>
               </div>
            </div>

            <div className="flex border-b border-neutral-200 bg-neutral-50 overflow-x-auto">
               {[
                 { id: 'overview', label: 'Overview' },
                 { id: 'matched', label: `Matched (${matchedItems.length})` },
                 { id: 'legacy', label: `Legacy Only (${legacyOnly.length})` },
                 { id: 'fg', label: `FG Only (${fgOnly.length})` },
                 { id: 'critical', label: `Critical Issues (${criticalIssues.length})` },
                 { id: 'store', label: 'Store Readiness' }
               ].map(t => (
                  <button 
                    key={t.id}
                    onClick={() => setActiveTab(t.id as any)}
                    className={`px-4 py-3 text-sm font-bold whitespace-nowrap transition-colors border-b-2 ${activeTab === t.id ? 'border-[#5c4033] text-[#5c4033] bg-white' : 'border-transparent text-neutral-500 hover:text-neutral-700'}`}
                  >
                    {t.label}
                  </button>
               ))}
            </div>

            <div className="p-6">
               {activeTab === 'overview' && (
                  <div className="space-y-4">
                     <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="p-4 rounded-xl border border-neutral-200 bg-neutral-50 text-center">
                           <p className="text-2xl font-black text-neutral-800">{matchedItems.length}</p>
                           <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest mt-1">Matched</p>
                        </div>
                        <div className="p-4 rounded-xl border border-neutral-200 bg-neutral-50 text-center">
                           <p className="text-2xl font-black text-neutral-800">{legacyOnly.length}</p>
                           <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest mt-1">Legacy Only</p>
                        </div>
                        <div className="p-4 rounded-xl border border-red-100 bg-red-50 text-center">
                           <p className="text-2xl font-black text-red-700">{criticalIssues.length}</p>
                           <p className="text-xs font-bold text-red-600 uppercase tracking-widest mt-1">Criticals</p>
                        </div>
                        <div className="p-4 rounded-xl border border-amber-100 bg-amber-50 text-center">
                           <p className="text-2xl font-black text-amber-700">{warnings.length}</p>
                           <p className="text-xs font-bold text-amber-600 uppercase tracking-widest mt-1">Warnings</p>
                        </div>
                     </div>
                     <div className="flex gap-2">
                        <button onClick={exportCSV} className="px-4 py-2 bg-neutral-100 border border-neutral-200 rounded-lg text-sm font-bold flex items-center gap-2 hover:bg-neutral-200">
                           <Download size={16} /> Export CSV
                        </button>
                     </div>
                  </div>
               )}

               {activeTab === 'matched' && (
                 <div className="overflow-x-auto w-full">
                    <table className="w-full text-left text-sm whitespace-nowrap min-w-[720px]">
                       <thead className="bg-neutral-50 text-neutral-500 uppercase text-xs">
                          <tr>
                             <th className="p-3">Legacy Name / Price</th>
                             <th className="p-3">FG Name / Price</th>
                             <th className="p-3">Price Diff</th>
                             <th className="p-3">Category Match</th>
                          </tr>
                       </thead>
                       <tbody className="divide-y divide-neutral-100">
                          {matchedItems.map((m, i) => (
                             <tr key={i}>
                               <td className="p-3">
                                  <div className="font-bold">{m.legacy.name}</div>
                                  <div className="text-neutral-500">₹{m.legacy.price} | {m.legacy.categoryName}</div>
                               </td>
                               <td className="p-3">
                                  <div className="font-bold">{m.fg.name}</div>
                                  <div className="text-neutral-500">₹{m.fg.salePrice} | {m.fg.posCategoryName}</div>
                               </td>
                               <td className="p-3">
                                  {m.priceDiff !== 0 ? (
                                    <span className={`px-2 py-1 rounded bg-red-100 text-red-700 font-bold text-xs`}>{m.priceDiff > 0 ? '+' : ''}{m.priceDiff}</span>
                                  ) : (
                                    <span className="text-neutral-400">Match</span>
                                  )}
                               </td>
                               <td className="p-3">
                                  {m.catDiff ? <XCircle size={16} className="text-red-500"/> : <CheckCircle size={16} className="text-emerald-500" />}
                               </td>
                             </tr>
                          ))}
                       </tbody>
                    </table>
                 </div>
               )}

               {activeTab === 'critical' && (
                 <div className="space-y-2">
                    {criticalIssues.length === 0 ? <p className="text-emerald-600 font-bold p-4 bg-emerald-50 rounded-xl">No critical issues!</p> : criticalIssues.map((c, i) => (
                       <div key={i} className="p-3 bg-red-50 text-red-700 text-sm font-medium border border-red-100 rounded-xl flex items-center gap-2">
                          <XCircle size={16} /> {c}
                       </div>
                    ))}
                 </div>
               )}

               {activeTab === 'store' && (
                 <div className="space-y-4">
                    {storeReadiness.map((sr, i) => (
                       <div key={i} className="p-4 border border-neutral-200 rounded-xl flex items-center justify-between">
                          <div>
                            <p className="font-bold">{sr.storeName}</p>
                            <p className="text-xs text-neutral-500 mt-1">Missing Avail: {sr.missingAvail} | Missing Direct Stock: {sr.missingStock} | Missing BOM Stock: {sr.missingBom}</p>
                          </div>
                          {sr.ready ? <CheckCircle className="text-emerald-500"/> : <XCircle className="text-red-500"/>}
                       </div>
                    ))}
                    {isAdmin && (
                      <div className="flex gap-2">
                        <button onClick={() => createMissingStock('FINISHED_GOODS')} className="px-4 py-2 bg-indigo-50 text-indigo-700 font-bold rounded-xl border border-indigo-200 hover:bg-indigo-100">
                          Create Missing Stock for Direct FGs
                        </button>
                        <button onClick={() => createMissingStock('BOM_COMPONENTS')} className="px-4 py-2 bg-purple-50 text-purple-700 font-bold rounded-xl border border-purple-200 hover:bg-purple-100">
                          Create Missing Stock for BOM
                        </button>
                      </div>
                    )}
                 </div>
               )}
               
               {activeTab === 'legacy' && (
                  <ul className="list-disc pl-4 space-y-1">
                     {legacyOnly.map(l => <li key={l.id} className="text-sm"><span className="font-bold">{l.name}</span> (₹{l.price}) - {l.isActive ? 'Active' : 'Inactive'}</li>)}
                  </ul>
               )}

               {activeTab === 'fg' && (
                  <ul className="list-disc pl-4 space-y-1">
                     {fgOnly.map(f => <li key={f.id} className="text-sm"><span className="font-bold">{f.name}</span> (₹{f.salePrice}) - {f.isActive ? 'Active' : 'Inactive'}</li>)}
                  </ul>
               )}
            </div>
         </div>
      )}
    </div>
  );
}
