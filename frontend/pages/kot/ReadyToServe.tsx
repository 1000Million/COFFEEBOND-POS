import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, where, onSnapshot, doc, updateDoc, serverTimestamp, runTransaction, getDoc, getDocs, addDoc, setDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, KotItem, KotStatus, Recipe } from '../../types';
import { Loader2, CheckCircle, Clock, X, Store as StoreIcon, Search, AlertCircle, RefreshCw, Trash2, Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const timeSince = (date: Date) => {
  if (!date) return '';
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  if (seconds < 0) return '0s';
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + "y";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + "m";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + "d";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + "h";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + "m";
  return Math.floor(seconds) + "s";
};

const RETURN_REASONS = [
  "Wrong item",
  "Cold item",
  "Quality issue",
  "Spillage",
  "Customer changed mind",
  "Other"
];

export default function ReadyToServe() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('ALL');
  const [items, setItems] = useState<KotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());

  const [returnModalItem, setReturnModalItem] = useState<KotItem | null>(null);
  const [returnReason, setReturnReason] = useState(RETURN_REASONS[0]);
  const [returnNotes, setReturnNotes] = useState("");
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnError, setReturnError] = useState("");

  const prevReadyCountRef = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!staffProfile) return;

    const qStore = query(collection(db, 'stores'), where('isActive', '==', true));
    const unsubStores = onSnapshot(qStore, (snap) => {
      const fetched = snap.docs.map(d => ({ id: d.id, ...d.data() } as Store));
      const accessible = staffProfile.role === 'ADMIN' 
        ? fetched 
        : fetched.filter(s => staffProfile.storeIds.includes(s.id));
      setStores(accessible);
      
      if (accessible.length > 0 && selectedStoreId === 'ALL') {
         if (accessible.length === 1) setSelectedStoreId(accessible[0].id);
      }
    });

    return () => unsubStores();
  }, [staffProfile]);

  useEffect(() => {
    if (!staffProfile) return;
    
    if (staffProfile.role !== 'ADMIN' && (!staffProfile.storeIds || staffProfile.storeIds.length === 0)) {
      setItems([]);
      setLoading(false);
      return;
    }

    // We query per authorized store so store-scoped rules can validate every returned document.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const storeIdsToQuery = staffProfile.role === 'ADMIN'
      ? stores.map(store => store.id)
      : stores
          .filter(store => staffProfile.storeIds.includes(store.id))
          .map(store => store.id);

    if (storeIdsToQuery.length === 0) {
      setItems([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const itemsByStore = new Map<string, KotItem[]>();
    const applySnapshots = () => {
      const accessibleItems = Array.from(itemsByStore.values()).flat().filter(item => {
        if (item.status === 'READY') return true;
        if (item.status === 'SERVED') {
          const servedTime = item.servedAt?.toDate ? item.servedAt.toDate().getTime() : 0;
          return servedTime >= today.getTime();
        }
        return false;
      });

      setItems(accessibleItems);
      setLoading(false);
    };

    const unsubs = storeIdsToQuery.map(storeId => {
      const readyQuery = query(
        collection(db, 'kotItems'),
        where('storeId', '==', storeId),
        where('status', 'in', ['READY', 'SERVED'])
      );

      return onSnapshot(readyQuery, (snap) => {
        itemsByStore.set(storeId, snap.docs.map(d => ({ id: d.id, ...d.data() } as KotItem)));
        applySnapshots();
      }, (error) => {
        console.error('Error loading ready-to-serve items', error);
        itemsByStore.set(storeId, []);
        applySnapshots();
      });
    });

    return () => unsubs.forEach(unsub => unsub());
  }, [staffProfile, stores]);

  const displayedItems = useMemo(() => {
    let list = [...items];
    if (selectedStoreId !== 'ALL') {
      list = list.filter(item => item.storeId === selectedStoreId);
    }
    return list;
  }, [items, selectedStoreId]);

  const readyItems = useMemo(() => {
    return displayedItems.filter(i => i.status === 'READY').sort((a,b) => {
      const aTime = a.readyAt?.toDate ? a.readyAt.toDate().getTime() : 0;
      const bTime = b.readyAt?.toDate ? b.readyAt.toDate().getTime() : 0;
      return aTime - bTime;
    });
  }, [displayedItems]);

  const servedItems = useMemo(() => {
    return displayedItems.filter(i => i.status === 'SERVED').sort((a,b) => {
      const aTime = a.servedAt?.toDate ? a.servedAt.toDate().getTime() : 0;
      const bTime = b.servedAt?.toDate ? b.servedAt.toDate().getTime() : 0;
      return bTime - aTime; // Newest served first
    });
  }, [displayedItems]);

  useEffect(() => {
    if (readyItems.length > prevReadyCountRef.current) {
      const pulseAudio = new Audio("data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqPb3BxfoaKkG5vcYCIi45vcXF9hYSJbm9wgIKKjm9wcn2FhopwcHSBiYuNbnFyfoWEiW5wcIGCio1v");
      pulseAudio.play().catch(e => {}); // subtle error catch
      document.title = `(${readyItems.length}) Ready Items`;
    } else if (readyItems.length === 0) {
      document.title = "Coffee Bond POS";
    }
    prevReadyCountRef.current = readyItems.length;
  }, [readyItems.length]);

  const handleMarkServed = async (item: KotItem) => {
    if (!item.id) return;
    try {
      const itemRef = doc(db, 'kotItems', item.id);
      await updateDoc(itemRef, {
        status: 'SERVED',
        servedAt: serverTimestamp(),
        handledByUserId: staffProfile?.uid || null,
        handledByName: staffProfile?.name || null,
        updatedAt: serverTimestamp()
      });

      // Update parent orderItem sync logic as in prior code if required, but requirements specify don't change existing POS checkout. We should at least update order item to SERVED.
      const oItemRef = doc(db, 'orders', item.orderId, 'items', item.orderItemId);
      await updateDoc(oItemRef, { status: 'SERVED' });
    } catch (e: any) {
      console.error(e);
      alert("Error marking served: " + e.message);
    }
  };

  const executeReturn = async (actionType: 'WASTAGE' | 'REMAKE') => {
    if (!returnModalItem?.id || !staffProfile) return;
    setReturnLoading(true);
    setReturnError("");

    try {
      const orderId = returnModalItem.orderId;
      const storeId = returnModalItem.storeId;
      const itemId = returnModalItem.itemCode;
      const qty = returnModalItem.quantity;
      
      const newStatus = actionType === 'WASTAGE' ? 'WASTAGE_RECORDED' : 'REMAKE_REQUESTED';
      
      let recipeItems: any[] = [];
      
      if (actionType === 'REMAKE') {
         // Deduct inventory for remake by checking recipes.
         const recipesSnap = await getDocs(query(collection(db, 'recipes'), where('menuItemCode', '==', itemId)));
         const activeRecipes = recipesSnap.docs.filter(d => Boolean(d.data().isActive));
         
         if (activeRecipes.length > 0) {
            recipeItems = activeRecipes[0].data().recipeItems || [];
         }
         
         // Verify stock
         for (let rItem of recipeItems) {
            const stockId = `${storeId}_${rItem.inventoryItemCode || rItem.inventoryItemId}`;
            const stockSnap = await getDoc(doc(db, 'storeInventory', stockId));
            if (!stockSnap.exists()) {
               throw new Error(`Item ${rItem.inventoryItemName} out of stock or missing inventory record.`);
            }
         }
      }

      await runTransaction(db, async (t) => {
         const originalKotRef = doc(db, 'kotItems', returnModalItem.id!);
         const remakeStockTargets = actionType === 'REMAKE'
           ? recipeItems.map((rItem) => {
               const stockId = `${storeId}_${rItem.inventoryItemCode || rItem.inventoryItemId}`;
               return {
                 rItem,
                 stockRef: doc(db, 'storeInventory', stockId),
               };
             })
           : [];
         const remakeStockSnaps = await Promise.all(remakeStockTargets.map(target => t.get(target.stockRef)));

         const updates: any = {
           status: newStatus,
           returnedAt: serverTimestamp(),
           returnReason,
           updatedAt: serverTimestamp()
         };

         if (actionType === 'WASTAGE') {
            updates.wastageAt = serverTimestamp();
            updates.wastageReason = returnNotes;
         } else {
            updates.remakeRequestedAt = serverTimestamp();
            updates.remakeReason = returnNotes;
         }
         
         t.update(originalKotRef, updates);

         // Handle Remake Stock & New KOT
         if (actionType === 'REMAKE') {
            // deduct stock
            remakeStockTargets.forEach((target, index) => {
               const rItem = target.rItem;
               const snap = remakeStockSnaps[index];
               if (!snap.exists()) {
                 throw new Error(`Item ${rItem.inventoryItemName} out of stock or missing inventory record.`);
               }
               const currentStock = snap.data()?.currentStock || 0;
               const deduction = parseFloat(rItem.quantity) * qty;

               t.update(target.stockRef, {
                 currentStock: currentStock - deduction,
                 updatedAt: serverTimestamp()
               });

               const movRef = doc(collection(db, 'stockMovements'));
               t.set(movRef, {
                 storeId: storeId,
                 storeName: returnModalItem.storeName,
                 inventoryItemId: rItem.inventoryItemCode || rItem.inventoryItemId,
                 inventoryItemName: rItem.inventoryItemName,
                 movementType: "WASTAGE", // using wastage for remake deduction
                 quantity: deduction,
                 unit: rItem.unit,
                 referenceType: "ORDER",
                 referenceId: orderId,
                 notes: `Remake deduction: ${returnReason} - ${returnNotes}`,
                 createdAt: serverTimestamp(),
                 createdByUserId: staffProfile.uid,
                 createdByName: staffProfile.name
               });
            });

            // Create new PENDING kot item
            const newKotRef = doc(collection(db, 'kotItems'));
            t.set(newKotRef, {
              orderId: returnModalItem.orderId,
              orderNumber: returnModalItem.orderNumber,
              orderItemId: returnModalItem.orderItemId,
              storeId: returnModalItem.storeId,
              storeCode: returnModalItem.storeCode || '',
              storeName: returnModalItem.storeName,
              station: returnModalItem.station,
              itemName: returnModalItem.itemName,
              itemCode: returnModalItem.itemCode,
              quantity: returnModalItem.quantity,
              orderType: returnModalItem.orderType,
              tableNumber: returnModalItem.tableNumber,
              customerName: returnModalItem.customerName,
              status: "PENDING",
              originalKotItemId: returnModalItem.originalKotItemId || returnModalItem.id,
              remakeOfKotItemId: returnModalItem.id,
              remakeCount: (returnModalItem.remakeCount || 0) + 1,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              createdByUserId: staffProfile.uid,
              createdByName: staffProfile.name
            });

            // Set parent order item status back to PENDING safely if we want, but the requirement is "The remake must be linked to the original order and original KOT." I'll update parent orderItem status back to PENDING.
            const pOrderRef = doc(db, 'orders', returnModalItem.orderId, 'items', returnModalItem.orderItemId);
            t.update(pOrderRef, { status: 'PENDING' });
         } else {
             // For pure wastage, we also just log the wastage reason but NO stock deduction because it was already deducted when originally ordered.
             // Wait: The prompt says "If Mark Wastage Only: Create stockMovements record... movementType = WASTAGE". Hmm... if we create a stockMovement with quantity 0 or matching the original item qty? It's just a log reference. We won't decrement `currentStock` again since the original sale already decremented it.
             const movRef = doc(collection(db, 'stockMovements'));
             t.set(movRef, {
               storeId: storeId,
               storeName: returnModalItem.storeName,
               inventoryItemId: 'GENERAL_WASTAGE',
               inventoryItemName: 'Wastage Record',
               movementType: "WASTAGE",
               quantity: 0,
               unit: '-',
               referenceType: "ORDER",
               referenceId: orderId,
               notes: `Customer return: ${returnReason} - ${returnNotes}`,
               createdAt: serverTimestamp(),
               createdByUserId: staffProfile.uid,
               createdByName: staffProfile.name
             });
         }
      });

      setReturnModalItem(null);
      setReturnReason(RETURN_REASONS[0]);
      setReturnNotes("");
    } catch (e: any) {
      console.error(e);
      setReturnError(e.message || "Failed to process return.");
    } finally {
      setReturnLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-3">
          <Bell size={32} className="text-[#5c4033]" />
          <div>
            <h1 className="text-3xl font-black tracking-tight text-neutral-900">Ready to Serve</h1>
            <p className="text-neutral-500 font-medium">Deliver orders to customers</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {(staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER') && (
            <div className="relative">
              <StoreIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
              <select
                 className="pl-10 pr-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none appearance-none font-medium shadow-sm transition-shadow min-w-[160px]"
                 value={selectedStoreId}
                 onChange={e => setSelectedStoreId(e.target.value)}
              >
                 <option value="ALL">All Accessible Stores</option>
                 {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {loading && items.length === 0 ? (
         <div className="flex items-center justify-center p-12">
            <Loader2 size={32} className="animate-spin text-[#5c4033]" />
         </div>
      ) : (
        <div className="space-y-12">
          
          {/* SECTION 1: READY ITEMS */}
          <section>
             <h2 className="text-xl font-bold text-neutral-800 mb-4 flex items-center gap-2">
               <span className="w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]"></span>
               Ready Items ({readyItems.length})
             </h2>
             
             {readyItems.length === 0 ? (
                <div className="bg-white rounded-2xl border border-neutral-200 p-8 text-center text-neutral-400">
                  <CheckCircle size={32} className="mx-auto mb-2 opacity-50" />
                  <p className="font-medium">All items have been served.</p>
                </div>
             ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  <AnimatePresence initial={false} mode="popLayout">
                    {readyItems.map(item => {
                      const timeReady = item.readyAt?.toDate ? item.readyAt.toDate() : new Date();
                      const secondsWaiting = Math.floor((new Date().getTime() - timeReady.getTime()) / 1000);
                      const isLate = secondsWaiting > 300; // > 5 minutes

                      return (
                        <motion.div 
                          key={item.id} 
                          layout
                          initial={{ opacity: 0, scale: 0.95, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: -10 }}
                          transition={{ duration: 0.25 }}
                          className="bg-white shadow-sm border border-green-500 rounded-xl p-4 flex flex-col relative overflow-hidden"
                        >
                          <div className="flex justify-between items-start mb-2">
                            <h3 className="text-lg font-black font-mono tracking-tight text-neutral-900">{item.orderNumber.split('-').slice(2).join('-')}</h3>
                            <span className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded ${isLate ? 'bg-red-100 text-red-700 animate-pulse' : 'bg-green-100 text-green-800'}`}>
                              <Clock size={12} /> {timeSince(timeReady)}
                            </span>
                          </div>

                          <div className="flex flex-col gap-1 mb-4 flex-1">
                            <p className="text-xs font-bold text-neutral-500 uppercase">{item.storeName} • {item.station}</p>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-lg font-black text-green-700">{item.quantity}x</span>
                              <span className="text-lg font-bold text-neutral-800 leading-tight">{item.itemName}</span>
                            </div>

                            <div className="flex flex-wrap gap-2 mt-2">
                              <span className="text-xs font-bold px-2 py-1 bg-[#f9f5f0] text-[#795C34] rounded uppercase tracking-wider">{item.orderType.replace('_', ' ')}</span>
                              {item.tableNumber && <span className="text-xs font-bold px-2 py-1 bg-yellow-100 text-yellow-800 rounded">Table {item.tableNumber}</span>}
                            </div>
                            {item.customerName && <p className="text-sm font-medium text-neutral-600 mt-2">Guest: {item.customerName}</p>}
                            {item.remakeCount ? <p className="text-xs font-bold text-purple-600 mt-1">REMAKE #{item.remakeCount}</p> : null}
                          </div>

                          <button 
                            onClick={() => handleMarkServed(item)}
                            className="w-full py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-lg transition-colors flex justify-center items-center gap-2 shadow-sm cursor-pointer"
                          >
                            <CheckCircle size={18} /> Mark Served
                          </button>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
             )}
          </section>

          {/* SECTION 2: SERVED */}
          <section>
             <h2 className="text-xl font-bold text-neutral-600 mb-4 border-b border-neutral-200 pb-2">Served Today ({servedItems.length})</h2>
             
             {servedItems.length === 0 ? (
                <div className="bg-white/50 rounded-2xl border border-neutral-200 p-8 text-center text-neutral-400">
                  <p className="font-medium text-sm">No items served yet.</p>
                </div>
             ) : (
                <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden overflow-x-auto">
                   <table className="min-w-full divide-y divide-neutral-200 text-sm">
                      <thead className="bg-neutral-50">
                         <tr>
                            <th className="px-4 py-3 text-left font-bold text-neutral-500 uppercase tracking-wider">Time</th>
                            <th className="px-4 py-3 text-left font-bold text-neutral-500 uppercase tracking-wider">Order</th>
                            <th className="px-4 py-3 text-left font-bold text-neutral-500 uppercase tracking-wider">Item</th>
                            <th className="px-4 py-3 text-left font-bold text-neutral-500 uppercase tracking-wider">Type / Table</th>
                            <th className="px-4 py-3 text-left font-bold text-neutral-500 uppercase tracking-wider">Served By</th>
                            <th className="px-4 py-3 text-right font-bold text-neutral-500 uppercase tracking-wider">Actions</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                         {servedItems.map(item => {
                           const sTime = item.servedAt?.toDate ? item.servedAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
                           return (
                             <tr key={item.id} className="hover:bg-neutral-50 transition-colors group">
                                <td className="px-4 py-3 whitespace-nowrap text-neutral-500 font-medium">{sTime}</td>
                                <td className="px-4 py-3 whitespace-nowrap font-mono font-medium text-neutral-900">{item.orderNumber.split('-').slice(2).join('-')}</td>
                                <td className="px-4 py-3">
                                  <span className="font-bold">{item.quantity}x {item.itemName}</span>
                                  {item.remakeCount ? <span className="ml-2 text-[10px] text-white bg-purple-500 px-1.5 py-0.5 rounded font-bold">REMAKE</span> : null}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-neutral-600">
                                  {item.orderType.replace('_', ' ')} {item.tableNumber ? `(T-${item.tableNumber})` : ''}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-neutral-500">{item.handledByName || '-'}</td>
                                <td className="px-4 py-3 whitespace-nowrap text-right">
                                  <button
                                     onClick={() => setReturnModalItem(item)}
                                     className="text-xs font-bold px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                                  >
                                    Customer Return
                                  </button>
                                </td>
                             </tr>
                           )
                         })}
                      </tbody>
                   </table>
                </div>
             )}
          </section>
        </div>
      )}

      {/* Return Modal */}
      {returnModalItem && (
        <div className="fixed inset-0 z-[100] bg-neutral-900/50 backdrop-blur-sm flex items-center justify-center p-4">
           <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <div className="p-6 border-b border-neutral-100">
                 <h2 className="text-xl font-black text-neutral-900">Return / Remake</h2>
                 <p className="text-neutral-500 text-sm mt-1">Order {returnModalItem.orderNumber} • {returnModalItem.quantity}x {returnModalItem.itemName}</p>
                 {returnModalItem.remakeCount ? <p className="text-xs font-bold text-red-500 mt-1">Warning: This item is already a remake.</p> : null}
              </div>

              <div className="p-6 space-y-4 bg-neutral-50/50">
                 {returnError && (
                   <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
                     <AlertCircle size={16} className="mt-0.5 shrink-0" />
                     {returnError}
                   </div>
                 )}

                 <div>
                   <label className="block text-sm font-bold text-neutral-700 mb-1">Reason for Return</label>
                   <select 
                      value={returnReason} 
                      onChange={e => setReturnReason(e.target.value)}
                      className="w-full bg-white border border-neutral-200 text-neutral-900 text-sm rounded-lg focus:ring-[#5c4033] focus:border-[#5c4033] block p-2.5 font-medium"
                   >
                      {RETURN_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                   </select>
                 </div>

                 <div>
                   <label className="block text-sm font-bold text-neutral-700 mb-1">Additional Notes</label>
                   <textarea
                     value={returnNotes}
                     onChange={e => setReturnNotes(e.target.value)}
                     placeholder="E.g. customer dropped coffee, latte art broke..."
                     rows={3}
                     className="w-full bg-white border border-neutral-200 text-neutral-900 text-sm rounded-lg focus:ring-[#5c4033] focus:border-[#5c4033] block p-2.5 font-medium resize-none"
                   ></textarea>
                 </div>
              </div>

              <div className="p-4 bg-neutral-100 border-t border-neutral-200 flex flex-col sm:flex-row gap-3">
                 <button 
                   onClick={() => setReturnModalItem(null)} 
                   disabled={returnLoading}
                   className="px-4 py-2 text-neutral-600 hover:bg-neutral-200 rounded-lg font-bold transition-colors w-full sm:w-auto text-sm"
                 >
                   Cancel
                 </button>

                 <div className="flex gap-2 w-full sm:ml-auto">
                    <button 
                       onClick={() => executeReturn('WASTAGE')}
                       disabled={returnLoading}
                       className="flex-1 sm:flex-none px-4 py-2 bg-red-100 text-red-800 hover:bg-red-200 focus:ring-2 focus:ring-red-500 rounded-lg font-bold flex items-center justify-center gap-2 transition-colors text-sm"
                    >
                       {returnLoading ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                       Log Wastage Only
                    </button>
                    <button 
                       onClick={() => executeReturn('REMAKE')}
                       disabled={returnLoading}
                       className="flex-1 sm:flex-none px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white focus:ring-2 focus:ring-purple-500 rounded-lg font-bold flex items-center justify-center gap-2 transition-colors shadow-sm text-sm"
                    >
                       {returnLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                       Request Remake
                    </button>
                 </div>
              </div>
           </div>
        </div>
      )}

    </div>
  );
}
