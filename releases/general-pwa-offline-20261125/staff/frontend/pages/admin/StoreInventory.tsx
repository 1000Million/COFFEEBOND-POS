import React, { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, query, where, getDocs, doc, setDoc, updateDoc, writeBatch, serverTimestamp, orderBy, limit } from 'firebase/firestore';
import { Store, StoreInventory, InventoryItem, StockMovement } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { Store as StoreIcon, AlertCircle, Save, History } from 'lucide-react';

export default function StoreInventoryScreen() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  
  const [globalItems, setGlobalItems] = useState<InventoryItem[]>([]);
  const [storeStock, setStoreStock] = useState<StoreInventory[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'CURRENT' | 'MOVEMENTS'>('CURRENT');

  // Load stores based on role
  useEffect(() => {
    const fetchStores = async () => {
      try {
        const snap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        let loadedStores = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Store));
        
        if (staffProfile?.role !== 'ADMIN') {
          loadedStores = loadedStores.filter(s => staffProfile?.storeIds.includes(s.id));
        }
        
        setStores(loadedStores);
        if (loadedStores.length > 0) {
          setSelectedStoreId(loadedStores[0].id);
        }
      } catch (err) {
         console.error(err);
      }
    };
    if (staffProfile) fetchStores();
  }, [staffProfile]);

  useEffect(() => {
    const fetchContext = async () => {
      try {
        const gSnap = await getDocs(query(collection(db, 'inventoryItems'), where('isActive', '==', true)));
        setGlobalItems(gSnap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem)));
      } catch (e) {
        console.error(e);
      }
    };
    fetchContext();
  }, []);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) return;
    
    const fetchData = async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const [sSnap, mSnap] = await Promise.all([
           getDocs(query(collection(db, 'storeInventory'), where('storeId', '==', selectedStoreId))),
           getDocs(query(collection(db, 'stockMovements'), where('storeId', '==', selectedStoreId), orderBy('createdAt', 'desc'), limit(100)))
        ]);
        setStoreStock(sSnap.docs.map(d => ({ id: d.id, ...d.data() } as StoreInventory)));
        setStockMovements(mSnap.docs.map(d => ({ id: d.id, ...d.data() } as StockMovement)));
      } catch (err: any) {
        console.error(err);
        if (err.message && (err.message.includes('requires an index') || err.message.includes('failed-precondition'))) {
           setErrorMsg("Firestore index required. Open the Firebase Console link from the browser console and create the index.");
        } else {
           setErrorMsg("Error loading data: " + err.message);
        }
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [selectedStoreId, activeTab]);

  const handleStockUpdate = async (itemId: string, newCurrent: number, newMin: number) => {
    const store = stores.find(s => s.id === selectedStoreId);
    const item = globalItems.find(i => i.id === itemId);
    if (!store || !item || !item.id) return;
    
    const stockId = `${selectedStoreId}_${item.id}`;
    const existing = storeStock.find(s => s.inventoryItemId === item.id);
    
    try {
      if (existing) {
        const diff = newCurrent - existing.currentStock;
        
        const batch = writeBatch(db);
        const stockRef = doc(db, 'storeInventory', stockId);
        batch.update(stockRef, {
           currentStock: newCurrent,
           minimumStock: newMin,
           updatedAt: serverTimestamp()
        });
        
        if (diff !== 0) {
          const moveRef = doc(collection(db, 'stockMovements'));
          batch.set(moveRef, {
            storeId: selectedStoreId,
            storeName: store.name,
            inventoryItemId: item.id,
            inventoryItemName: item.name,
            movementType: diff > 0 ? "ADJUSTMENT" : "WASTAGE",
            quantity: Math.abs(diff),
            unit: item.unit,
            referenceType: "MANUAL",
            referenceId: null,
            notes: "Manual adjustment via dashboard",
            createdByUserId: staffProfile?.uid || 'Unknown',
            createdByName: staffProfile?.name || 'Unknown',
            createdAt: serverTimestamp()
          });
        }
        await batch.commit();
        
      } else {
         const batch = writeBatch(db);
         const stockRef = doc(db, 'storeInventory', stockId);
         batch.set(stockRef, {
            storeId: selectedStoreId,
            storeName: store.name,
            inventoryItemId: item.id,
            inventoryItemName: item.name,
            unit: item.unit,
            openingStock: newCurrent,
            currentStock: newCurrent,
            minimumStock: newMin,
            updatedAt: serverTimestamp()
         });
         
         if (newCurrent > 0) {
           const moveRef = doc(collection(db, 'stockMovements'));
           batch.set(moveRef, {
              storeId: selectedStoreId,
              storeName: store.name,
              inventoryItemId: item.id,
              inventoryItemName: item.name,
              movementType: "PURCHASE",
              quantity: newCurrent,
              unit: item.unit,
              referenceType: "MANUAL",
              referenceId: "OPENING",
              notes: "Initial tracking",
              createdByUserId: staffProfile?.uid || 'Unknown',
              createdByName: staffProfile?.name || 'Unknown',
              createdAt: serverTimestamp()
           });
         }
         await batch.commit();
      }
      
      const sSnap = await getDocs(query(collection(db, 'storeInventory'), where('storeId', '==', selectedStoreId)));
      setStoreStock(sSnap.docs.map(d => ({ id: d.id, ...d.data() } as StoreInventory)));
      
    } catch (e) {
      console.error(e);
      alert("Failed to update stock");
    }
  };

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <div>
          <h1 className="text-2xl font-black text-neutral-900 flex items-center gap-2">
            <StoreIcon size={24} className="text-[#5c4033]" />
            Store Inventory
          </h1>
          <p className="text-sm font-medium text-neutral-500">Track and manage stock levels per location.</p>
        </div>
        <div>
          <select 
            value={selectedStoreId} 
            onChange={e => setSelectedStoreId(e.target.value)}
            className="bg-white border border-neutral-200 rounded-lg px-4 py-2 font-bold text-[#5c4033] w-full sm:w-auto"
            disabled={stores.length <= 1}
          >
             {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>
      
      <div className="flex gap-4 border-b border-neutral-200 overflow-x-auto min-w-0 w-full max-w-full">
         <button 
           onClick={() => setActiveTab('CURRENT')}
           className={`px-4 py-3 text-sm font-bold border-b-2 transition-colors whitespace-nowrap ${activeTab === 'CURRENT' ? 'border-[#5c4033] text-[#5c4033]' : 'border-transparent text-neutral-500 hover:text-neutral-700'}`}
         >
           Current Stock
         </button>
         <button 
           onClick={() => setActiveTab('MOVEMENTS')}
           className={`px-4 py-3 text-sm font-bold border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'MOVEMENTS' ? 'border-[#5c4033] text-[#5c4033]' : 'border-transparent text-neutral-500 hover:text-neutral-700'}`}
         >
           <History size={16} /> Movement Log
         </button>
      </div>

      {errorMsg && (
         <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-4 font-bold flex gap-3 text-sm">
           <AlertCircle className="shrink-0" size={18} />
           <p>{errorMsg}</p>
         </div>
      )}

      {loading ? (
         <div className="text-center py-12 text-neutral-400">Loading store inventory...</div>
      ) : activeTab === 'CURRENT' ? (
         <div className="w-full max-w-full min-w-0 overflow-hidden bg-white rounded-2xl shadow-sm border border-neutral-200">
          <div className="w-full max-w-full overflow-x-auto">
          <table className="min-w-[1050px] w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-neutral-50 text-neutral-500 font-bold text-xs uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">Item Name</th>
                <th className="px-6 py-4">Category</th>
                <th className="px-6 py-4 text-right">Current Stock</th>
                <th className="px-6 py-4 text-right">Min Stock</th>
                <th className="px-6 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-right">Adjust</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 font-medium text-neutral-900">
              {globalItems.map(item => {
                 const stock = storeStock.find(s => s.inventoryItemId === item.id);
                 const currentStock = stock?.currentStock || 0;
                 const minStock = stock?.minimumStock || 0;
                 const isLow = stock && currentStock <= minStock;
                 return (
                   <tr key={item.id} className="hover:bg-neutral-50">
                     <td className="px-6 py-4">
                       <p className="font-bold">{item.name}</p>
                       <p className="text-xs text-neutral-400">{item.code}</p>
                     </td>
                     <td className="px-6 py-4">{item.category}</td>
                     <td className="px-6 py-4 text-right font-mono">
                        <span className="text-lg">{currentStock}</span> <span className="text-xs text-neutral-400">{item.unit}</span>
                     </td>
                     <td className="px-6 py-4 text-right font-mono text-neutral-500">
                        {minStock} <span className="text-xs opacity-50">{item.unit}</span>
                     </td>
                     <td className="px-6 py-4 text-center">
                        {isLow ? (
                           <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 text-xs font-bold rounded">
                             <AlertCircle size={12} /> Low Stock
                           </span>
                        ) : stock ? (
                           <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-bold rounded">Good</span>
                        ) : (
                           <span className="px-2 py-1 bg-neutral-100 text-neutral-500 text-xs font-bold rounded">Unracked</span>
                        )}
                     </td>
                     <td className="px-6 py-4 text-right">
                        <StockEditor 
                           current={currentStock} 
                           min={minStock} 
                           unit={item.unit} 
                           onSave={(nc, nm) => handleStockUpdate(item.id!, nc, nm)} 
                        />
                     </td>
                   </tr>
                 );
              })}
              {globalItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-neutral-500 font-medium">No global items registered. Go to Global Inventory Catalog first.</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div className="w-full max-w-full min-w-0 overflow-hidden bg-white rounded-2xl shadow-sm border border-neutral-200">
          <div className="w-full max-w-full overflow-x-auto">
          <table className="min-w-[1050px] w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-neutral-50 text-neutral-500 font-bold text-xs uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">Date & Time</th>
                <th className="px-6 py-4">Item</th>
                <th className="px-6 py-4">Type</th>
                <th className="px-6 py-4">Quantity</th>
                <th className="px-6 py-4">Reference</th>
                <th className="px-6 py-4">Staff</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 font-medium text-neutral-900">
               {stockMovements.map(m => (
                 <tr key={m.id} className="hover:bg-neutral-50">
                    <td className="px-6 py-4 text-neutral-500">
                       {m.createdAt?.toDate ? m.createdAt.toDate().toLocaleString() : 'Just now'}
                    </td>
                    <td className="px-6 py-4 font-bold">{m.inventoryItemName}</td>
                    <td className="px-6 py-4">
                       <span className={`px-2 py-1 bg-neutral-100 rounded text-xs font-bold ${
                         m.movementType === 'SALE_DEDUCTION' || m.movementType === 'WASTAGE' ? 'text-red-600' : 'text-green-600'
                       }`}>
                          {m.movementType}
                       </span>
                    </td>
                    <td className="px-6 py-4 font-mono">
                       <span className={m.movementType === 'SALE_DEDUCTION' || m.movementType === 'WASTAGE' ? 'text-red-600' : 'text-green-600'}>
                         {m.movementType === 'SALE_DEDUCTION' || m.movementType === 'WASTAGE' ? '-' : '+'}{m.quantity}
                       </span>
                       <span className="text-xs text-neutral-400 ml-1">{m.unit}</span>
                    </td>
                    <td className="px-6 py-4 text-xs text-neutral-500 max-w-[200px] truncate" title={m.notes || ''}>
                       {m.referenceType}: {m.referenceId || 'N/A'}<br/>
                       <span className="opacity-70">{m.notes}</span>
                    </td>
                    <td className="px-6 py-4 text-neutral-600">{m.createdByName}</td>
                 </tr>
               ))}
               {stockMovements.length === 0 && (
                 <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-neutral-500">No stock movements found.</td>
                 </tr>
               )}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StockEditor({ current, min, unit, onSave }: { current: number, min: number, unit: string, onSave: (c: number, m: number) => void }) {
   const [isEditing, setIsEditing] = useState(false);
   const [c, setC] = useState(current);
   const [m, setM] = useState(min);
   
   if (!isEditing) {
      return (
         <button onClick={() => { setC(current); setM(min); setIsEditing(true); }} className="text-xs font-bold bg-neutral-100 hover:bg-[#5c4033] hover:text-white px-3 py-1.5 rounded transition-colors text-neutral-600">
            Edit
         </button>
      );
   }
   
   return (
      <div className="flex items-center justify-end gap-2">
         <div className="flex flex-col gap-1 items-end">
            <div className="flex items-center gap-1">
               <span className="text-[10px] uppercase text-neutral-400">Cur:</span>
               <input type="number" value={c} onChange={e => setC(Number(e.target.value))} className="w-16 border rounded px-1 py-0.5 text-xs text-right outline-none focus:border-[#5c4033]" />
            </div>
            <div className="flex items-center gap-1">
               <span className="text-[10px] uppercase text-neutral-400">Min:</span>
               <input type="number" value={m} onChange={e => setM(Number(e.target.value))} className="w-16 border rounded px-1 py-0.5 text-xs text-right outline-none focus:border-[#5c4033]" />
            </div>
         </div>
         <button onClick={() => { onSave(c, m); setIsEditing(false); }} className="p-1.5 bg-[#5c4033] text-white rounded hover:bg-[#4a332a]">
            <Save size={14} />
         </button>
      </div>
   );
}
