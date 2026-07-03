import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  Coffee,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store } from '../../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StockItemType, StoreStock } from '../../types/menu-management';

type StatusTone = 'ready' | 'warning' | 'blocked';

type RequiredStockRow = {
  docId: string;
  stockItemType: StockItemType;
  stockItemCode: string;
  stockItemName: string;
  fallbackDocId?: string;
};

type ReadinessBlocker = {
  storeCode: string;
  stockItemType: string;
  stockItemCode: string;
  stockItemName: string;
  currentOpeningStock: number | null;
  currentCurrentStock: number | null;
  confirmedZero: boolean;
  blockerReason: string;
  severity: 'RED' | 'AMBER';
};

type KotCoverage = {
  barista: number;
  kitchen: number;
  both: number;
  none: number;
  missing: number;
};

type StoreReadiness = {
  storeId: string;
  storeCode: string;
  storeName: string;
  posSource: 'FINISHED_GOODS';
  activePosMenuItemCount: number;
  finishedGoodsAvailableCount: number;
  stockBlockers: ReadinessBlocker[];
  bomBlockers: ReadinessBlocker[];
  zeroCurrentStockCount: number;
  unconfirmedZeroCount: number;
  kotCoverage: KotCoverage;
  gstStatus: StoreGstStatus;
  tone: StatusTone;
  summary: string;
};

type StoreGstStatus = {
  configured: boolean;
  source: 'item' | 'store' | 'app' | 'missing';
  rateLabel: string;
  missingFinishedGoodsTaxCount: number;
  detail: string;
};

type AppGstConfig = {
  exists: boolean;
  defaultRate: number;
  defaultSource: string;
  storeOverrides: Record<string, number>;
};

type LoadedData = {
  stores: (Store & { id: string })[];
  rawIngredients: (RawIngredient & { id: string })[];
  prepItems: (PrepItem & { id: string })[];
  finishedGoods: (FinishedGood & { id: string })[];
  storeStock: (StoreStock & { id: string } & Record<string, unknown>)[];
  gstConfig: AppGstConfig;
};

type EspressoFixState = {
  stockRow: (StoreStock & { id: string } & Record<string, unknown>) | null;
  openingStock: number;
  currentStock: number;
  confirmedZero: boolean;
  canRestore: boolean;
  message: string;
};

const TARGET_STORE_CODES = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];
const ESPRESSO_STOCK_CODE = 'ESPRESSO_DOUBLE_RISTRETTO';
const ESPRESSO_FIX_CONFIRMATION = 'RESTORE ESPRESSO STOCK';
const GST_CONFIG_DOC_ID = 'gstConfig';
const GST_CONFIG_CONFIRMATION = 'SAVE GST CONFIG';
const TAX_SETTING_DOC_IDS = [GST_CONFIG_DOC_ID, 'tax', 'taxSettings', 'posSettings', 'settings'];
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

function cleanValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toNumber(value: unknown, fallback = 0): number {
  const cleaned = cleanValue(value).replace(/,/g, '');
  if (!cleaned) return fallback;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  const cleaned = cleanValue(value).replace(/,/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTaxRate(value: unknown): number {
  const parsed = toOptionalNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function pickTaxRate(data: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const rate = normalizeTaxRate(data[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, rate]) => {
    const normalizedRate = normalizeTaxRate(rate);
    if (normalizedRate > 0) acc[key] = normalizedRate;
    return acc;
  }, {});
}

function withId<T extends Record<string, unknown>>(id: string, data: T): T & { id: string } {
  return { id, ...data };
}

function getStockDocId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

function isStockItemType(value: string): value is StockItemType {
  return ['RAW_INGREDIENT', 'PREP_ITEM', 'BOUGHT_COMPONENT', 'FINISHED_GOOD', 'PACKAGING'].includes(value);
}

function isStockTrackedFinishedGood(fg: FinishedGood): boolean {
  return fg.itemType === 'MADE_TO_ORDER' || fg.itemType === 'DIRECT_STOCK' || fg.productionMode === 'MADE_TO_ORDER' || fg.productionMode === 'ASSEMBLED_TO_ORDER' || fg.productionMode === 'BOUGHT_AND_SOLD';
}

function usesBom(fg: FinishedGood): boolean {
  return fg.itemType === 'MADE_TO_ORDER'
    || (fg.itemType === 'DIRECT_STOCK' && Array.isArray(fg.bom) && fg.bom.length > 0)
    || fg.productionMode === 'MADE_TO_ORDER'
    || fg.productionMode === 'ASSEMBLED_TO_ORDER';
}

function isActiveSellableFinishedGood(fg: FinishedGood, storeId: string): boolean {
  const storeIds = Array.isArray(fg.availableStoreIds) ? fg.availableStoreIds : [];
  return fg.isActive !== false
    && fg.isSellable !== false
    && fg.isAvailable !== false
    && (storeIds.length === 0 || storeIds.includes(storeId));
}

function getConfirmedZero(stock: (StoreStock & Record<string, unknown>) | undefined): boolean {
  return stock?.confirmedZero === true;
}

function componentName(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient & { id: string }>,
  prepByCode: Map<string, PrepItem & { id: string }>,
  finishedByCode: Map<string, FinishedGood & { id: string }>,
): string {
  if (line.componentName) return line.componentName;
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING') {
    return rawByCode.get(line.componentCode)?.name || line.componentCode;
  }
  if (line.componentType === 'PREP_ITEM') {
    return prepByCode.get(line.componentCode)?.name || line.componentCode;
  }
  if (line.componentType === 'FINISHED_GOOD') {
    return finishedByCode.get(line.componentCode)?.name || line.componentCode;
  }
  return line.componentCode;
}

function componentMasterExists(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient & { id: string }>,
  prepByCode: Map<string, PrepItem & { id: string }>,
  finishedByCode: Map<string, FinishedGood & { id: string }>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING') {
    return rawByCode.has(line.componentCode);
  }
  if (line.componentType === 'PREP_ITEM') {
    return prepByCode.has(line.componentCode);
  }
  if (line.componentType === 'FINISHED_GOOD') {
    return finishedByCode.has(line.componentCode);
  }
  return true;
}

