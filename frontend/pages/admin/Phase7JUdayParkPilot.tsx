import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  FileSearch,
  Loader2,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store } from '../../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StockItemType, StoreStock } from '../../types/menu-management';

type PosSource = 'LEGACY_MENU_ITEMS' | 'FINISHED_GOODS';

type PosSourceSettings = {
  globalSource: PosSource;
  storeOverrides: Record<string, PosSource>;
};

type RequiredStockRow = {
  docId: string;
  stockItemType: StockItemType;
  stockItemCode: string;
  stockItemName: string;
  fallbackDocId?: string;
};

type ReadinessStatus = {
  storeId: string;
  storeCode: string;
  storeName: string;
  costingComplete: boolean;
  stockLoaded: boolean;
  checkoutSafe: boolean;
  eligibleForFinishedGoodsPilot: boolean;
  costingIssues: number;
  stockIssues: number;
  checkoutIssues: number;
};

type LoadedData = {
  settings: PosSourceSettings;
  stores: (Store & { id: string })[];
  readiness: ReadinessStatus[];
};

type DryRunPreview = {
  beforeSettings: PosSourceSettings;
  afterSettings: PosSourceSettings;
  affectedStore: Store & { id: string };
  unaffectedStores: (Store & { id: string })[];
  readiness: ReadinessStatus;
  blockers: string[];
};

type LiveSummary = {
  importBatchId: string;
  manifestId: string;
  action: 'PILOT_SWITCH' | 'ROLLBACK';
};

const REQUIRED_STORE_CODES = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];
const UDAY_PARK_CODE = 'UDAY_PARK';
const LIVE_CONFIRMATION = 'I understand this will switch only Uday Park POS menu source to FINISHED_GOODS.';
const ROLLBACK_CONFIRMATION = 'I understand this will remove the Uday Park FINISHED_GOODS pilot override.';

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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function withId<T extends Record<string, unknown>>(id: string, data: T): T & { id: string } {
  return { id, ...data };
}

function normalizeSource(value: unknown): PosSource {
  return value === 'FINISHED_GOODS' ? 'FINISHED_GOODS' : 'LEGACY_MENU_ITEMS';
}

function normalizeOverrides(value: unknown): Record<string, PosSource> {
  if (!value || typeof value !== 'object') return {};
  const overrides: Record<string, PosSource> = {};
  Object.entries(value as Record<string, unknown>).forEach(([storeId, source]) => {
    if (source === 'FINISHED_GOODS' || source === 'LEGACY_MENU_ITEMS') {
      overrides[storeId] = source;
    }
  });
  return overrides;
}

function getStockDocId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

function isStockItemType(value: string): value is StockItemType {
  return ['RAW_INGREDIENT', 'PREP_ITEM', 'BOUGHT_COMPONENT', 'FINISHED_GOOD', 'PACKAGING'].includes(value);
}

