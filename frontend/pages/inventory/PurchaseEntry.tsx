import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  FileText,
  Loader2,
  PackagePlus,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Store as StoreIcon,
  Trash2,
} from 'lucide-react';
import { collection, doc, getDocs, query, serverTimestamp, where, writeBatch } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, StockMovement } from '../../types';
import { PrepItem, RawIngredient, StoreStock } from '../../types/menu-management';

type PurchaseLineType = 'RAW_INGREDIENT' | 'PREP_ITEM';
type ItemOption = {
  id: string;
  itemType: PurchaseLineType;
  code: string;
  name: string;
  baseUnit: string;
  purchaseUnit: string;
  conversionFactor: number;
  currentCost: number;
  raw?: RawIngredient & { id: string };
  prep?: PrepItem & { id: string };
};

type PurchaseLineForm = {
  id: string;
  itemType: PurchaseLineType;
  itemCode: string;
  quantity: string;
  unit: string;
  purchaseCostTotal: string;
  costPerUnit: string;
  notes: string;
};

type PurchaseEntryRecord = {
  id: string;
  storeId: string;
  storeCode?: string;
  storeName: string;
  purchaseDate: string;
  supplierName: string;
  invoiceNumber: string;
  notes?: string;
  totalAmount: number;
  itemCount: number;
  status: 'POSTED';
  createdAt: any;
  createdByName?: string;
  lines?: Array<{
    itemType: PurchaseLineType;
    itemCode: string;
    itemName: string;
    quantity: number;
    stockQuantity: number;
    unit: string;
    stockUnit: string;
    purchaseCostTotal: number;
    costPerUnit: number;
    costPerStockUnit: number;
    notes?: string;
  }>;
  movementIds?: string[];
};

type PreparedLine = {
  option: ItemOption;
  form: PurchaseLineForm;
  quantity: number;
  stockQuantity: number;
  totalCost: number;
  costPerInputUnit: number;
  costPerStockUnit: number;
  unit: string;
  stockId: string;
  existingStock?: StoreStock & { id: string };
};

const ITEM_TYPES: { value: PurchaseLineType; label: string }[] = [
  { value: 'RAW_INGREDIENT', label: 'Raw ingredient' },
  { value: 'PREP_ITEM', label: 'Prep item' },
];

function todayIso(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value: unknown): string {
  return `₹${money(value).toFixed(2)}`;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value: any): string {
  const date = toDate(value);
  return date ? date.toLocaleString() : '-';
}

function stockRowId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

function itemKey(itemType: string, itemCode: string): string {
  return `${itemType}|${itemCode}`;
}

function normalizeUnit(value: string): string {
  return value.trim().toUpperCase();
}

function allowedStoreIds(profile: NonNullable<ReturnType<typeof useAuth>['staffProfile']>): string[] {
  return profile.assignedStoreIds?.length ? profile.assignedStoreIds : (profile.storeIds || []);
}

function newLine(defaultType: PurchaseLineType = 'RAW_INGREDIENT'): PurchaseLineForm {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    itemType: defaultType,
    itemCode: '',
    quantity: '',
    unit: '',
    purchaseCostTotal: '',
    costPerUnit: '',
    notes: '',
  };
}