async function loadGstConfig(): Promise<AppGstConfig> {
  let defaultRate = 0;
  let defaultSource = 'No app GST fallback configured';
  let storeOverrides: Record<string, number> = {};
  let exists = false;

  for (const docId of TAX_SETTING_DOC_IDS) {
    const snap = await getDoc(doc(db, 'appSettings', docId));
    if (!snap.exists()) continue;

    exists = exists || docId === GST_CONFIG_DOC_ID;
    const data = snap.data() as Record<string, unknown>;
    if (docId === GST_CONFIG_DOC_ID) {
      storeOverrides = normalizeStoreOverrides(data.storeOverrides);
    }

    const pickedRate = pickTaxRate(data, APP_TAX_RATE_KEYS);
    if (pickedRate > 0) {
      defaultRate = pickedRate;
      defaultSource = `appSettings/${docId}`;
      break;
    }
  }

  return {
    exists,
    defaultRate,
    defaultSource,
    storeOverrides,
  };
}

async function loadReadinessData(): Promise<LoadedData> {
  const [storesSnap, rawSnap, prepSnap, finishedSnap, stockSnap, gstConfig] = await Promise.all([
    getDocs(collection(db, 'stores')),
    getDocs(collection(db, 'rawIngredients')),
    getDocs(collection(db, 'prepItems')),
    getDocs(collection(db, 'finishedGoods')),
    getDocs(collection(db, 'storeStock')),
    loadGstConfig(),
  ]);

  const allStores = storesSnap.docs.map((snap) => withId(snap.id, snap.data() as Store & Record<string, unknown>));
  const stores = TARGET_STORE_CODES
    .map((code) => allStores.find((store) => store.code === code && store.isActive))
    .filter((store): store is Store & Record<string, unknown> & { id: string } => !!store);

  return {
    stores,
    rawIngredients: rawSnap.docs.map((snap) => withId(snap.id, snap.data() as RawIngredient & Record<string, unknown>)),
    prepItems: prepSnap.docs.map((snap) => withId(snap.id, snap.data() as PrepItem & Record<string, unknown>)),
    finishedGoods: finishedSnap.docs.map((snap) => withId(snap.id, snap.data() as FinishedGood & Record<string, unknown>)),
    storeStock: stockSnap.docs.map((snap) => withId(snap.id, snap.data() as StoreStock & Record<string, unknown>)),
    gstConfig,
  };
}

function resolveStoreGstFallback(store: Store & { id: string }, gstConfig: AppGstConfig): { rate: number; source: 'store' | 'app' | 'missing'; detail: string } {
  const overrideRate = gstConfig.storeOverrides[store.id] || gstConfig.storeOverrides[store.code] || 0;
  if (overrideRate > 0) {
    return {
      rate: overrideRate,
      source: 'store',
      detail: `appSettings/${GST_CONFIG_DOC_ID}.storeOverrides.${store.code}`,
    };
  }

  const storeRate = pickTaxRate(store as unknown as Record<string, unknown>, STORE_TAX_RATE_KEYS);
  if (storeRate > 0) {
    return {
      rate: storeRate,
      source: 'store',
      detail: `stores/${store.id}`,
    };
  }

  if (gstConfig.defaultRate > 0) {
    return {
      rate: gstConfig.defaultRate,
      source: 'app',
      detail: gstConfig.defaultSource,
    };
  }

  return {
    rate: 0,
    source: 'missing',
    detail: 'No item, store, or app GST rate configured.',
  };
}

