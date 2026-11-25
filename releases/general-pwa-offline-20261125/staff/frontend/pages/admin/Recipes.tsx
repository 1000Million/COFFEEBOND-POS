import React, { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, query, getDocs, doc, setDoc, serverTimestamp, where } from 'firebase/firestore';
import { MenuItem, InventoryItem, Recipe, RecipeIngredient } from '../../types';
import { BookOpen, AlertCircle, Plus, Save, Trash2, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

export default function RecipesScreen() {
  const { firebaseUser, staffProfile } = useAuth();
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const [loading, setLoading] = useState(true);
  const [errorDetails, setErrorDetails] = useState<{ collection: string; code: string; message: string } | null>(null);
  
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);

  useEffect(() => {
    const loadAll = async () => {
      try {
        let mSnap;
        try {
          mSnap = await getDocs(query(collection(db, 'menuItems'), where('isActive', '==', true)));
        } catch (err: any) {
          throw { collection: 'menuItems', code: err.code, message: err.message };
        }

        let iSnap;
        try {
          iSnap = await getDocs(collection(db, 'inventoryItems'));
        } catch (err: any) {
          throw { collection: 'inventoryItems', code: err.code, message: err.message };
        }

        let rSnap;
        try {
          rSnap = await getDocs(collection(db, 'recipes'));
        } catch (err: any) {
          throw { collection: 'recipes', code: err.code, message: err.message };
        }
        
        if (import.meta.env.DEV) {
          console.log(`[RECIPES DEV] Fetched menuItems: ${mSnap.docs.length}`);
          console.log(`[RECIPES DEV] Fetched inventoryItems: ${iSnap.docs.length}`);
          console.log(`[RECIPES DEV] Fetched recipes: ${rSnap.docs.length}`);
        }
        
        const sortedMenuItems = mSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as MenuItem))
          .sort((a, b) => (a.categoryName || '').localeCompare(b.categoryName || '') || a.name.localeCompare(b.name));

        setMenuItems(sortedMenuItems);
        setInventoryItems(iSnap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem)));
        
        const rec: Record<string, Recipe> = {};
        rSnap.docs.forEach(d => {
           rec[d.id] = { id: d.id, ...d.data() } as Recipe;
        });
        setRecipes(rec);
      } catch (err: any) {
        console.error('[RECIPES DEV]', err);
        setErrorDetails(err);
      } finally {
        setLoading(false);
      }
    };
    loadAll();
  }, []);

  const handleSaveRecipe = async (menuItemId: string, finalIngredients: RecipeIngredient[]) => {
    try {
      const mi = menuItems.find(m => m.id === menuItemId)!;
      const ref = doc(db, 'recipes', menuItemId);
      
      const rData = {
          menuItemId,
          menuItemName: mi.name,
          recipeItems: finalIngredients,
          isActive: true,
          updatedAt: serverTimestamp()
      };
      
      await setDoc(ref, rData);
      setRecipes(prev => ({ ...prev, [menuItemId]: rData as Recipe }));
      setSelectedMenuId(null);
    } catch (err) {
      console.error(err);
      alert('Failed to save recipe');
    }
  };

  const [fixing, setFixing] = useState(false);

  const handleFixCoffeeRecipes = async () => {
    setFixing(true);
    let coffeeBeansItem = inventoryItems.find(i => i.name.toLowerCase().includes('coffee bean') || i.name.toLowerCase().includes('coffee ground'));
    
    if (!coffeeBeansItem) {
      alert("Please ensure 'Coffee Beans' or 'Coffee Grounds' exists in inventory first.");
      setFixing(false);
      return;
    }

    try {
      let updatedCount = 0;
      for (const recipe of Object.values(recipes)) {
        let changed = false;
        const newRecipeItems: RecipeIngredient[] = [];
        
        for (const item of recipe.recipeItems || []) {
          const nameLower = item.inventoryItemName.toLowerCase();
          if (nameLower === 'espresso shot' || nameLower === 'espresso' || nameLower === 'coffee shot' || nameLower === 'double espresso' || nameLower.includes('espresso shot')) {
            changed = true;
            let qty = parseFloat(item.quantity as any) || 0;
            // 1 espresso shot = 18g, double = 36g
            const multiplier = nameLower.includes('double') ? 36 : 18;
            const newQty = qty * multiplier;
            
            // Avoid duplicate 'Coffee Beans' lines
            const existingBeans = newRecipeItems.find(r => r.inventoryItemId === coffeeBeansItem!.id);
            if (existingBeans) {
              existingBeans.quantity = (parseFloat(existingBeans.quantity as any) || 0) + newQty;
            } else {
              newRecipeItems.push({
                inventoryItemCode: coffeeBeansItem.code,
                inventoryItemId: coffeeBeansItem.id!,
                inventoryItemName: coffeeBeansItem.name,
                quantity: newQty,
                unit: coffeeBeansItem.unit || 'g'
              });
            }
          } else {
            newRecipeItems.push(item);
          }
        }
        
        if (changed) {
          const ref = doc(db, 'recipes', recipe.id!);
          await setDoc(ref, { recipeItems: newRecipeItems, updatedAt: serverTimestamp() }, { merge: true });
          
          // update local state
          setRecipes(prev => ({
            ...prev,
            [recipe.id!]: {
               ...prev[recipe.id!],
               recipeItems: newRecipeItems
            }
          }));
          updatedCount++;
        }
      }
      alert(`Migrated ${updatedCount} recipes successfully.`);
    } catch (e: any) {
      console.error(e);
      alert('Error fixing recipes: ' + e.message);
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
       <div className="flex justify-between items-start">
         <div>
            <h1 className="text-2xl font-black text-neutral-900 flex items-center gap-2">
              <BookOpen size={24} className="text-[#5c4033]" />
              Product Recipes
            </h1>
            <p className="text-sm font-medium text-neutral-500">Map menu items to raw materials for automatic stock deduction.</p>
         </div>
         <button 
           onClick={handleFixCoffeeRecipes} 
           disabled={fixing || inventoryItems.length === 0}
           className="bg-amber-600 hover:bg-amber-700 text-white font-bold py-2 px-4 rounded-lg text-sm shadow-sm transition-colors disabled:opacity-50"
         >
           {fixing ? 'Fixing...' : 'Fix Coffee Recipe Mappings'}
         </button>
       </div>
       
       {loading ? (
          <div className="text-center py-12 text-neutral-400">Loading menu items...</div>
       ) : errorDetails ? (
          <div className="flex justify-center py-12">
             <div className="border border-red-200 bg-red-50 rounded-xl p-6 text-red-600 max-w-lg w-full">
               <h3 className="font-bold flex items-center gap-2 mb-2">
                 <AlertCircle size={20} />
                 Data Fetch Error
               </h3>
               <p className="text-sm mb-4">Error loading collection: <strong>{errorDetails.collection}</strong></p>
               <div className="bg-red-100 p-3 rounded text-xs font-mono mb-4 break-words">
                  Code: {errorDetails.code}<br/>
                  Message: {errorDetails.message}
               </div>
               <div className="text-xs text-red-800 space-y-1">
                 <p><strong>Debug Info:</strong></p>
                 <p>User ID: {firebaseUser?.uid || 'Not authenticated'}</p>
                 <p>Role: {staffProfile?.role || 'No role'}</p>
                 <p>Is Active: {staffProfile?.isActive ? 'Yes' : 'No'}</p>
               </div>
             </div>
          </div>
       ) : inventoryItems.length === 0 ? (
          <div className="text-center py-12 text-neutral-500 border border-neutral-200 bg-white rounded-xl">No inventory items found. Run System Seed first.</div>
       ) : menuItems.length === 0 ? (
          <div className="text-center py-12 text-neutral-500 border border-neutral-200 bg-white rounded-xl">No active menu items found. Run System Seed first.</div>
       ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
             <div className="lg:col-span-1 border border-neutral-200 rounded-2xl bg-white shadow-sm overflow-hidden flex flex-col max-h-[80vh]">
                <div className="bg-neutral-50 p-4 border-b border-neutral-200 font-bold text-neutral-700">Menu Items</div>
                <div className="overflow-y-auto flex-1">
                   {menuItems.map(mi => (
                     <div 
                        key={mi.id} 
                        onClick={() => setSelectedMenuId(mi.id)}
                        className={`p-4 border-b border-neutral-100 cursor-pointer transition-colors flex justify-between items-center ${selectedMenuId === mi.id ? 'bg-[#5c4033]/5 border-l-4 border-l-[#5c4033]' : 'hover:bg-neutral-50 border-l-4 border-l-transparent'}`}
                     >
                        <div>
                          <p className="font-bold text-sm text-neutral-900">{mi.name}</p>
                          <p className="text-xs text-neutral-500">{mi.categoryName}</p>
                        </div>
                        {recipes[mi.id] ? (
                           <span className="w-2 h-2 rounded-full bg-green-500"></span>
                        ) : (
                           <span className="w-2 h-2 rounded-full bg-neutral-200"></span>
                        )}
                     </div>
                   ))}
                </div>
             </div>
             
             <div className="lg:col-span-2">
                {selectedMenuId ? (
                   <RecipeEditor 
                     menuItem={menuItems.find(m => m.id === selectedMenuId)!}
                     initialRecipe={recipes[selectedMenuId]}
                     inventoryItems={inventoryItems}
                     onSave={handleSaveRecipe}
                     onCancel={() => setSelectedMenuId(null)}
                   />
                ) : (
                   <div className="h-full flex flex-col items-center justify-center text-neutral-400 bg-white/50 border border-neutral-200 border-dashed rounded-2xl min-h-[400px]">
                      <BookOpen size={48} className="mb-4 opacity-20" />
                      <p>Select a menu item to configure its recipe.</p>
                   </div>
                )}
             </div>
          </div>
       )}
    </div>
  );
}

