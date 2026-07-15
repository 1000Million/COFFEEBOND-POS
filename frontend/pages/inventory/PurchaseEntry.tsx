import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Calculator,
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
import {
  calculatePurchaseLine,
  calculatePurchaseTotals,
  emptyPurchaseTotals,
  normalizePurchaseUnit,
  parseNumber,
  PriceBasis,
  PURCHASE_UNITS,
  PurchaseLineCalculation,
} from '../../lib/purchaseCalculations';
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
  purchaseQuantity: string;
  purchaseUOM: string;
  packSize: string;
  packSizeUOM: string;
  priceBasis: PriceBasis;
  rate: string;
  taxPercent: string;
  discountPercent: string;
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
  subtotal?: number;
  discountAmount?: number;
  taxableAmount?: number;
  taxAmount?: number;
  grandTotal?: number;
  totalAmount: number;
  itemCount: number;
  status: 'POSTED';
  createdAt: any;
  createdByName?: string;
  lines?: Array<{
    itemType: PurchaseLineType;
    itemCode: string;
    itemName: string;
    quantity?: number;
    purchaseQuantity?: number;
    stockQuantity?: number;
    convertedStockQuantity?: number;
    unit?: string;
    purchaseUOM?: string;
    stockUnit?: string;
    stockUOM?: string;
    purchaseCostTotal?: number;
    costPerUnit?: number;
    costPerStockUnit?: number;
    calculatedCostPerStockUnit?: number;
    inventoryCostAmount?: number;
    rate?: number;
    subtotal?: number;
    discountAmount?: number;
    taxableAmount?: number;
    taxRate?: number;
    taxAmount?: number;
    totalAmount?: number;
    notes?: string;
  }>;
  movementIds?: string[];
};

type PreparedLine = {
  option: ItemOption;
  form: PurchaseLineForm;
  calculation: PurchaseLineCalculation;
  stockId: string;
  existingStock?: StoreStock & { id: string };
};

type LineState = {
  option: ItemOption | null;
  calculation: PurchaseLineCalculation | null;
  existingStock: (StoreStock & { id: string }) | null;
  error: string;
  fieldErrors: Record<string, string>;
};

const ITEM_TYPES: { value: PurchaseLineType; label: string }[] = [
  { value: 'RAW_INGREDIENT', label: 'Raw ingredient' },
  { value: 'PREP_ITEM', label: 'Prep item' },
];

const PACK_UNITS = new Set(['PACK', 'BOX', 'BOTTLE', 'BAG', 'TRAY']);
const PACK_CONTENT_UNITS = ['G', 'KG', 'ML', 'L', 'PCS'];