function buildStoreGstStatus(
  store: Store & { id: string },
  finishedGoods: (FinishedGood & { id: string })[],
  gstConfig: AppGstConfig,
): StoreGstStatus {
  const itemRates = finishedGoods
    .map((fg) => pickTaxRate(fg as unknown as Record<string, unknown>, ITEM_TAX_RATE_KEYS))
    .filter(rate => rate > 0);
  const missingFinishedGoodsTaxCount = Math.max(0, finishedGoods.length - itemRates.length);
  const uniqueItemRates = Array.from(new Set(itemRates));
  const fallback = resolveStoreGstFallback(store, gstConfig);

  if (missingFinishedGoodsTaxCount === 0 && finishedGoods.length > 0) {
    return {
      configured: true,
      source: 'item',
      rateLabel: uniqueItemRates.length === 1 ? `${uniqueItemRates[0]}%` : 'Mixed item rates',
      missingFinishedGoodsTaxCount,
      detail: 'Every active finished good has its own GST/tax rate.',
    };
  }

  if (fallback.rate > 0) {
    return {
      configured: true,
      source: fallback.source,
      rateLabel: `${fallback.rate}%`,
      missingFinishedGoodsTaxCount,
      detail: fallback.detail,
    };
  }

  return {
    configured: false,
    source: 'missing',
    rateLabel: '0%',
    missingFinishedGoodsTaxCount,
    detail: 'GST will calculate as 0 until item, store, or app GST is configured.',
  };
}

