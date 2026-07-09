import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Store as StoreIcon,
  Wrench,
  XCircle,
} from 'lucide-react';
import { collection, doc, getDocs, query, serverTimestamp, writeBatch, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { RawIngredient, PrepItem, StoreStock } from '../../types/menu-management';
import { Store, StockMovement } from '../../types';

type ItemTypeFilter = 'ALL' | 'RAW_INGREDIENT' | 'PREP_ITEM';
type IssueFilter = 'ALL' | 'NEGATIVE_STOCK' | 'MISSING_COST' | 'MISSING_STOCK_ROW';
type ActionMode = 'COST' | 'STOCK' | 'OPENING';
type IssueCode = 'NEGATIVE_STOCK' | 'MISSING_COST' | 'MISSING_STOCK_ROW';

type EditableRow = {
  docId: string;
  stockDocId: string;
  itemType: 'RAW_INGREDIENT' | 'PREP_ITEM';
  itemCode: string;
  itemName: string;
  unit: string;
  currentStock: number;
  masterCost: number;
  stockRowCost: number;
  issueCodes: IssueCode[];
  issueLabels: string[];
  lastMovementLabel: string;
  lastMovementNotes: string;
  raw?: RawIngredient & { id: string };
  prep?: PrepItem & { id: string };
  stockRow?: StoreStock & { id: string };
};

type EditorState = {
  mode: ActionMode;
  row: EditableRow;
};

type EditorFormState = {
  reason: string;
  notes: string;
  quantity: string;
  unit: string;
  purchaseCost: string;
  costPerUsageUnit: string;
  costPerUnit: string;
  supplierName: string;
};

type SummaryCard = {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'green' | 'amber' | 'red';
};

const ISSUE_LABELS: Record<IssueCode, string> = {
  NEGATIVE_STOCK: 'Negative stock',
  MISSING_COST: 'Missing cost',
  MISSING_STOCK_ROW: 'Missing stock row',
};

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

function formatDateTime(value: any): string {
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

function reviewFlagged(notes: string): boolean {
  const text = notes.toLowerCase();
  return ['review', 'pending', 'zero_ok', 'zero ok', 'cost pending'].some((flag) => text.includes(flag));
}

function canUseAutoCost(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export default function StockCorrection() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [rawIngredients, setRawIngredients] = useState<(RawIngredient & { id: string })[]>([]);
  const [prepItems, setPrepItems] = useState<(PrepItem & { id: string })[]>([]);
  const [storeStock, setStoreStock] = useState<(StoreStock & { id: string })[]>([]);
  const [stockMovements, setStockMovements] = useState<(StockMovement & { id: string })[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [search, setSearch] = useState('');
  const [itemTypeFilter, setItemTypeFilter] = useState<ItemTypeFilter>('ALL');
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('ALL');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [form, setForm] = useState<EditorFormState>({
    reason: '',
    notes: '',
    quantity: '',
    unit: '',
    purchaseCost: '',
    costPerUsageUnit: '',
    costPerUnit: '',
    supplierName: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');

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

  useEffect(() => {
    let active = true;
    const loadStores = async () => {
      if (!staffProfile) return;
      setStoresLoading(true);
      try {
        const snap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        let loaded = snap.docs.map((storeDoc) => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
        loaded.sort((a, b) => a.name.localeCompare(b.name));
        if (staffProfile.role !== 'ADMIN') {
          const ids = allowedStoreIds(staffProfile);
          loaded = loaded.filter((store) => ids.includes(store.id));
        }

        if (!active) return;
        setStores(loaded);
        setSelectedStoreId((prev) => {
          if (prev && loaded.some((store) => store.id === prev)) return prev;
          return loaded[0]?.id || '';
        });
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load stores.');
        }
      } finally {
        if (active) setStoresLoading(false);
      }
    };

    loadStores();
    return () => {
      active = false;
    };
  }, [staffProfile]);

  useEffect(() => {
    let active = true;
    const loadData = async () => {
      if (!hasAccess || !selectedStore) {
        if (active) setDataLoading(false);
        return;
      }

      setDataLoading(true);
      setError('');
      try {
        const [rawSnap, prepSnap, stockSnap, movementSnap] = await Promise.all([
          getDocs(collection(db, 'rawIngredients')),
          getDocs(collection(db, 'prepItems')),
          getDocs(query(collection(db, 'storeStock'), where('storeId', '==', selectedStore.id))),
          getDocs(query(collection(db, 'stockMovements'), where('storeId', '==', selectedStore.id))),
        ]);

        if (!active) return;

        setRawIngredients(rawSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() } as RawIngredient & { id: string })));
        setPrepItems(prepSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() } as PrepItem & { id: string })));
        setStoreStock(stockSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() } as StoreStock & { id: string })));
        setStockMovements(
          movementSnap.docs
            .map((snap) => ({ id: snap.id, ...snap.data() } as StockMovement & { id: string }))
            .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)),
        );
        setLastRefreshedAt(new Date().toLocaleString());
      } catch (err: any) {
        if (!active) return;
        const message = String(err?.message || err || 'Failed to load stock correction data.');
        if (message.toLowerCase().includes('requires an index') || message.toLowerCase().includes('failed-precondition')) {
          setError('Firestore index required for this stock correction dashboard query. Deploy Firestore indexes and refresh.');
        } else {
          setError(message);
        }
      } finally {
        if (active) setDataLoading(false);
      }
    };

    loadData();
    return () => {
      active = false;
    };
  }, [hasAccess, refreshNonce, selectedStore]);

  const lastMovementByKey = useMemo(() => {
    const map = new Map<string, StockMovement & { id: string }>();
    stockMovements.forEach((movement) => {
      if (!movement.stockItemType || !movement.stockItemCode) return;
      const key = itemKey(movement.stockItemType, movement.stockItemCode);
      if (!map.has(key)) {
        map.set(key, movement);
      }
    });
    return map;
  }, [stockMovements]);

  const rows = useMemo(() => {
    const stockByKey = new Map(
      storeStock.map((stock) => [itemKey(stock.stockItemType, stock.stockItemCode), stock]),
    );

    const rawRows: EditableRow[] = rawIngredients.map((raw) => {
      const stockRow = stockByKey.get(itemKey('RAW_INGREDIENT', raw.code));
      const currentStock = money(stockRow?.currentStock);
      const masterCost = money(raw.costPerUsageUnit);
      const issues: IssueCode[] = [];
      if (!stockRow) issues.push('MISSING_STOCK_ROW');
      if (currentStock < 0) issues.push('NEGATIVE_STOCK');
      if (money(raw.purchaseCost) <= 0 || masterCost <= 0) issues.push('MISSING_COST');

      const lastMovement = lastMovementByKey.get(itemKey('RAW_INGREDIENT', raw.code));
      return {
        docId: raw.id,
        stockDocId: stockRow?.id || stockRowId(selectedStoreId, 'RAW_INGREDIENT', raw.code),
        itemType: 'RAW_INGREDIENT',
        itemCode: raw.code,
        itemName: raw.name,
        unit: raw.usageUOM || raw.purchaseUOM || '-',
        currentStock,
        masterCost,
        stockRowCost: money(stockRow?.costPerUnit),
        issueCodes: issues,
        issueLabels: issues.map((issue) => ISSUE_LABELS[issue]),
        lastMovementLabel: lastMovement ? `${lastMovement.movementType} • ${formatDateTime(lastMovement.createdAt)}` : '-',
        lastMovementNotes: lastMovement?.notes || '-',
        raw,
        stockRow,
      };
    });

    const prepRows: EditableRow[] = prepItems.map((prep) => {
      const stockRow = stockByKey.get(itemKey('PREP_ITEM', prep.code));
      const currentStock = money(stockRow?.currentStock);
      const masterCost = money(prep.costPerUnit);
      const issues: IssueCode[] = [];
      if (!stockRow) issues.push('MISSING_STOCK_ROW');
      if (currentStock < 0) issues.push('NEGATIVE_STOCK');
      if (masterCost <= 0) issues.push('MISSING_COST');

      const lastMovement = lastMovementByKey.get(itemKey('PREP_ITEM', prep.code));
      return {
        docId: prep.id,
        stockDocId: stockRow?.id || stockRowId(selectedStoreId, 'PREP_ITEM', prep.code),
        itemType: 'PREP_ITEM',
        itemCode: prep.code,
        itemName: prep.name,
        unit: prep.yieldUOM || prep.outputUOM || '-',
        currentStock,
        masterCost,
        stockRowCost: money(stockRow?.costPerUnit),
        issueCodes: issues,
        issueLabels: issues.map((issue) => ISSUE_LABELS[issue]),
        lastMovementLabel: lastMovement ? `${lastMovement.movementType} • ${formatDateTime(lastMovement.createdAt)}` : '-',
        lastMovementNotes: lastMovement?.notes || '-',
        prep,
        stockRow,
      };
    });

    const searchTerm = search.trim().toLowerCase();
    const filtered = [...rawRows, ...prepRows]
      .filter((row) => itemTypeFilter === 'ALL' || row.itemType === itemTypeFilter)
      .filter((row) => issueFilter === 'ALL' || row.issueCodes.includes(issueFilter))
      .filter((row) => {
        if (!searchTerm) return true;
        return `${row.itemName} ${row.itemCode} ${row.unit}`.toLowerCase().includes(searchTerm);
      })
      .sort((a, b) => {
        const score = (row: EditableRow) => (
          row.issueCodes.includes('MISSING_STOCK_ROW') ? 0
            : row.issueCodes.includes('NEGATIVE_STOCK') ? 1
              : row.issueCodes.includes('MISSING_COST') ? 2
                : 3
        );
        return score(a) - score(b) || a.itemName.localeCompare(b.itemName);
      });

    return filtered;
  }, [issueFilter, itemTypeFilter, lastMovementByKey, prepItems, rawIngredients, search, selectedStoreId, storeStock]);

  const summaryCards: SummaryCard[] = useMemo(() => {
    const total = rows.length;
    const missingStockRows = rows.filter((row) => row.issueCodes.includes('MISSING_STOCK_ROW')).length;
    const negativeStockRows = rows.filter((row) => row.issueCodes.includes('NEGATIVE_STOCK')).length;
    const missingCostRows = rows.filter((row) => row.issueCodes.includes('MISSING_COST')).length;
    const attentionRows = rows.filter((row) => row.issueCodes.length > 0).length;
    const costCoverage = total > 0 ? `${Math.round(((total - missingCostRows) / total) * 100)}%` : '—';
    return [
      { label: 'Items shown', value: total, tone: 'neutral' },
      { label: 'Missing stock rows', value: missingStockRows, tone: missingStockRows > 0 ? 'amber' : 'green' },
      { label: 'Negative stock', value: negativeStockRows, tone: negativeStockRows > 0 ? 'red' : 'green' },
      { label: 'Missing cost', value: missingCostRows, tone: missingCostRows > 0 ? 'amber' : 'green' },
      { label: 'Attention rows', value: attentionRows, tone: attentionRows > 0 ? 'amber' : 'green' },
      { label: 'Cost coverage', value: costCoverage, tone: missingCostRows > 0 ? 'amber' : 'green' },
    ];
  }, [rows]);

  const openEditor = (mode: ActionMode, row: EditableRow) => {
    setSuccess('');
    setError('');
    setEditor({ mode, row });
    const raw = row.raw;
    const prep = row.prep;
    setForm({
      reason: mode === 'OPENING' ? 'Opening stock correction' : mode === 'STOCK' ? 'Stock correction' : 'Cost correction',
      notes: '',
      quantity: String(Math.max(0, row.currentStock || 0)),
      unit: row.unit || '',
      purchaseCost: raw ? String(Math.max(0, money(raw.purchaseCost))) : '',
      costPerUsageUnit: raw ? String(Math.max(0, money(raw.costPerUsageUnit))) : '',
      costPerUnit: prep ? String(Math.max(0, money(prep.costPerUnit))) : String(Math.max(0, row.stockRowCost || row.masterCost || 0)),
      supplierName: raw?.supplierName || '',
    });
  };

  const closeEditor = () => {
    if (saving) return;
    setEditor(null);
  };

  const saveEditor = async () => {
    if (!editor || !staffProfile || !selectedStore) return;

    const reason = form.reason.trim();
    const notes = form.notes.trim();
    if (!reason) {
      setError('Reason is required.');
      return;
    }
    if (!notes) {
      setError('Notes are required.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const batch = writeBatch(db);
      const now = serverTimestamp();
      const movementRef = doc(collection(db, 'stockMovements'));
      const row = editor.row;
      const currentStock = money(row.stockRow?.currentStock);
      const currentOpening = money(row.stockRow?.openingStock);
      if (editor.mode === 'COST') {
        if (row.itemType === 'RAW_INGREDIENT') {
          const purchaseCost = money(form.purchaseCost);
          if (purchaseCost <= 0) {
            throw new Error('Purchase cost must be greater than 0.');
          }

          let costPerUsageUnit = money(form.costPerUsageUnit);
          if (costPerUsageUnit <= 0) {
            const conversionFactor = money(row.raw?.conversionFactor);
            if (canUseAutoCost(conversionFactor)) {
              costPerUsageUnit = Math.round(((purchaseCost / conversionFactor) + Number.EPSILON) * 10000) / 10000;
            }
          }
          if (costPerUsageUnit <= 0 && !reviewFlagged(notes)) {
            throw new Error('Usage cost must be greater than 0 or the notes must clearly flag the row for review.');
          }

          batch.update(doc(db, 'rawIngredients', row.docId), {
            purchaseCost,
            costPerUsageUnit,
            supplierName: form.supplierName.trim(),
            updatedAt: now,
          });

          batch.set(movementRef, {
            storeId: selectedStore.id,
            storeName: selectedStore.name,
            inventoryItemId: row.itemCode,
            inventoryItemName: row.itemName,
            movementType: 'STOCK_CORRECTION',
            quantity: 0,
            quantityDelta: 0,
            previousQty: currentStock,
            newQty: currentStock,
            wentNegative: currentStock < 0,
            unit: row.unit,
            referenceType: 'MANUAL',
            referenceId: null,
            notes: `${reason} • ${notes}`,
            createdByUserId: staffProfile.uid,
            createdByName: staffProfile.name,
            createdAt: now,
            stockSystem: 'MENU_MANAGEMENT',
            stockItemType: row.itemType,
            stockItemCode: row.itemCode,
            correctionType: 'COST_UPDATE',
            previousCost: row.masterCost,
            newCost: costPerUsageUnit,
            supplierName: form.supplierName.trim(),
          });
        } else {
          const costPerUnit = money(form.costPerUnit);
          if (costPerUnit <= 0 && !reviewFlagged(notes)) {
            throw new Error('Prep item cost must be greater than 0 or the notes must clearly flag the row for review.');
          }

          batch.update(doc(db, 'prepItems', row.docId), {
            costPerUnit,
            updatedAt: now,
          });

          batch.set(movementRef, {
            storeId: selectedStore.id,
            storeName: selectedStore.name,
            inventoryItemId: row.itemCode,
            inventoryItemName: row.itemName,
            movementType: 'STOCK_CORRECTION',
            quantity: 0,
            quantityDelta: 0,
            previousQty: currentStock,
            newQty: currentStock,
            wentNegative: currentStock < 0,
            unit: row.unit,
            referenceType: 'MANUAL',
            referenceId: null,
            notes: `${reason} • ${notes}`,
            createdByUserId: staffProfile.uid,
            createdByName: staffProfile.name,
            createdAt: now,
            stockSystem: 'MENU_MANAGEMENT',
            stockItemType: row.itemType,
            stockItemCode: row.itemCode,
            correctionType: 'COST_UPDATE',
            previousCost: row.masterCost,
            newCost: costPerUnit,
          });
        }
      } else {
        const quantity = money(form.quantity);
        if (!Number.isFinite(quantity)) {
          throw new Error('Quantity must be numeric.');
        }
        if (editor.mode === 'OPENING' && quantity < 0) {
          throw new Error('Opening stock must be 0 or greater.');
        }

        const resolvedUnit = form.unit.trim() || row.unit;
        const manualCost = row.itemType === 'RAW_INGREDIENT' ? money(form.costPerUsageUnit) : money(form.costPerUnit);
        const costPerUnit = manualCost > 0 ? manualCost : (row.stockRow?.costPerUnit || row.masterCost || 0);
        const newQty = quantity;
        const previousQty = currentStock;
        const quantityDelta = newQty - previousQty;
        const stockId = row.stockRow?.id || stockRowId(selectedStore.id, row.itemType, row.itemCode);
        const stockRef = doc(db, 'storeStock', stockId);
        const setPayload: Record<string, unknown> = {
          storeId: selectedStore.id,
          storeName: selectedStore.name,
          stockItemType: row.itemType,
          stockItemCode: row.itemCode,
          stockItemName: row.itemName,
          uom: resolvedUnit,
          openingStock: editor.mode === 'OPENING' ? quantity : (row.stockRow ? currentOpening : 0),
          currentStock: newQty,
          minimumStock: row.stockRow ? money(row.stockRow.minimumStock) : 0,
          costPerUnit,
          updatedAt: now,
        };

        if (!row.stockRow) {
          setPayload.createdAt = now;
        }

        batch.set(stockRef, setPayload, { merge: true });
        batch.set(movementRef, {
          storeId: selectedStore.id,
          storeName: selectedStore.name,
          inventoryItemId: row.itemCode,
          inventoryItemName: row.itemName,
          movementType: editor.mode === 'OPENING' ? 'OPENING_STOCK' : 'STOCK_CORRECTION',
          quantity: editor.mode === 'OPENING' ? quantity : quantityDelta,
          quantityDelta,
          previousQty,
          newQty,
          wentNegative: newQty < 0,
          unit: resolvedUnit,
          referenceType: 'MANUAL',
          referenceId: null,
          notes: `${reason} • ${notes}`,
          createdByUserId: staffProfile.uid,
          createdByName: staffProfile.name,
          createdAt: now,
          stockSystem: 'MENU_MANAGEMENT',
          stockItemType: row.itemType,
          stockItemCode: row.itemCode,
          correctionType: editor.mode === 'OPENING' ? 'OPENING_STOCK' : 'STOCK_CORRECTION',
        });
      }

      await batch.commit();
      setEditor(null);
      setRefreshNonce((value) => value + 1);
      setSuccess(`${editor.mode === 'COST' ? 'Cost' : editor.mode === 'OPENING' ? 'Opening stock' : 'Stock'} updated for ${row.itemName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save the correction.');
    } finally {
      setSaving(false);
    }
  };

  const filteredRows = rows;
  const loading = storesLoading || dataLoading;

  if (!staffProfile) return null;

  if (!hasAccess) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">No access</p>
          <h1 className="mt-2 text-2xl font-black text-[#3e2723]">Stock Correction</h1>
          <p className="mt-3 text-sm font-medium text-neutral-600">
            This screen is available to Admin and Store Manager roles only.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/inventory/control" className="rounded-full bg-[#3e2723] px-4 py-2 text-sm font-black text-white hover:bg-[#2d1c19]">
              Back to Inventory Control
            </Link>
            <Link to="/reports" className="rounded-full border border-[#5c4033]/30 bg-white px-4 py-2 text-sm font-black text-[#5c4033] hover:bg-[#5c4033]/5">
              Open Reports
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
              <h1 className="text-2xl font-black tracking-tight text-[#3e2723] md:text-3xl">Stock Correction</h1>
              <p className="mt-1 text-sm font-medium text-neutral-500">
                Fix raw and prep counts, backfill opening stock, and update master costs. Missing stock rows are warnings only.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link to="/inventory/control" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm hover:bg-[#5c4033]/5">
              Inventory Control
            </Link>
            <Link to="/reports" className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm hover:bg-[#5c4033]/5">
              Open Reports
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

        <div className="mt-4 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
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
              Search
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search item name or code"
                  className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-2.5 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
                />
              </div>
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Item type
              <select
                value={itemTypeFilter}
                onChange={(event) => setItemTypeFilter(event.target.value as ItemTypeFilter)}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              >
                <option value="ALL">All</option>
                <option value="RAW_INGREDIENT">Raw ingredients</option>
                <option value="PREP_ITEM">Prep items</option>
              </select>
            </label>

            <label className="grid gap-1 text-xs font-black uppercase tracking-[0.16em] text-neutral-500">
              Issue filter
              <select
                value={issueFilter}
                onChange={(event) => setIssueFilter(event.target.value as IssueFilter)}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033]"
              >
                <option value="ALL">All</option>
                <option value="MISSING_STOCK_ROW">Missing stock row</option>
                <option value="NEGATIVE_STOCK">Negative stock</option>
                <option value="MISSING_COST">Missing cost</option>
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-neutral-500">
            <span>Store: {selectedStore ? selectedStore.name : 'Select a store'}</span>
            <span>Last refresh: {lastRefreshedAt || '—'}</span>
            <span>Missing stock rows are warnings only</span>
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

        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
          {summaryCards.map((card) => (
            <div key={card.label} className={`rounded-2xl border bg-white p-4 shadow-sm ${
              card.tone === 'green' ? 'border-emerald-200' : card.tone === 'amber' ? 'border-amber-200' : card.tone === 'red' ? 'border-red-200' : 'border-neutral-200'
            }`}>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-400">{card.label}</p>
              <p className="mt-2 text-2xl font-black text-[#3e2723]">{card.value}</p>
            </div>
          ))}
        </div>

        <section className="mt-6 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Package size={18} className="text-[#5c4033]" />
              <div>
                <h2 className="text-base font-black text-[#3e2723]">Raw and Prep stock rows</h2>
                <p className="text-sm font-medium text-neutral-500">Adjust counts, backfill opening stock, and update costs without blocking checkout.</p>
              </div>
            </div>
            <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] text-amber-800">
              Missing storeStock row = warning
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-400">
              <Loader2 className="animate-spin" size={18} />
              <span className="ml-2 text-sm font-medium">Loading stock correction data...</span>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-10 text-center text-sm font-medium text-neutral-500">
              No rows match the current filters.
            </div>
          ) : (
            <>
              <div className="grid gap-3 lg:hidden">
                {filteredRows.map((row) => (
                  <div key={`${row.itemType}-${row.itemCode}`} className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-lg font-black text-[#3e2723]">{row.itemName}</p>
                        <p className="text-xs font-bold text-neutral-500">{row.itemCode} • {row.itemType.replace('_', ' ')}</p>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        {row.issueCodes.length === 0 ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black text-emerald-700">Ready</span>
                        ) : row.issueCodes.map((issue) => (
                          <span key={issue} className={`rounded-full px-2 py-1 text-[10px] font-black ${
                            issue === 'NEGATIVE_STOCK' ? 'bg-red-100 text-red-700'
                              : issue === 'MISSING_COST' ? 'bg-amber-100 text-amber-800'
                                : 'bg-blue-100 text-blue-700'
                          }`}>
                            {ISSUE_LABELS[issue]}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-400">Current stock</p>
                        <p className="mt-1 font-mono text-[#3e2723]">{row.currentStock.toFixed(2)} {row.unit}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-400">Master cost</p>
                        <p className="mt-1 font-mono text-[#3e2723]">{row.masterCost > 0 ? formatMoney(row.masterCost) : 'Missing'}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-400">Last movement</p>
                        <p className="mt-1 text-sm font-medium text-neutral-700">{row.lastMovementLabel}</p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => openEditor('COST', row)}
                        className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/5"
                      >
                        Update cost
                      </button>
                      <button
                        onClick={() => openEditor('STOCK', row)}
                        className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/5"
                      >
                        Correct stock
                      </button>
                      <button
                        onClick={() => openEditor('OPENING', row)}
                        className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-800 hover:bg-emerald-100"
                      >
                        Set opening stock
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden lg:block overflow-x-auto">
                <table className="min-w-[1120px] w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-neutral-50 text-neutral-500 font-bold text-xs uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-4">Item</th>
                      <th className="px-4 py-4">Type</th>
                      <th className="px-4 py-4 text-right">Current stock</th>
                      <th className="px-4 py-4 text-right">Unit</th>
                      <th className="px-4 py-4 text-right">Master cost</th>
                      <th className="px-4 py-4">Last movement</th>
                      <th className="px-4 py-4">Issues</th>
                      <th className="px-4 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 font-medium text-neutral-900">
                    {filteredRows.map((row) => (
                      <tr key={`${row.itemType}-${row.itemCode}`} className="hover:bg-neutral-50">
                        <td className="px-4 py-4">
                          <p className="font-bold text-[#3e2723]">{row.itemName}</p>
                          <p className="text-xs text-neutral-400">{row.itemCode}</p>
                        </td>
                        <td className="px-4 py-4">{row.itemType.replace('_', ' ')}</td>
                        <td className="px-4 py-4 text-right font-mono">{row.currentStock.toFixed(2)}</td>
                        <td className="px-4 py-4 text-right">{row.unit}</td>
                        <td className="px-4 py-4 text-right font-mono">{row.masterCost > 0 ? formatMoney(row.masterCost) : 'Missing'}</td>
                        <td className="px-4 py-4 text-xs text-neutral-600">
                          <div>{row.lastMovementLabel}</div>
                          <div className="mt-1 truncate max-w-[240px] text-neutral-400" title={row.lastMovementNotes}>
                            {row.lastMovementNotes}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-1">
                            {row.issueCodes.length === 0 ? (
                              <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black text-emerald-700">Ready</span>
                            ) : row.issueCodes.map((issue) => (
                              <span key={issue} className={`rounded-full px-2 py-1 text-[10px] font-black ${
                                issue === 'NEGATIVE_STOCK' ? 'bg-red-100 text-red-700'
                                  : issue === 'MISSING_COST' ? 'bg-amber-100 text-amber-800'
                                    : 'bg-blue-100 text-blue-700'
                              }`}>
                                {ISSUE_LABELS[issue]}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              onClick={() => openEditor('COST', row)}
                              className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/5"
                            >
                              Update cost
                            </button>
                            <button
                              onClick={() => openEditor('STOCK', row)}
                              className="rounded-full border border-[#5c4033]/20 bg-white px-3 py-2 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/5"
                            >
                              Correct stock
                            </button>
                            <button
                              onClick={() => openEditor('OPENING', row)}
                              className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-800 hover:bg-emerald-100"
                            >
                              Set opening stock
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>

      {editor && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-6">
          <div className="w-full max-w-2xl rounded-3xl bg-white shadow-2xl">
            <div className="border-b border-neutral-200 px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-400">
                    {editor.mode === 'COST' ? 'Update cost' : editor.mode === 'OPENING' ? 'Set opening stock' : 'Correct stock'}
                  </p>
                  <h2 className="mt-1 text-2xl font-black text-[#3e2723]">{editor.row.itemName}</h2>
                  <p className="mt-1 text-sm font-medium text-neutral-500">
                    {editor.row.itemCode} • {editor.row.itemType.replace('_', ' ')} • {selectedStore?.name || 'Selected store'}
                  </p>
                </div>
                <button
                  onClick={closeEditor}
                  className="rounded-full border border-neutral-200 bg-white p-2 text-neutral-500 hover:bg-neutral-50"
                  aria-label="Close"
                >
                  <XCircle size={18} />
                </button>
              </div>
            </div>

            <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {editor.mode === 'COST' && (
                  <>
                    {editor.row.itemType === 'RAW_INGREDIENT' ? (
                      <>
                        <label className="grid gap-2 text-sm font-bold text-neutral-700">
                          Purchase cost
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={form.purchaseCost}
                            onChange={(event) => setForm((current) => ({ ...current, purchaseCost: event.target.value }))}
                            className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                          />
                        </label>
                        <label className="grid gap-2 text-sm font-bold text-neutral-700">
                          Cost per usage unit
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={form.costPerUsageUnit}
                            onChange={(event) => setForm((current) => ({ ...current, costPerUsageUnit: event.target.value }))}
                            className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                          />
                        </label>
                        <label className="grid gap-2 text-sm font-bold text-neutral-700 md:col-span-2">
                          Supplier name
                          <input
                            type="text"
                            value={form.supplierName}
                            onChange={(event) => setForm((current) => ({ ...current, supplierName: event.target.value }))}
                            className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                          />
                        </label>
                      </>
                    ) : (
                      <label className="grid gap-2 text-sm font-bold text-neutral-700 md:col-span-2">
                        Cost per unit
                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          value={form.costPerUnit}
                          onChange={(event) => setForm((current) => ({ ...current, costPerUnit: event.target.value }))}
                          className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                        />
                      </label>
                    )}
                  </>
                )}

                {(editor.mode === 'STOCK' || editor.mode === 'OPENING') && (
                  <>
                    <label className="grid gap-2 text-sm font-bold text-neutral-700">
                      Counted quantity
                      <input
                        type="number"
                        min={editor.mode === 'OPENING' ? '0' : undefined}
                        step="0.01"
                        value={form.quantity}
                        onChange={(event) => setForm((current) => ({ ...current, quantity: event.target.value }))}
                        className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                      />
                    </label>
                    <label className="grid gap-2 text-sm font-bold text-neutral-700">
                      Unit
                      <input
                        type="text"
                        value={form.unit}
                        onChange={(event) => setForm((current) => ({ ...current, unit: event.target.value }))}
                        className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                      />
                    </label>
                    <label className="grid gap-2 text-sm font-bold text-neutral-700">
                      Cost per unit
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={editor.row.itemType === 'RAW_INGREDIENT' ? form.costPerUsageUnit : form.costPerUnit}
                        onChange={(event) => setForm((current) => (
                          editor.row.itemType === 'RAW_INGREDIENT'
                            ? { ...current, costPerUsageUnit: event.target.value }
                            : { ...current, costPerUnit: event.target.value }
                        ))}
                        className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                      />
                    </label>
                  </>
                )}

                <label className="grid gap-2 text-sm font-bold text-neutral-700 md:col-span-2">
                  Reason
                  <input
                    type="text"
                    value={form.reason}
                    onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
                    className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                  />
                </label>

                <label className="grid gap-2 text-sm font-bold text-neutral-700 md:col-span-2">
                  Notes
                  <textarea
                    rows={4}
                    value={form.notes}
                    onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                    className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033]"
                  />
                </label>
              </div>

              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
                {editor.mode === 'COST'
                  ? 'This updates master cost fields for future COGS only. A zero-quantity stock movement is written for audit.'
                  : editor.mode === 'OPENING'
                    ? 'This sets opening stock and current stock together, and writes an OPENING_STOCK movement.'
                    : 'This adjusts current stock to the counted value and writes a STOCK_CORRECTION movement.'}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-5 py-4">
              <button
                onClick={closeEditor}
                disabled={saving}
                className="rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm font-black text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveEditor}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-full bg-[#3e2723] px-4 py-2 text-sm font-black text-white hover:bg-[#2d1c19] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                Save correction
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