function getExistingConfirmedZero(stock: unknown): boolean {
  return !!stock && typeof stock === 'object' && (stock as { confirmedZero?: unknown }).confirmedZero === true;
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

function buildReadiness(
  stores: (Store & { id: string })[],
  rawIngredients: (RawIngredient & { id: string })[],
  stockRows: (StoreStock & { id: string })[],
  finishedGoods: (FinishedGood & { id: string })[],
  prepItems: (PrepItem & { id: string })[],
): ReadinessStatus[] {
  const rawByCode = new Map(rawIngredients.map((raw) => [raw.code, raw]));
  const prepByCode = new Map(prepItems.map((prep) => [prep.code, prep]));
  const finishedByCode = new Map(finishedGoods.map((finishedGood) => [finishedGood.code, finishedGood]));
  const stockById = new Map(stockRows.map((row) => [row.id, row]));
  const activeRawCodes = rawIngredients.filter((raw) => raw.isActive !== false).map((raw) => raw.code);

  return stores.map((store) => {
    const costingIssues = activeRawCodes.filter((code) => {
      const raw = rawByCode.get(code);
      return toNumber(raw?.purchaseCost) <= 0 || toNumber(raw?.conversionFactor) <= 0;
    }).length;
    const activeSellable = finishedGoods.filter((fg) => (
      fg.isActive !== false
      && fg.isSellable !== false
      && (!Array.isArray(fg.availableStoreIds) || fg.availableStoreIds.length === 0 || fg.availableStoreIds.includes(store.id))
    ));
    const requiredStockRows = new Map<string, RequiredStockRow>();
    let checkoutIssues = 0;

    const addRequiredStock = (requirement: RequiredStockRow) => {
      if (!requiredStockRows.has(requirement.docId)) {
        requiredStockRows.set(requirement.docId, requirement);
      }
    };

    activeSellable.forEach((fg) => {
      const usesBom = fg.itemType === 'MADE_TO_ORDER' || (fg.itemType === 'DIRECT_STOCK' && Array.isArray(fg.bom) && fg.bom.length > 0);
      if ((fg.productionMode === 'MADE_TO_ORDER' || fg.productionMode === 'ASSEMBLED_TO_ORDER' || usesBom) && (!fg.bom || fg.bom.length === 0)) {
        checkoutIssues += 1;
      }

      if (usesBom) {
        fg.bom?.forEach((line) => {
          if (!line.componentCode || !isStockItemType(line.componentType)) return;
          const stockItemType = line.componentType;
          const fallbackDocId = stockItemType === 'PACKAGING' ? getStockDocId(store.id, 'RAW_INGREDIENT', line.componentCode) : undefined;
          addRequiredStock({
            docId: getStockDocId(store.id, stockItemType, line.componentCode),
            stockItemType,
            stockItemCode: line.componentCode,
            stockItemName: componentName(line, rawByCode, prepByCode, finishedByCode),
            fallbackDocId,
          });
        });
      } else if (fg.itemType === 'DIRECT_STOCK') {
        addRequiredStock({
          docId: getStockDocId(store.id, 'FINISHED_GOOD', fg.code),
          stockItemType: 'FINISHED_GOOD',
          stockItemCode: fg.code,
          stockItemName: fg.name,
        });
      }
    });

    let stockIssues = 0;
    requiredStockRows.forEach((requirement) => {
      const existing = stockById.get(requirement.docId) || (requirement.fallbackDocId ? stockById.get(requirement.fallbackDocId) : undefined);
      if (!existing) {
        stockIssues += 1;
        checkoutIssues += 1;
        return;
      }

      if ((toNumber(existing.openingStock) <= 0 || toNumber(existing.currentStock) <= 0) && !getExistingConfirmedZero(existing)) {
        stockIssues += 1;
        checkoutIssues += 1;
      }
    });

    const costingComplete = costingIssues === 0;
    const stockLoaded = stockIssues === 0;
    const checkoutSafe = costingComplete && stockLoaded && checkoutIssues === 0;

    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      costingComplete,
      stockLoaded,
      checkoutSafe,
      eligibleForFinishedGoodsPilot: checkoutSafe,
      costingIssues,
      stockIssues,
      checkoutIssues,
    };
  });
}

async function loadPilotData(): Promise<LoadedData> {
  const [settingsDoc, rawSnap, stockSnap, storesSnap, finishedSnap, prepSnap] = await Promise.all([
    getDoc(doc(db, 'appSettings', 'posMenuSource')),
    getDocs(collection(db, 'rawIngredients')),
    getDocs(collection(db, 'storeStock')),
    getDocs(collection(db, 'stores')),
    getDocs(collection(db, 'finishedGoods')),
    getDocs(collection(db, 'prepItems')),
  ]);

  const settingsData = settingsDoc.exists() ? settingsDoc.data() as Record<string, unknown> : {};
  const settings = {
    globalSource: normalizeSource(settingsData.globalSource || settingsData.source),
    storeOverrides: normalizeOverrides(settingsData.storeOverrides),
  };
  const rawIngredients = rawSnap.docs.map((snap) => withId(snap.id, snap.data() as RawIngredient & Record<string, unknown>));
  const storeStock = stockSnap.docs.map((snap) => withId(snap.id, snap.data() as StoreStock & Record<string, unknown>));
  const stores = storesSnap.docs.map((snap) => withId(snap.id, snap.data() as Store & Record<string, unknown>));
  const finishedGoods = finishedSnap.docs.map((snap) => withId(snap.id, snap.data() as FinishedGood & Record<string, unknown>));
  const prepItems = prepSnap.docs.map((snap) => withId(snap.id, snap.data() as PrepItem & Record<string, unknown>));
  const targetStores = REQUIRED_STORE_CODES
    .map((code) => stores.find((store) => store.code === code && store.isActive))
    .filter((store): store is Store & Record<string, unknown> & { id: string } => !!store);

  return {
    settings,
    stores: targetStores,
    readiness: buildReadiness(targetStores, rawIngredients, storeStock, finishedGoods, prepItems),
  };
}