function buildStoreReadiness(data: LoadedData): StoreReadiness[] {
  const rawByCode = new Map(data.rawIngredients.map((raw) => [raw.code, raw]));
  const prepByCode = new Map(data.prepItems.map((prep) => [prep.code, prep]));
  const finishedByCode = new Map(data.finishedGoods.map((fg) => [fg.code, fg]));
  const stockById = new Map(data.storeStock.map((row) => [row.id, row]));

  return data.stores.map((store) => {
    const posSource = 'FINISHED_GOODS' as const;
    const finishedGoods = data.finishedGoods.filter((fg) => isActiveSellableFinishedGood(fg, store.id));
    const stockRowsForStore = data.storeStock.filter((stock) => stock.storeId === store.id);
    const requiredStockRows = new Map<string, RequiredStockRow>();
    const stockBlockers: ReadinessBlocker[] = [];
    const bomBlockers: ReadinessBlocker[] = [];

    const addRequiredStock = (requirement: RequiredStockRow) => {
      if (!requiredStockRows.has(requirement.docId)) {
        requiredStockRows.set(requirement.docId, requirement);
      }
    };

    finishedGoods.forEach((fg) => {
      if (isStockTrackedFinishedGood(fg) && usesBom(fg) && (!fg.bom || fg.bom.length === 0)) {
        bomBlockers.push({
          storeCode: store.code,
          stockItemType: 'FINISHED_GOOD',
          stockItemCode: fg.code,
          stockItemName: fg.displayName || fg.name,
          currentOpeningStock: null,
          currentCurrentStock: null,
          confirmedZero: false,
          blockerReason: 'Sellable FINISHED_GOODS item needs a BOM before checkout can safely deduct stock.',
          severity: 'RED',
        });
      }

      if (usesBom(fg)) {
        fg.bom?.forEach((line) => {
          if (!line.componentCode || !isStockItemType(line.componentType)) return;
          if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
            bomBlockers.push({
              storeCode: store.code,
              stockItemType: line.componentType,
              stockItemCode: line.componentCode,
              stockItemName: componentName(line, rawByCode, prepByCode, finishedByCode),
              currentOpeningStock: null,
              currentCurrentStock: null,
              confirmedZero: false,
              blockerReason: `Missing BOM component master for ${line.componentType} / ${line.componentCode}.`,
              severity: 'RED',
            });
          }
          const fallbackDocId = line.componentType === 'PACKAGING' ? getStockDocId(store.id, 'RAW_INGREDIENT', line.componentCode) : undefined;
          addRequiredStock({
            docId: getStockDocId(store.id, line.componentType, line.componentCode),
            stockItemType: line.componentType,
            stockItemCode: line.componentCode,
            stockItemName: componentName(line, rawByCode, prepByCode, finishedByCode),
            fallbackDocId,
          });
        });
      } else if (fg.itemType === 'DIRECT_STOCK' || fg.productionMode === 'BOUGHT_AND_SOLD') {
        addRequiredStock({
          docId: getStockDocId(store.id, 'FINISHED_GOOD', fg.code),
          stockItemType: 'FINISHED_GOOD',
          stockItemCode: fg.code,
          stockItemName: fg.displayName || fg.name,
        });
      }
    });

    requiredStockRows.forEach((requirement) => {
      const stock = stockById.get(requirement.docId) || (requirement.fallbackDocId ? stockById.get(requirement.fallbackDocId) : undefined);
      if (!stock) {
        stockBlockers.push({
          storeCode: store.code,
          stockItemType: requirement.stockItemType,
          stockItemCode: requirement.stockItemCode,
          stockItemName: requirement.stockItemName,
          currentOpeningStock: null,
          currentCurrentStock: null,
          confirmedZero: false,
          blockerReason: `Missing required stock row ${requirement.docId}.`,
          severity: 'RED',
        });
        return;
      }

      const openingStock = toNumber(stock.openingStock);
      const currentStock = toNumber(stock.currentStock);
      const confirmedZero = getConfirmedZero(stock);
      if ((openingStock <= 0 || currentStock <= 0) && !confirmedZero) {
        stockBlockers.push({
          storeCode: store.code,
          stockItemType: stock.stockItemType || requirement.stockItemType,
          stockItemCode: stock.stockItemCode || requirement.stockItemCode,
          stockItemName: stock.stockItemName || requirement.stockItemName,
          currentOpeningStock: openingStock,
          currentCurrentStock: currentStock,
          confirmedZero,
          blockerReason: 'Opening/current stock must be greater than 0 unless confirmedZero is TRUE.',
          severity: 'RED',
        });
      }
    });

    const zeroCurrentStockCount = stockRowsForStore.filter((stock) => toNumber(stock.currentStock) <= 0).length;
    const unconfirmedZeroCount = stockRowsForStore.filter((stock) => toNumber(stock.currentStock) <= 0 && !getConfirmedZero(stock)).length;
    const activePosItems = finishedGoods;
    const kotCoverage = activePosItems.reduce<KotCoverage>((counts, item) => {
      const station = (item as { prepStation?: string }).prepStation || 'NONE';
      if (station === 'BARISTA') counts.barista += 1;
      else if (station === 'KITCHEN') counts.kitchen += 1;
      else if (station === 'BOTH') counts.both += 1;
      else if (station === 'NONE') counts.none += 1;
      else counts.missing += 1;
      return counts;
    }, { barista: 0, kitchen: 0, both: 0, none: 0, missing: 0 });

    const hasCheckoutBlockers = activePosItems.length === 0 || stockBlockers.length > 0 || bomBlockers.length > 0;
    const gstStatus = buildStoreGstStatus(store, finishedGoods, data.gstConfig);
    const tone: StatusTone = hasCheckoutBlockers
      ? 'blocked'
      : unconfirmedZeroCount > 0 || kotCoverage.missing > 0 || !gstStatus.configured
        ? 'warning'
        : 'ready';
    const summary = tone === 'blocked'
      ? activePosItems.length === 0 ? 'No active Finished Goods are available for billing.' : 'Checkout will fail for at least one item.'
      : tone === 'warning'
        ? 'Checkout can proceed, but review warnings.'
        : 'Ready for billing.';

    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      posSource,
      activePosMenuItemCount: activePosItems.length,
      finishedGoodsAvailableCount: finishedGoods.length,
      stockBlockers,
      bomBlockers,
      zeroCurrentStockCount,
      unconfirmedZeroCount,
      kotCoverage,
      gstStatus,
      tone,
      summary,
    };
  });
}

function getToneClasses(tone: StatusTone): string {
  if (tone === 'blocked') return 'bg-red-50 border-red-200 text-red-900';
  if (tone === 'warning') return 'bg-amber-50 border-amber-200 text-amber-900';
  return 'bg-emerald-50 border-emerald-200 text-emerald-900';
}

function getToneIcon(tone: StatusTone) {
  if (tone === 'blocked') return <XCircle size={20} className="text-red-600" />;
  if (tone === 'warning') return <ShieldAlert size={20} className="text-amber-600" />;
  return <CheckCircle2 size={20} className="text-emerald-600" />;
}

