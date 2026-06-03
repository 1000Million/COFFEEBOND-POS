import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot, doc, updateDoc, serverTimestamp, runTransaction, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, KotItem, KotStatus } from '../../types';
import { Loader2, CheckCircle, Clock, X, ChefHat, Coffee, Store as StoreIcon, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Fallback helper if we don't have date-fns
const timeSince = (date: Date) => {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
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

export default function KOTScreen({ station }: { station: "BARISTA" | "KITCHEN" }) {
  const { staffProfile } = useAuth();
  const [items, setItems] = useState<KotItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('ALL');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // refresh time every minute
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!staffProfile) return;

    // Load accessible stores
    let unsubs: (() => void)[] = [];
    
    // We fetch ALL active stores, then filter based on role/access
    const qStore = query(collection(db, 'stores'), where('isActive', '==', true));
    const unsubStores = onSnapshot(qStore, (snap) => {
      const fetched = snap.docs.map(d => ({ id: d.id, ...d.data() } as Store));
      const accessible = staffProfile.role === 'ADMIN' 
        ? fetched 
        : fetched.filter(s => staffProfile.storeIds.includes(s.id));
      setStores(accessible);
      
      if (accessible.length > 0 && selectedStoreId === 'ALL') {
         // Auto-select if only 1 store, else let it be ALL
         if (accessible.length === 1) setSelectedStoreId(accessible[0].id);
      }
    });
    unsubs.push(unsubStores);

    return () => unsubs.forEach(u => u());
  }, [staffProfile]);
  
  useEffect(() => {
    if (!staffProfile) return;
    
    if (staffProfile.role !== 'ADMIN' && (!staffProfile.storeIds || staffProfile.storeIds.length === 0)) {
      setItems([]);
      setLoading(false);
      return;
    }

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
      const accessibleItems = Array.from(itemsByStore.values()).flat();
      setItems(accessibleItems);
      setLoading(false);
    };

    const unsubs = storeIdsToQuery.map(storeId => {
      const storeKotQuery = query(
        collection(db, 'kotItems'),
        where('storeId', '==', storeId),
        where('station', '==', station),
        where('status', 'in', ['PENDING', 'PREPARING', 'READY'])
      );

      return onSnapshot(storeKotQuery, (snap) => {
        itemsByStore.set(storeId, snap.docs.map(d => ({ id: d.id, ...d.data() } as KotItem)));
        applySnapshots();
      }, (error) => {
        console.error('Error loading KOT items', error);
        itemsByStore.set(storeId, []);
        applySnapshots();
      });
    });

    return () => unsubs.forEach(unsub => unsub());
  }, [staffProfile, station, stores]);

  const displayedItems = useMemo(() => {
    let list = [...items];
    
    if (selectedStoreId !== 'ALL') {
      list = list.filter(item => item.storeId === selectedStoreId);
    }
    
    if (selectedStatus !== 'ALL') {
      list = list.filter(item => item.status === selectedStatus);
    }

    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      list = list.filter(item => 
        item.orderNumber.toLowerCase().includes(q) || 
        item.itemName.toLowerCase().includes(q)
      );
    }

    // Sort oldest first so they get fulfilled first
    list.sort((a, b) => {
       const aTime = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : 0) : 0;
       const bTime = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : 0) : 0;
       return aTime - bTime;
    });
    return list;
  }, [items, selectedStoreId, selectedStatus, searchQuery]);

  // Group by orderNumber for display
  const groupedTickets = useMemo(() => {
    const map = new Map<string, KotItem[]>();
    displayedItems.forEach(item => {
      if (!map.has(item.orderNumber)) map.set(item.orderNumber, []);
      map.get(item.orderNumber)!.push(item);
    });
    // Return array of entries
    return Array.from(map.entries());
  }, [displayedItems]);


  const canUpdateStatus = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER' || staffProfile?.role === station;
  const canCancel = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';

  // A simplified helper that handles the status change and attempts to sync the parent order item.
  const handleStatusChange = async (item: KotItem, newStatus: KotStatus) => {
    if (!canUpdateStatus) return alert("You don't have permission to update status.");
    if (!item.id) return;
    setLoading(true);

    try {
      const itemRef = doc(db, 'kotItems', item.id);
      const updateData: any = {
        status: newStatus,
        updatedAt: serverTimestamp()
      };
      
      if (newStatus === 'READY' && item.status !== 'READY') {
        updateData.readyAt = serverTimestamp();
      }

      await updateDoc(itemRef, updateData);

      // Sync the parent order item
      const oItemRef = doc(db, 'orders', item.orderId, 'items', item.orderItemId);
      const oItemSnap = await getDoc(oItemRef);
      if (oItemSnap.exists()) {
        const oItemData = oItemSnap.data();
        if (oItemData.prepStation !== 'BOTH') {
          await updateDoc(oItemRef, { status: newStatus });
        } else {
          // If BOTH, we need to know the status of the *other* kot item(s) for this orderItemId
          const qKot = query(
            collection(db, 'kotItems'), 
            where('orderItemId', '==', item.orderItemId),
            where('storeId', '==', item.storeId)
          );
          const docs = await getDocs(qKot);
          const relatedItems = docs.docs.map(d => d.data() as KotItem);
          
          let nextItemStatus = newStatus;

          const hasPending = relatedItems.some(r => r.status === 'PENDING');
          const hasPreparing = relatedItems.some(r => r.status === 'PREPARING');
          const hasReady = relatedItems.some(r => r.status === 'READY');
          
          if (hasPending) nextItemStatus = 'PENDING';
          else if (hasPreparing) nextItemStatus = 'PREPARING';
          else if (hasReady) nextItemStatus = 'READY';
          else nextItemStatus = 'SERVED';

          // If one is cancelled... handle carefully or just stick to operational logic above
          const hasCancelled = relatedItems.some(r => r.status === 'CANCELLED');
          if (hasCancelled && relatedItems.length === 1) nextItemStatus = 'CANCELLED'; // Should have 2 though

          await updateDoc(oItemRef, { status: nextItemStatus });
        }
      }
    } catch (e: any) {
       console.error("Error updating KOT status", e);
    } finally {
       setLoading(false);
    }
  };

  const nextStatusInfo = (status: KotStatus): { label: string, next: KotStatus, color: string } | null => {
    if (status === 'PENDING') return { label: 'Start', next: 'PREPARING', color: 'bg-yellow-500 hover:bg-yellow-600' };
    if (status === 'PREPARING') return { label: 'Mark Ready', next: 'READY', color: 'bg-green-500 hover:bg-green-600' };
    return null;
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-8">
       <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
         <div className="flex items-center gap-3">
           {station === 'BARISTA' ? <Coffee size={32} className="text-[#5c4033]" /> : <ChefHat size={32} className="text-[#5c4033]" />}
           <div>
             <h1 className="text-3xl font-black tracking-tight text-neutral-900">{station === 'BARISTA' ? 'Barista Station' : 'Kitchen KOT'}</h1>
             <p className="text-neutral-500 font-medium">Manage incoming {station === 'BARISTA' ? 'drinks' : 'food'} tickets</p>
           </div>
         </div>

         <div className="flex flex-wrap items-center gap-3">
           <div className="relative">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
             <input
                type="text"
                placeholder="Search order or item..."
                className="pl-10 pr-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none font-medium shadow-sm transition-shadow w-48"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
             />
           </div>

           <select
              className="px-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none appearance-none font-medium shadow-sm transition-shadow min-w-[120px]"
              value={selectedStatus}
              onChange={e => setSelectedStatus(e.target.value)}
           >
              <option value="ALL">All Active</option>
              <option value="PENDING">Pending</option>
              <option value="PREPARING">Preparing</option>
              <option value="READY">Ready</option>
           </select>

           {(staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER') && (
             <div className="relative">
               <StoreIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
               <select
                  className="pl-10 pr-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none appearance-none font-medium shadow-sm transition-shadow min-w-[160px]"
                  value={selectedStoreId}
                  onChange={e => setSelectedStoreId(e.target.value)}
               >
                  <option value="ALL">All Accessible Stores</option>
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
               </select>
             </div>
           )}
         </div>
       </div>

       {loading && displayedItems.length === 0 ? (
         <div className="flex items-center justify-center p-12">
            <Loader2 size={32} className="animate-spin text-[#5c4033]" />
         </div>
       ) : groupedTickets.length === 0 ? (
         <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-12 text-center">
            {station === 'BARISTA' ? <Coffee size={48} className="mx-auto mb-4 text-neutral-300" /> : <ChefHat size={48} className="mx-auto mb-4 text-neutral-300" />}
            <h3 className="text-xl font-bold text-neutral-400">No active {station.toLowerCase()} tickets.</h3>
            <p className="text-neutral-500 text-sm mt-2">All caught up! Time to brew some magic.</p>
         </div>
       ) : (
         <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
            {groupedTickets.map(([orderNumber, ticketItems]) => {
               // Render a ticket card for each order
               const first = ticketItems[0];
               const timeCreated = first.createdAt?.toDate ? first.createdAt.toDate() : new Date();
               
               return (
                 <div key={orderNumber} className="bg-white border-t-8 border-t-[#5c4033] border-neutral-200 rounded-xl overflow-hidden flex flex-col shadow-sm hover:shadow-lg hover:-translate-y-1 transition-all duration-300 transform-gpu">
                    <div className="p-4 border-b border-dashed border-neutral-200 bg-neutral-50/50">
                       <div className="flex justify-between items-start mb-2">
                         <h3 className="text-lg font-black font-mono tracking-tight text-neutral-900">{orderNumber.split('-').slice(2).join('-')}</h3>
                         <span className="flex items-center gap-1 text-xs font-bold text-neutral-500 bg-neutral-200 px-2 py-1 rounded">
                           <Clock size={12} /> {timeSince(timeCreated)}
                         </span>
                       </div>
                       
                       <p className="text-xs font-bold text-neutral-600 truncate">{first.storeName}</p>
                       <div className="flex flex-wrap gap-2 mt-2">
                         <span className="text-xs font-bold px-2 py-1 bg-[#f9f5f0] text-[#795C34] rounded uppercase tracking-wider">{first.orderType.replace('_', ' ')}</span>
                         {first.tableNumber && <span className="text-xs font-bold px-2 py-1 bg-yellow-100 text-yellow-800 rounded">Table {first.tableNumber}</span>}
                       </div>
                       {first.customerName && <p className="text-xs font-medium text-neutral-500 mt-2 truncate max-w-full">Guest: {first.customerName}</p>}
                    </div>

                    <div className="flex-1 p-0">
                       {ticketItems.map((item, idx) => {
                          const action = nextStatusInfo(item.status);
                          return (
                            <div key={item.id} className={`p-4 ${idx !== ticketItems.length - 1 ? 'border-b border-neutral-100' : ''}`}>
                               <div className="flex justify-between items-start mb-2">
                                  <div className="flex-1 pr-2">
                                    <div className="flex items-baseline gap-2">
                                      <span className="font-mono font-black text-sm text-[#5c4033]">{item.quantity}x</span>
                                      <span className="font-bold text-sm text-neutral-800">{item.itemName}</span>
                                    </div>
                                    <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded mt-1 inline-block ${
                                      item.status === 'PENDING' ? 'bg-neutral-100 text-neutral-500' :
                                      item.status === 'PREPARING' ? 'bg-yellow-100 text-yellow-700' :
                                      item.status === 'READY' ? 'bg-green-100 text-green-700' : ''
                                    }`}>{item.status}</span>
                                  </div>
                               </div>

                               <div className="flex gap-2 mt-3">
                                 {action && canUpdateStatus && (
                                   <button 
                                     onClick={() => handleStatusChange(item, action.next)}
                                     disabled={loading}
                                     className={`flex-1 text-xs font-bold text-white px-3 py-2 rounded-lg transition-colors ${action.color} disabled:opacity-50`}
                                   >
                                      {action.label}
                                   </button>
                                 )}
                                 {canCancel && item.status !== 'CANCELLED' && item.status !== 'SERVED' && (
                                    <button 
                                      onClick={() => {
                                        if (confirm(`Cancel ${item.itemName}?`)) {
                                          handleStatusChange(item, 'CANCELLED');
                                        }
                                      }}
                                      disabled={loading}
                                      className="text-white bg-red-400 hover:bg-red-500 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                                      title="Cancel Item"
                                    >
                                       <X size={14} />
                                    </button>
                                 )}
                               </div>
                            </div>
                          );
                       })}
                    </div>
                 </div>
               );
            })}
         </div>
       )}
    </div>
  );
}