function effectiveSource(settings: PosSourceSettings, storeId: string): PosSource {
  return settings.storeOverrides[storeId] || settings.globalSource;
}

function buildPilotOverrides(settings: PosSourceSettings, udayStoreId: string): Record<string, PosSource> {
  return {
    ...settings.storeOverrides,
    [udayStoreId]: 'FINISHED_GOODS',
  };
}

function buildRollbackOverrides(settings: PosSourceSettings, udayStoreId: string): Record<string, PosSource> {
  const nextOverrides = { ...settings.storeOverrides };
  delete nextOverrides[udayStoreId];
  return nextOverrides;
}

function findNonUdayFinishedOverrides(settings: PosSourceSettings, udayStoreId: string): string[] {
  return Object.entries(settings.storeOverrides)
    .filter(([storeId, source]) => storeId !== udayStoreId && source === 'FINISHED_GOODS')
    .map(([storeId]) => storeId);
}

export default function Phase7JUdayParkPilot() {
  const { staffProfile } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isWritingLive, setIsWritingLive] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<LoadedData | null>(null);
  const [preview, setPreview] = useState<DryRunPreview | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [rollbackConfirmationText, setRollbackConfirmationText] = useState('');
  const [liveSummary, setLiveSummary] = useState<LiveSummary | null>(null);

  const isAdmin = staffProfile?.role === 'ADMIN';
  const udayStore = data?.stores.find((store) => store.code === UDAY_PARK_CODE);
  const udayReadiness = udayStore ? data?.readiness.find((status) => status.storeId === udayStore.id) : undefined;
  const udayIsEligible = !!udayReadiness?.eligibleForFinishedGoodsPilot;
  const currentUdaySource = data && udayStore ? effectiveSource(data.settings, udayStore.id) : 'LEGACY_MENU_ITEMS';
  const nonUdayFinishedOverrides = data && udayStore ? findNonUdayFinishedOverrides(data.settings, udayStore.id) : [];
  const liveReady = !!preview
    && isAdmin
    && udayIsEligible
    && preview.blockers.length === 0
    && confirmationText.trim() === LIVE_CONFIRMATION
    && !isWritingLive;
  const rollbackReady = !!data
    && !!udayStore
    && isAdmin
    && data.settings.globalSource === 'LEGACY_MENU_ITEMS'
    && data.settings.storeOverrides[udayStore.id] === 'FINISHED_GOODS'
    && rollbackConfirmationText.trim() === ROLLBACK_CONFIRMATION
    && !isRollingBack;

  const refresh = async () => {
    setIsLoading(true);
    setError('');
    try {
      const loaded = await loadPilotData();
      setData(loaded);
      setPreview(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load Phase 7J pilot data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const runPreview = async () => {
    setIsPreviewing(true);
    setError('');
    setLiveSummary(null);

    try {
      const loaded = await loadPilotData();
      const pilotStore = loaded.stores.find((store) => store.code === UDAY_PARK_CODE);
      const blockers: string[] = [];
      if (!isAdmin) blockers.push('Current user is not ADMIN.');
      if (!pilotStore) blockers.push('Uday Park store is missing or inactive.');
      if (loaded.settings.globalSource !== 'LEGACY_MENU_ITEMS') blockers.push(`globalSource is ${loaded.settings.globalSource}; Phase 7J requires LEGACY_MENU_ITEMS.`);

      const pilotReadiness = pilotStore ? loaded.readiness.find((status) => status.storeId === pilotStore.id) : undefined;
      if (!pilotReadiness?.eligibleForFinishedGoodsPilot) blockers.push('Uday Park is not fully eligible for FINISHED_GOODS pilot.');

      if (pilotStore) {
        const otherFinishedOverrides = findNonUdayFinishedOverrides(loaded.settings, pilotStore.id);
        if (otherFinishedOverrides.length > 0) {
          blockers.push(`Non-Uday FINISHED_GOODS overrides already exist: ${otherFinishedOverrides.join(', ')}.`);
        }
      }

      if (!pilotStore || !pilotReadiness) {
        setData(loaded);
        setPreview(null);
        if (blockers.length > 0) setError(blockers.join(' '));
        return;
      }

      const afterSettings = {
        globalSource: 'LEGACY_MENU_ITEMS' as PosSource,
        storeOverrides: buildPilotOverrides(loaded.settings, pilotStore.id),
      };
      setData(loaded);
      setPreview({
        beforeSettings: loaded.settings,
        afterSettings,
        affectedStore: pilotStore,
        unaffectedStores: loaded.stores.filter((store) => store.id !== pilotStore.id),
        readiness: pilotReadiness,
        blockers,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Phase 7J dry-run preview failed.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const runLiveSwitch = async () => {
    if (!preview || preview.blockers.length > 0) {
      setError('Live switch is blocked until the dry-run preview has zero blockers.');
      return;
    }
    if (!liveReady) {
      setError('Live switch is not ready. Check Admin role, readiness, global source, and confirmation text.');
      return;
    }
    if (!window.confirm(`${LIVE_CONFIRMATION}\n\nThis writes only appSettings/posMenuSource and importManifests audit data. Continue?`)) {
      return;
    }

    setIsWritingLive(true);
    setError('');
    setLiveSummary(null);
    let importBatchId = '';

    try {
      const latest = await loadPilotData();
      const pilotStore = latest.stores.find((store) => store.code === UDAY_PARK_CODE);
      if (!pilotStore) throw new Error('Uday Park store is missing or inactive.');
      const latestReadiness = latest.readiness.find((status) => status.storeId === pilotStore.id);
      if (!latestReadiness?.eligibleForFinishedGoodsPilot) throw new Error('Live switch blocked because Uday Park is no longer eligible.');
      if (latest.settings.globalSource !== 'LEGACY_MENU_ITEMS') throw new Error(`Live switch blocked because globalSource is ${latest.settings.globalSource}.`);
      const otherFinishedOverrides = findNonUdayFinishedOverrides(latest.settings, pilotStore.id);
      if (otherFinishedOverrides.length > 0) throw new Error(`Live switch blocked because non-Uday FINISHED_GOODS overrides exist: ${otherFinishedOverrides.join(', ')}.`);

      const beforeSettings = latest.settings;
      const afterSettings = {
        globalSource: 'LEGACY_MENU_ITEMS' as PosSource,
        storeOverrides: buildPilotOverrides(latest.settings, pilotStore.id),
      };
      importBatchId = `phase7j-pilot-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const adminName = staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin';
      const manifestRef = doc(db, 'importManifests', importBatchId);

      await setDoc(manifestRef, {
        importBatchId,
        phase: 'PHASE_7J_SINGLE_STORE_FINISHED_GOODS_PILOT',
        status: 'STARTED',
        createdAt: serverTimestamp(),
        createdBy: {
          uid: staffProfile?.uid || '',
          name: adminName,
          email: staffProfile?.email || '',
          role: staffProfile?.role || '',
        },
        storeId: pilotStore.id,
        storeCode: pilotStore.code,
        beforeSettings,
        afterSettings,
        action: 'UPDATE',
        rollbackSnapshot: beforeSettings,
        beforeHash: stableHash(beforeSettings),
        afterHash: stableHash(afterSettings),
        rolloutScope: 'SINGLE_STORE',
        globalSourceChanged: false,
        legacyCollectionsChanged: false,
      });

      await setDoc(doc(db, 'appSettings', 'posMenuSource'), {
        globalSource: 'LEGACY_MENU_ITEMS',
        storeOverrides: afterSettings.storeOverrides,
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile?.uid || '',
        updatedByName: adminName,
        phase7JImportBatchId: importBatchId,
      }, { merge: true });

      await setDoc(manifestRef, {
        status: 'COMPLETED',
        completedAt: serverTimestamp(),
      }, { merge: true });

      setLiveSummary({
        importBatchId,
        manifestId: importBatchId,
        action: 'PILOT_SWITCH',
      });
      setConfirmationText('');
      const refreshed = await loadPilotData();
      setData(refreshed);
      setPreview(null);
    } catch (err: unknown) {
      if (importBatchId) {
        try {
          await setDoc(doc(db, 'importManifests', importBatchId), {
            status: 'FAILED_OR_PARTIAL',
            failedAt: serverTimestamp(),
            failureMessage: err instanceof Error ? err.message : 'Phase 7J pilot switch failed.',
          }, { merge: true });
        } catch {
          // Preserve the original error if the failure manifest update also fails.
        }
      }
      setError(err instanceof Error ? err.message : 'Phase 7J pilot switch failed.');
    } finally {
      setIsWritingLive(false);
    }
  };

  const runRollback = async () => {
    if (!rollbackReady || !data || !udayStore) {
      setError('Rollback is not ready. Uday Park must currently have a FINISHED_GOODS override and confirmation text must match.');
      return;
    }
    if (!window.confirm(`${ROLLBACK_CONFIRMATION}\n\nThis writes only appSettings/posMenuSource and importManifests audit data. Continue?`)) {
      return;
    }

    setIsRollingBack(true);
    setError('');
    setLiveSummary(null);
    let importBatchId = '';

    try {
      const latest = await loadPilotData();
      const pilotStore = latest.stores.find((store) => store.code === UDAY_PARK_CODE);
      if (!pilotStore) throw new Error('Uday Park store is missing or inactive.');
      if (latest.settings.globalSource !== 'LEGACY_MENU_ITEMS') throw new Error(`Rollback blocked because globalSource is ${latest.settings.globalSource}.`);
      if (latest.settings.storeOverrides[pilotStore.id] !== 'FINISHED_GOODS') throw new Error('Rollback blocked because Uday Park is not currently overridden to FINISHED_GOODS.');

      const beforeSettings = latest.settings;
      const afterSettings = {
        globalSource: 'LEGACY_MENU_ITEMS' as PosSource,
        storeOverrides: buildRollbackOverrides(latest.settings, pilotStore.id),
      };
      importBatchId = `phase7j-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const adminName = staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin';
      const manifestRef = doc(db, 'importManifests', importBatchId);

      await setDoc(manifestRef, {
        importBatchId,
        phase: 'PHASE_7J_SINGLE_STORE_FINISHED_GOODS_ROLLBACK',
        status: 'STARTED',
        createdAt: serverTimestamp(),
        createdBy: {
          uid: staffProfile?.uid || '',
          name: adminName,
          email: staffProfile?.email || '',
          role: staffProfile?.role || '',
        },
        storeId: pilotStore.id,
        storeCode: pilotStore.code,
        beforeSettings,
        afterSettings,
        action: 'UPDATE',
        rollbackSnapshot: beforeSettings,
        beforeHash: stableHash(beforeSettings),
        afterHash: stableHash(afterSettings),
        rolloutScope: 'SINGLE_STORE_ROLLBACK',
        globalSourceChanged: false,
        legacyCollectionsChanged: false,
      });

      await setDoc(doc(db, 'appSettings', 'posMenuSource'), {
        globalSource: 'LEGACY_MENU_ITEMS',
        storeOverrides: afterSettings.storeOverrides,
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile?.uid || '',
        updatedByName: adminName,
        phase7JRollbackBatchId: importBatchId,
      }, { merge: true });

      await setDoc(manifestRef, {
        status: 'COMPLETED',
        completedAt: serverTimestamp(),
      }, { merge: true });

      setLiveSummary({
        importBatchId,
        manifestId: importBatchId,
        action: 'ROLLBACK',
      });
      setRollbackConfirmationText('');
      const refreshed = await loadPilotData();
      setData(refreshed);
      setPreview(null);
    } catch (err: unknown) {
      if (importBatchId) {
        try {
          await setDoc(doc(db, 'importManifests', importBatchId), {
            status: 'FAILED_OR_PARTIAL',
            failedAt: serverTimestamp(),
            failureMessage: err instanceof Error ? err.message : 'Phase 7J rollback failed.',
          }, { merge: true });
        } catch {
          // Preserve the original error if the failure manifest update also fails.
        }
      }
      setError(err instanceof Error ? err.message : 'Phase 7J rollback failed.');
    } finally {
      setIsRollingBack(false);
    }
  };

  const statusCards = data?.stores || [];
  const sourceRows = useMemo(() => (
    data?.stores.map((store) => ({
      store,
      override: data.settings.storeOverrides[store.id],
      effective: effectiveSource(data.settings, store.id),
    })) || []
  ), [data]);

  return (
    <div className="max-w-6xl mx-auto w-full pb-20 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Coffee Bond Menu Management</p>
          <h1 className="text-3xl font-black text-[#5c4033]">Phase 7J Uday Park FINISHED_GOODS Pilot</h1>
          <p className="text-neutral-600 mt-2">Switch Uday Park only by store override. Global source and Noida stores stay legacy.</p>
        </div>
        <Link to="/admin" className="text-sm font-bold text-[#5c4033] hover:underline">
          Back to Admin Dashboard
        </Link>
      </div>

      <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-5 flex gap-4">
        <ShieldAlert className="w-6 h-6 shrink-0 mt-0.5" />
        <div>
          <h2 className="font-black text-lg">Single-store pilot only</h2>
          <p className="text-sm mt-1">This page never switches globalSource, never rolls out Noida, and never writes menu, stock, order, KOT, inventory, or legacy collections.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 flex gap-3 text-sm">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {isLoading ? (
        <div className="bg-white border border-neutral-200 rounded-2xl p-8 text-center text-neutral-500">
          <Loader2 className="mx-auto mb-3 animate-spin text-[#5c4033]" />
          Loading pilot readiness...
        </div>
      ) : data && (
        <>
          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-5">
              <div>
                <h2 className="text-xl font-black text-neutral-800">Current POS Source Status</h2>
                <p className="text-sm text-neutral-500 mt-1">Current appSettings/posMenuSource and effective source by store.</p>
              </div>
              <button
                type="button"
                onClick={refresh}
                disabled={isLoading}
                className="px-4 py-2 rounded-xl bg-neutral-100 text-neutral-800 font-bold flex items-center justify-center gap-2 hover:bg-neutral-200 disabled:opacity-50"
              >
                <RefreshCw size={16} />
                Refresh
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4">
                <p className="text-xs uppercase tracking-wide font-black text-neutral-500">globalSource</p>
                <p className={`mt-1 text-lg font-black ${data.settings.globalSource === 'LEGACY_MENU_ITEMS' ? 'text-emerald-700' : 'text-red-700'}`}>{data.settings.globalSource}</p>
              </div>
              <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4">
                <p className="text-xs uppercase tracking-wide font-black text-neutral-500">storeOverrides</p>
                <pre className="mt-2 text-xs whitespace-pre-wrap break-all text-neutral-700">{JSON.stringify(data.settings.storeOverrides, null, 2)}</pre>
              </div>
            </div>

            <div className="mt-5 overflow-auto border border-neutral-100 rounded-xl">
              <table className="min-w-full text-sm">
                <thead className="bg-neutral-50">
                  <tr className="text-left uppercase text-xs text-neutral-500">
                    <th className="p-3">Store</th>
                    <th className="p-3">Override</th>
                    <th className="p-3">Effective POS Source</th>
                    <th className="p-3">Phase 7J Availability</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map(({ store, override, effective }) => (
                    <tr key={store.id} className="border-t border-neutral-100">
                      <td className="p-3 font-bold">{store.name}<span className="block text-xs font-normal text-neutral-500">{store.code}</span></td>
                      <td className="p-3 font-mono text-xs">{override || '(none)'}</td>
                      <td className="p-3">
                        <span className={`rounded-full px-2 py-1 text-xs font-black ${effective === 'FINISHED_GOODS' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-700'}`}>
                          {effective}
                        </span>
                      </td>
                      <td className="p-3 text-xs font-bold">
                        {store.code === UDAY_PARK_CODE ? 'Available if eligible' : 'Not available in Phase 7J - later phase.'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-black text-neutral-800 mb-4">Readiness Status Per Store</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {statusCards.map((store) => {
                const status = data.readiness.find((item) => item.storeId === store.id);
                return (
                  <div key={store.id} className={`border rounded-xl p-4 ${store.code === UDAY_PARK_CODE ? 'border-amber-300 bg-amber-50/40' : 'border-neutral-200 bg-neutral-50'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-neutral-800">{store.name}</p>
                        <p className="text-xs text-neutral-500">{store.code}</p>
                      </div>
                      {store.code === UDAY_PARK_CODE ? (
                        <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-1 text-[10px] font-black">PHASE 7J PILOT</span>
                      ) : (
                        <span className="rounded-full bg-neutral-200 text-neutral-600 px-2 py-1 text-[10px] font-black">LATER PHASE</span>
                      )}
                    </div>
                    {status ? (
                      <div className="mt-4">
                        <StatusLine label="Costing complete" ok={status.costingComplete} detail={`${status.costingIssues} issue(s)`} />
                        <StatusLine label="Stock loaded" ok={status.stockLoaded} detail={`${status.stockIssues} issue(s)`} />
                        <StatusLine label="Checkout safe" ok={status.checkoutSafe} detail={`${status.checkoutIssues} issue(s)`} />
                        <StatusLine label={status.eligibleForFinishedGoodsPilot ? 'Eligible for FINISHED_GOODS pilot' : 'Not eligible for FINISHED_GOODS pilot'} ok={status.eligibleForFinishedGoodsPilot} />
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-red-700 font-bold">Readiness unavailable.</p>
                    )}
                    {store.code !== UDAY_PARK_CODE && (
                      <p className="mt-4 rounded-xl bg-white border border-neutral-200 p-3 text-xs text-neutral-600 font-bold">Not available in Phase 7J - later phase.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <h2 className="text-xl font-black text-neutral-800">Dry-Run Preview</h2>
                <p className="text-sm text-neutral-500 mt-2">Preview the Uday Park store override. No Firestore writes happen during preview.</p>
              </div>
              <button
                type="button"
                onClick={runPreview}
                disabled={isPreviewing}
                className="px-6 py-3 bg-[#5c4033] text-white font-black rounded-xl hover:bg-[#3e2723] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isPreviewing ? <Loader2 size={18} className="animate-spin" /> : <FileSearch size={18} />}
                {isPreviewing ? 'Previewing...' : 'Preview Uday Park Pilot Switch'}
              </button>
            </div>

            {preview && (
              <div className="mt-5 space-y-4">
                {preview.blockers.length > 0 && (
                  <div className="bg-red-50 border border-red-200 text-red-900 rounded-xl p-4">
                    <p className="font-black mb-2">Preview blockers</p>
                    <ul className="space-y-1 text-sm">
                      {preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <JsonBox title="Current setting" value={preview.beforeSettings} />
                  <JsonBox title="Proposed setting" value={preview.afterSettings} />
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 text-sm">
                  <p><strong>Affected store:</strong> {preview.affectedStore.name} ({preview.affectedStore.code}) becomes FINISHED_GOODS.</p>
                  <p className="mt-1"><strong>Global source:</strong> remains LEGACY_MENU_ITEMS.</p>
                  <p className="mt-1"><strong>Unaffected stores:</strong> {preview.unaffectedStores.map((store) => `${store.name} remains ${effectiveSource(preview.afterSettings, store.id)}`).join('; ')}.</p>
                </div>
              </div>
            )}
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Guarded Live Switch</p>
                <h2 className="text-xl font-black text-neutral-800">Switch Uday Park Only</h2>
                <p className="text-sm text-neutral-600 mt-2">Writes only appSettings/posMenuSource and importManifests audit data.</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${liveReady ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {liveReady ? 'READY' : 'BLOCKED'}
              </span>
            </div>

            <label className="block mt-5">
              <span className="block text-sm font-black text-neutral-800 mb-2">Type this exact confirmation:</span>
              <code className="block text-xs bg-neutral-100 border border-neutral-200 rounded-xl p-3 text-neutral-700 whitespace-pre-wrap">{LIVE_CONFIRMATION}</code>
              <input
                type="text"
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.target.value)}
                className="mt-3 w-full border border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-[#5c4033] focus:border-transparent"
                placeholder="Paste the confirmation text here"
              />
            </label>

            <button
              type="button"
              onClick={runLiveSwitch}
              disabled={!liveReady}
              className="mt-5 w-full md:w-auto px-6 py-3 bg-red-700 text-white font-black rounded-xl hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isWritingLive ? <Loader2 size={18} className="animate-spin" /> : <ShieldAlert size={18} />}
              {isWritingLive ? 'Switching...' : 'Run Guarded Uday Park Pilot Switch'}
            </button>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-red-700 uppercase tracking-wide">Rollback</p>
                <h2 className="text-xl font-black text-neutral-800">Remove Uday Park Override</h2>
                <p className="text-sm text-neutral-600 mt-2">Keeps globalSource as LEGACY_MENU_ITEMS and removes only the Uday Park override.</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${currentUdaySource === 'FINISHED_GOODS' ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-600'}`}>
                Uday Park current source: {currentUdaySource}
              </span>
            </div>

            <label className="block mt-5">
              <span className="block text-sm font-black text-neutral-800 mb-2">Type this exact rollback confirmation:</span>
              <code className="block text-xs bg-neutral-100 border border-neutral-200 rounded-xl p-3 text-neutral-700 whitespace-pre-wrap">{ROLLBACK_CONFIRMATION}</code>
              <input
                type="text"
                value={rollbackConfirmationText}
                onChange={(event) => setRollbackConfirmationText(event.target.value)}
                className="mt-3 w-full border border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-[#5c4033] focus:border-transparent"
                placeholder="Paste the rollback confirmation text here"
              />
            </label>

            <button
              type="button"
              onClick={runRollback}
              disabled={!rollbackReady}
              className="mt-5 w-full md:w-auto px-6 py-3 bg-neutral-800 text-white font-black rounded-xl hover:bg-neutral-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isRollingBack ? <Loader2 size={18} className="animate-spin" /> : <ShieldAlert size={18} />}
              {isRollingBack ? 'Rolling back...' : 'Rollback Uday Park Override'}
            </button>
          </div>

          {liveSummary && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900">
              <p className="font-black">{liveSummary.action === 'PILOT_SWITCH' ? 'Uday Park pilot switch complete.' : 'Uday Park rollback complete.'}</p>
              <p className="text-xs mt-2">Manifest ID: <span className="font-mono">{liveSummary.manifestId}</span></p>
              {liveSummary.action === 'PILOT_SWITCH' && <PostSwitchChecklist />}
            </div>
          )}

          {nonUdayFinishedOverrides.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 text-sm">
              Non-Uday FINISHED_GOODS overrides detected: {nonUdayFinishedOverrides.join(', ')}. Phase 7J blocks live switch until only Uday Park can be active.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function JsonBox({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4">
      <p className="text-xs uppercase tracking-wide font-black text-neutral-500">{title}</p>
      <pre className="mt-2 text-xs whitespace-pre-wrap break-all text-neutral-700">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function StatusLine({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm mb-2">
      {ok ? <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" /> : <XCircle size={16} className="text-red-600 shrink-0 mt-0.5" />}
      <div>
        <p className="font-bold text-neutral-800">{label}</p>
        {detail && <p className="text-xs text-neutral-500">{detail}</p>}
      </div>
    </div>
  );
}

function PostSwitchChecklist() {
  const items = [
    'Open POS.',
    'Select Uday Park.',
    'Verify FINISHED_GOODS menu appears.',
    'Create one controlled test order.',
    'Confirm KOT routing to Barista/Kitchen.',
    'Confirm storeStock deduction.',
    'Confirm order appears in reports.',
    'Confirm Noida Sector 29 still uses legacy menu.',
    'Confirm Noida Sector 51 still uses legacy menu.',
    'If any issue appears, use rollback immediately.',
  ];

  return (
    <div className="mt-5 rounded-xl bg-white border border-emerald-200 p-4">
      <p className="font-black mb-3">Post-switch test checklist</p>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