function buildEspressoFixState(data: LoadedData | null): EspressoFixState {
  const udayStore = data?.stores.find((store) => store.code === 'UDAY_PARK');
  if (!data || !udayStore) {
    return {
      stockRow: null,
      openingStock: 0,
      currentStock: 0,
      confirmedZero: false,
      canRestore: false,
      message: 'Uday Park store is not loaded.',
    };
  }

  const stockRow = data.storeStock.find((stock) => (
    stock.storeId === udayStore.id
    && stock.stockItemType === 'PREP_ITEM'
    && stock.stockItemCode === ESPRESSO_STOCK_CODE
  )) || null;

  if (!stockRow) {
    return {
      stockRow: null,
      openingStock: 0,
      currentStock: 0,
      confirmedZero: false,
      canRestore: false,
      message: `Missing Uday Park stock row for PREP_ITEM / ${ESPRESSO_STOCK_CODE}.`,
    };
  }

  const openingStock = toNumber(stockRow.openingStock);
  const currentStock = toNumber(stockRow.currentStock);
  const confirmedZero = getConfirmedZero(stockRow);
  const canRestore = openingStock > 0 && currentStock <= 0 && !confirmedZero;

  return {
    stockRow,
    openingStock,
    currentStock,
    confirmedZero,
    canRestore,
    message: canRestore
      ? 'Known espresso blocker detected. This can be restored from opening stock.'
      : 'No restore needed for this espresso stock row.',
  };
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: 'neutral' | 'red' | 'amber' | 'green' }) {
  const toneClass = tone === 'red'
    ? 'bg-red-50 text-red-900 border-red-200'
    : tone === 'amber'
      ? 'bg-amber-50 text-amber-900 border-amber-200'
      : tone === 'green'
        ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
        : 'bg-white text-neutral-800 border-neutral-200';
  return (
    <div className={`rounded-xl border p-3 ${toneClass}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-70">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  );
}

function BlockerTable({ blockers }: { blockers: ReadinessBlocker[] }) {
  if (blockers.length === 0) return null;
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-red-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-red-50 text-red-900">
          <tr className="text-left">
            <th className="py-2 px-3">Type</th>
            <th className="py-2 px-3">Code</th>
            <th className="py-2 px-3">Name</th>
            <th className="py-2 px-3">Opening</th>
            <th className="py-2 px-3">Current</th>
            <th className="py-2 px-3">confirmedZero</th>
            <th className="py-2 px-3">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-red-100">
          {blockers.map((blocker, index) => (
            <tr key={`${blocker.storeCode}_${blocker.stockItemType}_${blocker.stockItemCode}_${index}`}>
              <td className="py-2 px-3 font-bold">{blocker.stockItemType}</td>
              <td className="py-2 px-3 font-mono">{blocker.stockItemCode}</td>
              <td className="py-2 px-3">{blocker.stockItemName}</td>
              <td className="py-2 px-3 font-mono">{blocker.currentOpeningStock ?? '-'}</td>
              <td className="py-2 px-3 font-mono">{blocker.currentCurrentStock ?? '-'}</td>
              <td className="py-2 px-3">{blocker.confirmedZero ? 'TRUE' : 'FALSE'}</td>
              <td className="py-2 px-3 text-red-800">{blocker.blockerReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function POSReadiness() {
  const { staffProfile } = useAuth();
  const [data, setData] = useState<LoadedData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [confirmationText, setConfirmationText] = useState('');
  const [gstDefaultRateInput, setGstDefaultRateInput] = useState('');
  const [gstStoreRateInputs, setGstStoreRateInputs] = useState<Record<string, string>>({});
  const [gstConfirmationText, setGstConfirmationText] = useState('');
  const [isSavingGst, setIsSavingGst] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState('');

  const isAdmin = staffProfile?.role === 'ADMIN';
  const readiness = useMemo(() => data ? buildStoreReadiness(data) : [], [data]);
  const espressoFix = useMemo(() => buildEspressoFixState(data), [data]);

  const refresh = async () => {
    setIsLoading(true);
    setError('');
    try {
      const loaded = await loadReadinessData();
      setData(loaded);
      setRefreshedAt(new Date().toLocaleString());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load POS readiness data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!data) return;
    setGstDefaultRateInput(data.gstConfig.defaultRate > 0 ? String(data.gstConfig.defaultRate) : '');
    setGstStoreRateInputs(data.stores.reduce<Record<string, string>>((acc, store) => {
      const rate = data.gstConfig.storeOverrides[store.id] || data.gstConfig.storeOverrides[store.code] || 0;
      acc[store.id] = rate > 0 ? String(rate) : '';
      return acc;
    }, {}));
  }, [data]);

  const saveGstConfig = async () => {
    if (!isAdmin) {
      setError('Admin access is required to update GST settings.');
      return;
    }
    if (!data) {
      setError('Readiness data is still loading.');
      return;
    }
    if (gstConfirmationText.trim() !== GST_CONFIG_CONFIRMATION) {
      setError(`Type ${GST_CONFIG_CONFIRMATION} to confirm this GST configuration update.`);
      return;
    }

    const defaultRate = toOptionalNumber(gstDefaultRateInput) || 0;
    if (defaultRate < 0 || defaultRate > 100) {
      setError('Default GST rate must be between 0 and 100.');
      return;
    }

    const storeOverrides: Record<string, number> = {};
    for (const store of data.stores) {
      const rawValue = cleanValue(gstStoreRateInputs[store.id]);
      if (!rawValue) continue;
      const rate = toOptionalNumber(rawValue);
      if (rate === null || rate < 0 || rate > 100) {
        setError(`GST override for ${store.name} must be between 0 and 100.`);
        return;
      }
      if (rate > 0) storeOverrides[store.id] = rate;
    }

    if (defaultRate <= 0 && Object.keys(storeOverrides).length === 0) {
      setError('Enter a positive default GST rate or at least one positive store GST override.');
      return;
    }

    if (!window.confirm('Save GST settings for POS V2? This updates appSettings/gstConfig only and does not modify historical orders.')) {
      return;
    }

    setIsSavingGst(true);
    setError('');
    setSuccessMessage('');

    try {
      const adminName = staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin';
      await setDoc(doc(db, 'appSettings', GST_CONFIG_DOC_ID), {
        defaultGstRate: defaultRate,
        storeOverrides,
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile?.uid || '',
        updatedByName: adminName,
        ...(data.gstConfig.exists ? {} : { createdAt: serverTimestamp(), createdByUserId: staffProfile?.uid || '', createdByName: adminName }),
      }, { merge: true });

      setSuccessMessage('GST configuration saved. Readiness has been refreshed.');
      setGstConfirmationText('');
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to save GST configuration.');
    } finally {
      setIsSavingGst(false);
    }
  };

  const restoreEspressoStock = async () => {
    if (!isAdmin) {
      setError('Admin access is required for this stock fix.');
      return;
    }
    if (!espressoFix.stockRow || !espressoFix.canRestore) {
      setError('Espresso stock restore is not available for the current data.');
      return;
    }
    if (confirmationText.trim() !== ESPRESSO_FIX_CONFIRMATION) {
      setError(`Type ${ESPRESSO_FIX_CONFIRMATION} to confirm this stock adjustment.`);
      return;
    }
    if (!window.confirm('Restore ESPRESSO_DOUBLE_RISTRETTO current stock from opening stock for Uday Park only?')) {
      return;
    }

    setIsRestoring(true);
    setError('');
    setSuccessMessage('');

    try {
      const stockRow = espressoFix.stockRow;
      const restoreQuantity = espressoFix.openingStock - espressoFix.currentStock;
      if (restoreQuantity <= 0) throw new Error('Restore quantity is not positive.');
      const adminName = staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin';
      const movementRef = doc(collection(db, 'stockMovements'));

      await setDoc(doc(db, 'storeStock', stockRow.id), {
        currentStock: espressoFix.openingStock,
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile?.uid || '',
        updatedByName: adminName,
        phase8AReadinessFix: true,
      }, { merge: true });

      await setDoc(movementRef, {
        storeId: stockRow.storeId,
        storeName: stockRow.storeName,
        inventoryItemId: stockRow.stockItemCode,
        inventoryItemName: stockRow.stockItemName,
        movementType: 'ADJUSTMENT',
        quantity: restoreQuantity,
        unit: stockRow.uom,
        referenceType: 'MANUAL',
        referenceId: stockRow.id,
        reason: 'ADMIN_READINESS_FIX',
        notes: 'ADMIN_READINESS_FIX: Restored current stock from opening stock on POS Readiness screen.',
        createdByUserId: staffProfile?.uid || '',
        createdByName: adminName,
        createdAt: serverTimestamp(),
        stockSystem: 'MENU_MANAGEMENT',
        stockItemType: stockRow.stockItemType,
        stockItemCode: stockRow.stockItemCode,
      });

      setSuccessMessage('Espresso current stock restored from opening stock. Readiness has been refreshed.');
      setConfirmationText('');
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to restore espresso stock.');
    } finally {
      setIsRestoring(false);
    }
  };

  if (isLoading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#5c4033]" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full pb-20 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-emerald-700 uppercase tracking-wide">Phase 8A</p>
          <h1 className="text-3xl font-black text-[#5c4033]">POS Go-Live Readiness</h1>
          <p className="text-neutral-600 mt-2">
            Single-source POS V2 checks for Finished Goods menu availability, stock, BOM, and KOT routing.
          </p>
          {refreshedAt && <p className="text-xs text-neutral-500 mt-1">Last refreshed: {refreshedAt}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={isLoading}
            className="px-4 py-2 bg-white border border-neutral-200 rounded-xl font-bold text-neutral-700 hover:bg-neutral-50 disabled:opacity-60 flex items-center gap-2"
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
          <Link to="/admin" className="px-4 py-2 bg-[#5c4033] text-white rounded-xl font-bold hover:bg-[#4a332a]">
            Admin Dashboard
          </Link>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-2xl flex gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <p className="font-bold">{error}</p>
        </div>
      )}

      {successMessage && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-4 rounded-2xl flex gap-3">
          <CheckCircle2 size={20} className="shrink-0 mt-0.5" />
          <p className="font-bold">{successMessage}</p>
        </div>
      )}

      <div className="bg-white border border-neutral-200 rounded-2xl p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center shrink-0">
              <Wrench size={24} />
            </div>
            <div>
              <h2 className="text-xl font-black text-neutral-900">Uday Park Espresso Stock Fix</h2>
              <p className="text-sm text-neutral-600 mt-1">{espressoFix.message}</p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm">
                <div><span className="font-bold text-neutral-500">Item</span><p className="font-mono">{ESPRESSO_STOCK_CODE}</p></div>
                <div><span className="font-bold text-neutral-500">Opening</span><p className="font-mono">{espressoFix.openingStock}</p></div>
                <div><span className="font-bold text-neutral-500">Current</span><p className="font-mono">{espressoFix.currentStock}</p></div>
                <div><span className="font-bold text-neutral-500">confirmedZero</span><p>{espressoFix.confirmedZero ? 'TRUE' : 'FALSE'}</p></div>
              </div>
            </div>
          </div>
          <div className="w-full md:w-80 space-y-3">
            <input
              type="text"
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              placeholder={ESPRESSO_FIX_CONFIRMATION}
              disabled={!espressoFix.canRestore || isRestoring}
              className="w-full px-3 py-2 border border-neutral-200 rounded-xl font-mono text-sm outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] disabled:bg-neutral-100"
            />
            <button
              type="button"
              onClick={restoreEspressoStock}
              disabled={!espressoFix.canRestore || confirmationText.trim() !== ESPRESSO_FIX_CONFIRMATION || isRestoring || !isAdmin}
              className="w-full px-4 py-3 bg-amber-600 text-white rounded-xl font-black hover:bg-amber-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isRestoring ? <Loader2 size={18} className="animate-spin" /> : <Coffee size={18} />}
              Restore Current Stock from Opening Stock
            </button>
            <p className="text-xs text-neutral-500">
              Writes only the Uday Park storeStock row and one stockMovements audit record after confirmation.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-2xl p-4 flex gap-3">
        <AlertCircle size={20} className="shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-black">POS V2 is the single source for billing.</p>
          <p>The billing screen uses Finished Goods, BOM, prep components, and storeStock for every Coffee Bond store.</p>
        </div>
      </div>

      {isAdmin && data && (
        <div className="bg-white border border-neutral-200 rounded-2xl p-5 shadow-sm">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5">
            <div>
              <h2 className="text-xl font-black text-neutral-900">GST Configuration</h2>
              <p className="text-sm text-neutral-600 mt-1">
                Checkout uses item GST first, then store GST override, then this app default. Historical orders are not changed.
              </p>
              <div className="mt-3 text-xs text-neutral-500">
                <p><strong>Current app default:</strong> {data.gstConfig.defaultRate > 0 ? `${data.gstConfig.defaultRate}%` : 'Not configured'}</p>
                <p><strong>Source:</strong> {data.gstConfig.defaultSource}</p>
              </div>
            </div>
            <div className="w-full lg:max-w-2xl space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Default GST rate (%)</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={gstDefaultRateInput}
                    onChange={(event) => setGstDefaultRateInput(event.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-neutral-200 rounded-xl font-mono outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                    placeholder="5"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Confirmation</span>
                  <input
                    type="text"
                    value={gstConfirmationText}
                    onChange={(event) => setGstConfirmationText(event.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-neutral-200 rounded-xl font-mono text-sm outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                    placeholder={GST_CONFIG_CONFIRMATION}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {data.stores.map((store) => (
                  <label key={store.id} className="block">
                    <span className="text-xs font-black uppercase tracking-widest text-neutral-500">{store.name} override (%)</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={gstStoreRateInputs[store.id] || ''}
                      onChange={(event) => setGstStoreRateInputs(prev => ({ ...prev, [store.id]: event.target.value }))}
                      className="mt-1 w-full px-3 py-2 border border-neutral-200 rounded-xl font-mono outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                      placeholder="Optional"
                    />
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={saveGstConfig}
                disabled={isSavingGst || gstConfirmationText.trim() !== GST_CONFIG_CONFIRMATION}
                className="w-full md:w-auto px-4 py-3 bg-[#5c4033] text-white rounded-xl font-black hover:bg-[#4a332a] disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                {isSavingGst ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                Save GST Configuration
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5">
        {readiness.map((store) => {
          const blockers = [...store.stockBlockers, ...store.bomBlockers];
          return (
            <section key={store.storeId} className={`rounded-2xl border p-5 shadow-sm ${getToneClasses(store.tone)}`}>
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1">{getToneIcon(store.tone)}</div>
                  <div>
                    <h2 className="text-2xl font-black">{store.storeName}</h2>
                    <p className="font-mono text-xs opacity-70">{store.storeCode}</p>
                    <p className="mt-2 font-bold">{store.summary}</p>
                  </div>
                </div>
                <div className="text-left lg:text-right text-sm">
                  <p className="font-bold uppercase tracking-wide opacity-70">POS Source</p>
                  <p className="text-lg font-black font-mono">{store.posSource}</p>
                  <p className="text-xs font-bold opacity-70">Finished Goods Menu</p>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-9 gap-3">
                <Stat label="Active Finished Goods" value={store.activePosMenuItemCount} tone={store.activePosMenuItemCount ? 'green' : 'red'} />
                <Stat label="Finished Goods Menu" value={store.finishedGoodsAvailableCount} />
                <Stat label="Stock Blockers" value={store.stockBlockers.length} tone={store.stockBlockers.length ? 'red' : 'green'} />
                <Stat label="BOM Blockers" value={store.bomBlockers.length} tone={store.bomBlockers.length ? 'red' : 'green'} />
                <Stat label="Current <= 0" value={store.zeroCurrentStockCount} tone={store.zeroCurrentStockCount ? 'amber' : 'green'} />
                <Stat label="Zero Not Confirmed" value={store.unconfirmedZeroCount} tone={store.unconfirmedZeroCount ? 'amber' : 'green'} />
                <Stat label="KOT Missing" value={store.kotCoverage.missing} tone={store.kotCoverage.missing ? 'amber' : 'green'} />
                <Stat label="GST Configured" value={store.gstStatus.configured ? 'Yes' : 'No'} tone={store.gstStatus.configured ? 'green' : 'amber'} />
                <Stat label="Missing Item GST" value={store.gstStatus.missingFinishedGoodsTaxCount} tone={store.gstStatus.missingFinishedGoodsTaxCount ? 'amber' : 'green'} />
              </div>

              <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="bg-white/70 border border-white/70 rounded-xl p-4">
                  <p className="text-sm font-black mb-2">KOT Station Coverage</p>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
                    <span>Barista: <strong>{store.kotCoverage.barista}</strong></span>
                    <span>Kitchen: <strong>{store.kotCoverage.kitchen}</strong></span>
                    <span>Both: <strong>{store.kotCoverage.both}</strong></span>
                    <span>No KOT: <strong>{store.kotCoverage.none}</strong></span>
                    <span>Missing: <strong>{store.kotCoverage.missing}</strong></span>
                  </div>
                </div>

                <div className="bg-white/70 border border-white/70 rounded-xl p-4">
                  <p className="text-sm font-black mb-2">GST Status</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                    <span>Configured: <strong>{store.gstStatus.configured ? 'Yes' : 'No'}</strong></span>
                    <span>Source: <strong>{store.gstStatus.source}</strong></span>
                    <span>Rate used: <strong>{store.gstStatus.rateLabel}</strong></span>
                    <span>Missing item GST: <strong>{store.gstStatus.missingFinishedGoodsTaxCount}</strong></span>
                  </div>
                  <p className="mt-2 text-xs font-bold opacity-70 break-words">{store.gstStatus.detail}</p>
                </div>
              </div>

              <BlockerTable blockers={blockers} />
            </section>
          );
        })}
      </div>
    </div>
  );
}
