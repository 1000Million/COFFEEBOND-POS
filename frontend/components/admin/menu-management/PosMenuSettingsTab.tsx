import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot, getDocs, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { FinishedGood } from '../../../types/menu-management';
import { Store } from '../../../types';
import { Power, CheckCircle, XCircle, Loader2, ArrowRightLeft, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';

export default function PosMenuSettingsTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';

  const [settings, setSettings] = useState<{ globalSource: string, storeOverrides: Record<string, string> }>({ globalSource: 'LEGACY_MENU_ITEMS', storeOverrides: {} });
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showGlobalConfirm, setShowGlobalConfirm] = useState<'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS' | null>(null);

  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [stockIds, setStockIds] = useState<Set<string>>(new Set());

  const [storeStatus, setStoreStatus] = useState<any[]>([]);

  useEffect(() => {
    const unsubSettings = onSnapshot(doc(db, 'appSettings', 'posMenuSource'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setSettings({
            globalSource: data.globalSource || data.source || 'LEGACY_MENU_ITEMS',
            storeOverrides: data.storeOverrides || {}
        });
      }
      setLoading(false);
    });

    return () => unsubSettings();
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [fgSnap, storeSnap, stockSnap] = await Promise.all([
          getDocs(query(collection(db, 'finishedGoods'))),
          getDocs(query(collection(db, 'stores'))),
          getDocs(query(collection(db, 'storeStock')))
        ]);
        
        const fgs = fgSnap.docs.map(d => ({ ...d.data(), id: d.id } as FinishedGood));
        const st = storeSnap.docs.map(d => ({ ...d.data(), id: d.id } as Store)).filter(s => s.isActive);
        const stocks = new Set(stockSnap.docs.map(d => d.id));
        
        setFinishedGoods(fgs);
        setStores(st);
        setStockIds(stocks);
        
        calculateStoreStatus(fgs, st, stocks);
      } catch (err) {
        console.error(err);
      } finally {
        setAnalyzing(false);
      }
    };
    fetchData();
  }, []);

  const calculateStoreStatus = (fgs: FinishedGood[], st: Store[], stocks: Set<string>) => {
     const statuses = st.map(store => {
         let criticals = 0;
         const activeSellableFGs = fgs.filter(f => f.isActive && f.isSellable);

         activeSellableFGs.forEach(fg => {
             // 1. Missing prices / prep
             if ((fg.salePrice || 0) <= 0 && fg.itemType !== 'NO_STOCK') criticals++;
             if (!fg.prepStation) criticals++;
             if (!fg.posCategoryName) criticals++;

             // 2. Store Availability
             if (!fg.availableStoreIds?.includes(store.id)) criticals++;

             // 3. BOM
             if (fg.itemType === 'MADE_TO_ORDER' && (!fg.bom || fg.bom.length === 0)) criticals++;

             // 4. Stock
             if (fg.itemType === 'DIRECT_STOCK' && !stocks.has(`${store.id}_FINISHED_GOOD_${fg.code}`)) criticals++;
             
             if (fg.itemType === 'MADE_TO_ORDER' && fg.bom) {
                 fg.bom.forEach((bomItem: any) => {
                     const stId = `${store.id}_${bomItem.componentType}_${bomItem.componentCode}`;
                     const altId = bomItem.componentType === 'PACKAGING' ? `${store.id}_RAW_INGREDIENT_${bomItem.componentCode}` : null;
                     if (!stocks.has(stId) && !(altId && stocks.has(altId))) {
                        criticals++;
                     }
                 });
             }
         });
         
         const totalChecks = activeSellableFGs.length || 1;
         const badItems = Math.min(criticals, totalChecks); // just a rough approx of readiness
         // We'll calculate a percentage strictly for visuals
         const score = Math.max(0, Math.round(((totalChecks - badItems) / totalChecks) * 100));

         return {
            id: store.id,
            name: store.name,
            criticalCount: criticals,
            readiness: score === 100 && criticals === 0 ? 100 : score
         };
     });
     setStoreStatus(statuses);
  };

  const handleGlobalSwitch = async () => {
    if (!isAdmin || !showGlobalConfirm) return;
    const newSource = showGlobalConfirm;
    
    if (newSource === 'FINISHED_GOODS') {
       const hasCriticals = storeStatus.some(s => s.criticalCount > 0);
       if (hasCriticals) {
          alert("Cannot switch global source to Finished Goods. Some active stores have critical issues.");
          setShowGlobalConfirm(null);
          return;
       }
    }
    
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
      alert("Failed to switch global POS source.");
    } finally {
      setSaving(false);
      setShowGlobalConfirm(null);
    }
  };

  const handleEmergencyRollback = async () => {
     if (!isAdmin) return;
     if (!window.confirm("Are you sure you want to reset ALL stores back to Legacy Menu Items? This will clear all overrides.")) return;
     
     setSaving(true);
     try {
         await setDoc(doc(db, 'appSettings', 'posMenuSource'), {
             globalSource: 'LEGACY_MENU_ITEMS',
             storeOverrides: {},
             updatedAt: serverTimestamp(),
             updatedByUserId: staffProfile?.uid || '',
             updatedByName: staffProfile?.name || ''
         }, { merge: true });
     } catch (err) {
         console.error(err);
         alert("Failed to perform emergency rollback.");
     } finally {
         setSaving(false);
     }
  };

  const handleStoreOverride = async (storeId: string, action: 'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS' | 'CLEAR') => {
      if (!isAdmin) return;

      if (action === 'FINISHED_GOODS') {
          const stInfo = storeStatus.find(s => s.id === storeId);
          if (stInfo && stInfo.criticalCount > 0) {
              alert(`Cannot enable Finished Goods for ${stInfo.name} because it has ${stInfo.criticalCount} critical issues.`);
              return;
          }
      }

      setSaving(true);
      try {
          const newOverrides = { ...settings.storeOverrides };
          if (action === 'CLEAR') {
             delete newOverrides[storeId];
          } else {
             newOverrides[storeId] = action;
          }
          await setDoc(doc(db, 'appSettings', 'posMenuSource'), {
              storeOverrides: newOverrides,
              updatedAt: serverTimestamp(),
              updatedByUserId: staffProfile?.uid || '',
              updatedByName: staffProfile?.name || ''
          }, { merge: true });
      } catch(e) {
          console.error(e);
          alert("Failed to update store override.");
      } finally {
          setSaving(false);
      }
  };

  if (loading || analyzing) {
    return (
      <div className="h-64 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#5c4033]" />
      </div>
    );
  }

  const pilotStoresCount = Object.values(settings.storeOverrides).filter(v => v === 'FINISHED_GOODS').length;
  const readyStoresCount = storeStatus.filter(s => s.readiness === 100).length;
  const totalCriticalIssues = storeStatus.reduce((acc, curr) => acc + curr.criticalCount, 0);

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div>
         <h2 className="text-2xl font-black text-neutral-800">POS Rollout</h2>
         <p className="text-sm text-neutral-500 mt-1">Control which stores use the live Menu Management POS source.</p>
         <p className="text-sm text-neutral-400 mt-1">Menu Management POS is the active source. Classic POS can be used as a fallback if needed.</p>
      </div>

      {/* Overview Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
             <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Global Default</div>
             <div className="text-lg font-black text-neutral-900">{settings.globalSource === 'FINISHED_GOODS' ? 'Menu Management POS' : 'Classic POS'}</div>
          </div>
          <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
             <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Pilot Stores</div>
             <div className="text-lg font-black text-neutral-900">{pilotStoresCount}</div>
          </div>
          <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
             <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Stores Ready</div>
             <div className="text-lg font-black text-emerald-600">{readyStoresCount} <span className="text-sm text-neutral-400 font-medium">/ {stores.length}</span></div>
          </div>
          <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
             <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Critical Issues</div>
             <div className={`text-lg font-black ${totalCriticalIssues > 0 ? 'text-red-600' : 'text-neutral-900'}`}>{totalCriticalIssues}</div>
          </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-4">
              <h3 className="text-lg font-black text-neutral-800 mb-2">Store Rollout</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                 {storeStatus.map(st => {
                    const override = settings.storeOverrides[st.id];
                    const activeSource = override || settings.globalSource;
                    
                    return (
                        <div key={st.id} className="bg-white rounded-xl border border-neutral-200 p-5 shadow-sm hover:shadow-md transition-shadow">
                            <div className="flex justify-between items-start mb-4">
                                <div>
                                    <h4 className="font-bold text-neutral-800 text-lg">{st.name}</h4>
                                    <div className="flex items-center gap-2 mt-2">
                                        <span className={`px-2 py-1 rounded text-[10px] uppercase tracking-wider font-bold ${activeSource === 'FINISHED_GOODS' ? 'bg-emerald-100 text-emerald-800' : 'bg-[#f4ebe1] text-[#7c6354]'}`}>
                                            {activeSource === 'FINISHED_GOODS' ? 'Menu Management POS' : 'Classic POS'}
                                        </span>
                                        {override && <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-wider">(Override Active)</span>}
                                    </div>
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4 mb-5 p-3 bg-neutral-50 rounded-lg">
                                <div>
                                    <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider mb-1">Readiness</div>
                                    <div className={`font-black ${st.readiness === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>{st.readiness}%</div>
                                </div>
                                <div>
                                    <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider mb-1">Critical Issues</div>
                                    <div className={`font-black ${st.criticalCount === 0 ? 'text-emerald-500' : 'text-red-600 flex items-center gap-1'}`}>
                                        {st.criticalCount === 0 ? '0' : <><AlertTriangle size={14} /> {st.criticalCount}</>}
                                    </div>
                                </div>
                            </div>

                            <div>
                               <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-wider mb-2">Select Source</label>
                               {isAdmin ? (
                                   <select 
                                      value={override || 'CLEAR'}
                                      onChange={(e) => handleStoreOverride(st.id, e.target.value as any)}
                                      disabled={saving}
                                      className="w-full bg-white border border-neutral-200 text-sm font-bold text-neutral-700 px-3 py-2 rounded-lg outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                                   >
                                      <option value="CLEAR">Use Default ({settings.globalSource === 'FINISHED_GOODS' ? 'Menu Management POS' : 'Classic POS'})</option>
                                      <option value="LEGACY_MENU_ITEMS">Classic POS Source</option>
                                      <option value="FINISHED_GOODS">Menu Management POS (Live)</option>
                                   </select>
                               ) : (
                                   <div className="text-sm font-medium text-neutral-400">Admin access required to change.</div>
                               )}
                               <p className="text-[10px] text-neutral-400 mt-2 leading-relaxed">
                                   Changing a store source affects only that store's POS menu and stock deduction path.
                               </p>
                            </div>
                        </div>
                    );
                 })}
              </div>
          </div>

          <div className="space-y-6">
              {/* Global Settings */}
              <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-sm">
                  <h3 className="text-lg font-black text-neutral-800 mb-1">Global Default</h3>
                  <p className="text-xs font-medium text-neutral-500 mb-5">Change the default source for all stores without an override.</p>
                  
                  {isAdmin ? (
                     <div className="space-y-4">
                         {settings.globalSource === 'FINISHED_GOODS' ? (
                             <button
                               onClick={() => setShowGlobalConfirm('LEGACY_MENU_ITEMS')}
                               disabled={saving}
                               className="w-full px-4 py-3 bg-amber-50 text-amber-700 border border-amber-200 font-bold rounded-xl hover:bg-amber-100 transition-colors"
                             >
                               Set Default to Classic POS
                             </button>
                         ) : (
                             <>
                                 <button
                                   onClick={() => setShowGlobalConfirm('FINISHED_GOODS')}
                                   disabled={saving}
                                   className="w-full px-4 py-3 bg-neutral-800 text-white font-bold rounded-xl hover:bg-neutral-900 transition-colors"
                                 >
                                   Set Default to Menu Management POS
                                 </button>
                                 <p className="text-[10px] text-amber-600 bg-amber-50 p-2 rounded-lg font-medium">Verify store readiness before sweeping default changes.</p>
                             </>
                         )}
                     </div>
                  ) : (
                      <p className="text-sm text-neutral-400">Admin access required.</p>
                  )}
              </div>

              {/* Emergency Rollback */}
              <div className="bg-rose-50 rounded-xl border border-rose-200 p-5 shadow-sm">
                 <div className="flex items-center gap-2 mb-2">
                     <AlertTriangle size={18} className="text-rose-600" />
                     <h3 className="text-sm font-black text-rose-800">Advanced Safety</h3>
                 </div>
                 <p className="text-xs font-medium text-rose-600/80 mb-4">Instantly reset all stores to Classic POS Source and clear pilots.</p>
                 
                 {isAdmin ? (
                     <button
                       onClick={handleEmergencyRollback}
                       disabled={saving}
                       className="w-full px-4 py-2 bg-white text-rose-700 border border-rose-200 font-bold text-sm rounded-lg hover:bg-rose-100 transition-colors"
                     >
                       Emergency: switch to Classic POS Source
                     </button>
                 ) : (
                     <p className="text-xs text-rose-500 font-medium">Admin access required.</p>
                 )}
              </div>
          </div>
      </div>

      {/* Global Switch Modal */}
      {showGlobalConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
             <div className="bg-white rounded-2xl p-6 shadow-xl w-full max-w-sm">
                 <h2 className="text-xl font-black text-neutral-900 mb-2">
                    Switch all stores to {showGlobalConfirm === 'FINISHED_GOODS' ? 'Menu Management POS' : 'Classic POS'}?
                 </h2>
                 <p className="text-sm text-neutral-600 mb-6">
                    {showGlobalConfirm === 'FINISHED_GOODS' 
                       ? "This affects every store without an override. Please ensure store data is ready." 
                       : "This will revert the global default to the classic menu source."}
                 </p>
                 
                 <div className="flex gap-3 mt-8">
                     <button 
                        onClick={() => setShowGlobalConfirm(null)}
                        className="flex-1 py-3 bg-neutral-100 text-neutral-700 font-bold rounded-xl hover:bg-neutral-200"
                     >
                         Cancel
                     </button>
                     <button 
                        onClick={handleGlobalSwitch}
                        disabled={saving}
                        className={`flex-1 py-3 font-bold rounded-xl text-white ${showGlobalConfirm === 'FINISHED_GOODS' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}
                     >
                         Confirm
                     </button>
                 </div>
             </div>
          </div>
      )}

    </div>
  );
}