function todayIso(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function money(value: unknown): number {
  return parseNumber(value);
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

function allowedStoreIds(profile: NonNullable<ReturnType<typeof useAuth>['staffProfile']>): string[] {
  return profile.assignedStoreIds?.length ? profile.assignedStoreIds : (profile.storeIds || []);
}

function newLine(defaultType: PurchaseLineType = 'RAW_INGREDIENT'): PurchaseLineForm {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    itemType: defaultType,
    itemCode: '',
    purchaseQuantity: '',
    purchaseUOM: '',
    packSize: '',
    packSizeUOM: '',
    priceBasis: 'RATE_PER_PURCHASE_UNIT',
    rate: '',
    taxPercent: '0',
    discountPercent: '0',
    notes: '',
  };
}

function purchaseUnitLabel(line: PurchaseLineForm, option: ItemOption | null): string {
  return normalizePurchaseUnit(line.purchaseUOM || option?.purchaseUnit || option?.baseUnit || 'purchase unit') || 'purchase unit';
}

function contentsUnitLabel(line: PurchaseLineForm): string {
  return normalizePurchaseUnit(line.packSizeUOM || 'contents unit') || 'contents unit';
}

function stockUnitLabel(option: ItemOption | null): string {
  return normalizePurchaseUnit(option?.baseUnit || 'stock unit') || 'stock unit';
}

function priceBasisOptionsForLine(line: PurchaseLineForm, option: ItemOption | null): { value: PriceBasis; label: string }[] {
  const purchaseUnit = purchaseUnitLabel(line, option);
  const contentsUnit = contentsUnitLabel(line);
  const stockUnit = stockUnitLabel(option);
  return [
    { value: 'RATE_PER_PURCHASE_UNIT', label: `Rate per ${purchaseUnit}` },
    { value: 'RATE_PER_CONTENTS_UNIT', label: `Rate per ${contentsUnit} inside pack` },
    { value: 'RATE_PER_STOCK_UNIT', label: `Rate per ${stockUnit}` },
  ];
}

function rateLabelForLine(line: PurchaseLineForm, option: ItemOption | null): string {
  if (line.priceBasis === 'RATE_PER_CONTENTS_UNIT') return `Rate per ${contentsUnitLabel(line)} inside pack`;
  if (line.priceBasis === 'RATE_PER_STOCK_UNIT') return `Rate per ${stockUnitLabel(option)}`;
  return `Rate per ${purchaseUnitLabel(line, option)}`;
}

function fieldClass(hasError: boolean): string {
  return [
    'w-full rounded-2xl border bg-white px-3 py-3 text-sm font-bold text-[#3e2723] outline-none transition focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/10',
    hasError ? 'border-red-300' : 'border-neutral-200',
  ].join(' ');
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs font-bold text-red-700">{message}</p>;
}

function shouldUseItemConversion(line: PurchaseLineForm, option: ItemOption): number {
  const purchaseUOM = normalizePurchaseUnit(line.purchaseUOM || option.purchaseUnit || option.baseUnit);
  const packSizeUOM = normalizePurchaseUnit(line.packSizeUOM);
  const optionPurchaseUOM = normalizePurchaseUnit(option.purchaseUnit);
  const optionBaseUnit = normalizePurchaseUnit(option.baseUnit);

  if (!option.conversionFactor || option.conversionFactor <= 0 || option.conversionFactor === 1) return 0;
  if (purchaseUOM === optionPurchaseUOM && optionPurchaseUOM !== optionBaseUnit) return option.conversionFactor;
  if (packSizeUOM === optionPurchaseUOM && optionPurchaseUOM !== optionBaseUnit) return option.conversionFactor;
  return 0;
}

function buildLineState(
  line: PurchaseLineForm,
  optionsByKey: Map<string, ItemOption>,
  stockByKey: Map<string, StoreStock & { id: string }>,
): LineState {
  const option = optionsByKey.get(itemKey(line.itemType, line.itemCode)) || null;
  const fieldErrors: Record<string, string> = {};

  if (!option) {
    if (line.itemCode) fieldErrors.itemCode = 'Selected item is no longer available.';
    return { option, calculation: null, existingStock: null, error: '', fieldErrors };
  }

  const purchaseQuantity = money(line.purchaseQuantity);
  const rate = money(line.rate);
  const discountPercent = money(line.discountPercent);
  const taxPercent = money(line.taxPercent);
  if (line.purchaseQuantity && purchaseQuantity <= 0) fieldErrors.purchaseQuantity = 'Quantity must be greater than 0.';
  if (line.rate && rate < 0) fieldErrors.rate = 'Rate cannot be negative.';
  if (discountPercent < 0 || discountPercent > 100) fieldErrors.discountPercent = 'Discount must be 0 to 100%.';
  if (taxPercent < 0 || taxPercent > 100) fieldErrors.taxPercent = 'Tax must be 0 to 100%.';

  try {
    if (!line.purchaseQuantity || !line.rate) {
      return {
        option,
        calculation: null,
        existingStock: stockByKey.get(itemKey(option.itemType, option.code)) || null,
        error: '',
        fieldErrors,
      };
    }

    const purchaseUOM = line.purchaseUOM || option.purchaseUnit || option.baseUnit;
    const calculation = calculatePurchaseLine({
      purchaseQuantity,
      purchaseUOM,
      stockUOM: option.baseUnit,
      packSize: money(line.packSize),
      packSizeUOM: line.packSizeUOM,
      priceBasis: line.priceBasis,
      rate,
      taxPercent,
      discountPercent,
      itemConversionFactor: shouldUseItemConversion(line, option),
    });

    return {
      option,
      calculation,
      existingStock: stockByKey.get(itemKey(option.itemType, option.code)) || null,
      error: '',
      fieldErrors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to calculate this row.';
    return {
      option,
      calculation: null,
      existingStock: stockByKey.get(itemKey(option.itemType, option.code)) || null,
      error: message,
      fieldErrors,
    };
  }
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

  const lineStates = useMemo(() => (
    new Map(lines.map((line) => [line.id, buildLineState(line, optionsByKey, stockByKey)]))
  ), [lines, optionsByKey, stockByKey]);

  const calculatedLines = useMemo(() => (
    Array.from(lineStates.values()).flatMap((state) => (state.calculation ? [state.calculation] : []))
  ), [lineStates]);

  const formTotals = useMemo(() => (
    calculatedLines.length > 0 ? calculatePurchaseTotals(calculatedLines) : emptyPurchaseTotals()
  ), [calculatedLines]);

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
        next.purchaseUOM = '';
        next.packSize = '';
        next.packSizeUOM = '';
        next.rate = '';
      }
      if (patch.itemCode) {
        const option = optionsByKey.get(itemKey(next.itemType, patch.itemCode));
        next.purchaseUOM = normalizePurchaseUnit(option?.purchaseUnit || option?.baseUnit || '');
        next.packSizeUOM = '';
        if (!next.rate && option?.currentCost) {
          next.rate = String(option.currentCost);
        }
      }
      if (patch.purchaseUOM && !PACK_UNITS.has(normalizePurchaseUnit(patch.purchaseUOM))) {
        next.packSize = '';
        next.packSizeUOM = '';
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

  const prepareLines = (): PreparedLine[] => {
    const prepared = lines.map((line, index) => {
      const state = lineStates.get(line.id) || buildLineState(line, optionsByKey, stockByKey);
      if (!state.option) throw new Error(`Select an item for row ${index + 1}.`);
      if (!line.purchaseQuantity) throw new Error(`Enter purchase quantity for ${state.option.name}.`);
      if (!line.rate) throw new Error(`Enter rate for ${state.option.name}.`);
      if (state.error) throw new Error(`${state.option.name}: ${state.error}`);
      if (!state.calculation) throw new Error(`${state.option.name}: complete quantity, unit, rate, and conversion details.`);

      return {
        option: state.option,
        form: line,
        calculation: state.calculation,
        stockId: state.existingStock?.id || stockRowId(selectedStoreId, state.option.itemType, state.option.code),
        existingStock: state.existingStock || undefined,
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
      const totals = calculatePurchaseTotals(prepared.map((line) => line.calculation));
      const now = serverTimestamp();
      const purchaseRef = doc(collection(db, 'purchaseEntries'));
      const movementIds: string[] = [];
      const batch = writeBatch(db);

      prepared.forEach((line) => {
        const movementRef = doc(collection(db, 'stockMovements'));
        movementIds.push(movementRef.id);

        const previousQty = money(line.existingStock?.currentStock);
        const newQty = previousQty + line.calculation.convertedStockQuantity;
        const stockRef = doc(db, 'storeStock', line.stockId);
        const stockCost = line.calculation.calculatedCostPerStockUnit > 0
          ? line.calculation.calculatedCostPerStockUnit
          : money(line.existingStock?.costPerUnit) || line.option.currentCost || 0;
        const rowNote = line.form.notes.trim();

        batch.set(stockRef, {
          storeId: selectedStore.id,
          storeCode: selectedStore.code,
          storeName: selectedStore.name,
          stockItemType: line.option.itemType,
          stockItemCode: line.option.code,
          stockItemName: line.option.name,
          uom: line.calculation.stockUOM,
          openingStock: line.existingStock ? money(line.existingStock.openingStock) : 0,
          currentStock: newQty,
          minimumStock: line.existingStock ? money(line.existingStock.minimumStock) : 0,
          costPerUnit: stockCost,
          createdAt: line.existingStock ? line.existingStock.createdAt || now : now,
          updatedAt: now,
        }, { merge: true });

        if (staffProfile.role === 'ADMIN' && line.calculation.taxableAmount > 0) {
          const costPerPurchaseUnit = line.calculation.taxableAmount / money(line.form.purchaseQuantity);
          if (line.option.itemType === 'RAW_INGREDIENT' && line.option.raw) {
            batch.update(doc(db, 'rawIngredients', line.option.raw.id), {
              purchaseCost: costPerPurchaseUnit,
              costPerUsageUnit: line.calculation.calculatedCostPerStockUnit,
              supplierName: supplier,
              updatedAt: now,
            });
          }
          if (line.option.itemType === 'PREP_ITEM' && line.option.prep) {
            batch.update(doc(db, 'prepItems', line.option.prep.id), {
              costPerUnit: line.calculation.calculatedCostPerStockUnit,
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
          quantity: line.calculation.convertedStockQuantity,
          quantityDelta: line.calculation.convertedStockQuantity,
          previousQty,
          newQty,
          wentNegative: newQty < 0,
          unit: line.calculation.stockUOM,
          referenceType: 'PURCHASE_ENTRY',
          referenceId: purchaseRef.id,
          purchaseEntryId: purchaseRef.id,
          supplierName: supplier,
          invoiceNumber: invoice || null,
          purchaseQuantity: money(line.form.purchaseQuantity),
          purchaseUOM: line.calculation.purchaseUOM,
          conversionFactor: line.calculation.conversionFactor,
          convertedStockQuantity: line.calculation.convertedStockQuantity,
          stockUOM: line.calculation.stockUOM,
          rate: money(line.form.rate),
          subtotal: line.calculation.lineSubtotal,
          discountAmount: line.calculation.discountAmount,
          taxableAmount: line.calculation.taxableAmount,
          taxRate: money(line.form.taxPercent),
          taxAmount: line.calculation.taxAmount,
          totalAmount: line.calculation.lineTotal,
          inventoryCostAmount: line.calculation.inventoryCostAmount,
          purchaseCostTotal: line.calculation.lineTotal,
          costPerUnitSnapshot: line.calculation.calculatedCostPerStockUnit,
          calculatedCostPerStockUnit: line.calculation.calculatedCostPerStockUnit,
          notes: [rowNote, purchaseNotes].filter(Boolean).join(' • ') || null,
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
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxableAmount: totals.taxableAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        totalAmount: totals.grandTotal,
        itemCount: prepared.length,
        status: 'POSTED',
        createdAt: now,
        createdBy: staffProfile.uid,
        createdByName: staffProfile.name,
        movementIds,
        lines: prepared.map((line) => {
          const purchaseQuantity = money(line.form.purchaseQuantity);
          const rate = money(line.form.rate);
          return {
            itemType: line.option.itemType,
            itemCode: line.option.code,
            itemName: line.option.name,
            purchaseQuantity,
            purchaseUOM: line.calculation.purchaseUOM,
            conversionFactor: line.calculation.conversionFactor,
            convertedStockQuantity: line.calculation.convertedStockQuantity,
            stockUOM: line.calculation.stockUOM,
            priceBasis: line.form.priceBasis,
            rate,
            subtotal: line.calculation.lineSubtotal,
            discountPercent: money(line.form.discountPercent),
            discountAmount: line.calculation.discountAmount,
            taxableAmount: line.calculation.taxableAmount,
            taxRate: money(line.form.taxPercent),
            taxAmount: line.calculation.taxAmount,
            totalAmount: line.calculation.lineTotal,
            inventoryCostAmount: line.calculation.inventoryCostAmount,
            calculatedCostPerStockUnit: line.calculation.calculatedCostPerStockUnit,
            packSize: money(line.form.packSize),
            packSizeUOM: normalizePurchaseUnit(line.form.packSizeUOM),
            notes: line.form.notes.trim(),
            quantity: purchaseQuantity,
            stockQuantity: line.calculation.convertedStockQuantity,
            unit: line.calculation.purchaseUOM,
            stockUnit: line.calculation.stockUOM,
            purchaseCostTotal: line.calculation.lineTotal,
            costPerUnit: line.calculation.taxableAmount / purchaseQuantity,
            costPerStockUnit: line.calculation.calculatedCostPerStockUnit,
          };
        }),
      });

      await batch.commit();
      setSuccess(`Purchase posted for ${supplier}. ${prepared.length} item row(s) increased stock by converted stock quantity.`);
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
                Post supplier invoices with safe unit conversion and stock movement audit.
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

        <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <PackagePlus size={20} className="text-[#5c4033]" />
                <div>
                  <h2 className="text-base font-black text-[#3e2723]">New purchase inward</h2>
                  <p className="text-sm font-medium text-neutral-500">Original supplier units are saved; stock movements use converted stock units.</p>
                </div>
              </div>
              <div className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm font-black text-[#3e2723]">
                {formTotals.itemRows} calculated row(s)
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
                Store
                <div className="relative">
                  <StoreIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                  <select
                    value={selectedStoreId}
                    onChange={(event) => setSelectedStoreId(event.target.value)}
                    className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-3 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                  >
                    {accessibleStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                  </select>
                </div>
              </label>

              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
                Purchase date
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(event) => setPurchaseDate(event.target.value)}
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </label>

              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
                Supplier
                <input
                  value={supplierName}
                  onChange={(event) => setSupplierName(event.target.value)}
                  placeholder="Supplier name"
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </label>

              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
                Invoice
                <input
                  value={invoiceNumber}
                  onChange={(event) => setInvoiceNumber(event.target.value)}
                  placeholder="Bill number"
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </label>

              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
                Search items
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                  <input
                    value={itemSearch}
                    onChange={(event) => setItemSearch(event.target.value)}
                    placeholder="Milk, cups, beans"
                    className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-3 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                  />
                </div>
              </label>
            </div>

            <label className="mt-3 grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
              Notes
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional purchase notes"
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              />
            </label>

            <div className="mt-5 grid gap-4">
              {lines.map((line, index) => {
                const state = lineStates.get(line.id) || buildLineState(line, optionsByKey, stockByKey);
                const lineOptions = filteredItemOptions.filter((option) => option.itemType === line.itemType);
                const selectedOption = state.option;
                const existingStock = state.existingStock;
                const isPackUnit = PACK_UNITS.has(normalizePurchaseUnit(line.purchaseUOM));
                const priceBasisOptions = priceBasisOptionsForLine(line, selectedOption);
                const rateLabel = rateLabelForLine(line, selectedOption);

                return (
                  <div key={line.id} className="rounded-3xl border border-neutral-200 bg-[#fffaf4] p-3 shadow-sm md:p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-black text-[#3e2723]">Item row {index + 1}</p>
                        <p className="text-xs font-bold text-neutral-500">
                          {selectedOption ? `${selectedOption.code} · stock in ${selectedOption.baseUnit || '-'}` : 'Choose item and supplier unit'}
                        </p>
                      </div>
                      <button
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length === 1}
                        className="inline-flex items-center gap-1 rounded-full border border-red-100 bg-white px-3 py-2 text-xs font-black text-red-700 disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        Type
                        <select
                          value={line.itemType}
                          onChange={(event) => updateLine(line.id, { itemType: event.target.value as PurchaseLineType })}
                          className={fieldClass(false)}
                        >
                          {ITEM_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                        </select>
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-4">
                        Item
                        <select
                          value={line.itemCode}
                          onChange={(event) => updateLine(line.id, { itemCode: event.target.value })}
                          className={fieldClass(Boolean(state.fieldErrors.itemCode))}
                        >
                          <option value="">Select item</option>
                          {lineOptions.map((option) => (
                            <option key={`${option.itemType}-${option.code}`} value={option.code}>
                              {option.name} ({option.code})
                            </option>
                          ))}
                        </select>
                        <FieldError message={state.fieldErrors.itemCode} />
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        Purchase qty
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={line.purchaseQuantity}
                          onChange={(event) => updateLine(line.id, { purchaseQuantity: event.target.value })}
                          className={fieldClass(Boolean(state.fieldErrors.purchaseQuantity))}
                        />
                        <FieldError message={state.fieldErrors.purchaseQuantity} />
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        Purchase unit
                        <select
                          value={line.purchaseUOM}
                          onChange={(event) => updateLine(line.id, { purchaseUOM: event.target.value })}
                          className={fieldClass(false)}
                        >
                          <option value="">Unit</option>
                          {PURCHASE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                        </select>
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        Price basis
                        <select
                          value={line.priceBasis}
                          onChange={(event) => updateLine(line.id, { priceBasis: event.target.value as PriceBasis })}
                          className={fieldClass(false)}
                        >
                          {priceBasisOptions.map((basis) => <option key={basis.value} value={basis.value}>{basis.label}</option>)}
                        </select>
                      </label>
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-12">
                      {isPackUnit && (
                        <>
                          <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                            Pack contents
                            <input
                              type="number"
                              min="0"
                              step="0.001"
                              value={line.packSize}
                              onChange={(event) => updateLine(line.id, { packSize: event.target.value })}
                              placeholder="10"
                              className={fieldClass(Boolean(state.error && state.error.includes('pack')))}
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                            Contents unit
                            <select
                              value={line.packSizeUOM}
                              onChange={(event) => updateLine(line.id, { packSizeUOM: event.target.value })}
                              className={fieldClass(Boolean(state.error && state.error.includes('contents unit')))}
                            >
                              <option value="">Unit</option>
                              {PACK_CONTENT_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                            </select>
                          </label>
                        </>
                      )}

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        {rateLabel}
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.rate}
                          onChange={(event) => updateLine(line.id, { rate: event.target.value })}
                          className={fieldClass(Boolean(state.fieldErrors.rate))}
                        />
                        <FieldError message={state.fieldErrors.rate} />
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        Tax %
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.taxPercent}
                          onChange={(event) => updateLine(line.id, { taxPercent: event.target.value })}
                          className={fieldClass(Boolean(state.fieldErrors.taxPercent))}
                        />
                        <FieldError message={state.fieldErrors.taxPercent} />
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-2">
                        Discount %
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={line.discountPercent}
                          onChange={(event) => updateLine(line.id, { discountPercent: event.target.value })}
                          className={fieldClass(Boolean(state.fieldErrors.discountPercent))}
                        />
                        <FieldError message={state.fieldErrors.discountPercent} />
                      </label>

                      <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500 lg:col-span-4">
                        Optional note
                        <input
                          value={line.notes}
                          onChange={(event) => updateLine(line.id, { notes: event.target.value })}
                          placeholder="Batch, expiry, supplier note"
                          className={fieldClass(false)}
                        />
                      </label>
                    </div>

                    {state.error && (
                      <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                        <span>{state.error}</span>
                      </div>
                    )}

                    <div className="mt-3 grid gap-2 rounded-2xl bg-white p-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-400">Conversion</p>
                        <p className="font-black text-[#3e2723]">{state.calculation?.conversionPreview || 'Complete row to preview'}</p>
                        {state.calculation?.pricingPreview && (
                          <p className="mt-1 text-xs font-bold text-neutral-500">{state.calculation.pricingPreview}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-400">Invoice line</p>
                        <p className="font-black text-[#3e2723]">{formatMoney(state.calculation?.lineTotal || 0)}</p>
                        <p className="text-xs font-bold text-neutral-500">Tax {formatMoney(state.calculation?.taxAmount || 0)} · Discount {formatMoney(state.calculation?.discountAmount || 0)}</p>
                      </div>
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-400">Cost per stock unit</p>
                        <p className="font-black text-[#3e2723]">
                          {formatMoney(state.calculation?.calculatedCostPerStockUnit || 0)} / {selectedOption?.baseUnit || '-'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-400">Current stock</p>
                        <p className="font-black text-[#3e2723]">
                          {existingStock ? `${money(existingStock.currentStock).toFixed(2)} ${existingStock.uom}` : 'Missing row'}
                        </p>
                        <p className="text-xs font-bold text-neutral-500">{staffProfile.role !== 'ADMIN' ? 'Master cost unchanged' : 'Master cost may update'}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <button
                onClick={addLine}
                className="inline-flex items-center gap-2 rounded-full border border-[#5c4033]/20 bg-white px-4 py-3 text-sm font-black text-[#5c4033] hover:bg-[#5c4033]/5"
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

          <aside className="xl:sticky xl:top-4 xl:self-start">
            <div className="rounded-3xl border border-[#5c4033]/15 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <Calculator size={18} className="text-[#5c4033]" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-400">Purchase summary</p>
                  <h2 className="text-xl font-black text-[#3e2723]">{formatMoney(formTotals.grandTotal)}</h2>
                </div>
              </div>

              <div className="mt-4 grid gap-2 text-sm font-bold text-neutral-600">
                <div className="flex justify-between gap-3">
                  <span>Subtotal</span>
                  <span>{formatMoney(formTotals.subtotal)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>Discount</span>
                  <span>-{formatMoney(formTotals.discountAmount)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>Taxable</span>
                  <span>{formatMoney(formTotals.taxableAmount)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>Tax</span>
                  <span>{formatMoney(formTotals.taxAmount)}</span>
                </div>
                <div className="mt-2 border-t border-neutral-200 pt-3">
                  <div className="flex items-end justify-between gap-3">
                    <span className="text-lg font-black text-[#3e2723]">Grand total</span>
                    <span className="text-2xl font-black text-[#3e2723]">{formatMoney(formTotals.grandTotal)}</span>
                  </div>
                  <p className="mt-1 text-xs font-bold text-neutral-500">{formTotals.itemRows} calculated item row(s)</p>
                </div>
              </div>

              <button
                onClick={postPurchase}
                disabled={saving || loading || !selectedStore}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#3e2723] px-5 py-3 text-sm font-black text-white shadow-sm hover:bg-[#2d1c19] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <ReceiptText size={16} />}
                Post purchase
              </button>
            </div>
          </aside>
        </div>

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
              <table className="w-full min-w-[820px] text-left text-sm">
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
                      <td className="px-3 py-3 text-right font-black">{formatMoney(purchase.grandTotal ?? purchase.totalAmount)}</td>
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
                <p className="text-xs font-black uppercase tracking-[0.14em] text-neutral-400">Grand total</p>
                <p className="font-black text-[#3e2723]">{formatMoney(selectedPurchase.grandTotal ?? selectedPurchase.totalAmount)}</p>
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
              {(selectedPurchase.lines || []).map((line) => {
                const purchaseQuantity = line.purchaseQuantity ?? line.quantity ?? 0;
                const purchaseUOM = line.purchaseUOM || line.unit || '';
                const stockQuantity = line.convertedStockQuantity ?? line.stockQuantity ?? 0;
                const stockUOM = line.stockUOM || line.stockUnit || '';
                const totalAmount = line.totalAmount ?? line.purchaseCostTotal ?? 0;
                const inventoryCostAmount = line.inventoryCostAmount ?? line.taxableAmount ?? 0;
                const stockCost = line.calculatedCostPerStockUnit ?? line.costPerStockUnit ?? 0;
                return (
                  <div key={`${line.itemType}-${line.itemCode}`} className="rounded-2xl border border-neutral-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-black text-[#3e2723]">{line.itemName}</p>
                        <p className="text-xs font-bold text-neutral-500">{line.itemCode} • {line.itemType.replace('_', ' ')}</p>
                      </div>
                      <p className="font-black text-[#3e2723]">{formatMoney(totalAmount)}</p>
                    </div>
                    <p className="mt-2 text-sm font-medium text-neutral-600">
                      Invoice {purchaseQuantity} {purchaseUOM} → stock +{money(stockQuantity).toFixed(2)} {stockUOM}
                    </p>
                    <p className="text-xs font-bold text-neutral-500">
                      Tax {formatMoney(line.taxAmount || 0)} · Discount {formatMoney(line.discountAmount || 0)} · Cost {formatMoney(stockCost)} / {stockUOM}
                    </p>
                    <p className="text-xs font-bold text-neutral-500">
                      Inventory cost excludes GST: {formatMoney(inventoryCostAmount)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
