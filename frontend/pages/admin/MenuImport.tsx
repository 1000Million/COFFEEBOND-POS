import React, { useState } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs, doc, setDoc, serverTimestamp, query, where } from 'firebase/firestore';
import { DatabaseZap, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

import { CATEGORIES_RAW, MENU_ITEMS_RAW } from '../../data/rawData1';
import { INVENTORY_ITEMS_RAW } from '../../data/rawData2';
import { RECIPES_RAW } from '../../data/rawData3';
import { RECIPE_LINES_RAW_1 } from '../../data/rawData4';
import { RECIPE_LINES_RAW_2 } from '../../data/rawData5';
import { useAuth } from '../../contexts/AuthContext';

function sanitizeFirestoreData(obj: any): any {
  if (obj === undefined) return null;
  if (obj === null) return null;
  if (Array.isArray(obj)) {
    return obj.map(v => sanitizeFirestoreData(v)).filter(v => v !== undefined && v !== null);
  }
  if (typeof obj === 'object') {
     if (
       obj instanceof Date || 
       typeof obj.isEqual === 'function' || 
       obj._methodName === 'serverTimestamp' || 
       obj.type === 'serverTimestamp' ||
       obj.constructor?.name === 'ServerTimestampFieldValueImpl' ||
       obj.constructor?.name === 'FieldValueImpl'
     ) {
        return obj; 
     }
    const cleaned: any = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val !== undefined) {
        cleaned[key] = sanitizeFirestoreData(val);
      }
    }
    return cleaned;
  }
  return obj;
}

function parseRawBlock<T>(rawText: string): T[] {
  const lines = rawText.trim().split('\n').filter(l => l.trim() !== '');
  return lines.map(line => {
    const dataPart = line.replace(/^\d+\.\s*/, '');
    const parts = dataPart.split(' | ');
    const obj: any = {};
    parts.forEach(part => {
      const [key, ...valueParts] = part.split('=');
      obj[key] = valueParts.join('=');
    });
    return obj as T;
  });
}

const ALL_RECIPE_LINES = [
  ...parseRawBlock<any>(RECIPE_LINES_RAW_1),
  ...parseRawBlock<any>(RECIPE_LINES_RAW_2)
];