function RecipeEditor({ menuItem, initialRecipe, inventoryItems, onSave, onCancel }: { menuItem: MenuItem, initialRecipe?: Recipe, inventoryItems: InventoryItem[], onSave: (id: string, igs: RecipeIngredient[]) => void, onCancel: () => void }) {
    const [ingredients, setIngredients] = useState<RecipeIngredient[]>(initialRecipe?.recipeItems || []);
    const [addingItem, setAddingItem] = useState<string>('');
    const [addingQty, setAddingQty] = useState<number>(0);
    
    // reset when menu item changes
    useEffect(() => {
       setIngredients(initialRecipe?.recipeItems || []);
       setAddingItem('');
       setAddingQty(0);
    }, [menuItem.id, initialRecipe]);

    const handleAdd = () => {
       if (!addingItem || addingQty <= 0) return;
       const inv = inventoryItems.find(i => i.id === addingItem);
       if (!inv) return;
       
       if (ingredients.some(i => i.inventoryItemId === inv.id)) {
          alert('Item already in recipe');
          return;
       }
       
       setIngredients([...ingredients, {
          inventoryItemId: inv.id!,
          inventoryItemName: inv.name,
          quantity: addingQty,
          unit: inv.unit
       }]);
       
       setAddingItem('');
       setAddingQty(0);
    };
    
    const remove = (id: string) => {
       setIngredients(ingredients.filter(i => i.inventoryItemId !== id));
    };

    return (
       <div className="bg-white border border-neutral-200 shadow-sm rounded-2xl flex flex-col h-full">
          <div className="p-6 border-b border-neutral-100 flex justify-between items-start">
             <div>
                <h2 className="text-xl font-bold text-neutral-900">{menuItem.name}</h2>
                <div className="text-sm font-medium text-neutral-400 mt-1 flex items-center gap-2">
                   {initialRecipe ? (
                     <span className="inline-flex items-center gap-1 text-green-600 bg-green-50 px-2 py-0.5 rounded text-xs border border-green-100"><BookOpen size={12}/> Recipe Configured</span>
                   ) : (
                     <span className="inline-flex items-center gap-1 text-neutral-500 bg-neutral-100 px-2 py-0.5 rounded text-xs border border-neutral-200"><AlertCircle size={12}/> No Recipe</span>
                   )}
                   <span>• Price: ₹{menuItem.price}</span>
                </div>
             </div>
             <button onClick={onCancel} className="text-neutral-400 hover:text-neutral-700">
                <X size={20} />
             </button>
          </div>
          
          <div className="p-6 flex-1 bg-[#fcf9f5]/30">
             <div className="bg-white rounded-xl border border-neutral-200 p-4 mb-6 relative">
                 <div className="absolute -top-3 left-4 bg-white px-2 text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Add Ingredient</div>
                 <div className="flex gap-4 items-end">
                    <div className="flex-1">
                       <label className="block text-xs font-medium text-neutral-500 mb-1">Raw Material</label>
                       <select value={addingItem} onChange={e => setAddingItem(e.target.value)} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2 text-sm font-medium outline-none focus:border-[#5c4033]">
                         <option value="">-- Select Material --</option>
                         {inventoryItems.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                       </select>
                    </div>
                    <div className="w-32">
                       <label className="block text-xs font-medium text-neutral-500 mb-1">Quantity</label>
                       <div className="relative">
                          <input type="number" step="0.01" min="0" value={addingQty || ''} onChange={e => setAddingQty(Number(e.target.value))} className="w-full bg-neutral-50 border border-neutral-200 rounded-lg pl-3 pr-8 py-2 text-sm font-medium outline-none focus:border-[#5c4033]" />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-neutral-400 pointer-events-none">
                             {addingItem ? inventoryItems.find(i => i.id === addingItem)?.unit : ''}
                          </span>
                       </div>
                    </div>
                    <button onClick={handleAdd} disabled={!addingItem || addingQty <= 0} className="bg-neutral-800 text-white p-2 rounded-lg hover:bg-black transition-colors disabled:opacity-30">
                       <Plus size={20} />
                    </button>
                 </div>
             </div>
             
             <div>
                 <h3 className="text-sm font-bold text-neutral-800 mb-3 border-b border-neutral-200 pb-2">Recipe Formula</h3>
                 
                 {ingredients.some(ing => {
                    const nl = ing.inventoryItemName.toLowerCase();
                    return nl === 'espresso shot' || nl === 'espresso' || nl === 'double espresso' || nl === 'coffee shot' || nl.includes('espresso shot');
                 }) && (
                   <div className="mb-4 bg-orange-50 border border-orange-200 text-orange-800 p-3 rounded-lg text-sm flex items-start gap-2 shadow-sm">
                     <AlertCircle size={18} className="shrink-0 mt-0.5" />
                     <p><strong>Prepared component detected.</strong> Map to raw inventory item such as Coffee Beans directly.</p>
                   </div>
                 )}

                 {ingredients.length === 0 ? (
                    <div className="text-center py-8 text-neutral-400 text-sm">No recipe mapped yet. Add ingredients below.</div>
                 ) : (
                    <ul className="space-y-2">
                       {ingredients.map(ing => (
                          <li key={ing.inventoryItemId} className="flex justify-between items-center bg-white border border-neutral-100 p-3 rounded-lg shadow-sm">
                             <div className="font-medium text-sm text-neutral-800">{ing.inventoryItemName}</div>
                             <div className="flex items-center gap-4">
                                <span className="font-mono font-bold text-[#5c4033] bg-[#5c4033]/5 px-2 py-1 rounded">{ing.quantity} <span className="text-xs opacity-75">{ing.unit}</span></span>
                                <button onClick={() => remove(ing.inventoryItemId)} className="text-neutral-400 hover:text-red-500"><Trash2 size={16} /></button>
                             </div>
                          </li>
                       ))}
                    </ul>
                 )}
             </div>
          </div>
          
          <div className="p-4 border-t border-neutral-100 flex justify-end gap-3 bg-neutral-50 rounded-b-2xl">
             <button onClick={onCancel} className="px-4 py-2 text-sm font-bold text-neutral-600 hover:bg-neutral-200 rounded-lg transition-colors">Cancel</button>
             <button onClick={() => onSave(menuItem.id, ingredients)} className="flex items-center gap-2 bg-[#5c4033] px-5 py-2 text-sm font-bold text-white rounded-lg hover:bg-[#4a332a] transition-colors">
                <Save size={16} /> Save Recipe
             </button>
          </div>
       </div>
    );
}