export default function PurchaseEntry() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayIso());
  const [supplierName, setSupplierName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [lines, setLines] = useState<PurchaseLineForm[]>([newLine()]);
  const [rawIngredients, setRawIngredients] = useState<(RawIngredient & { id: string })[]>([]);
  const [prepItems, setPrepItems] = useState<(PrepItem & { id: string })[]>([]);
  const [storeStock, setStoreStock] = useState<(StoreStock & { id: string })[]>([]);
  const [recentPurchases, setRecentPurchases] = useState<PurchaseEntryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<string | null>(null);

  const hasAccess = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';

  const accessibleStores = useMemo(() => {
    if (!staffProfile) return [];
    if (staffProfile.role === 'ADMIN') return stores;
    const ids = allowedStoreIds(staffProfile);
    return stores.filter((store) => ids.includes(store.id));
  }, [staffProfile, stores]);

  const selectedStore = useMemo(
    () => accessibleStores.find((store) => store.id === selectedStoreId) || null,
    [accessibleStores, selectedStoreId],
  );

  const stockByKey = useMemo(() => (
    new Map(storeStock.map((stock) => [itemKey(stock.stockItemType, stock.stockItemCode), stock]))
  ), [storeStock]);

  const itemOptions = useMemo<ItemOption[]>(() => {
    const rawOptions = rawIngredients
      .filter((item) => item.isActive !== false)
      .map((raw) => ({
        id: raw.id,
        itemType: 'RAW_INGREDIENT' as const,
        code: raw.code,
        name: raw.name,
        baseUnit: raw.usageUOM || raw.purchaseUOM || '',
        purchaseUnit: raw.purchaseUOM || raw.usageUOM || '',
        conversionFactor: money(raw.conversionFactor) || 1,
        currentCost: money(raw.costPerUsageUnit),
        raw,
      }));

    const prepOptions = prepItems
      .filter((item) => item.isActive !== false && item.isStockTracked !== false)
      .map((prep) => ({
        id: prep.id,
        itemType: 'PREP_ITEM' as const,
        code: prep.code,
        name: prep.name,
        baseUnit: prep.yieldUOM || prep.outputUOM || '',
        purchaseUnit: prep.yieldUOM || prep.outputUOM || '',
        conversionFactor: 1,
        currentCost: money(prep.costPerUnit),
        prep,
      }));

    return [...rawOptions, ...prepOptions].sort((a, b) => a.name.localeCompare(b.name));
  }, [prepItems, rawIngredients]);

  const optionsByKey = useMemo(() => (
    new Map(itemOptions.map((option) => [itemKey(option.itemType, option.code), option]))
  ), [itemOptions]);

  const filteredItemOptions = useMemo(() => {
    const term = itemSearch.trim().toLowerCase();
    if (!term) return itemOptions;
    return itemOptions.filter((item) => `${item.name} ${item.code} ${item.itemType}`.toLowerCase().includes(term));
  }, [itemOptions, itemSearch]);

  const selectedPurchase = useMemo(
    () => recentPurchases.find((purchase) => purchase.id === selectedPurchaseId) || null,
    [recentPurchases, selectedPurchaseId],
  );

  useEffect(() => {
    let active = true;
    const loadData = async () => {
      if (!staffProfile || !hasAccess) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const [storeSnap, rawSnap, prepSnap] = await Promise.all([
          getDocs(query(collection(db, 'stores'), where('isActive', '==', true))),
          getDocs(collection(db, 'rawIngredients')),
          getDocs(collection(db, 'prepItems')),
        ]);

        if (!active) return;

        let loadedStores = storeSnap.docs.map((storeDoc) => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
        loadedStores.sort((a, b) => a.name.localeCompare(b.name));
        if (staffProfile.role !== 'ADMIN') {
          const ids = allowedStoreIds(staffProfile);
          loadedStores = loadedStores.filter((store) => ids.includes(store.id));
        }

        setStores(loadedStores);
        setRawIngredients(rawSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() } as RawIngredient & { id: string })));
        setPrepItems(prepSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() } as PrepItem & { id: string })));
        setSelectedStoreId((prev) => {
          if (prev && loadedStores.some((store) => store.id === prev)) return prev;
          return loadedStores[0]?.id || '';
        });

        try {
          const purchaseQuery = staffProfile.role === 'ADMIN'
            ? query(collection(db, 'purchaseEntries'))
            : loadedStores.length > 0
              ? query(collection(db, 'purchaseEntries'), where('storeId', 'in', loadedStores.slice(0, 10).map((store) => store.id)))
              : null;
          const purchaseSnap = purchaseQuery ? await getDocs(purchaseQuery) : { docs: [] };
          const purchases = purchaseSnap.docs
            .map((purchaseDoc) => ({ id: purchaseDoc.id, ...purchaseDoc.data() } as PurchaseEntryRecord))
            .filter((purchase) => staffProfile.role === 'ADMIN' || loadedStores.some((store) => store.id === purchase.storeId))
            .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0))
            .slice(0, 20);
          setRecentPurchases(purchases);
        } catch {
          setRecentPurchases([]);
          setError('Purchase entry rules need deployment before recent purchases can load or new purchases can be posted.');
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load purchase entry data.');
      } finally {
        if (active) setLoading(false);
      }
    };

    loadData();
    return () => {
      active = false;
    };
  }, [hasAccess, refreshNonce, staffProfile]);

  useEffect(() => {
    let active = true;
    const loadStoreStock = async () => {
      if (!selectedStore) {
        setStoreStock([]);
        return;
      }

      try {
        const snap = await getDocs(query(collection(db, 'storeStock'), where('storeId', '==', selectedStore.id)));
        if (active) {
          setStoreStock(snap.docs.map((stockDoc) => ({ id: stockDoc.id, ...stockDoc.data() } as StoreStock & { id: string })));
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load store stock rows.');
      }
    };

    loadStoreStock();
    return () => {
      active = false;
    };
  }, [selectedStore]);

  const updateLine = (lineId: string, patch: Partial<PurchaseLineForm>) => {
    setLines((current) => current.map((line) => {
      if (line.id !== lineId) return line;
      const next = { ...line, ...patch };
      if (patch.itemType && patch.itemType !== line.itemType) {
        next.itemCode = '';
        next.unit = '';
      }
      if (patch.itemCode) {
        const option = optionsByKey.get(itemKey(next.itemType, patch.itemCode));
        next.unit = option?.purchaseUnit || option?.baseUnit || '';
        if (!next.costPerUnit && option?.currentCost) {
          next.costPerUnit = String(option.currentCost);
        }
      }
      return next;
    }));
  };

  const addLine = () => {
    setLines((current) => [...current, newLine(current[current.length - 1]?.itemType || 'RAW_INGREDIENT')]);
  };

  const removeLine = (lineId: string) => {
    setLines((current) => current.length === 1 ? current : current.filter((line) => line.id !== lineId));
  };

  const resolveStockQuantity = (option: ItemOption, quantity: number, unit: string): number => {
    const enteredUnit = normalizeUnit(unit);
    const baseUnit = normalizeUnit(option.baseUnit);
    const purchaseUnit = normalizeUnit(option.purchaseUnit);

    if (!enteredUnit || !baseUnit) throw new Error(`Unit is missing for ${option.name}.`);
    if (enteredUnit === baseUnit) return quantity;
    if (option.itemType === 'RAW_INGREDIENT' && enteredUnit === purchaseUnit && option.conversionFactor > 0) {
      return quantity * option.conversionFactor;
    }
    throw new Error(`Cannot convert ${unit} to ${option.baseUnit} for ${option.name}.`);
  };

  const prepareLines = (): PreparedLine[] => {
    const prepared = lines.map((line, index) => {
      const option = optionsByKey.get(itemKey(line.itemType, line.itemCode));
      if (!option) throw new Error(`Select an item for row ${index + 1}.`);

      const quantity = money(line.quantity);
      if (quantity <= 0) throw new Error(`Quantity must be greater than 0 for ${option.name}.`);

      const unit = line.unit.trim() || option.purchaseUnit || option.baseUnit;
      const stockQuantity = resolveStockQuantity(option, quantity, unit);
      if (stockQuantity <= 0) throw new Error(`Stock quantity must be greater than 0 for ${option.name}.`);

      const totalFromInput = money(line.purchaseCostTotal);
      const costPerInput = money(line.costPerUnit);
      if (totalFromInput < 0 || costPerInput < 0) throw new Error(`Cost cannot be negative for ${option.name}.`);

      const totalCost = totalFromInput > 0 ? totalFromInput : costPerInput * quantity;
      const costPerInputUnit = totalCost > 0 ? totalCost / quantity : 0;
      const costPerStockUnit = totalCost > 0 ? totalCost / stockQuantity : option.currentCost || 0;
      const existingStock = stockByKey.get(itemKey(option.itemType, option.code));

      return {
        option,
        form: line,
        quantity,
        stockQuantity,
        totalCost,
        costPerInputUnit,
        costPerStockUnit,
        unit,
        stockId: existingStock?.id || stockRowId(selectedStoreId, option.itemType, option.code),
        existingStock,
      };
    });

    const seen = new Set<string>();
    prepared.forEach((line) => {
      const key = itemKey(line.option.itemType, line.option.code);
      if (seen.has(key)) throw new Error(`${line.option.name} appears more than once. Combine it into one row.`);
      seen.add(key);
    });

    return prepared;
  };

  const postPurchase = async () => {
    if (!staffProfile || !selectedStore) return;

    const supplier = supplierName.trim();
    const invoice = invoiceNumber.trim();
    const purchaseNotes = notes.trim();
    if (!supplier) {
      setError('Supplier name is required.');
      return;
    }
    if (!purchaseDate) {
      setError('Purchase date is required.');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one purchase item.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const prepared = prepareLines();
      const now = serverTimestamp();
      const purchaseRef = doc(collection(db, 'purchaseEntries'));
      const movementIds: string[] = [];
      const batch = writeBatch(db);
      const totalAmount = prepared.reduce((sum, line) => sum + line.totalCost, 0);

      prepared.forEach((line) => {
        const movementRef = doc(collection(db, 'stockMovements'));
        movementIds.push(movementRef.id);

        const previousQty = money(line.existingStock?.currentStock);
        const newQty = previousQty + line.stockQuantity;
        const stockRef = doc(db, 'storeStock', line.stockId);
        const stockCost = line.costPerStockUnit > 0 ? line.costPerStockUnit : money(line.existingStock?.costPerUnit) || line.option.currentCost || 0;

        batch.set(stockRef, {
          storeId: selectedStore.id,
          storeCode: selectedStore.code,
          storeName: selectedStore.name,
          stockItemType: line.option.itemType,
          stockItemCode: line.option.code,
          stockItemName: line.option.name,
          uom: line.option.baseUnit,
          openingStock: line.existingStock ? money(line.existingStock.openingStock) : 0,
          currentStock: newQty,
          minimumStock: line.existingStock ? money(line.existingStock.minimumStock) : 0,
          costPerUnit: stockCost,
          createdAt: line.existingStock ? line.existingStock.createdAt || now : now,
          updatedAt: now,
        }, { merge: true });

        if (staffProfile.role === 'ADMIN' && line.totalCost > 0) {
          if (line.option.itemType === 'RAW_INGREDIENT' && line.option.raw) {
            let purchaseCost = line.costPerInputUnit;
            if (normalizeUnit(line.unit) === normalizeUnit(line.option.baseUnit) && line.option.conversionFactor > 0) {
              purchaseCost = line.costPerStockUnit * line.option.conversionFactor;
            }
            batch.update(doc(db, 'rawIngredients', line.option.raw.id), {
              purchaseCost,
              costPerUsageUnit: line.costPerStockUnit,
              supplierName: supplier,
              updatedAt: now,
            });
          }
          if (line.option.itemType === 'PREP_ITEM' && line.option.prep) {
            batch.update(doc(db, 'prepItems', line.option.prep.id), {
              costPerUnit: line.costPerStockUnit,
              updatedAt: now,
            });
          }
        }

        batch.set(movementRef, {
          storeId: selectedStore.id,
          storeCode: selectedStore.code,
          storeName: selectedStore.name,
          inventoryItemId: line.option.code,
          inventoryItemName: line.option.name,
          movementType: 'PURCHASE_INWARD',
          quantity: line.stockQuantity,
          quantityDelta: line.stockQuantity,
          previousQty,
          newQty,
          wentNegative: newQty < 0,
          unit: line.option.baseUnit,
          referenceType: 'PURCHASE_ENTRY',
          referenceId: purchaseRef.id,
          purchaseEntryId: purchaseRef.id,
          supplierName: supplier,
          invoiceNumber: invoice || null,
          purchaseCostTotal: line.totalCost,
          costPerUnitSnapshot: line.costPerStockUnit,
          notes: [line.form.notes.trim(), purchaseNotes].filter(Boolean).join(' • ') || null,
          createdByUserId: staffProfile.uid,
          createdByName: staffProfile.name,
          createdAt: now,
          stockSystem: 'MENU_MANAGEMENT',
          stockItemType: line.option.itemType,
          stockItemCode: line.option.code,
          source: 'PURCHASE_ENTRY',
        } as StockMovement & Record<string, unknown>);
      });

      batch.set(purchaseRef, {
        storeId: selectedStore.id,
        storeCode: selectedStore.code,
        storeName: selectedStore.name,
        purchaseDate,
        supplierName: supplier,
        invoiceNumber: invoice,
        notes: purchaseNotes,
        totalAmount,
        itemCount: prepared.length,
        status: 'POSTED',
        createdAt: now,
        createdBy: staffProfile.uid,
        createdByName: staffProfile.name,
        movementIds,
        lines: prepared.map((line) => ({
          itemType: line.option.itemType,
          itemCode: line.option.code,
          itemName: line.option.name,
          quantity: line.quantity,
          stockQuantity: line.stockQuantity,
          unit: line.unit,
          stockUnit: line.option.baseUnit,
          purchaseCostTotal: line.totalCost,
          costPerUnit: line.costPerInputUnit,
          costPerStockUnit: line.costPerStockUnit,
          notes: line.form.notes.trim(),
        })),
      });

      await batch.commit();
      setSuccess(`Purchase posted for ${supplier}. ${prepared.length} item row(s) increased stock.`);
      setSupplierName('');
      setInvoiceNumber('');
      setNotes('');
      setLines([newLine()]);
      setItemSearch('');
      setRefreshNonce((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to post purchase entry.');
    } finally {
      setSaving(false);
    }
  };

  const formTotal = useMemo(() => {
    try {
      return prepareLines().reduce((sum, line) => sum + line.totalCost, 0);
    } catch {
      return lines.reduce((sum, line) => {
        const total = money(line.purchaseCostTotal);
        return sum + (total > 0 ? total : money(line.costPerUnit) * money(line.quantity));
      }, 0);
    }
  }, [lines, optionsByKey, selectedStoreId, stockByKey]);

  if (!staffProfile) return null;

  if (!hasAccess) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">No access</p>
          <h1 className="mt-2 text-2xl font-black text-[#3e2723]">Purchase Entry</h1>
          <p className="mt-3 text-sm font-medium text-neutral-600">
            Purchase inward is available to Admin and Store Manager roles only.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/inventory/control" className="rounded-full bg-[#3e2723] px-4 py-2 text-sm font-black text-white hover:bg-[#2d1c19]">
              Inventory Control
            </Link>
            <Link to="/pos" className="rounded-full border border-[#5c4033]/30 bg-white px-4 py-2 text-sm font-black text-[#5c4033] hover:bg-[#5c4033]/5">
              Back to POS
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full min-w-0 bg-[#fcf9f5] pb-24 font-sans text-neutral-800">
      <div className="mx-auto w-full max-w-7xl min-w-0 px-4 py-4 md:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/inventory/control" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-600 shadow-sm ring-1 ring-neutral-200 hover:bg-neutral-50">
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">Inventory</p>
              <h1 className="text-2xl font-black tracking-tight text-[#3e2723] md:text-3xl">Purchase Entry</h1>
              <p className="mt-1 text-sm font-medium text-neutral-500">
                Post supplier purchases and increase raw or prep stock with a movement audit.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link to="/inventory/control" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm hover:bg-[#5c4033]/5">
              Inventory Control
            </Link>
            <Link to="/inventory/stock-correction" className="rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-black text-emerald-800 shadow-sm hover:bg-emerald-50">
              Stock Correction
            </Link>
            <button
              onClick={() => setRefreshNonce((value) => value + 1)}
              className="inline-flex items-center gap-2 rounded-full bg-[#3e2723] px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-sm hover:bg-[#2d1c19]"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
            {error}
          </div>
        )}

        {success && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
            {success}
          </div>
        )}

        <section className="mt-4 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <PackagePlus size={20} className="text-[#5c4033]" />
              <div>
                <h2 className="text-base font-black text-[#3e2723]">New purchase inward</h2>
                <p className="text-sm font-medium text-neutral-500">One posted purchase creates stock movements for every item row.</p>
              </div>
            </div>
            <div className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm font-black text-[#3e2723]">
              Total {formatMoney(formTotal)}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-5">
            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Store
              <div className="relative">
                <StoreIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                <select
                  value={selectedStoreId}
                  onChange={(event) => setSelectedStoreId(event.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-2.5 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                >
                  {accessibleStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
              </div>
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Purchase date
              <input
                type="date"
                value={purchaseDate}
                onChange={(event) => setPurchaseDate(event.target.value)}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              />
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-1">
              Supplier
              <input
                value={supplierName}
                onChange={(event) => setSupplierName(event.target.value)}
                placeholder="Supplier name"
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              />
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Invoice
              <input
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                placeholder="Bill number"
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              />
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Search items
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                <input
                  value={itemSearch}
                  onChange={(event) => setItemSearch(event.target.value)}
                  placeholder="Milk, cups, beans"
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-2.5 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </div>
            </label>
          </div>

          <label className="mt-3 grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
            Notes
            <input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional purchase notes"
              className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
            />
          </label>

          <div className="mt-4 grid gap-3">
            {lines.map((line, index) => {
              const lineOptions = filteredItemOptions.filter((option) => option.itemType === line.itemType);
              const selectedOption = optionsByKey.get(itemKey(line.itemType, line.itemCode));
              const existingStock = selectedOption ? stockByKey.get(itemKey(selectedOption.itemType, selectedOption.code)) : null;

              return (
                <div key={line.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-sm font-black text-[#3e2723]">Item row {index + 1}</p>
                    <button
                      onClick={() => removeLine(line.id)}
                      disabled={lines.length === 1}
                      className="inline-flex items-center gap-1 rounded-full border border-red-100 bg-white px-3 py-1.5 text-xs font-black text-red-700 disabled:opacity-40"
                    >
                      <Trash2 size={13} />
                      Remove
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
                    <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-2">
                      Type
                      <select
                        value={line.itemType}
                        onChange={(event) => updateLine(line.id, { itemType: event.target.value as PurchaseLineType })}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                      >
                        {ITEM_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                      </select>
                    </label>

                    <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-4">
                      Item
                      <select
                        value={line.itemCode}
                        onChange={(event) => updateLine(line.id, { itemCode: event.target.value })}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                      >
                        <option value="">Select item</option>
                        {lineOptions.map((option) => (
                          <option key={`${option.itemType}-${option.code}`} value={option.code}>
                            {option.name} ({option.code})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-2">
                      Quantity
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={line.quantity}
                        onChange={(event) => updateLine(line.id, { quantity: event.target.value })}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                      />
                    </label>

                    <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-1">
                      Unit
                      <input
                        value={line.unit}
                        onChange={(event) => updateLine(line.id, { unit: event.target.value })}
                        placeholder={selectedOption?.purchaseUnit || selectedOption?.baseUnit || ''}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                      />
                    </label>

                    <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-1">
                      Total cost
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.purchaseCostTotal}
                        onChange={(event) => updateLine(line.id, { purchaseCostTotal: event.target.value })}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                      />
                    </label>

                    <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500 lg:col-span-2">
                      Cost per unit
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={line.costPerUnit}
                        onChange={(event) => updateLine(line.id, { costPerUnit: event.target.value })}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                      />
                    </label>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
                    <input
                      value={line.notes}
                      onChange={(event) => updateLine(line.id, { notes: event.target.value })}
                      placeholder="Optional row note"
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                    />
                    <div className="flex flex-wrap gap-2 text-xs font-bold text-neutral-500">
                      <span>Stock unit: {selectedOption?.baseUnit || '-'}</span>
                      <span>Current: {existingStock ? `${money(existingStock.currentStock).toFixed(2)} ${existingStock.uom}` : 'missing row'}</span>
                      {staffProfile.role !== 'ADMIN' && <span>Cost saved as snapshot only</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={addLine}
              className="inline-flex items-center gap-2 rounded-full border border-[#5c4033]/20 bg-white px-4 py-2 text-sm font-black text-[#5c4033] hover:bg-[#5c4033]/5"
            >
              <Plus size={16} />
              Add item row
            </button>
            <button
              onClick={postPurchase}
              disabled={saving || loading || !selectedStore}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#3e2723] px-6 py-3 text-sm font-black text-white shadow-sm hover:bg-[#2d1c19] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <ReceiptText size={16} />}
              Post purchase inward
            </button>
          </div>

          <p className="mt-3 text-xs font-bold text-neutral-500">
            Purchases increase current stock and create `PURCHASE_INWARD` movements. Old orders are not recalculated.
          </p>
        </section>

        <section className="mt-6 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-[#5c4033]" />
              <div>
                <h2 className="text-base font-black text-[#3e2723]">Recent purchase entries</h2>
                <p className="text-sm font-medium text-neutral-500">Posted entries are read-only in this phase.</p>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-400">
              <Loader2 className="animate-spin" size={18} />
              <span className="ml-2 text-sm font-medium">Loading purchase entries...</span>
            </div>
          ) : recentPurchases.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-10 text-center text-sm font-medium text-neutral-500">
              No purchase entries posted yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[820px] w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.14em] text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Store</th>
                    <th className="px-3 py-2">Supplier</th>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2 text-right">Items</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2">Created by</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPurchases.map((purchase) => (
                    <tr
                      key={purchase.id}
                      onClick={() => setSelectedPurchaseId(purchase.id)}
                      className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                    >
                      <td className="px-3 py-3 font-bold text-[#3e2723]">{purchase.purchaseDate}</td>
                      <td className="px-3 py-3">{purchase.storeName}</td>
                      <td className="px-3 py-3">{purchase.supplierName}</td>
                      <td className="px-3 py-3">{purchase.invoiceNumber || '-'}</td>
                      <td className="px-3 py-3 text-right">{purchase.itemCount}</td>
                      <td className="px-3 py-3 text-right font-black">{formatMoney(purchase.totalAmount)}</td>
                      <td className="px-3 py-3">{purchase.createdByName || '-'}</td>
                      <td className="px-3 py-3">{formatDate(purchase.createdAt)}</td>
                      <td className="px-3 py-3">
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-black text-emerald-700">{purchase.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {selectedPurchase && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 md:items-center">
          <div className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">Purchase detail</p>
                <h3 className="mt-1 text-2xl font-black text-[#3e2723]">{selectedPurchase.supplierName}</h3>
                <p className="text-sm font-bold text-neutral-500">{selectedPurchase.storeName} • {selectedPurchase.purchaseDate}</p>
              </div>
              <button
                onClick={() => setSelectedPurchaseId(null)}
                className="rounded-full border border-neutral-200 px-3 py-1.5 text-sm font-black text-neutral-600 hover:bg-neutral-50"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-neutral-50 p-3 text-sm">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-neutral-400">Invoice</p>
                <p className="font-bold text-[#3e2723]">{selectedPurchase.invoiceNumber || '-'}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-neutral-400">Total</p>
                <p className="font-black text-[#3e2723]">{formatMoney(selectedPurchase.totalAmount)}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-neutral-400">Created</p>
                <p className="font-bold text-[#3e2723]">{formatDate(selectedPurchase.createdAt)}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-neutral-400">Movement rows</p>
                <p className="font-bold text-[#3e2723]">{selectedPurchase.movementIds?.length || 0}</p>
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              {(selectedPurchase.lines || []).map((line) => (
                <div key={`${line.itemType}-${line.itemCode}`} className="rounded-2xl border border-neutral-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-black text-[#3e2723]">{line.itemName}</p>
                      <p className="text-xs font-bold text-neutral-500">{line.itemCode} • {line.itemType.replace('_', ' ')}</p>
                    </div>
                    <p className="font-black text-[#3e2723]">{formatMoney(line.purchaseCostTotal)}</p>
                  </div>
                  <p className="mt-2 text-sm font-medium text-neutral-600">
                    Received {line.quantity} {line.unit} → stock +{money(line.stockQuantity).toFixed(2)} {line.stockUnit}
                  </p>
                  <p className="text-xs font-bold text-neutral-500">Cost snapshot: {formatMoney(line.costPerStockUnit)} / {line.stockUnit}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
