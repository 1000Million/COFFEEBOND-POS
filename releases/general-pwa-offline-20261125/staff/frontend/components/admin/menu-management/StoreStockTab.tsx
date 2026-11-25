import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, onSnapshot, orderBy, getDocs } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { StoreStock } from '../../../types/menu-management';
import { Store } from '../../../types';
import { Edit2, Loader2, Store as StoreIcon, Search, Filter, DatabaseZap, AlertCircle } from 'lucide-react';
import StockAdjustmentModal from './StockAdjustmentModal';
import { useAuth } from '../../../contexts/AuthContext';
import { createMissingStockRows } from '../../../lib/stockManagement';

export default function StoreStockTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';
  const isManager = staffProfile?.role === 'STORE_MANAGER';

  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  const [stockItems, setStockItems] = useState<StoreStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<StoreStock | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [showLowStock, setShowLowStock] = useState(false);
  const [activeType, setActiveType] = useState<'ALL' | 'RAW_INGREDIENT' | 'PREP_ITEM' | 'BOUGHT_COMPONENT' | 'FINISHED_GOOD' | 'PACKAGING'>('ALL');
  const [createTarget, setCreateTarget] = useState<'ALL' | 'RAW_INGREDIENTS' | 'PREP_ITEMS' | 'FINISHED_GOODS'>('RAW_INGREDIENTS');

  useEffect(() => {
    const fetchStores = async () => {
      const q = query(collection(db, 'stores'), orderBy('name', 'asc'));
      const snap = await getDocs(q);
      const data = snap.docs.map(d => ({ ...d.data(), id: d.id } as Store));
      
      let allowedStores = data;
      if (isManager && staffProfile?.storeIds) {
        allowedStores = data.filter(s => staffProfile.storeIds.includes(s.id));
      } else if (!isAdmin && !isManager) {
        allowedStores = []; // read only? The requirements say cashier/barista/kitchen read only or no access depending on current app pattern. We will just use `allowedStores = data;` if they have `storeIds`, wait, they should probably only see what's in their `storeIds` anyway. Let's just use `staffProfile.storeIds` if not admin.
        if (staffProfile?.storeIds) {
          allowedStores = data.filter(s => staffProfile.storeIds.includes(s.id));
        }
      }
      
      setStores(allowedStores);
      if (allowedStores.length > 0) {
        setSelectedStoreId(allowedStores[0].id);
      }
      setLoading(false);
    };
    fetchStores();
  }, [isAdmin, isManager, staffProfile]);

  useEffect(() => {
    if (!selectedStoreId) {
      setStockItems([]);
      return;
    }
    
    // We cannot easily query storeStock by both storeId and order by name if we don't have a composite index right off the bat,
    // so we will query all for the store and sort locally.
    const q = query(collection(db, 'storeStock'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs
        .map(doc => ({ ...doc.data(), id: doc.id } as StoreStock))
        .filter(s => s.storeId === selectedStoreId && (activeType === 'ALL' || s.stockItemType === activeType));
        
      data.sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
      setStockItems(data);
    });
    return () => unsubscribe();
  }, [selectedStoreId, activeType]);

  const handleEdit = (item: StoreStock) => {
    if (!isAdmin && !isManager) return;
    setEditingItem(item);
    setIsModalOpen(true);
  };

  const handleCreateMissing = async () => {
    if (!isAdmin) return;
    if (!selectedStoreId || !staffProfile) return;
    
    const store = stores.find(s => s.id === selectedStoreId);
    if (!store) return;

    setCreating(true);
    try {
      const created = await createMissingStockRows(store.id, store.name, staffProfile.uid, staffProfile.name, createTarget);
      alert(`Created ${created} missing stock rows.`);
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Error creating rows');
    } finally {
      setCreating(false);
    }
  };

  const filteredItems = useMemo(() => {
    return stockItems.filter(item => {
      const matchesSearch = item.stockItemName.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            item.stockItemCode.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesLowStock = showLowStock ? item.currentStock <= item.minimumStock : true;
      return matchesSearch && matchesLowStock;
    });
  }, [stockItems, searchTerm, showLowStock]);

  const canManage = isAdmin || (isManager && staffProfile?.storeIds.includes(selectedStoreId));

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#5c4033]" />
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
        <AlertCircle size={48} className="mb-4 opacity-30 text-amber-600" />
        <p className="font-bold text-lg text-neutral-600 mb-2">No Stores Found</p>
        <p className="text-sm max-w-md text-center">You don't have access to any stores, or no stores are configured.</p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full">
      <div className="bg-white p-4 rounded-xl shadow-sm border border-neutral-200 mb-6 flex flex-wrap gap-3 items-center w-full min-w-0">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="w-10 h-10 bg-[#5c4033]/10 text-[#5c4033] rounded-lg flex items-center justify-center shrink-0">
            <StoreIcon size={20} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">Select Store</label>
            <select
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="w-full bg-transparent font-bold text-neutral-800 focus:outline-none cursor-pointer"
            >
              {stores.map(store => (
                <option key={store.id} value={store.id}>{store.name}</option>
              ))}
            </select>
          </div>
        </div>

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            <select 
              value={createTarget}
              onChange={(e) => setCreateTarget(e.target.value as any)}
              className="px-3 py-2 border border-indigo-200 rounded-xl bg-indigo-50 text-indigo-700 font-bold focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            >
              <option value="ALL">All Missing Types</option>
              <option value="RAW_INGREDIENTS">Raw Ingredients</option>
              <option value="PREP_ITEMS">Prep Items</option>
              <option value="FINISHED_GOODS">Direct Stock Finished Goods</option>
            </select>
            <button 
              onClick={handleCreateMissing}
              disabled={creating}
              className="px-4 py-2 bg-indigo-50 text-indigo-700 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-indigo-100 transition-colors text-sm border border-indigo-200 disabled:opacity-50"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <DatabaseZap size={16} />}
              Create Missing Rows
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6 w-full min-w-0">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-bold text-neutral-800 shrink-0">Store Stock</h3>
          <select 
            value={activeType}
            onChange={(e) => setActiveType(e.target.value as any)}
            className="p-1 px-2 text-sm font-bold bg-neutral-100 rounded border border-neutral-200 outline-none text-[#5c4033]"
          >
            <option value="ALL">All Types</option>
            <option value="RAW_INGREDIENT">Raw Ingredients</option>
            <option value="PREP_ITEM">Prep Items</option>
            <option value="BOUGHT_COMPONENT">Bought Components</option>
            <option value="FINISHED_GOOD">Finished Goods (Direct)</option>
            <option value="PACKAGING">Packaging</option>
          </select>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input 
              type="text" 
              placeholder="Search ingredient..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] min-w-[200px]"
            />
          </div>
          
          <label className="flex items-center cursor-pointer gap-2 bg-white px-3 py-2 border border-neutral-200 rounded-xl hover:bg-neutral-50 transition-colors">
            <input 
              type="checkbox" 
              checked={showLowStock}
              onChange={(e) => setShowLowStock(e.target.checked)}
              className="w-4 h-4 text-red-500 rounded border-neutral-300 focus:ring-red-500"
            />
            <span className="text-sm font-bold text-neutral-700 whitespace-nowrap">Low Stock Only</span>
          </label>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
          <StoreIcon size={48} className="mb-4 opacity-30 text-[#5c4033]" />
          <p className="font-bold text-lg text-neutral-600 mb-2">No stock items found</p>
          <p className="text-sm max-w-md text-center">
            {stockItems.length === 0 && isAdmin
              ? 'Click "Create Missing Stock Rows" to initialize stock for this store based on active raw ingredients.' 
              : 'No stock items match your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="w-full max-w-full min-w-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <div className="w-full max-w-full overflow-x-auto">
            <table className="min-w-[1050px] w-full text-left border-collapse">
              <thead>
                <tr className="bg-neutral-50/50 border-b border-neutral-200">
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Item</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">Type</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Opening</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Current</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Minimum</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Value</th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-center">Status</th>
                  {canManage && <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredItems.map(item => {
                  let status = 'OK';
                  if (item.currentStock <= 0) status = 'OUT';
                  else if (item.currentStock <= item.minimumStock) status = 'LOW';

                  const stockValue = item.currentStock * (item.costPerUnit || 0);

                  return (
                    <tr key={item.id} className="hover:bg-neutral-50/50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-neutral-800">{item.stockItemName}</div>
                        <div className="text-xs text-neutral-500 font-mono">{item.stockItemCode}</div>
                      </td>
                      <td className="p-4">
                        <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-neutral-100 text-neutral-600">
                          {item.stockItemType.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="p-4 text-right font-medium text-neutral-500">
                        {item.openingStock?.toFixed(2)} <span className="text-xs">{item.uom}</span>
                      </td>
                      <td className="p-4 text-right font-bold text-neutral-800">
                        {item.currentStock?.toFixed(2)} <span className="text-xs text-neutral-500 font-medium">{item.uom}</span>
                      </td>
                      <td className="p-4 text-right font-medium text-neutral-500">
                        {item.minimumStock?.toFixed(2)} <span className="text-xs">{item.uom}</span>
                      </td>
                      <td className="p-4 text-right font-medium text-neutral-800">
                        ${stockValue.toFixed(2)}
                      </td>
                      <td className="p-4 text-center">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                          status === 'OK' ? 'bg-emerald-100 text-emerald-800' : 
                          status === 'LOW' ? 'bg-amber-100 text-amber-800' : 
                          'bg-red-100 text-red-800'
                        }`}>
                          {status === 'LOW' ? 'LOW STOCK' : status === 'OUT' ? 'OUT OF STOCK' : 'OK'}
                        </span>
                      </td>
                      {canManage && (
                        <td className="p-4 text-right">
                          <button 
                            onClick={() => handleEdit(item)}
                            className="px-3 py-1.5 text-xs font-bold text-[#5c4033] bg-[#5c4033]/10 hover:bg-[#5c4033]/20 rounded-lg transition-colors"
                          >
                            Manage
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canManage && (
        <StockAdjustmentModal 
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          stockItem={editingItem}
        />
      )}
    </div>
  );
}
