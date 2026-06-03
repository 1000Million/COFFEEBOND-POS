import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, getDocs, orderBy, where, runTransaction, doc, serverTimestamp, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, Category, MenuItem, CartItem, OrderType, PaymentMethod, Customer, Order, OrderItem, OrderPayment } from '../../types';
import { Loader2, Plus, Minus, Trash2, Search, Store as StoreIcon, User, Phone, MapPin, SearchX, Coffee, CheckCircle, Printer, AlertCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function POSHome() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';

  const [stores, setStores] = useState<Store[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [orderType, setOrderType] = useState<OrderType>('DINE_IN');
  const [tableNumber, setTableNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  const [cart, setCart] = useState<CartItem[]>([]);
  const [globalDiscountStr, setGlobalDiscountStr] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [isSaving, setIsSaving] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<{ order: Order, items: OrderItem[], payment: OrderPayment, storeName: string } | null>(null);

  const [posSourceSettings, setPosSourceSettings] = useState<{ globalSource: string, storeOverrides: Record<string, string> }>({ globalSource: 'LEGACY_MENU_ITEMS', storeOverrides: {} });
  const [posSource, setPosSource] = useState<'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS'>('LEGACY_MENU_ITEMS');

  const [debugCounts, setDebugCounts] = useState<any>(null);
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);

  useEffect(() => {
    fetchData();
    const unsub = onSnapshot(doc(db, 'appSettings', 'posMenuSource'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const globalSource = data.globalSource || data.source || 'LEGACY_MENU_ITEMS';
        const storeOverrides = data.storeOverrides || {};
        setPosSourceSettings({ globalSource, storeOverrides });
      } else {
        setPosSourceSettings({ globalSource: 'LEGACY_MENU_ITEMS', storeOverrides: {} });
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (selectedStoreId) {
       const override = posSourceSettings.storeOverrides[selectedStoreId];
       if (override === 'FINISHED_GOODS' || override === 'LEGACY_MENU_ITEMS') {
          setPosSource(override);
       } else {
          setPosSource(posSourceSettings.globalSource as 'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS');
       }
    } else {
       setPosSource(posSourceSettings.globalSource as 'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS');
    }
  }, [selectedStoreId, posSourceSettings]);

  // Effect to reload menu items when source changes
  useEffect(() => {
    fetchMenuData();
  }, [posSource]);

  const fetchMenuData = async () => {
    setLoading(true);
    try {
      if (posSource === 'FINISHED_GOODS') {
        const fgSnap = await getDocs(query(collection(db, 'finishedGoods')));
        
        let total = 0;
        let activeCount = 0;
        let sellableCount = 0;
        let availableCount = 0;
        let finalCount = 0;

        const mappedItems: (MenuItem & { itemType: string, bom: any[], finishedGoodCode: string })[] = [];

        fgSnap.docs.forEach(d => {
           const data = d.data();
           total++;
           
           if (!data.isActive) return;
           activeCount++;
           
           if (!data.isSellable) return;
           sellableCount++;
           
           // If 'isAvailable' is checked
           if (data.isAvailable === false) return; // sometimes omitted, so assume true if not false
           availableCount++;

           mappedItems.push({
             id: data.code,
             name: data.displayName || data.name,
             code: data.code,
             categoryId: data.posCategoryCode || 'MISC',
             categoryCode: data.posCategoryCode || 'MISC',
             categoryName: data.posCategoryName || 'Misc',
             categorySortOrder: typeof data.categorySortOrder === 'number' ? data.categorySortOrder : 999,
             subcategoryCode: data.posSubcategoryCode || 'MISC',
             subcategoryName: data.posSubcategoryName || '',
             subcategorySortOrder: typeof data.subcategorySortOrder === 'number' ? data.subcategorySortOrder : 999,
             sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 999,
             description: data.description || '',
             price: data.salePrice || 0,
             taxRate: data.taxRate || 0,
             prepStation: data.prepStation || 'NONE',
             isActive: data.isActive,
             availableStoreIds: data.availableStoreIds || [],
             itemType: data.itemType,
             bom: data.bom || [],
             finishedGoodCode: data.code,
             createdAt: data.createdAt,
             updatedAt: data.updatedAt
           } as any);
        });
        
        setMenuItems(mappedItems);
        setDebugCounts({ total, activeCount, sellableCount, availableCount, mappedCount: mappedItems.length });
      } else {
        const itemsSnap = await getDocs(query(collection(db, 'menuItems'), where('isActive', '==', true)));
        setMenuItems(itemsSnap.docs.map(d => ({ id: d.id, ...d.data() } as MenuItem)));
        setDebugCounts(null);
      }
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  const fetchData = async () => {
    try {
      const [storesSnap, catSnap] = await Promise.all([
        getDocs(query(collection(db, 'stores'), where('isActive', '==', true))),
        getDocs(query(collection(db, 'categories'), orderBy('sortOrder', 'asc')))
      ]);

      const fetchedStores = storesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Store));
      
      const allowedStores = isAdmin 
        ? fetchedStores 
        : fetchedStores.filter(s => staffProfile?.storeIds.includes(s.id));

      setStores(allowedStores);
      setCategories(catSnap.docs.map(d => ({ id: d.id, ...d.data() } as Category)).filter(c => c.isActive));

      if (allowedStores.length > 0) {
        setSelectedStoreId(allowedStores[0].id);
      }
    } catch (error: any) {
      if (error?.code !== 'permission-denied') {
        console.error("Error fetching POS data:", error);
      }
    }
  };

  const handleStoreChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (cart.length > 0) {
      if (window.confirm("Changing store will clear your current cart. Proceed?")) {
        setCart([]);
        setSelectedStoreId(e.target.value);
      }
    } else {
      setSelectedStoreId(e.target.value);
    }
  };

  const displayCategories = useMemo(() => {
    if (posSource === 'LEGACY_MENU_ITEMS') {
      return categories.map(cat => {
        const count = menuItems.filter(i => i.categoryId === cat.id && i.availableStoreIds?.includes(selectedStoreId)).length;
        return { ...cat, sortOrder: cat.sortOrder || 999, count };
      }).sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }
        return a.name.localeCompare(b.name);
      });
    }
    
    // FINISHED_GOODS categories
    const catsMap = new Map<string, { id: string, name: string, sortOrder: number, count: number }>();
    menuItems.forEach(item => {
      if (!item.availableStoreIds?.includes(selectedStoreId)) return;
      
      const code = (item as any).categoryCode || item.categoryId || 'MISC';
      const name = (item as any).categoryName || 'Misc';
      const order = (item as any).categorySortOrder !== undefined ? (item as any).categorySortOrder : 999;
      
      if (!catsMap.has(code)) {
         catsMap.set(code, { id: code, name: name, sortOrder: order, count: 0 });
      }
      catsMap.get(code)!.count++;
    });

    return Array.from(catsMap.values()).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return a.name.localeCompare(b.name);
    });
  }, [posSource, categories, menuItems, selectedStoreId]);

  // Reset selected category if it's no longer valid for the current display categories
  useEffect(() => {
    if (selectedCategoryId !== 'ALL') {
      const isValid = displayCategories.some(c => c.id === selectedCategoryId);
      if (!isValid) {
        setSelectedCategoryId('ALL');
      }
    }
  }, [displayCategories, selectedCategoryId]);

  const filteredMenuItems = useMemo(() => {
    const filtered = menuItems.filter(item => {
      // Must be available in selected store
      if (!item.availableStoreIds?.includes(selectedStoreId)) return false;
      
      // Must match category if selected
      const catCode = posSource === 'FINISHED_GOODS' ? (item as any).categoryCode || item.categoryId : item.categoryId;
      if (selectedCategoryId !== 'ALL' && catCode !== selectedCategoryId) return false;
      
      // Must match search query
      if (searchQuery) {
        const queryLower = searchQuery.toLowerCase();
        const nameMatch = (item.name || '').toLowerCase().includes(queryLower);
        const codeMatch = (item.code || '').toLowerCase().includes(queryLower);
        if (!nameMatch && !codeMatch) {
          return false;
        }
      }
      return true;
    });

    // Sort items
    return filtered.sort((a: any, b: any) => {
      const orderA = typeof a.sortOrder === 'number' ? a.sortOrder : 999;
      const orderB = typeof b.sortOrder === 'number' ? b.sortOrder : 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [menuItems, selectedStoreId, selectedCategoryId, searchQuery, posSource]);

  // --- Cart Operations ---
  const addToCart = (item: any) => {
    setCart(prev => {
      const existing = prev.find(ci => ci.menuItemId === item.id);
      if (existing) {
        return prev.map(ci => ci.menuItemId === item.id ? { ...ci, quantity: ci.quantity + 1 } : ci);
      }
      return [...prev, {
        id: crypto.randomUUID(),
        menuItemId: item.id,
        menuItemCode: item.code,
        name: item.name,
        price: item.price,
        taxRate: item.taxRate,
        prepStation: item.prepStation,
        quantity: 1,
        sourceSystem: posSource,
        itemType: item.itemType,
        finishedGoodCode: item.finishedGoodCode,
        bom: item.bom
      }];
    });
  };

  const updateQuantity = (cartItemId: string, delta: number) => {
    setCart(prev => prev.map(ci => {
      if (ci.id === cartItemId) {
        const newQty = Math.max(0, ci.quantity + delta);
        return { ...ci, quantity: newQty };
      }
      return ci;
    }).filter(ci => ci.quantity > 0));
  };

  const removeCartItem = (cartItemId: string) => {
    setCart(prev => prev.filter(ci => ci.id !== cartItemId));
  };

  const clearCart = (skipConfirm: boolean = false) => {
    if (skipConfirm === true || window.confirm("Clear the entire cart?")) {
      setCart([]);
      setGlobalDiscountStr('');
      setPaymentMethod('');
      setCustomerName('');
      setCustomerPhone('');
      setTableNumber('');
      setOrderType('DINE_IN');
    }
  };

  const cartTotals = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;
    
    cart.forEach(item => {
      const lineSub = item.price * item.quantity;
      const lineTax = lineSub * (item.taxRate / 100);
      subtotal += lineSub;
      taxTotal += lineTax;
    });

    let discount = Number(globalDiscountStr) || 0;
    if (discount < 0) discount = 0;
    
    // Prevent discount > total
    if (discount > subtotal + taxTotal) {
      discount = subtotal + taxTotal;
    }

    const grandTotal = subtotal + taxTotal - discount;

    return { subtotal, taxTotal, discount, grandTotal };
  }, [cart, globalDiscountStr]);

  const handleCheckout = async () => {
    if (!staffProfile || !auth.currentUser) return;
    if (cart.length === 0) return alert("Cart is empty");
    if (!selectedStoreId) return alert("Please select a store");
    if (!paymentMethod) return alert("Please select a payment method");
    if (orderType === 'DINE_IN' && !tableNumber.trim()) return alert("Table number is required for DINE IN");
    
    setIsSaving(true);
    
    try {
      const selectedStore = stores.find(s => s.id === selectedStoreId);
      if (!selectedStore) throw new Error("Store not found");

      // Verify menu items exist and are still active/available, and compute true totals
      let trueSubtotal = 0;
      let trueTaxTotal = 0;
      
      for (const item of cart) {
        const liveItem = menuItems.find(mi => mi.id === item.menuItemId && mi.isActive && mi.availableStoreIds.includes(selectedStoreId));
        if (!liveItem) {
          throw new Error(`Menu item ${item.name} is no longer available at this store.`);
        }
        const lineSub = liveItem.price * item.quantity;
        const lineTax = lineSub * (liveItem.taxRate / 100);
        trueSubtotal += lineSub;
        trueTaxTotal += lineTax;
      }

      let trueDiscount = Number(globalDiscountStr) || 0;
      if (trueDiscount < 0) trueDiscount = 0;
      if (trueDiscount > trueSubtotal + trueTaxTotal) trueDiscount = trueSubtotal + trueTaxTotal;
      const trueGrandTotal = trueSubtotal + trueTaxTotal - trueDiscount;

      if (paymentMethod === 'COMPLIMENTARY' && trueGrandTotal > 0) {
        if (!window.confirm(`This order is COMPLIMENTARY but has a total of ₹${trueGrandTotal.toFixed(2)}. Proceed?`)) {
          setIsSaving(false);
          return;
        }
      }

      // Detailed Checkout Logging
      if (import.meta.env.DEV) console.log(`[CHECKOUT START] User: ${auth.currentUser.uid}, Role: ${staffProfile.role}, Store: ${selectedStoreId}, Phone: ${customerPhone}`);
      
      // Check customer
      let customerId: string | null = null;
      let customerNameFinal = customerName.trim() || null;
      let existingCustomerDocs: any[] = [];
      const phoneToSearch = customerPhone.trim();
      
      if (phoneToSearch) {
        try {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Fetching customer with phone: ${phoneToSearch}`);
          const q = query(collection(db, 'customers'), where('phone', '==', phoneToSearch));
          const custSnap = await getDocs(q);
          if (!custSnap.empty) {
            existingCustomerDocs = custSnap.docs;
            if (import.meta.env.DEV) console.log(`[CHECKOUT] Found existing customer: ${existingCustomerDocs[0].id}`);
          }
        } catch (e: any) {
          console.error(`[CHECKOUT ERROR] Customers getDocs failed:`, e);
          throw e; // fail early for logging
        }
      }

      const custRef = existingCustomerDocs.length > 0 
        ? doc(db, 'customers', existingCustomerDocs[0].id) 
        : phoneToSearch ? doc(collection(db, 'customers')) : null;

      // 10. Generate order number & save transaction
      const dateKey = new Date().toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD
      const counterId = `${selectedStore.code}_${dateKey}`;
      const counterRef = doc(db, 'counters', counterId);
      const newOrderRef = doc(collection(db, 'orders'));

      if (import.meta.env.DEV) console.log(`[CHECKOUT] Preflight complete. target counter: ${counterId}, order: ${newOrderRef.id}`);

      const reqStock: Record<string, { id: string, name: string, unit: string, qty: number, type: string, code: string }> = {};
      const missingRecipes: string[] = []; // for dev logs
      const allowMissingRecipeCheckout = import.meta.env.DEV && import.meta.env.VITE_ALLOW_MISSING_RECIPE_CHECKOUT === 'true';
      
      if (posSource === 'FINISHED_GOODS') {
        for (const item of cart) {
          if (item.itemType === 'NO_STOCK') continue;
          
          if (item.itemType === 'MADE_TO_ORDER' || (item.itemType === 'DIRECT_STOCK' && item.bom && item.bom.length > 0)) {
            // Deduct BOM
            if (!item.bom || item.bom.length === 0) {
               missingRecipes.push(item.name);
               continue;
            }
            item.bom.forEach((line: any) => {
              const code = line.componentCode;
              const type = line.componentType;
              let stockId = `${selectedStoreId}_${type}_${code}`;

              if (!reqStock[stockId]) {
                 reqStock[stockId] = { id: stockId, name: line.componentName, unit: line.uom, qty: 0, type, code };
              }
              reqStock[stockId].qty += (line.quantity * item.quantity);
            });
          } else if (item.itemType === 'DIRECT_STOCK') {
            // Deduct directly
            const stockId = `${selectedStoreId}_FINISHED_GOOD_${item.menuItemCode}`;
            if (!reqStock[stockId]) {
              reqStock[stockId] = { id: stockId, name: item.name, unit: 'pcs', qty: 0, type: 'FINISHED_GOOD', code: item.menuItemCode };
            }
            reqStock[stockId].qty += item.quantity;
          }
        }
      } else {
        const allRecipesSnap = await getDocs(collection(db, 'recipes'));
        const activeRecipes = allRecipesSnap.docs.map(d => d.data()).filter(r => r.isActive);
        
        for (const item of cart) {
          // Find recipes for this menu item
          const matchingRecipes = activeRecipes.filter(r => r.menuItemCode === item.menuItemCode);
          if (matchingRecipes.length > 0) {
            matchingRecipes.forEach(rec => {
               const recipeItems = rec.recipeItems || [];
               for (const ri of recipeItems) {
                  const invCode = ri.inventoryItemCode || ri.inventoryItemId; 
                  if (!invCode) continue;
                  const stockId = `${selectedStoreId}_${invCode}`;
                  if (!reqStock[stockId]) {
                     reqStock[stockId] = { id: stockId, name: ri.inventoryItemName, unit: ri.unit, qty: 0, type: 'LEGACY', code: invCode };
                  }
                  reqStock[stockId].qty += (ri.quantity * item.quantity);
               }
            });
          } else {
            missingRecipes.push(item.name);
          }
        }
      }

      if (missingRecipes.length > 0) {
        const message = `Checkout blocked. These items require inventory deduction but have no recipe/BOM mapped: ${missingRecipes.join(', ')}. Add the missing recipe/BOM or mark the item as No Stock before selling.`;
        if (!allowMissingRecipeCheckout) {
          throw new Error(message);
        }
        console.warn(`[CHECKOUT DEV BYPASS] ${message}`);
      }

      const { sequence, savedOrder, savedItems, savedPayment } = await runTransaction(db, async (transaction) => {
        // --- READ PHASE ONLY ---
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: get counter`);
        const counterDoc = await transaction.get(counterRef);
        
        let custDoc: any = null;
        if (custRef) {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: get customer doc`);
          custDoc = await transaction.get(custRef);
        }
        
        // Fetch current stock
        const stockDocsMap: Record<string, any> = {};
        for (const stockKey of Object.keys(reqStock)) {
           const req = reqStock[stockKey];
           
           let stockRef;
           if (posSource === 'FINISHED_GOODS') {
              if (req.type === 'PACKAGING') {
                 // Try packaging first, if not found (we can't easily fallback inside a transaction optimally without complex logic, so we will just use the exact ID we specified or RAW_INGREDIENT)
                 stockRef = doc(db, 'storeStock', `${selectedStoreId}_PACKAGING_${req.code}`);
              } else {
                 stockRef = doc(db, 'storeStock', stockKey);
              }
           } else {
              stockRef = doc(db, 'storeInventory', stockKey);
           }
           
           let stockDoc = await transaction.get(stockRef);
           
           if (posSource === 'FINISHED_GOODS' && req.type === 'PACKAGING' && !stockDoc.exists()) {
              stockRef = doc(db, 'storeStock', `${selectedStoreId}_RAW_INGREDIENT_${req.code}`);
              stockDoc = await transaction.get(stockRef);
           }

           if (!stockDoc.exists()) {
              throw new Error(`Insufficient stock: ${req.name} required ${req.qty.toFixed(2)}${req.unit}, available 0.00${req.unit}.`);
           }
           
           const currentStock = (stockDoc.data() as any).currentStock || 0;
           if (currentStock < req.qty) {
              throw new Error(`Insufficient stock: ${req.name} required ${req.qty.toFixed(2)}${req.unit}, available ${currentStock.toFixed(2)}${req.unit}.`);
           }
           
           stockDocsMap[stockKey] = { ref: stockRef, currentStock };
        }
        
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction read phase complete`);

        // --- VALIDATION PHASE ---
        let seq = 1;
        if (counterDoc.exists()) {
          seq = (counterDoc.data()?.lastSequence || 0) + 1;
        }

        const orderNumber = `CB-${selectedStore.code}-${dateKey}-${seq.toString().padStart(4, '0')}`;
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction validation complete - order number generated: ${orderNumber}`);
        
        // --- WRITE PHASE ONLY ---
        
        // Inventory Deduction Writes
        for (const stockKey of Object.keys(reqStock)) {
           const { ref, currentStock } = stockDocsMap[stockKey] as { ref: any, currentStock: number };
           const req = reqStock[stockKey];
           const deduction = req.qty;
           
           transaction.update(ref, {
              currentStock: currentStock - deduction,
              updatedAt: serverTimestamp()
           });
           
           // movement record
           const moveRef = doc(collection(db, 'stockMovements'));
           
           const movementData: any = {
              storeId: selectedStore.id,
              storeName: selectedStore.name,
              inventoryItemId: req.code,
              inventoryItemName: req.name,
              movementType: 'SALE_DEDUCTION',
              quantity: -deduction,
              unit: req.unit,
              referenceType: 'ORDER',
              referenceId: newOrderRef.id,
              notes: `Order ${orderNumber}`,
              createdByUserId: auth.currentUser!.uid,
              createdByName: staffProfile.name,
              createdAt: serverTimestamp()
           };

           if (posSource === 'FINISHED_GOODS') {
             movementData.stockSystem = 'MENU_MANAGEMENT';
             movementData.stockItemType = req.type === 'PACKAGING' ? (ref.id.includes('RAW_INGREDIENT') ? 'RAW_INGREDIENT' : 'PACKAGING') : req.type;
             movementData.stockItemCode = req.code;
           }

           transaction.set(moveRef, movementData);
        }
        if (counterDoc.exists()) {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: updating counter to ${seq}`);
          transaction.update(counterRef, { lastSequence: seq, updatedAt: serverTimestamp() });
        } else {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: creating counter at ${seq}`);
          transaction.set(counterRef, { storeCode: selectedStore.code, dateKey, lastSequence: seq, updatedAt: serverTimestamp() });
        }

        // Prepare customer updates
        if (custRef) {
          if (custDoc && custDoc.exists()) {
             if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: update customer`);
            const data = custDoc.data();
            transaction.update(custRef, {
              visitCount: (data.visitCount || 0) + 1,
              totalSpend: (data.totalSpend || 0) + trueGrandTotal,
              lastVisitAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              ...(customerNameFinal && { name: customerNameFinal })
            });
            if (!customerNameFinal && data.name) customerNameFinal = data.name;
          } else {
            if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: create customer`);
            transaction.set(custRef, {
              name: customerNameFinal || 'Unknown',
              phone: phoneToSearch,
              visitCount: 1,
              totalSpend: trueGrandTotal,
              lastVisitAt: serverTimestamp(),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          }
          customerId = custRef.id;
        }

        const paymentStatus = (paymentMethod === 'CREDIT' && trueGrandTotal > 0) ? 'UNPAID' : 'PAID';

        const orderData: Order = {
          orderNumber,
          storeId: selectedStore.id,
          storeCode: selectedStore.code,
          storeName: selectedStore.name,
          customerId,
          customerName: customerNameFinal,
          customerPhone: phoneToSearch || null,
          createdByUserId: auth.currentUser!.uid,
          createdByName: staffProfile.name,
          orderType,
          status: 'COMPLETED',
          paymentStatus,
          tableNumber: tableNumber.trim() || null,
          subtotal: trueSubtotal,
          taxTotal: trueTaxTotal,
          discountTotal: trueDiscount,
          grandTotal: trueGrandTotal,
          paymentMethod: paymentMethod as PaymentMethod,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving order data...`);
        transaction.set(newOrderRef, orderData);

        // Prep line items
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving line items...`);
        const newItems: OrderItem[] = [];
        cart.forEach(item => {
          const liveItem = menuItems.find(mi => mi.id === item.menuItemId)!;
          const lineRef = doc(collection(newOrderRef, 'items'));
          const lineSub = liveItem.price * item.quantity;
          const lineTax = lineSub * (liveItem.taxRate / 100);
          
          const itemData: OrderItem = {
            menuItemId: liveItem.id,
            itemName: liveItem.name,
            itemCode: liveItem.code,
            categoryId: liveItem.categoryId,
            categoryName: liveItem.categoryName,
            quantity: item.quantity,
            unitPrice: liveItem.price,
            taxRate: liveItem.taxRate,
            lineSubtotal: lineSub,
            lineTax: lineTax,
            lineTotal: lineSub + lineTax,
            prepStation: liveItem.prepStation,
            status: 'PENDING',
            createdAt: serverTimestamp(),
            sourceSystem: item.sourceSystem || 'LEGACY_MENU_ITEMS',
            itemType: item.itemType,
            finishedGoodCode: item.finishedGoodCode
          };
          
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: set lineItem ${lineRef.id}`);
          transaction.set(lineRef, itemData);
          newItems.push({ id: lineRef.id, ...itemData });

          // Create KOT items
          const createKotItem = (station: "BARISTA" | "KITCHEN") => {
            const kotRef = doc(collection(db, 'kotItems'));
            if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: set kotItem ${kotRef.id} for station: ${station}`);
            transaction.set(kotRef, {
              orderId: newOrderRef.id,
              orderNumber,
              orderItemId: lineRef.id,
              storeId: selectedStore.id,
              storeCode: selectedStore.code,
              storeName: selectedStore.name,
              station,
              itemName: liveItem.name,
              itemCode: liveItem.code || '',
              quantity: item.quantity,
              orderType,
              tableNumber: orderType === 'DINE_IN' ? tableNumber.trim() : null,
              customerName: customerNameFinal,
              status: "PENDING",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              createdByUserId: auth.currentUser!.uid,
              createdByName: staffProfile.name
            });
          };

          if (liveItem.prepStation === "BARISTA" || liveItem.prepStation === "BOTH") {
            createKotItem("BARISTA");
          }
          if (liveItem.prepStation === "KITCHEN" || liveItem.prepStation === "BOTH") {
            createKotItem("KITCHEN");
          }
        });

        // Prep payment
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving payment data...`);
        const paymentRef = doc(collection(newOrderRef, 'payments'));
        const paymentData: OrderPayment = {
          method: paymentMethod as PaymentMethod,
          amount: paymentStatus === 'PAID' ? trueGrandTotal : 0,
          reference: null,
          createdAt: serverTimestamp()
        };
        transaction.set(paymentRef, paymentData);
        
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction write phase complete`);

        return { sequence: seq, savedOrder: { id: newOrderRef.id, ...orderData }, savedItems: newItems, savedPayment: { id: paymentRef.id, ...paymentData } };
      });

      if (import.meta.env.DEV) console.log(`[CHECKOUT] Success`);

      // Show receipt
      setCompletedOrder({
        order: savedOrder,
        items: savedItems,
        payment: savedPayment,
        storeName: selectedStore.name
      });
      clearCart(true); // pass true to skip confirmation on submit
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Error saving order');
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#5c4033]" />
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-neutral-500">
        <div>
          <SearchX size={48} className="mx-auto mb-4 opacity-50" />
          <h2 className="text-xl font-bold mb-2">No Active Stores</h2>
          <p>You do not have access to any active stores, or none exist in the system.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden relative w-full min-w-0 h-[100dvh] lg:h-[calc(100vh-64px)] pb-[env(safe-area-inset-bottom)] lg:pb-0">

      {/* Desktop Category Rail (Hidden on Mobile) */}
      <div className="hidden lg:flex flex-col w-[180px] shrink-0 bg-white border-r border-neutral-200 z-10">
        <div className="p-4 border-b border-neutral-100 bg-[#faf8f5]">
          <h2 className="font-black text-neutral-800 tracking-tight">Categories</h2>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          <button
            onClick={() => setSelectedCategoryId('ALL')}
            className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-bold transition-colors flex items-center justify-between group ${selectedCategoryId === 'ALL' ? 'bg-[#5c4033] text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            <span>All Items</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-md transition-colors ${selectedCategoryId === 'ALL' ? 'bg-white/20 text-white' : 'bg-neutral-200 text-neutral-500 group-hover:bg-neutral-300'}`}>
              {menuItems.filter(i => i.availableStoreIds?.includes(selectedStoreId)).length}
            </span>
          </button>
          {displayCategories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategoryId(cat.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-bold transition-colors leading-snug flex items-center justify-between group ${selectedCategoryId === cat.id ? 'bg-[#5c4033] text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100'}`}
            >
              <span className="flex-1 mr-2">{cat.name}</span>
              {(cat as any).count !== undefined && (
                <span className={`text-xs px-1.5 py-0.5 rounded-md transition-colors shrink-0 ${selectedCategoryId === cat.id ? 'bg-white/20 text-white' : 'bg-neutral-200 text-neutral-500 group-hover:bg-neutral-300'}`}>
                  {(cat as any).count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Center Area: Menu & Navigation */}
      <div className="flex flex-col bg-[#f9f5f0] overflow-hidden flex-1 w-full min-w-0">
        {/* Top Header */}
        <div className="bg-white border-b border-neutral-200 px-4 py-3 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 shadow-sm z-10 basis-auto shrink-0 relative">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 lg:hidden bg-[#5c4033] rounded-lg flex items-center justify-center text-[#f9f5f0] shrink-0">
              <Coffee size={18} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col gap-1">
               <div className="flex items-center gap-2">
                 <StoreIcon size={18} className="text-[#5c4033] hidden lg:block" />
                 <select
                   value={selectedStoreId}
                   onChange={handleStoreChange}
                   className="bg-neutral-50 border border-neutral-200 text-neutral-800 font-bold px-3 py-1.5 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none text-sm max-w-[140px] sm:max-w-xs"
                 >
                   {stores.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
                 </select>
               </div>
               <div className="flex flex-col">
                 {posSource === 'FINISHED_GOODS' ? (
                    <span className="text-[8px] sm:text-[9px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded self-start">
                      Menu Management POS
                    </span>
                 ) : isAdmin ? (
                    <span className="text-[8px] sm:text-[9px] font-bold uppercase tracking-wider text-neutral-500 bg-neutral-100 border border-neutral-200 px-1.5 py-0.5 rounded self-start">
                      Classic POS Source
                    </span>
                 ) : null}
               </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex bg-neutral-100 p-1 rounded-lg w-full sm:w-auto overflow-x-auto custom-scrollbar">
              {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as OrderType[]).map(type => (
                <button
                  key={type}
                  onClick={() => setOrderType(type)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-all ${orderType === type ? 'bg-[#5c4033] text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200/50'}`}
                >
                  {type === 'DINE_IN' ? 'DINE IN' : type === 'TAKEAWAY' ? 'TAKEAWAY' : 'DELIVERY'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Categories Mobile Dropdown */}
        <div className="lg:hidden bg-white border-b border-neutral-200 px-4 py-3 flex items-center gap-3 shrink-0">
          <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest shrink-0">Category</label>
          <select
            value={selectedCategoryId}
            onChange={e => setSelectedCategoryId(e.target.value)}
            className="flex-1 bg-neutral-50 border border-neutral-200 text-neutral-800 font-bold px-3 py-2 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none text-sm"
          >
            <option value="ALL">All Items ({menuItems.filter(i => i.availableStoreIds?.includes(selectedStoreId)).length})</option>
            {displayCategories.map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.name} {(cat as any).count !== undefined ? `(${(cat as any).count})` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* DEV Debug Panel */}
        {import.meta.env.DEV && posSource === 'FINISHED_GOODS' && debugCounts && (
          <div className="mx-4 mt-4 bg-blue-50 border border-blue-200 p-3 rounded-xl shadow-sm text-xs text-blue-900 grid grid-cols-2 md:grid-cols-4 gap-2 xl:grid-cols-6 items-center text-center">
             <div className="flex flex-col"><span className="font-bold">Total Finished Goods</span><span>{debugCounts.total}</span></div>
             <div className="flex flex-col"><span className="font-bold">Unique Categories</span><span>{displayCategories.length}</span></div>
             <div className="flex flex-col"><span className="font-bold">Current Category</span><span className="truncate" title={selectedCategoryId}>{selectedCategoryId}</span></div>
             <div className="flex flex-col"><span className="font-bold">Visible Items</span><span>{filteredMenuItems.length}</span></div>
             <div className="flex flex-col"><span className="font-bold">Active/Sellable</span><span>{debugCounts.activeCount}/{debugCounts.sellableCount}</span></div>
             <div className="flex flex-col"><span className="font-bold">Store Available</span><span>{menuItems.filter(i => i.availableStoreIds?.includes(selectedStoreId)).length}</span></div>
          </div>
        )}

        {/* Search & Items Grid */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col">
          <div className="relative mb-4 shrink-0">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input 
              type="text"
              placeholder="Search menu..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white border border-neutral-200 rounded-xl shadow-sm focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none font-medium"
            />
          </div>

          <div className="flex-1">
            {menuItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-neutral-400 p-6 text-center">
                <AlertCircle size={48} className="mb-4 opacity-30 text-amber-500" />
                <p className="font-bold text-lg text-neutral-600 mb-2">No active menu items found</p>
                <p className="text-sm border border-neutral-200 bg-white p-3 rounded-xl shadow-sm text-neutral-600 max-w-sm">
                  Go to <strong>Admin &rarr; Menu Import</strong> and click <strong>Restore All Menu Items Active</strong>.
                </p>
              </div>
            ) : filteredMenuItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-neutral-400 p-6 text-center">
                <Coffee size={48} className="mb-4 opacity-30 text-[#5c4033]" />
                <p className="font-medium text-lg text-neutral-600 mb-2">No items found</p>
                {posSource === 'FINISHED_GOODS' ? (
                  <p className="text-sm text-amber-700 bg-amber-50 p-4 border border-amber-200 rounded-xl max-w-md">
                    No Finished Goods are available for this store. Check <strong>Finished Goods &rarr; POS Visibility</strong>.
                  </p>
                ) : (
                  <p className="text-sm bg-neutral-50 px-4 py-2 rounded-xl">Try changing category or search terms.</p>
                )}
              </div>
            ) : (
              <div className="pb-32 lg:pb-4">
                {(() => {
                  const renderMenuItem = (item: any) => (
                    <motion.button
                      key={item.id}
                      whileHover={{ scale: 1.025, y: -2 }}
                      whileTap={{ scale: 0.975 }}
                      onClick={() => addToCart(item)}
                      className="bg-white border border-neutral-200 hover:border-[#5c4033]/40 p-4 rounded-xl shadow-sm hover:shadow-md active:scale-95 transition-all text-left flex flex-col h-full cursor-pointer"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                          item.prepStation === 'BARISTA' ? 'bg-amber-100 text-amber-800' :
                          item.prepStation === 'KITCHEN' ? 'bg-blue-100 text-blue-800' :
                          item.prepStation === 'BOTH' ? 'bg-purple-100 text-purple-800' :
                          'bg-neutral-100 text-neutral-500'
                        }`}>
                          {item.prepStation === 'NONE' ? 'NO KOT' : item.prepStation}
                        </span>
                      </div>
                      <h4 className="font-bold text-neutral-800 leading-tight mb-auto">{item.name}</h4>
                      <p className="text-[#5c4033] font-bold mt-3 text-lg font-mono">₹{item.price}</p>
                    </motion.button>
                  );

                  if (posSource === 'FINISHED_GOODS' && selectedCategoryId !== 'ALL') {
                    const grouped = new Map<string, any[]>();
                    const sortedSubcats = new Map<string, {name: string, order: number}>();
                    
                    filteredMenuItems.forEach((item: any) => {
                      const subCode = item.subcategoryCode || 'MISC';
                      const subName = item.subcategoryName || 'Other';
                      const subOrder = typeof item.subcategorySortOrder === 'number' ? item.subcategorySortOrder : 999;
                      if (!grouped.has(subCode)) {
                        grouped.set(subCode, []);
                        sortedSubcats.set(subCode, { name: subName, order: subOrder });
                      }
                      grouped.get(subCode)!.push(item);
                    });

                    const sortedSubCodes = Array.from(sortedSubcats.keys()).sort((a, b) => {
                      return sortedSubcats.get(a)!.order - sortedSubcats.get(b)!.order;
                    });

                    return sortedSubCodes.map(subCode => (
                      <div key={subCode} className="mb-6 last:mb-0">
                        {sortedSubcats.get(subCode)!.name && sortedSubcats.get(subCode)!.name !== 'Misc' && sortedSubcats.get(subCode)!.name !== 'Other' && (
                          <h3 className="text-sm font-bold text-neutral-500 uppercase tracking-wider mb-3 px-1">{sortedSubcats.get(subCode)!.name}</h3>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
                          {grouped.get(subCode)!.map(renderMenuItem)}
                        </div>
                      </div>
                    ));
                  }

                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
                      {filteredMenuItems.map(renderMenuItem)}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Area: Cart Panel */}
      <div className={`lg:w-[360px] xl:w-[400px] shrink-0 bg-white border-l border-neutral-200 flex flex-col z-[100] lg:z-20 fixed lg:static inset-0 lg:inset-auto w-full h-[100dvh] lg:h-full transition-transform duration-300 transform overflow-hidden ${isMobileCartOpen ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'}`}>
           
        {/* Cart Header */}
        <div className="p-4 pl-4 pr-3 border-b border-neutral-100 bg-[#faf8f5] shrink-0 sticky lg:static top-0 z-20 w-full">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-black text-neutral-800">Current Order</h3>
            <div className="flex items-center gap-2">
              {cart.length > 0 && (
                <button onClick={() => clearCart()} className="text-xs font-bold text-red-500 hover:bg-red-50 px-2 py-2 md:py-1 rounded transition-colors uppercase tracking-wider">
                  Clear Cart
                </button>
              )}
              <button onClick={() => setIsMobileCartOpen(false)} className="lg:hidden p-1.5 bg-neutral-200 text-neutral-600 hover:bg-neutral-300 rounded-full font-bold transition-colors">
                <X size={20} />
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable Body (Mobile) / Flex Container (Desktop) */}
        <div className="flex-1 overflow-y-auto lg:overflow-hidden flex flex-col w-full pb-28 lg:pb-0 custom-scrollbar min-h-0">
          
          {/* Order Details Inputs */}
          <div className="p-4 border-b border-neutral-100 bg-[#faf8f5] shrink-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {orderType === 'DINE_IN' && (
                <div className="col-span-1 sm:col-span-2 flex items-center gap-2 bg-white px-3 py-3 lg:py-2 border border-neutral-200 rounded-lg min-h-[44px]">
                  <MapPin size={16} className="text-neutral-400" />
                  <input 
                    type="text" 
                    placeholder="Table Number" 
                    value={tableNumber} 
                    onChange={e => setTableNumber(e.target.value)}
                    className="bg-transparent outline-none w-full font-medium placeholder-neutral-400"
                  />
                </div>
              )}
              <div className={`flex items-center gap-2 bg-white px-3 py-3 lg:py-2 border border-neutral-200 rounded-lg min-h-[44px] ${orderType !== 'DINE_IN' ? 'col-span-1 sm:col-span-2' : ''}`}>
                <User size={16} className="text-neutral-400 shrink-0" />
                <input 
                  type="text" 
                  placeholder="Name" 
                  value={customerName} 
                  onChange={e => setCustomerName(e.target.value)}
                  className="bg-transparent outline-none w-full font-medium placeholder-neutral-400"
                />
              </div>
              <div className={`flex items-center gap-2 bg-white px-3 py-3 lg:py-2 border border-neutral-200 rounded-lg min-h-[44px] ${orderType !== 'DINE_IN' ? 'col-span-1 sm:col-span-2' : ''}`}>
                <Phone size={16} className="text-neutral-400 shrink-0" />
                <input 
                  type="tel" 
                  placeholder="Phone" 
                  value={customerPhone} 
                  onChange={e => setCustomerPhone(e.target.value)}
                  className="bg-transparent outline-none w-full font-medium placeholder-neutral-400"
                />
              </div>
            </div>
          </div>

          {/* Cart Items List */}
          <div className="shrink-0 lg:flex-1 lg:overflow-y-auto custom-scrollbar p-4 space-y-3 min-h-max lg:min-h-0">
            {cart.length === 0 ? (
              <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center opacity-50 py-10">
                <div className="w-16 h-16 border-2 border-dashed border-neutral-400 rounded-full flex items-center justify-center mb-3">
                  <Coffee size={24} className="text-neutral-400" />
                </div>
                <p className="font-bold text-neutral-500">Cart is empty</p>
                <p className="text-sm text-neutral-400">Select items to start order</p>
              </div>
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {cart.map(item => (
                    <motion.div 
                      key={item.id} 
                      layout
                      initial={{ opacity: 0, x: 20, height: 0 }}
                      animate={{ opacity: 1, x: 0, height: "auto" }}
                      exit={{ opacity: 0, x: -20, height: 0 }}
                      transition={{ type: "spring" as const, stiffness: 500, damping: 40 }}
                      className="flex justify-between items-center py-2 border-b border-neutral-100 last:border-0 group gap-3 min-w-0"
                    >
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="font-bold text-neutral-800 text-sm line-clamp-2 leading-snug break-words">{item.name}</span>
                        <p className="text-xs text-neutral-400 font-mono mt-0.5">₹{item.price} each</p>
                      </div>
                      <div className="flex flex-col items-end shrink-0">
                        <span className="font-mono text-sm font-bold text-neutral-800 mb-1.5">
                          ₹{(item.price * item.quantity).toFixed(2)}
                        </span>
                        <div className="flex items-center gap-1.5 flex-nowrap">
                          <button onClick={() => updateQuantity(item.id, -1)} className="p-1.5 bg-neutral-100 hover:bg-neutral-200 rounded-md text-neutral-600 transition-colors flex items-center justify-center cursor-pointer">
                            {item.quantity === 1 ? <Trash2 size={14} className="text-red-500" /> : <Minus size={14} />}
                          </button>
                          <span className="font-mono font-bold w-6 text-center text-sm">{item.quantity}</span>
                          <button onClick={() => updateQuantity(item.id, 1)} className="p-1.5 bg-[#5c4033]/10 hover:bg-[#5c4033]/20 rounded-md text-[#5c4033] transition-colors flex items-center justify-center cursor-pointer">
                            <Plus size={14} />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* Cart Footer (Totals & Payments) */}
          <div className="bg-white border-t border-neutral-200 flex flex-col shrink-0 lg:bg-neutral-50 shadow-[0_-4px_15px_rgba(0,0,0,0.05)] lg:shadow-none mt-auto lg:mt-0">
            <div className="px-4 lg:px-5 py-3 lg:py-4 space-y-2">
              <div className="flex justify-between text-sm font-medium text-neutral-500">
                <span>Subtotal</span>
                <span className="font-mono">₹{cartTotals.subtotal.toFixed(2)}</span>
              </div>
              
              <div className="flex justify-between items-center text-sm font-medium text-neutral-500">
                <span>Discount (₹)</span>
                <input
                  type="number"
                  min="0"
                  value={globalDiscountStr}
                  onChange={e => setGlobalDiscountStr(e.target.value)}
                  className="w-20 text-right bg-white lg:bg-white border border-neutral-200 rounded px-2 py-1 font-mono outline-none focus:border-[#5c4033]"
                  placeholder="0"
                />
              </div>
              
              <div className="flex justify-between text-sm font-medium text-neutral-500">
                <span>Taxes</span>
                <span className="font-mono">₹{cartTotals.taxTotal.toFixed(2)}</span>
              </div>

              <div className="h-px bg-neutral-200 my-2" />
              
              <div className="flex justify-between items-end gap-2">
                <span className="font-black text-lg text-neutral-800 shrink-0">Total</span>
                <span className="font-black font-mono text-2xl text-[#3e2723] break-all text-right">₹{cartTotals.grandTotal.toFixed(2)}</span>
              </div>
            </div>

            <div className="px-4 pb-4">
              <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2">Payment Method</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 lg:mb-4">
                {(['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY'] as PaymentMethod[]).map(method => (
                  <button
                    key={method}
                    onClick={() => setPaymentMethod(method)}
                    className={`py-3 lg:py-2 px-1 text-[11px] lg:text-[10px] font-bold uppercase rounded-xl lg:rounded-md border transition-all h-full min-h-[44px] ${
                      paymentMethod === method 
                        ? 'bg-[#5c4033] border-[#5c4033] text-white shadow-sm' 
                        : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                    }`}
                  >
                    <span className="truncate block mx-auto -tracking-wider uppercase">
                      {method === 'COMPLIMENTARY' ? 'COMP' : method}
                    </span>
                  </button>
                ))}
              </div>

              {/* Desktop ONLY Order button (Mobile has sticky footer) */}
              <div className="hidden lg:block">
                <button
                  disabled={cart.length === 0 || isSaving}
                  className={`w-full py-4 rounded-xl font-black uppercase tracking-widest text-sm transition-all shadow-sm ${
                    (cart.length > 0 && !isSaving)
                      ? 'bg-[#3e2723] hover:bg-[#2d1c19] text-[#f9f5f0] hover:shadow-md active:scale-[0.99]' 
                      : 'bg-neutral-200 text-neutral-400 cursor-not-allowed'
                  }`}
                  onClick={handleCheckout}
                >
                  {isSaving ? <Loader2 size={20} className="animate-spin mx-auto text-[#5c4033]" /> : 'Order & Pay'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile ONLY Sticky Checkout Footer */}
      {isMobileCartOpen && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-neutral-200 z-[120] shadow-[0_-4px_15px_rgba(0,0,0,0.05)]" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button
            disabled={cart.length === 0 || isSaving}
            className={`w-full py-4 rounded-xl font-black uppercase tracking-widest text-sm transition-all shadow-[0_4px_14px_rgba(0,0,0,0.15)] ${
              (cart.length > 0 && !isSaving)
                ? 'bg-[#3e2723] hover:bg-[#2d1c19] text-[#f9f5f0] hover:shadow-md active:scale-[0.99] border border-[#2d1c19]' 
                : 'bg-neutral-200 text-neutral-400 cursor-not-allowed border border-neutral-300'
            }`}
            onClick={handleCheckout}
          >
            {isSaving ? <Loader2 size={20} className="animate-spin mx-auto text-[#5c4033]" /> : (cart.length > 0 ? `Pay ₹${cartTotals.grandTotal.toFixed(2)}` : 'Cart Empty')}
          </button>
        </div>
      )}

      {/* Sticky Mobile Cart Bar */}
      {!isMobileCartOpen && cart.length > 0 && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-neutral-200 p-4 shadow-[0_-4px_15px_rgba(0,0,0,0.05)] z-30 pb-[calc(1rem+env(safe-area-inset-bottom))]">
           <button onClick={() => setIsMobileCartOpen(true)} className="w-full bg-[#3e2723] hover:bg-[#2d1c19] text-white py-3.5 rounded-xl font-black uppercase tracking-widest flex items-center justify-between px-5 shadow-sm transition-colors">
              <span className="flex items-center gap-2">
                <span className="bg-white/20 px-2.5 py-1 rounded-md text-xs">{cart.reduce((a,c)=>a+c.quantity, 0)} items</span>
              </span>
              <span className="text-lg">Checkout ₹{cartTotals.grandTotal.toFixed(2)}</span>
           </button>
        </div>
      )}

      {completedOrder && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col max-h-[90vh]">
            <div className="bg-[#5c4033] p-6 text-center text-white shrink-0 relative">
               <CheckCircle size={48} className="mx-auto mb-3 text-emerald-400" />
               <h2 className="text-2xl font-black mb-1 tracking-tight">Order Saved</h2>
               <p className="text-white/80 font-mono text-sm">{completedOrder.order.orderNumber}</p>
            </div>
            
            {/* Printable Receipt Area */}
            <div id="receipt-area" className="p-6 bg-white flex-1 overflow-y-auto custom-scrollbar text-neutral-800 text-sm">
               <div className="text-center mb-6 border-b border-dashed border-neutral-300 pb-6">
                 <h1 className="text-xl font-black uppercase tracking-widest mb-1">Coffee Bond</h1>
                 <p className="font-bold text-neutral-600">{completedOrder.storeName}</p>
                 <p className="text-neutral-500 mt-2 text-xs">{(completedOrder.order.createdAt?.toDate ? completedOrder.order.createdAt.toDate() : new Date()).toLocaleString()}</p>
                 <p className="text-neutral-500 text-xs">Staff: {completedOrder.order.createdByName}</p>
                 {completedOrder.order.customerName && <p className="text-neutral-500 text-xs mt-1">Guest: {completedOrder.order.customerName} {completedOrder.order.customerPhone ? `(${completedOrder.order.customerPhone})` : ''}</p>}
                 <p className="font-bold mt-3 border border-neutral-200 inline-block px-3 py-1 rounded-md">{completedOrder.order.orderType.replace('_', ' ')} {completedOrder.order.tableNumber ? `- Table ${completedOrder.order.tableNumber}` : ''}</p>
               </div>
               
               <div className="space-y-3 mb-6 border-b border-dashed border-neutral-300 pb-6">
                 <div className="flex justify-between font-bold text-xs text-neutral-500 uppercase pb-1 border-b border-neutral-100">
                    <span>Item</span>
                    <span>Total</span>
                 </div>
                 {completedOrder.items.map((item, i) => (
                   <div key={i} className="flex justify-between items-start text-sm">
                     <div>
                       <p className="font-bold leading-tight">{item.itemName}</p>
                       <p className="text-xs text-neutral-500 font-mono">{item.quantity} x ₹{item.unitPrice.toFixed(2)}</p>
                     </div>
                     <span className="font-bold font-mono">₹{item.lineTotal.toFixed(2)}</span>
                   </div>
                 ))}
               </div>
               
               <div className="space-y-2 mb-6 text-sm">
                 <div className="flex justify-between text-neutral-500">
                    <span>Subtotal</span>
                    <span className="font-mono text-neutral-800">₹{completedOrder.order.subtotal.toFixed(2)}</span>
                 </div>
                 {completedOrder.order.discountTotal > 0 && (
                   <div className="flex justify-between text-red-500">
                      <span>Discount</span>
                      <span className="font-mono">-₹{completedOrder.order.discountTotal.toFixed(2)}</span>
                   </div>
                 )}
                 <div className="flex justify-between text-neutral-500 pb-2 border-b border-neutral-100">
                    <span>Taxes</span>
                    <span className="font-mono text-neutral-800">₹{completedOrder.order.taxTotal.toFixed(2)}</span>
                 </div>
                 <div className="flex justify-between font-black text-lg pt-1">
                    <span>Grand Total</span>
                    <span className="font-mono">₹{completedOrder.order.grandTotal.toFixed(2)}</span>
                 </div>
               </div>
               
               <div className="text-center text-xs font-bold text-neutral-500 mb-6">
                 <p>Paid via {completedOrder.order.paymentMethod}</p>
                 <p>{completedOrder.order.paymentStatus}</p>
               </div>
               
               <div className="text-center font-bold text-neutral-400 pt-4 border-t border-dashed border-neutral-300">
                 Thank you! Keep Brewing.
               </div>
            </div>

            <div className="p-4 bg-neutral-50 border-t border-neutral-200 grid grid-cols-2 gap-2 shrink-0">
               <button 
                 onClick={() => {
                   const content = document.getElementById('receipt-area')?.innerHTML;
                   if (content) {
                     const printWin = window.open('', '', 'width=400,height=600');
                     printWin?.document.write(`
                       <html>
                         <head>
                           <title>Print Receipt</title>
                           <style>
                             body { font-family: monospace; padding: 20px; color: #000; }
                             * { margin: 0; padding: 0; box-sizing: border-box; }
                             .text-center { text-align: center; }
                             .flex { display: flex; }
                             .justify-between { justify-content: space-between; }
                             .font-bold { font-weight: bold; }
                             .font-black { font-weight: 900; }
                             .uppercase { text-transform: uppercase; }
                             .mb-1 { margin-bottom: 4px; }
                             .mb-2 { margin-bottom: 8px; }
                             .mb-3 { margin-bottom: 12px; }
                             .mb-6 { margin-bottom: 24px; }
                             .pb-1 { padding-bottom: 4px; }
                             .pb-2 { padding-bottom: 8px; }
                             .pb-6 { padding-bottom: 24px; }
                             .pt-1 { padding-top: 4px; }
                             .pt-4 { padding-top: 16px; }
                             .mt-1 { margin-top: 4px; }
                             .mt-2 { margin-top: 8px; }
                             .mt-3 { margin-top: 12px; }
                             .text-xs { font-size: 10px; }
                             .text-sm { font-size: 12px; }
                             .text-lg { font-size: 18px; }
                             .text-xl { font-size: 20px; }
                             .border-b { border-bottom: 1px solid #ccc; }
                             .border-t { border-top: 1px solid #ccc; }
                             .border-dashed { border-style: dashed; }
                             .text-neutral-500 { color: #666; }
                             .text-neutral-600 { color: #444; }
                             .text-red-500 { color: red; }
                           </style>
                         </head>
                         <body>${content}</body>
                       </html>
                     `);
                     printWin?.document.close();
                     printWin?.focus();
                     printWin?.print();
                     printWin?.close();
                   }
                 }}
                 className="flex items-center justify-center gap-2 bg-white border border-neutral-200 hover:bg-neutral-100 text-neutral-700 font-bold py-3 rounded-xl transition-colors"
               >
                 <Printer size={18} /> Print
               </button>
               <button 
                 onClick={() => setCompletedOrder(null)}
                 className="bg-[#5c4033] hover:bg-[#4a332a] text-white font-bold py-3 rounded-xl transition-colors"
               >
                 New Order
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
