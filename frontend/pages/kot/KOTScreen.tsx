import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot, doc, updateDoc, serverTimestamp, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, KotItem, KotStatus } from '../../types';
import { Loader2, Clock, X, ChefHat, Coffee, Store as StoreIcon, Search, AlertTriangle } from 'lucide-react';

const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

const toDate = (value: any): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value.toDate) return value.toDate();
  return null;
};

const isToday = (date: Date | null) => {
  if (!date) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
};

const isStaleKot = (item: KotItem, now: Date) => {
  const createdAt = toDate(item.createdAt);
  return Boolean(createdAt && now.getTime() - createdAt.getTime() > STALE_THRESHOLD_MS);
};

const shortOrderNumber = (orderNumber: string) => orderNumber.split('-').slice(2).join('-') || orderNumber;

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
  const [ageFilter, setAgeFilter] = useState<'ALL' | 'TODAY' | 'STALE'>('ALL');
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
        where('status', 'in', ['PENDING', 'PREPARING'])
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

    if (ageFilter === 'TODAY') {
      list = list.filter(item => isToday(toDate(item.createdAt)));
    }

    if (ageFilter === 'STALE') {
      list = list.filter(item => isStaleKot(item, now));
    }

    // Sort oldest first so they get fulfilled first
    list.sort((a, b) => {
       const aTime = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : 0) : 0;
       const bTime = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : 0) : 0;
       return aTime - bTime;
    });
    return list;
  }, [items, selectedStoreId, selectedStatus, searchQuery, ageFilter, now]);

  const staleTicketCount = useMemo(() => {
    const activeStaleOrders = new Set<string>();
    items.forEach(item => {
      if (selectedStoreId !== 'ALL' && item.storeId !== selectedStoreId) return;
      if (isStaleKot(item, now)) activeStaleOrders.add(item.orderNumber);
    });
    return activeStaleOrders.size;
  }, [items, selectedStoreId, now]);

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
    if (status === 'PENDING') return { label: 'Start Preparing', next: 'PREPARING', color: 'bg-amber-500 hover:bg-amber-600' };
    if (status === 'PREPARING') return { label: 'Mark Ready', next: 'READY', color: 'bg-emerald-600 hover:bg-emerald-700' };
    return null;
  };

  return (
    <div className="max-w-7xl mx-auto w-full min-w-0 p-4 md:p-8">
       <div className="flex min-w-0 flex-col md:flex-row md:items-center justify-between mb-5 gap-4">
         <div className="flex min-w-0 items-center gap-3">
           {station === 'BARISTA' ? <Coffee size={30} className="text-[#5c4033]" /> : <ChefHat size={30} className="text-[#5c4033]" />}
           <div>
             <h1 className="text-2xl font-black tracking-tight text-neutral-900 sm:text-3xl">{station === 'BARISTA' ? 'Barista Station' : 'Kitchen KOT'}</h1>
             <p className="text-sm font-medium text-neutral-500">Live {station === 'BARISTA' ? 'drink' : 'food'} production tickets</p>
           </div>
         </div>

         <div className="flex w-full flex-wrap items-center gap-3 md:w-auto">
           <div className="relative w-full sm:w-auto">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
             <input
                type="text"
                placeholder="Search order or item..."
                className="w-full pl-10 pr-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none font-medium shadow-sm transition-shadow sm:w-48"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
             />
           </div>

           <select
              className="w-full px-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none appearance-none font-medium shadow-sm transition-shadow sm:w-auto sm:min-w-[120px]"
              value={selectedStatus}
              onChange={e => setSelectedStatus(e.target.value)}
           >
              <option value="ALL">All Active</option>
              <option value="PENDING">Pending</option>
              <option value="PREPARING">Preparing</option>
           </select>

           {(staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER') && (
             <div className="relative w-full sm:w-auto">
               <StoreIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
               <select
                  className="w-full pl-10 pr-4 py-2 bg-white border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] outline-none appearance-none font-medium shadow-sm transition-shadow sm:w-auto sm:min-w-[160px]"
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

       <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#eadfd2] bg-[#fffaf5] p-3 sm:flex-row sm:items-center sm:justify-between">
         <div className="flex flex-wrap items-center gap-2">
           {[
             { id: 'ALL', label: 'All Active' },
             { id: 'TODAY', label: 'Today' },
             { id: 'STALE', label: 'Stale' },
           ].map(filter => (
             <button
               key={filter.id}
               type="button"
               onClick={() => setAgeFilter(filter.id as 'ALL' | 'TODAY' | 'STALE')}
               className={`rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-wide transition-colors ${
                 ageFilter === filter.id
                   ? 'bg-[#3b2418] text-white shadow-sm'
                   : 'bg-white text-[#5c4033] ring-1 ring-[#eadfd2] hover:bg-[#f6eee6]'
               }`}
             >
               {filter.label}
             </button>
           ))}
         </div>
         <div className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black ${
           staleTicketCount > 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
         }`}>
           <AlertTriangle size={14} />
           {staleTicketCount} stale ticket{staleTicketCount === 1 ? '' : 's'}
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
               const timeCreated = toDate(first.createdAt) || new Date();
               const ticketIsStale = ticketItems.some(item => isStaleKot(item, now));
               const pendingCount = ticketItems.filter(item => item.status === 'PENDING').length;
               const preparingCount = ticketItems.filter(item => item.status === 'PREPARING').length;
               
               return (
                 <div key={orderNumber} className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-sm transition-all duration-200 ${
                   ticketIsStale ? 'border-red-300 ring-2 ring-red-100' : 'border-[#eadfd2]'
                 }`}>
                    <div className="border-b border-dashed border-[#eadfd2] bg-[#fffaf5] p-3">
                       <div className="mb-2 flex items-start justify-between gap-2">
                         <div className="min-w-0">
                           <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#9a6a3a]">Order</p>
                           <h3 className="min-w-0 break-words font-mono text-lg font-black tracking-tight text-neutral-950">{shortOrderNumber(orderNumber)}</h3>
                         </div>
                         <span className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black ${
                           ticketIsStale ? 'bg-red-100 text-red-700' : 'bg-neutral-100 text-neutral-600'
                         }`}>
                           <Clock size={12} /> {timeSince(timeCreated)}
                         </span>
                       </div>
                       
                       <div className="flex flex-wrap gap-1.5">
                         {ticketIsStale && <span className="rounded-full bg-red-600 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-white">Stale</span>}
                         <span className="rounded-full bg-white px-2 py-1 text-[10px] font-black uppercase tracking-wider text-[#795C34] ring-1 ring-[#eadfd2]">{first.orderType.replace('_', ' ')}</span>
                         {first.tableNumber && <span className="rounded-full bg-yellow-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-yellow-800">Table {first.tableNumber}</span>}
                         <span className="rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-neutral-600">{ticketItems.length} item{ticketItems.length === 1 ? '' : 's'}</span>
                       </div>
                       <div className="mt-2 grid grid-cols-1 gap-1 text-xs font-bold text-neutral-600">
                         <p className="truncate">{first.storeName}</p>
                         {first.customerName && <p className="truncate">Guest: {first.customerName}</p>}
                         <p className="text-neutral-500">{pendingCount} pending · {preparingCount} preparing</p>
                       </div>
                    </div>

                    <div className="flex-1 p-0">
                       {ticketItems.map((item, idx) => {
                          const action = nextStatusInfo(item.status);
                          const itemIsStale = isStaleKot(item, now);
                          return (
                            <div key={item.id} className={`p-3 ${idx !== ticketItems.length - 1 ? 'border-b border-neutral-100' : ''}`}>
                               <div className="mb-2 flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1 pr-2">
                                    <div className="flex items-start gap-2">
                                      <span className="rounded-lg bg-[#3b2418] px-2 py-1 font-mono text-sm font-black text-white">{item.quantity}x</span>
                                      <div className="min-w-0">
                                        <p className="break-words text-sm font-black leading-snug text-neutral-900">{item.itemName}</p>
                                        <p className="break-words text-[11px] font-bold uppercase tracking-wide text-neutral-400">{item.itemCode}</p>
                                      </div>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-black uppercase tracking-widest ${
                                        item.status === 'PENDING' ? 'bg-neutral-100 text-neutral-500' :
                                        item.status === 'PREPARING' ? 'bg-yellow-100 text-yellow-700' : ''
                                      }`}>{item.status}</span>
                                      {itemIsStale && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-widest text-red-700">STALE</span>}
                                    </div>
                                  </div>
                               </div>

                               <div className="flex gap-2 mt-3">
                                 {action && canUpdateStatus && (
                                   <button 
                                     onClick={() => handleStatusChange(item, action.next)}
                                     disabled={loading}
                                     className={`min-h-[44px] flex-1 rounded-xl px-3 py-2 text-sm font-black text-white transition-colors ${action.color} disabled:opacity-50`}
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
                                      className="min-h-[44px] rounded-xl bg-red-400 px-3 py-2 text-white transition-colors hover:bg-red-500 disabled:opacity-50"
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
