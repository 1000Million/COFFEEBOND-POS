import React, { useState } from 'react';
import { collection, doc, writeBatch, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { DatabaseZap, Loader2, CheckCircle2, AlertCircle, Package } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const SEED_STORES = [
  { name: 'Uday Park', code: 'UDAY_PARK', address: 'Uday Park, New Delhi', isActive: true },
  { name: 'Noida Sector 29', code: 'NOIDA_29', address: 'Sector 29, Noida', isActive: true },
  { name: 'Noida Sector 51', code: 'NOIDA_51', address: 'Sector 51, Noida', isActive: true },
];

const SEED_CATEGORIES = [
  { name: 'Hot Coffee', code: 'HOT_COFFEE', sortOrder: 10, isActive: true, defaultPrepStation: 'BARISTA' },
  { name: 'Cold Coffee', code: 'COLD_COFFEE', sortOrder: 20, isActive: true, defaultPrepStation: 'BARISTA' },
  { name: 'Matcha', code: 'MATCHA', sortOrder: 30, isActive: true, defaultPrepStation: 'BARISTA' },
  { name: 'Tea', code: 'TEA', sortOrder: 40, isActive: true, defaultPrepStation: 'BARISTA' },
  { name: 'Cookies', code: 'COOKIES', sortOrder: 50, isActive: true, defaultPrepStation: 'KITCHEN' },
  { name: 'Croissants', code: 'CROISSANTS', sortOrder: 60, isActive: true, defaultPrepStation: 'KITCHEN' },
  { name: 'Sandwiches', code: 'SANDWICHES', sortOrder: 70, isActive: true, defaultPrepStation: 'KITCHEN' },
  { name: 'Desserts', code: 'DESSERTS', sortOrder: 80, isActive: true, defaultPrepStation: 'KITCHEN' },
  { name: 'Retail Coffee', code: 'RETAIL_COFFEE', sortOrder: 90, isActive: true, defaultPrepStation: 'NONE' },
];

const SEED_MENU_ITEMS = [
  { name: 'Hot Milk Coffee', code: 'HOT_MILK_COFFEE', categoryCode: 'HOT_COFFEE', price: 180, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Americano', code: 'AMERICANO', categoryCode: 'HOT_COFFEE', price: 160, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Cappuccino', code: 'CAPPUCCINO', categoryCode: 'HOT_COFFEE', price: 190, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Latte', code: 'LATTE', categoryCode: 'HOT_COFFEE', price: 190, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Flat White', code: 'FLAT_WHITE', categoryCode: 'HOT_COFFEE', price: 210, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Iced Latte', code: 'ICED_LATTE', categoryCode: 'COLD_COFFEE', price: 220, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Cold Coffee', code: 'COLD_COFFEE', categoryCode: 'COLD_COFFEE', price: 240, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Orange Espresso Tonic', code: 'ORANGE_ESPRESSO_TONIC', categoryCode: 'COLD_COFFEE', price: 260, taxRate: 5, prepStation: 'BARISTA' },
  { name: 'Double Chocolate Cookie', code: 'DOUBLE_CHOCOLATE_COOKIE', categoryCode: 'COOKIES', price: 160, taxRate: 5, prepStation: 'KITCHEN' },
  { name: 'Butter Cookie', code: 'BUTTER_COOKIE', categoryCode: 'COOKIES', price: 120, taxRate: 5, prepStation: 'KITCHEN' },
  { name: 'Butter Croissant', code: 'BUTTER_CROISSANT', categoryCode: 'CROISSANTS', price: 180, taxRate: 5, prepStation: 'KITCHEN' },
  { name: 'Almond Croissant', code: 'ALMOND_CROISSANT', categoryCode: 'CROISSANTS', price: 260, taxRate: 5, prepStation: 'KITCHEN' },
  { name: 'Paneer Sandwich', code: 'PANEER_SANDWICH', categoryCode: 'SANDWICHES', price: 280, taxRate: 5, prepStation: 'KITCHEN' },
  { name: 'Mushroom Melt', code: 'MUSHROOM_MELT', categoryCode: 'SANDWICHES', price: 300, taxRate: 5, prepStation: 'KITCHEN' },
  { name: 'House Blend Beans 250g', code: 'HOUSE_BLEND_BEANS_250G', categoryCode: 'RETAIL_COFFEE', price: 650, taxRate: 5, prepStation: 'NONE' },
];

const SEED_INVENTORY_ITEMS = [
  { name: 'Coffee Beans', code: 'COFFEE_BEANS', unit: 'g', category: 'COFFEE', costPerUnit: 1 },
  { name: 'Milk', code: 'MILK', unit: 'ml', category: 'MILK', costPerUnit: 0.05 },
  { name: 'Paper Cup 8oz', code: 'PAPER_CUP_8OZ', unit: 'pcs', category: 'PACKAGING', costPerUnit: 5 },
  { name: 'Lid 8oz', code: 'LID_8OZ', unit: 'pcs', category: 'PACKAGING', costPerUnit: 2 },
  { name: 'Double Chocolate Cookie Stock', code: 'DOUBLE_CHOCOLATE_COOKIE_STOCK', unit: 'pcs', category: 'BAKERY', costPerUnit: 40 },
  { name: 'Butter Cookie Stock', code: 'BUTTER_COOKIE_STOCK', unit: 'pcs', category: 'BAKERY', costPerUnit: 30 },
  { name: 'Butter Croissant Stock', code: 'BUTTER_CROISSANT_STOCK', unit: 'pcs', category: 'BAKERY', costPerUnit: 80 },
  { name: 'Almond Croissant Stock', code: 'ALMOND_CROISSANT_STOCK', unit: 'pcs', category: 'BAKERY', costPerUnit: 120 },
  { name: 'House Blend Beans 250g Stock', code: 'HOUSE_BLEND_BEANS_250G_STOCK', unit: 'pcs', category: 'RETAIL', costPerUnit: 300 }
];

const SEED_RECIPES_MAPPING: Record<string, any[]> = {
  'HOT_MILK_COFFEE': [
    { code: 'COFFEE_BEANS', qty: 18 },
    { code: 'MILK', qty: 180 },
    { code: 'PAPER_CUP_8OZ', qty: 1 },
    { code: 'LID_8OZ', qty: 1 }
  ],
  'AMERICANO': [
    { code: 'COFFEE_BEANS', qty: 18 },
    { code: 'PAPER_CUP_8OZ', qty: 1 },
    { code: 'LID_8OZ', qty: 1 }
  ],
  'DOUBLE_CHOCOLATE_COOKIE': [
    { code: 'DOUBLE_CHOCOLATE_COOKIE_STOCK', qty: 1 }
  ],
  'BUTTER_COOKIE': [
    { code: 'BUTTER_COOKIE_STOCK', qty: 1 }
  ],
  'BUTTER_CROISSANT': [
    { code: 'BUTTER_CROISSANT_STOCK', qty: 1 }
  ],
  'ALMOND_CROISSANT': [
    { code: 'ALMOND_CROISSANT_STOCK', qty: 1 }
  ],
  'HOUSE_BLEND_BEANS_250G': [
    { code: 'HOUSE_BLEND_BEANS_250G_STOCK', qty: 1 }
  ]
};

export default function Seed() {
  const { staffProfile } = useAuth();
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<{message: string, type: 'info'|'success'|'error'}[]>([]);

  const addLog = (message: string, type: 'info'|'success'|'error' = 'info') => {
    setLogs(prev => [...prev, { message, type }]);
  };

  const handleSeed = async () => {
    if (staffProfile?.role !== 'ADMIN') {
      addLog('Unauthorized: Admin access required', 'error');
      return;
    }
    setIsRunning(true);
    setLogs([]);
    
    try {
      const batch = writeBatch(db);
      const now = new Date();

      // --- 1. Seed Stores ---
      addLog('Processing stores...');
      const storeCodeMap: Record<string, string> = {};
      const storeIds: string[] = [];

      for (const store of SEED_STORES) {
        const q = query(collection(db, 'stores'), where('code', '==', store.code));
        const snap = await getDocs(q);
        if (snap.empty) {
          const docRef = doc(collection(db, 'stores'));
          batch.set(docRef, { ...store, createdAt: now, updatedAt: now });
          storeCodeMap[store.code] = docRef.id;
          storeIds.push(docRef.id);
          addLog(`Added store: ${store.name}`, 'success');
        } else {
          storeCodeMap[store.code] = snap.docs[0].id;
          storeIds.push(snap.docs[0].id);
          addLog(`Store exists: ${store.name}`, 'info');
        }
      }

      // Commit early block to get IDs if needed
      await batch.commit();
      addLog('Store batch committed.');

      const batch2 = writeBatch(db);

      // --- 2. Seed Categories ---
      addLog('Processing categories...');
      const catCodeMap: Record<string, any> = {};

      for (const cat of SEED_CATEGORIES) {
        const q = query(collection(db, 'categories'), where('code', '==', cat.code));
        const snap = await getDocs(q);
        if (snap.empty) {
          const docRef = doc(collection(db, 'categories'));
          batch2.set(docRef, { ...cat, createdAt: now, updatedAt: now });
          catCodeMap[cat.code] = { id: docRef.id, name: cat.name };
          addLog(`Added category: ${cat.name}`, 'success');
        } else {
          catCodeMap[cat.code] = { id: snap.docs[0].id, name: snap.docs[0].data().name };
          addLog(`Category exists: ${cat.name}`, 'info');
        }
      }

      await batch2.commit();
      addLog('Category batch committed.');

      const batch3 = writeBatch(db);

      // --- 3. Seed Menu Items ---
      addLog('Processing menu items...');
      
      for (const item of SEED_MENU_ITEMS) {
        const q = query(collection(db, 'menuItems'), where('code', '==', item.code));
        const snap = await getDocs(q);
        if (snap.empty) {
          const docRef = doc(collection(db, 'menuItems'));
          const catInfo = catCodeMap[item.categoryCode];
          if (!catInfo) {
            addLog(`Skipped ${item.name}: Category missing.`, 'error');
            continue;
          }

          batch3.set(docRef, {
            name: item.name,
            code: item.code,
            categoryId: catInfo.id,
            categoryCode: item.categoryCode,
            categoryName: catInfo.name,
            description: '',
            price: item.price,
            taxRate: item.taxRate,
            prepStation: item.prepStation,
            isActive: true,
            availableStoreIds: storeIds, // Assign to all found stores
            createdAt: now,
            updatedAt: now
          });
          addLog(`Added item: ${item.name}`, 'success');
        } else {
          addLog(`Item exists: ${item.name}`, 'info');
        }
      }

      await batch3.commit();
      addLog('Menu Items batch committed.', 'success');
      
      addLog('Seed process completed successfully!', 'success');

    } catch (error: any) {
      console.error(error);
      addLog(`Error during seeding: ${error.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleMigrate = async () => {
    console.log('[MIGRATION] Migrate Prep Stations clicked');
    if (staffProfile?.role !== 'ADMIN') {
      addLog('Unauthorized: Admin access required', 'error');
      return;
    }
    
    setIsRunning(true);
    setLogs([]);
    addLog('Starting Pre-station Migration...', 'info');

    try {
      const now = Timestamp.now();
      
      // Update Categories
      const catQuery = await getDocs(collection(db, 'categories'));
      let catBatch = writeBatch(db);
      let catCount = 0;
      
      catQuery.docs.forEach(docSnap => {
        const data = docSnap.data();
        const seedCat = SEED_CATEGORIES.find(c => c.code === data.code);
        if (seedCat) {
          catBatch.update(docSnap.ref, { defaultPrepStation: seedCat.defaultPrepStation, updatedAt: now });
          catCount++;
        } else {
          catBatch.update(docSnap.ref, { defaultPrepStation: 'NONE', updatedAt: now });
          catCount++;
        }
      });
      
      if (catCount > 0) {
        await catBatch.commit();
        addLog(`Migrated ${catCount} Categories`, 'success');
      } else {
        addLog('No categories needed migration', 'info');
      }

      // Update Menu Items
      const itemQuery = await getDocs(collection(db, 'menuItems'));
      let itemBatch = writeBatch(db);
      let itemCount = 0;
      let batchCount = 0;
      
      for (const docSnap of itemQuery.docs) {
        const data = docSnap.data();
        
        // Find seed match or fallback
        const seedItem = SEED_MENU_ITEMS.find(i => i.code === data.code);
        let newPrepStation = 'NONE';
        
        if (seedItem) {
          newPrepStation = seedItem.prepStation;
        } else {
          // Fallback to category default
          const seedCat = SEED_CATEGORIES.find(c => c.code === data.categoryCode);
          newPrepStation = seedCat ? seedCat.defaultPrepStation : 'NONE';
        }
           
        itemBatch.update(docSnap.ref, { prepStation: newPrepStation, updatedAt: now });
        itemCount++;
        batchCount++;
           
        // Firestore batch limit is 500
        if (batchCount === 450) {
          await itemBatch.commit();
          itemBatch = writeBatch(db);
          batchCount = 0;
          addLog(`Committed batch of menu items...`, 'info');
        }
      }
      
      if (batchCount > 0) {
         await itemBatch.commit();
      }
      
      if (itemCount > 0) {
        addLog(`Migrated ${itemCount} Menu Items`, 'success');
      } else {
        addLog('No menu items needed migration', 'info');
      }

      addLog('Migration completed successfully!', 'success');

    } catch (error: any) {
      console.error(error);
      addLog(`Error during migration: ${error.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSeedInventory = async () => {
    if (staffProfile?.role !== 'ADMIN') return;
    setIsRunning(true); setLogs([]);
    addLog('Starting Inventory Seed...', 'info');

    try {
       const now = Timestamp.now();
       
       // 1. Seed Global Inventory Items
       let invRefMap: Record<string, any> = {};
       const batch1 = writeBatch(db);
       
       for (const inv of SEED_INVENTORY_ITEMS) {
          const q = query(collection(db, 'inventoryItems'), where('code', '==', inv.code));
          const snap = await getDocs(q);
          if (snap.empty) {
             const ref = doc(collection(db, 'inventoryItems'));
             batch1.set(ref, { ...inv, isActive: true, createdAt: now, updatedAt: now });
             invRefMap[inv.code] = { id: ref.id, name: inv.name, unit: inv.unit };
             addLog(`Added Inventory Item: ${inv.name}`, 'success');
          } else {
             invRefMap[inv.code] = { id: snap.docs[0].id, name: snap.docs[0].data().name, unit: snap.docs[0].data().unit };
             addLog(`Inventory Item exists: ${inv.name}`);
          }
       }
       await batch1.commit();
       addLog('Global Inventory batch committed.', 'success');
       
       // 2. Map Recipes
       const mSnap = await getDocs(collection(db, 'menuItems'));
       const menuItems = mSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
       
       const batch2 = writeBatch(db);
       let builtRecipes = 0;
       
       for (const [mCode, recipeData] of Object.entries(SEED_RECIPES_MAPPING)) {
          const mItem = menuItems.find(m => m.code === mCode);
          if (mItem) {
             const rRef = doc(db, 'recipes', mItem.id);
             const rSnap = await getDocs(query(collection(db, 'recipes'), where('menuItemId', '==', mItem.id)));
             // we'll just upsert default recipe if missing
             const exists = (await getDocs(query(collection(db, 'recipes'), where('menuItemId', '==', mItem.id))));
             if(exists.empty) {
                const igs = recipeData.map(r => {
                   const ir = invRefMap[r.code];
                   return {
                      inventoryItemId: ir.id,
                      inventoryItemName: ir.name,
                      quantity: r.qty,
                      unit: ir.unit
                   };
                });
                
                batch2.set(rRef, {
                   menuItemId: mItem.id,
                   menuItemName: mItem.name,
                   recipeItems: igs,
                   isActive: true,
                   updatedAt: now
                });
                builtRecipes++;
             }
          }
       }
       
       if (builtRecipes > 0) {
          await batch2.commit();
          addLog(`Added ${builtRecipes} Default Recipes.`, 'success');
       } else {
          addLog('Default Recipes already exist.');
       }
       
       // 3. Setup initial store inventory
       const sSnap = await getDocs(collection(db, 'stores'));
       const stores = sSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
       
       const batch3 = writeBatch(db);
       let stockGen = 0;
       
       for (const store of stores) {
          for (const inv of SEED_INVENTORY_ITEMS) {
              const ir = invRefMap[inv.code];
              const sid = `${store.id}_${ir.id}`;
              const check = doc(db, 'storeInventory', sid);
              // (can't easily check batch doc existence in web SDK without transaction, but we can query storeInventory in advance)
          }
       }
       
       // Optimization: fetch all storeInventory
       const stkSnap = await getDocs(collection(db, 'storeInventory'));
       const exStkPaths = stkSnap.docs.map(d => d.id);
       
       for (const store of stores) {
          for (const inv of SEED_INVENTORY_ITEMS) {
             const ir = invRefMap[inv.code];
             const sid = `${store.id}_${ir.id}`;
             if (!exStkPaths.includes(sid)) {
                batch3.set(doc(db, 'storeInventory', sid), {
                   storeId: store.id,
                   storeName: store.name,
                   inventoryItemId: ir.id,
                   inventoryItemName: ir.name,
                   unit: ir.unit,
                   openingStock: 1000,
                   currentStock: 1000,
                   minimumStock: 100,
                   updatedAt: now
                });
                stockGen++;
             }
          }
       }
       
       if (stockGen > 0) {
          await batch3.commit();
          addLog(`Added ${stockGen} initial stock racks to stores.`, 'success');
       } else {
          addLog('Stock tracks already configured for stores.');
       }

       addLog('Inventory Seed Process Complete!', 'success');
    } catch (e: any) {
       console.error(e);
       addLog(`Error: ${e.message}`, 'error');
    } finally {
       setIsRunning(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-neutral-200">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 bg-red-50 text-red-600 rounded-xl flex items-center justify-center">
            <DatabaseZap size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-neutral-800">System Seed & Migration</h2>
            <p className="text-sm text-neutral-500">Initialize standard Cofffe Bond POS data safely.</p>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-xl text-sm mb-6 flex gap-3">
          <AlertCircle size={20} className="shrink-0" />
          <div>
            <p className="font-semibold mb-1">Idempotent Operation</p>
            <p className="opacity-90">Running this tool will only add missing default stores, categories, and menu items based on unique codes. It will not overwrite customized existing data.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <button
            type="button"
            onClick={handleSeed}
            disabled={isRunning}
            className="w-full py-3 bg-[#3e2723] hover:bg-[#2d1c19] text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed z-10 relative"
          >
            {isRunning ? (
              <><Loader2 size={18} className="animate-spin" /> Processing...</>
            ) : (
              <><DatabaseZap size={18} /> Run Seed Process</>
            )}
          </button>
          
          <button
            type="button"
            onClick={handleMigrate}
            disabled={isRunning}
            className="w-full py-3 border-2 border-[#3e2723] text-[#3e2723] font-medium rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed hover:bg-neutral-50 z-10 relative"
          >
            {isRunning ? (
              <><Loader2 size={18} className="animate-spin" /> Migrating...</>
            ) : (
              <><DatabaseZap size={18} /> Migrate Prep Stations</>
            )}
          </button>
        </div>

        <div className="mb-6 border-t border-neutral-100 pt-6">
           <button
             type="button"
             onClick={handleSeedInventory}
             disabled={isRunning}
             className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed z-10 relative"
           >
             {isRunning ? (
               <><Loader2 size={18} className="animate-spin" /> Processing...</>
             ) : (
               <><Package size={18} /> Seed Inventory & Recipes</>
             )}
           </button>
        </div>

        {logs.length > 0 && (
          <div className="bg-neutral-900 text-neutral-300 font-mono text-xs p-4 rounded-xl max-h-64 overflow-y-auto space-y-1.5 custom-scrollbar">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="opacity-50">[{new Date().toLocaleTimeString()}]</span>
                <span className={`
                  ${log.type === 'success' ? 'text-green-400' : ''}
                  ${log.type === 'error' ? 'text-red-400' : ''}
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