export default function MenuImport() {
  const { staffProfile } = useAuth();
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<{message: string, type: 'info'|'success'|'error', time: string}[]>([]);
  const archiveOld = false; // Forced to false for now based on user request

  const cats = parseRawBlock<any>(CATEGORIES_RAW);
  const menus = parseRawBlock<any>(MENU_ITEMS_RAW);
  const invs = parseRawBlock<any>(INVENTORY_ITEMS_RAW);
  const recipes = parseRawBlock<any>(RECIPES_RAW);

  const addLog = (message: string, type: 'info'|'success'|'error' = 'info') => {
    setLogs(prev => [...prev, { message, type, time: new Date().toLocaleTimeString() }]);
  };

  const handleRestoreActiveMenus = async () => {
    if (staffProfile?.role !== 'ADMIN') return;
    setIsRunning(true);
    setLogs([]);
    addLog('Restoring all menu items to Active...', 'info');
    try {
      const snap = await getDocs(collection(db, 'menuItems'));
      let count = 0;
      for (const d of snap.docs) {
        try {
          await setDoc(doc(db, 'menuItems', d.id), { isActive: true }, { merge: true });
          count++;
        } catch (e: any) {
          addLog(`Error restoring menu item ${d.id}: ${e.code} - ${e.message}`, 'error');
        }
      }
      addLog(`Restored ${count} menu items to active.`, 'success');
    } catch (error: any) {
      addLog(`Error restoring items: ${error.code} - ${error.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSeedCategories = async () => {
    setIsRunning(true);
    addLog('Starting Categories Seed...', 'info');
    try {
      for (const c of cats) {
        if (!c.categoryCode || !c.categoryName) continue;
        try {
          const payload = {
            code: c.categoryCode,
            name: c.categoryName,
            index: parseInt(c.index, 10) || 999,
            sortOrder: parseInt(c.index, 10) || 999,
            defaultPrepStation: 'NONE',
            isActive: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          const sanitized = sanitizeFirestoreData(payload);
          await setDoc(doc(db, 'categories', c.categoryCode), sanitized, { merge: true });
          addLog(`Seeded category: ${c.categoryCode}`, 'success');
        } catch (err: any) {
           addLog(`Error category ${c.categoryCode}: ${err.code} - ${err.message}`, 'error');
        }
      }
      addLog('Seed Categories complete.', 'info');
    } catch(e: any) {
      addLog(`Critical error: ${e.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSeedMenuItems = async () => {
    setIsRunning(true);
    addLog('Starting Menu Items Seed...', 'info');
    try {
      for (const m of menus) {
        if (!m.itemCode || !m.itemName) continue;
        try {
          let prepStation = 'NONE';
          if (m.station && m.station.toUpperCase() === 'OTHER/NOT PREPARED') {
            prepStation = m.station;
          } else if (m.station === 'BARISTA' || m.station === 'KITCHEN' || m.station === 'BOTH') {
            prepStation = m.station;
          }
          const payload = {
            code: m.itemCode,
            name: m.itemName,
            categoryCode: m.categoryCode || 'UNCATEGORISED',
            categoryName: m.categoryName || 'Uncategorised',
            description: m.description || '',
            price: parseInt(m.price, 10) || 0,
            basePrice: parseInt(m.basePrice, 10) || parseInt(m.price, 10) || 0,
            taxRate: parseFloat(m.taxRate) || 5,
            prepStation,
            isActive: m.isActive !== 'FALSE',
            availableStoreIds: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          const sanitized = sanitizeFirestoreData(payload);
          await setDoc(doc(db, 'menuItems', m.itemCode), sanitized, { merge: true });
          addLog(`Seeded menu item: ${m.itemCode}`, 'success');
        } catch (err: any) {
           addLog(`Error menu item ${m.itemCode}: ${err.code} - ${err.message}`, 'error');
        }
      }
      addLog('Seed Menu Items complete.', 'info');
    } catch(e: any) {
      addLog(`Critical error: ${e.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSeedInventoryItems = async () => {
    setIsRunning(true);
    addLog('Starting Inventory Items Seed...', 'info');
    try {
      for (const i of invs) {
        if (!i.inventoryItemCode || !i.inventoryItemName) continue;
        try {
          let targetCategory = i.category;
          if (!targetCategory || targetCategory.trim() === '') targetCategory = 'OTHER';
          const payload = {
            code: i.inventoryItemCode,
            name: i.inventoryItemName,
            category: targetCategory,
            primaryUnit: i.primaryUnit || 'pcs',
            purchaseUnit: i.purchaseUnit || 'pcs',
            conversionRatio: parseFloat(i.conversionRatio) || 1,
            purchasePricePerPurchaseUnit: parseFloat(i.purchasePrice) || 0,
            costPerPrimaryUnit: parseFloat(i.costPerPrimaryUnit) || 0,
            isActive: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          const sanitized = sanitizeFirestoreData(payload);
          await setDoc(doc(db, 'inventoryItems', i.inventoryItemCode), sanitized, { merge: true });
          addLog(`Seeded inventory item: ${i.inventoryItemCode}`, 'success');
        } catch (err: any) {
           addLog(`Error inventory item ${i.inventoryItemCode}: ${err.code} - ${err.message}`, 'error');
        }
      }
      addLog('Seed Inventory Items complete.', 'info');
    } catch(e: any) {
      addLog(`Critical error: ${e.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSeedRecipes = async () => {
    setIsRunning(true);
    addLog('Starting Recipes Seed...', 'info');
    try {
      const recipeLinesMap = new Map<string, any[]>();
      ALL_RECIPE_LINES.forEach(line => {
        const arr = recipeLinesMap.get(line.recipeCode) || [];
        arr.push({
          inventoryItemCode: line.inventoryItemCode || '',
          inventoryItemName: line.inventoryItemName || '',
          quantity: parseFloat(line.quantity) || 0,
          unit: line.unit || '',
        });
        recipeLinesMap.set(line.recipeCode || '', arr);
      });

      for (const r of recipes) {
        if (!r.recipeCode || !r.menuItemCode) continue;
        try {
          const payload = {
            code: r.recipeCode,
            menuItemCode: r.menuItemCode,
            menuItemName: r.menuItemName || '',
            station: r.station || 'NONE',
            isActive: r.isActive !== 'FALSE',
            recipeCost: 0,
            recipeItems: recipeLinesMap.get(r.recipeCode) || [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          const sanitized = sanitizeFirestoreData(payload);
          await setDoc(doc(db, 'recipes', r.recipeCode), sanitized, { merge: true });
          addLog(`Seeded recipe: ${r.recipeCode}`, 'success');
        } catch (err: any) {
           addLog(`Error recipe ${r.recipeCode}: ${err.code} - ${err.message}`, 'error');
        }
      }
      addLog('Seed Recipes complete.', 'info');
    } catch(e: any) {
      addLog(`Critical error: ${e.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSeedStoreInventory = async () => {
    setIsRunning(true);
    addLog('Starting Store Inventory Seed...', 'info');
    try {
      const storesSnapshot = await getDocs(collection(db, 'stores'));
      const activeStores = storesSnapshot.docs.filter((d: any) => d.data().isActive).map((d: any) => ({ id: d.id, ...d.data() }));
      addLog(`Found ${activeStores.length} active stores. Creating missing stock rows...`, 'info');

      for (const store of activeStores) {
        const existingStoreInvSnapshot = await getDocs(query(collection(db, 'storeInventory'), where('storeId', '==', store.id)));
        const existingCodes = new Set(existingStoreInvSnapshot.docs.map((d: any) => d.data().inventoryItemCode || d.data().inventoryItemId));

        for (const inv of invs) {
          if (inv.inventoryItemCode && !existingCodes.has(inv.inventoryItemCode)) {
            try {
              const stockId = `${store.id}_${inv.inventoryItemCode}`;
              const payload = {
                storeId: store.id,
                inventoryItemId: inv.inventoryItemCode,
                inventoryItemCode: inv.inventoryItemCode,
                inventoryItemName: inv.inventoryItemName || 'Unknown',
                primaryUnit: inv.primaryUnit || 'pcs',
                unit: inv.primaryUnit || 'pcs',
                openingStock: 0,
                currentStock: 0,
                minimumStock: 0,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
              };
              const sanitized = sanitizeFirestoreData(payload);
              await setDoc(doc(db, 'storeInventory', stockId), sanitized, { merge: true });
              addLog(`Seeded store inventory: ${stockId}`, 'success');
            } catch (err: any) {
               addLog(`Error store inventory ${inv.inventoryItemCode}: ${err.code} - ${err.message}`, 'error');
            }
          }
        }
      }
      addLog('Seed Store Inventory complete.', 'info');
    } catch(e: any) {
      addLog(`Critical error: ${e.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleReset = () => {
    setIsRunning(false);
    setLogs([]);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-neutral-200">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center">
            <DatabaseZap size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-neutral-800">Menu & Seed Configuration</h2>
            <p className="text-sm font-medium text-neutral-500">Restore or import data progressively</p>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-xl text-sm mb-6 flex gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold mb-1">Safety First System</p>
            <p className="opacity-90">Archive functionality is completely disabled. Import items individually. In case of missing items, please use the Restore functionality first.</p>
          </div>
        </div>
        
        <div className="mb-6 flex items-center opacity-50 select-none">
          <input
            type="checkbox"
            id="archiveOld"
            checked={archiveOld}
            readOnly
            className="w-4 h-4 text-[#5c4033] bg-gray-100 border-gray-300 rounded focus:ring-[#5c4033] focus:ring-2"
          />
          <label htmlFor="archiveOld" className="ml-2 text-sm font-medium text-neutral-800">
            Archive old menu items not found in 2026 import (Archiving disabled until 2026 seed is verified)
          </label>
        </div>

        <div className="flex flex-col md:flex-row gap-4 mb-6 pb-6 border-b border-neutral-200">
          <button
            type="button"
            onClick={handleRestoreActiveMenus}
            disabled={isRunning}
            className="flex-1 py-3 px-4 bg-orange-100 hover:bg-orange-200 text-orange-800 font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed border border-orange-300"
          >
            {isRunning ? (
              <><Loader2 size={18} className="animate-spin" /> Working...</>
            ) : (
              <><RefreshCw size={18} /> Restore All Menu Items Active</>
            )}
          </button>
        </div>

        <h3 className="text-lg font-bold mb-4">Step-by-Step Seed Procedures</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          <button
            type="button"
            onClick={handleSeedCategories}
            disabled={isRunning}
            className="py-3 px-4 bg-[#5c4033] hover:bg-[#3e2723] text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm"
          >
             Seed Categories
          </button>
          <button
            type="button"
            onClick={handleSeedMenuItems}
            disabled={isRunning}
            className="py-3 px-4 bg-[#5c4033] hover:bg-[#3e2723] text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm"
          >
             Seed Menu Items
          </button>
          <button
            type="button"
            onClick={handleSeedInventoryItems}
            disabled={isRunning}
            className="py-3 px-4 bg-[#5c4033] hover:bg-[#3e2723] text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm"
          >
             Seed Inventory Items
          </button>
          <button
            type="button"
            onClick={handleSeedRecipes}
            disabled={isRunning}
            className="py-3 px-4 bg-[#5c4033] hover:bg-[#3e2723] text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm"
          >
             Seed Recipes
          </button>
          <button
            type="button"
            onClick={handleSeedStoreInventory}
            disabled={isRunning}
            className="py-3 px-4 bg-[#5c4033] hover:bg-[#3e2723] text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm"
          >
             Seed Store Inventory
          </button>
          
          <button
            type="button"
            onClick={handleReset}
            disabled={isRunning}
            className="py-3 px-4 border border-neutral-300 text-neutral-600 font-bold rounded-xl transition-colors hover:bg-neutral-50 text-sm"
          >
             Clear Logs
          </button>
        </div>

        {logs.length > 0 && (
          <div className="bg-neutral-900 flex flex-col-reverse text-neutral-300 font-mono text-xs p-4 rounded-xl h-[400px] overflow-y-auto space-y-1.5 space-y-reverse custom-scrollbar">
            {logs.slice().reverse().map((log, i) => (
              <div key={i} className="flex gap-2 shrink-0">
                <span className="opacity-50 min-w-max">[{log.time}]</span>
                <span className={`
                  ${log.type === 'success' ? 'text-green-400' : ''}
                  ${log.type === 'error' ? 'text-red-400 font-bold' : ''}
                  ${log.type === 'info' ? 'text-blue-300' : ''}
                `}>
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

