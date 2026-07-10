import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Store as StoreIcon,
  XCircle,
} from 'lucide-react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { DayClosing, OnlineOrder, Order, Role, StaffProfile, StockMovement, Store } from '../../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StoreStock } from '../../types/menu-management';

type Status = 'READY' | 'WARNING' | 'BLOCKED';

type AppGstConfig = {
  exists: boolean;
  defaultRate: number;
  storeOverrides: Record<string, number>;
};

type StaffRecord = StaffProfile & { id: string };

type SetupBlocker = {
  itemCode: string;
  itemName: string;
  type: string;
  detail: string;
};

type StoreGoLiveReadiness = {
  store: Store;
  status: Status;
  blockers: string[];
  warnings: string[];
  staffKnown: boolean;
  managerCount: number;
  posUserCount: number;
  kotUserCount: number;
  activeStaffCount: number;
  gstConfigured: boolean;
  gstRateLabel: string;
  publicSnapshotExists: boolean;
  activeFinishedGoodsCount: number;
  setupBlockers: SetupBlocker[];
  negativeStockCount: number;
  missingCostWarningCount: number;
  pendingOnlineOrdersCount: number;
  unsettledPayAtCounterCount: number;
  lastPurchaseInward: string;
  lastStockMovement: string;
  dayCloseRouteAccessible: boolean;
  purchaseEntryRouteAccessible: boolean;
  stockCorrectionRouteAccessible: boolean;
  kotRoutesAccessible: boolean;
};

type LoadedData = {
  stores: Store[];
  staff: StaffRecord[];
  staffLoaded: boolean;
  rawIngredients: RawIngredient[];
  prepItems: PrepItem[];
  finishedGoods: FinishedGood[];
  storeStock: StoreStock[];
  orders: Order[];
  onlineOrders: OnlineOrder[];
  stockMovements: StockMovement[];
  purchaseEntries: Record<string, unknown>[];
  dayClosings: DayClosing[];
  publicSnapshots: Record<string, boolean>;
  gstConfig: AppGstConfig;
};

const GST_CONFIG_DOC_ID = 'gstConfig';
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];
const POS_ROLES: Role[] = ['CASHIER'];
const KOT_ROLES: Role[] = ['BARISTA', 'KITCHEN'];

const DATA_LOCATION_ROWS = [
  ['Stores', 'stores'],
  ['Staff/users and role access', 'users/{uid}'],
  ['Finished goods menu', 'finishedGoods'],
  ['Raw ingredients', 'rawIngredients'],
  ['Prep items/components', 'prepItems'],
  ['Store stock', 'storeStock'],
  ['Stock movements', 'stockMovements'],
  ['POS orders', 'orders and orders/{orderId}/items/payments'],
  ['Online orders', 'onlineOrders'],
  ['KOT items', 'kotItems'],
  ['Day close', 'dayClosings'],
  ['Purchase entries', 'purchaseEntries'],
  ['Public menu availability', 'publicMenuAvailability/{storeCode}'],
  ['GST settings', `appSettings/${GST_CONFIG_DOC_ID}`],
  ['Inventory warnings', 'orders inventory fields and stockMovements warning fields'],
];

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRate(value: unknown): number {
  const parsed = numberValue(value);
  return parsed > 0 ? parsed : 0;
}

function pickRate(source: Record<string, unknown> | null | undefined, keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const rate = parseRate(source[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, rate]) => {
    const parsed = parseRate(rate);
    if (parsed > 0) acc[key] = parsed;
    return acc;
  }, {});
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value: any): string {
  const date = toDate(value);
  return date ? date.toLocaleString() : '-';
}

function todayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfToday(): Date {
  return new Date(`${todayKey()}T00:00:00`);
}

function isStoreAssigned(item: FinishedGood, storeId: string): boolean {
  const storeIds = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return storeIds.length === 0 || storeIds.includes(storeId);
}

function isActiveFinishedGood(item: FinishedGood, storeId: string): boolean {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isStoreAssigned(item, storeId);
}

function usesBom(item: FinishedGood): boolean {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

function isNoStockItem(item: FinishedGood): boolean {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

function normalizeUom(value: unknown): string {
  const raw = String(value || '').trim().toUpperCase();
  const aliases: Record<string, string> = {
    G: 'G',
    GRAM: 'G',
    GRAMS: 'G',
    KG: 'KG',
    KGS: 'KG',
    KILOGRAM: 'KG',
    KILOGRAMS: 'KG',
    ML: 'ML',
    MILLILITRE: 'ML',
    MILLILITER: 'ML',
    MILLILITRES: 'ML',
    MILLILITERS: 'ML',
    L: 'L',
    LTR: 'L',
    LTRS: 'L',
    LITRE: 'L',
    LITER: 'L',
    LITRES: 'L',
    LITERS: 'L',
    PCS: 'PCS',
    PC: 'PCS',
    PIECE: 'PCS',
    PIECES: 'PCS',
  };
  return aliases[raw] || raw;
}

function canConvertUom(fromUom: unknown, toUom: unknown): boolean {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  const family: Record<string, 'WEIGHT' | 'VOLUME' | 'COUNT'> = {
    G: 'WEIGHT',
    KG: 'WEIGHT',
    ML: 'VOLUME',
    L: 'VOLUME',
    PCS: 'COUNT',
  };
  return !!family[from] && family[from] === family[to];
}

function componentMasterExists(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING' || line.componentType === 'BOUGHT_COMPONENT') {
    return rawByCode.has(line.componentCode);
  }
  if (line.componentType === 'PREP_ITEM') return prepByCode.has(line.componentCode);
  if (line.componentType === 'FINISHED_GOOD') return finishedByCode.has(line.componentCode);
  return false;
}

function componentUomCompatible(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING' || line.componentType === 'BOUGHT_COMPONENT') {
    const raw = rawByCode.get(line.componentCode);
    return canConvertUom(line.uom, raw?.usageUOM || line.uom);
  }
  if (line.componentType === 'PREP_ITEM') {
    const prep = prepByCode.get(line.componentCode);
    return canConvertUom(line.uom, prep?.yieldUOM || prep?.outputUOM || line.uom);
  }
  if (line.componentType === 'FINISHED_GOOD') return canConvertUom(line.uom, 'PCS');
  return false;
}

function buildSetupBlockers(
  store: Store,
  rawIngredients: RawIngredient[],
  prepItems: PrepItem[],
  finishedGoods: FinishedGood[],
): SetupBlocker[] {
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));
  const blockers: SetupBlocker[] = [];

  const addBlocker = (item: FinishedGood, type: string, detail: string) => {
    blockers.push({
      itemCode: item.code,
      itemName: item.displayName || item.name,
      type,
      detail,
    });
  };

  finishedGoods.forEach((item) => {
    if (!isStoreAssigned(item, store.id) || item.isAvailable === false) return;
    if (item.isActive === false || item.isSellable === false) {
      addBlocker(item, 'Inactive / not sellable', 'Finished good is inactive or not sellable.');
      return;
    }
    if (numberValue(item.salePrice) <= 0 || !['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
      addBlocker(item, 'Invalid sale setup', 'Finished good needs a positive sale price and valid KOT station.');
      return;
    }
    if (isNoStockItem(item) || !usesBom(item)) return;
    if (!Array.isArray(item.bom) || item.bom.length === 0) {
      addBlocker(item, 'Missing BOM', 'BOM-based finished good has no BOM rows.');
      return;
    }
    item.bom.forEach((line) => {
      const componentCode = String(line.componentCode || '').trim();
      const componentType = String(line.componentType || '').trim();
      const quantity = numberValue(line.quantity);
      const uom = normalizeUom(line.uom);
      if (!componentCode || !componentType || quantity <= 0 || !uom) {
        addBlocker(item, 'Invalid BOM quantity', `BOM row is missing component type, code, quantity, or UOM.`);
        return;
      }
      if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
        addBlocker(item, 'Missing raw/prep master', `${componentType} / ${componentCode} is missing from master data.`);
        return;
      }
      if (!componentUomCompatible(line, rawByCode, prepByCode)) {
        addBlocker(item, 'Impossible unit conversion', `${componentType} / ${componentCode} cannot convert ${uom} to the stock unit.`);
      }
    });
  });

  const deduped = new Map<string, SetupBlocker>();
  blockers.forEach((blocker) => {
    const key = `${blocker.itemCode}|${blocker.type}|${blocker.detail}`;
    if (!deduped.has(key)) deduped.set(key, blocker);
  });
  return Array.from(deduped.values());
}

function isStaffAssignedToStore(person: StaffRecord, storeId: string): boolean {
  const storeIds = person.assignedStoreIds?.length ? person.assignedStoreIds : person.storeIds || [];
  return person.isActive === true && storeIds.includes(storeId);
}

function lastDateLabel(records: { createdAt?: unknown }[]): string {
  const dates = records.map((record) => toDate(record.createdAt)).filter((date): date is Date => !!date);
  if (dates.length === 0) return '-';
  return dates.sort((a, b) => b.getTime() - a.getTime())[0].toLocaleString();
}

function storeGstStatus(store: Store, finishedGoods: FinishedGood[], config: AppGstConfig): { configured: boolean; rateLabel: string } {
  const overrideRate = config.storeOverrides[store.id] || config.storeOverrides[store.code] || 0;
  if (overrideRate > 0) return { configured: true, rateLabel: `${overrideRate}% store override` };

  const storeRate = pickRate(store as unknown as Record<string, unknown>, STORE_TAX_RATE_KEYS);
  if (storeRate > 0) return { configured: true, rateLabel: `${storeRate}% store` };

  const itemRates = finishedGoods.map((item) => pickRate(item as unknown as Record<string, unknown>, ITEM_TAX_RATE_KEYS)).filter((rate) => rate > 0);
  if (itemRates.length > 0) return { configured: true, rateLabel: `${Array.from(new Set(itemRates)).join(', ')}% item` };

  if (config.defaultRate > 0) return { configured: true, rateLabel: `${config.defaultRate}% app default` };
  return { configured: false, rateLabel: 'Missing' };
}

async function loadGstConfig(): Promise<AppGstConfig> {
  const snap = await getDoc(doc(db, 'appSettings', GST_CONFIG_DOC_ID));
  if (!snap.exists()) return { exists: false, defaultRate: 0, storeOverrides: {} };
  const data = snap.data() as Record<string, unknown>;
  return {
    exists: true,
    defaultRate: pickRate(data, APP_TAX_RATE_KEYS),
    storeOverrides: normalizeStoreOverrides(data.storeOverrides),
  };
}

function allowedStoreIds(profile: StaffProfile): string[] {
  return profile.assignedStoreIds?.length ? profile.assignedStoreIds : profile.storeIds || [];
}

function canUseOpsRoutes(role: Role): boolean {
  return role === 'ADMIN' || role === 'STORE_MANAGER';
}

function buildStoreReadiness(data: LoadedData, staffProfile: StaffProfile): StoreGoLiveReadiness[] {
  const todayStart = startOfToday();
  return data.stores.map((store) => {
    const activeFinishedGoods = data.finishedGoods.filter((item) => isActiveFinishedGood(item, store.id));
    const storeStock = data.storeStock.filter((stock) => stock.storeId === store.id);
    const setupBlockers = buildSetupBlockers(store, data.rawIngredients, data.prepItems, data.finishedGoods);
    const staffForStore = data.staff.filter((person) => isStaffAssignedToStore(person, store.id));
    const managerCount = staffForStore.filter((person) => person.role === 'STORE_MANAGER').length;
    const posUserCount = staffForStore.filter((person) => POS_ROLES.includes(person.role)).length;
    const kotUserCount = staffForStore.filter((person) => KOT_ROLES.includes(person.role)).length;
    const gstStatus = storeGstStatus(store, activeFinishedGoods, data.gstConfig);
    const ordersForStore = data.orders.filter((order) => order.storeId === store.id);
    const onlineOrdersForStore = data.onlineOrders.filter((order) => order.storeId === store.id);
    const movementsForStore = data.stockMovements.filter((movement) => movement.storeId === store.id);
    const purchasesForStore = data.purchaseEntries.filter((purchase) => purchase.storeId === store.id);
    const pendingOnlineOrders = onlineOrdersForStore.filter((order) => order.status === 'PENDING');
    const unsettledPayAtCounterOrders = ordersForStore.filter((order) => {
      const hasPayAtCounter = order.paymentMethod === 'PAY_AT_COUNTER'
        || (order.paymentBreakdown || []).some((payment) => payment.method === 'PAY_AT_COUNTER');
      return hasPayAtCounter && order.paymentStatus !== 'PAID' && order.status !== 'VOIDED';
    });
    const recentMovements = movementsForStore.filter((movement) => {
      const date = toDate(movement.createdAt);
      return !!date && date >= todayStart;
    });
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (!store.isActive) blockers.push('Store is inactive.');
    if (data.staffLoaded) {
      if (posUserCount === 0) blockers.push('No active Cashier/POS user assigned.');
      if (kotUserCount === 0) blockers.push('No active Barista/Kitchen KOT user assigned.');
    } else {
      warnings.push('Staff assignment check is Admin-only on current Firestore rules.');
    }
    if (activeFinishedGoods.length === 0) blockers.push('No active Finished Goods are available for POS V2.');
    if (setupBlockers.length > 0) blockers.push(`${setupBlockers.length} menu setup blocker(s) need review.`);
    if (!gstStatus.configured) warnings.push('GST is not configured for this store/menu.');
    if (!data.publicSnapshots[store.code]) warnings.push('Public customer menu availability snapshot is missing.');

    const negativeStockCount = storeStock.filter((stock) => numberValue(stock.currentStock) < 0).length;
    if (negativeStockCount > 0) warnings.push(`${negativeStockCount} stock row(s) are negative. Sales can continue, but review inventory.`);

    const missingCostWarningCount = [
      ...data.rawIngredients.filter((item) => item.isActive !== false && (numberValue(item.purchaseCost) <= 0 || numberValue(item.costPerUsageUnit) <= 0)),
      ...data.prepItems.filter((item) => item.isActive !== false && numberValue(item.costPerUnit) <= 0),
    ].length;
    if (missingCostWarningCount > 0) warnings.push(`${missingCostWarningCount} raw/prep cost warning(s) remain.`);
    if (pendingOnlineOrders.length > 0) warnings.push(`${pendingOnlineOrders.length} pending online order(s).`);
    if (unsettledPayAtCounterOrders.length > 0) warnings.push(`${unsettledPayAtCounterOrders.length} PAY_AT_COUNTER order(s) need settlement.`);
    if (recentMovements.length === 0) warnings.push('No stock movements recorded today yet.');
    if (purchasesForStore.length === 0) warnings.push('No purchase inward entry found yet.');

    return {
      store,
      status: blockers.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'WARNING' : 'READY',
      blockers,
      warnings,
      staffKnown: data.staffLoaded,
      managerCount,
      posUserCount,
      kotUserCount,
      activeStaffCount: staffForStore.length,
      gstConfigured: gstStatus.configured,
      gstRateLabel: gstStatus.rateLabel,
      publicSnapshotExists: !!data.publicSnapshots[store.code],
      activeFinishedGoodsCount: activeFinishedGoods.length,
      setupBlockers,
      negativeStockCount,
      missingCostWarningCount,
      pendingOnlineOrdersCount: pendingOnlineOrders.length,
      unsettledPayAtCounterCount: unsettledPayAtCounterOrders.length,
      lastPurchaseInward: lastDateLabel(purchasesForStore),
      lastStockMovement: lastDateLabel(movementsForStore),
      dayCloseRouteAccessible: canUseOpsRoutes(staffProfile.role),
      purchaseEntryRouteAccessible: canUseOpsRoutes(staffProfile.role),
      stockCorrectionRouteAccessible: canUseOpsRoutes(staffProfile.role),
      kotRoutesAccessible: ['ADMIN', 'STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN'].includes(staffProfile.role),
    };
  });
}

function StatusBadge({ status }: { status: Status }) {
  const classes = {
    READY: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    WARNING: 'border-amber-200 bg-amber-50 text-amber-800',
    BLOCKED: 'border-red-200 bg-red-50 text-red-800',
  }[status];
  const icon = status === 'READY' ? <CheckCircle2 size={16} /> : status === 'WARNING' ? <AlertTriangle size={16} /> : <XCircle size={16} />;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-black ${classes}`}>{icon}{status}</span>;
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  const classes = {
    neutral: 'border-neutral-200 bg-white text-neutral-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-900',
  }[tone];
  return (
    <div className={`rounded-2xl border p-3 ${classes}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-60">{label}</p>
      <div className="mt-1 text-lg font-black">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-black text-[#3e2723]">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function GoLiveReadiness() {
  const { staffProfile } = useAuth();
  const [data, setData] = useState<LoadedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);

  const canAccess = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';
  const storeIds = useMemo(() => (staffProfile ? allowedStoreIds(staffProfile) : []), [staffProfile]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!staffProfile || !canAccess) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const [storesSnap, rawSnap, prepSnap, finishedSnap, stockSnap, gstConfig] = await Promise.all([
          getDocs(query(collection(db, 'stores'), where('isActive', '==', true))),
          getDocs(collection(db, 'rawIngredients')),
          getDocs(collection(db, 'prepItems')),
          getDocs(collection(db, 'finishedGoods')),
          getDocs(collection(db, 'storeStock')),
          loadGstConfig(),
        ]);

        let stores = storesSnap.docs.map((storeDoc) => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
        stores.sort((a, b) => a.name.localeCompare(b.name));
        if (staffProfile.role !== 'ADMIN') {
          stores = stores.filter((store) => storeIds.includes(store.id));
        }

        const staffPromise = staffProfile.role === 'ADMIN'
          ? getDocs(collection(db, 'users')).then((snapshot) => ({
              staffLoaded: true,
              staff: snapshot.docs.map((userDoc) => {
                const user = userDoc.data();
                const assignedStoreIds = Array.isArray(user.assignedStoreIds) ? user.assignedStoreIds : Array.isArray(user.storeIds) ? user.storeIds : [];
                const displayName = String(user.displayName || user.name || '');
                return {
                  id: userDoc.id,
                  uid: String(user.uid || userDoc.id),
                  name: displayName,
                  displayName,
                  email: String(user.email || ''),
                  role: user.role,
                  isActive: user.isActive === true,
                  assignedStoreIds,
                  storeIds: assignedStoreIds,
                  createdAt: user.createdAt,
                  updatedAt: user.updatedAt,
                } as StaffRecord;
              }),
            }))
          : Promise.resolve({ staffLoaded: false, staff: [] as StaffRecord[] });

        const storeScoped = async <T,>(collectionName: string, mapper: (id: string, data: Record<string, unknown>) => T): Promise<T[]> => {
          const snaps = await Promise.all(stores.map((store) => getDocs(query(collection(db, collectionName), where('storeId', '==', store.id)))));
          return snaps.flatMap((snap) => snap.docs.map((item) => mapper(item.id, item.data() as Record<string, unknown>)));
        };

        const [staffResult, orders, onlineOrders, stockMovements, purchaseEntries, dayClosings, publicSnapshots] = await Promise.all([
          staffPromise,
          storeScoped('orders', (id, item) => ({ id, ...item } as Order)),
          storeScoped('onlineOrders', (id, item) => ({ id, ...item } as OnlineOrder)),
          storeScoped('stockMovements', (id, item) => ({ id, ...item } as StockMovement)),
          storeScoped('purchaseEntries', (id, item) => ({ id, ...item })),
          Promise.all(stores.map(async (store) => {
            const closing = await getDoc(doc(db, 'dayClosings', `${store.id}_${todayKey()}`));
            return closing.exists() ? ({ id: closing.id, ...closing.data() } as DayClosing) : null;
          })).then((closings) => closings.filter((closing): closing is DayClosing => !!closing)),
          Promise.all(stores.map(async (store) => {
            const snapshot = await getDoc(doc(db, 'publicMenuAvailability', store.code));
            return [store.code, snapshot.exists()] as const;
          })).then((entries) => Object.fromEntries(entries)),
        ]);

        if (!active) return;
        setData({
          stores,
          staff: staffResult.staff,
          staffLoaded: staffResult.staffLoaded,
          rawIngredients: rawSnap.docs.map((item) => ({ id: item.id, ...item.data() } as RawIngredient)),
          prepItems: prepSnap.docs.map((item) => ({ id: item.id, ...item.data() } as PrepItem)),
          finishedGoods: finishedSnap.docs.map((item) => ({ id: item.id, ...item.data() } as FinishedGood)),
          storeStock: stockSnap.docs.map((item) => ({ id: item.id, ...item.data() } as StoreStock)),
          orders,
          onlineOrders,
          stockMovements,
          purchaseEntries,
          dayClosings,
          publicSnapshots,
          gstConfig,
        });
        setLastRefreshed(new Date().toLocaleString());
      } catch (err: any) {
        if (!active) return;
        setError(err?.message || 'Unable to load go-live readiness checks.');
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [canAccess, refreshNonce, staffProfile, storeIds]);

  const readiness = useMemo(() => (data && staffProfile ? buildStoreReadiness(data, staffProfile) : []), [data, staffProfile]);
  const overallStatus: Status = readiness.some((store) => store.status === 'BLOCKED')
    ? 'BLOCKED'
    : readiness.some((store) => store.status === 'WARNING')
      ? 'WARNING'
      : 'READY';

  if (!staffProfile) return null;

  if (!canAccess) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">No access</p>
          <h1 className="mt-2 text-2xl font-black text-[#3e2723]">Go-Live Readiness</h1>
          <p className="mt-3 text-sm font-medium text-neutral-600">
            This checklist is available to Admin and Store Manager roles only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full min-w-0 bg-[#fcf9f5] pb-24 font-sans text-neutral-800">
      <div className="mx-auto w-full max-w-7xl min-w-0 px-4 py-4 md:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/admin" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-600 shadow-sm ring-1 ring-neutral-200 hover:bg-neutral-50">
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.2em] text-neutral-400">Phase 10A</p>
              <h1 className="text-2xl font-black tracking-tight text-[#3e2723] md:text-3xl">Go-Live Readiness</h1>
              <p className="mt-1 text-sm font-medium text-neutral-500">
                Store-wise staff access, POS V2 setup, and operational checks before opening.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={loading ? 'WARNING' : overallStatus} />
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

        <div className="mt-4 rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Metric label="Overall" value={loading ? 'Loading' : overallStatus} tone={overallStatus === 'READY' ? 'green' : overallStatus === 'WARNING' ? 'amber' : 'red'} />
            <Metric label="Stores checked" value={readiness.length} />
            <Metric label="Blocked stores" value={readiness.filter((store) => store.status === 'BLOCKED').length} tone={readiness.some((store) => store.status === 'BLOCKED') ? 'red' : 'green'} />
            <Metric label="Last refresh" value={lastRefreshed || '-'} />
          </div>
        </div>

        {loading ? (
          <div className="mt-8 rounded-3xl border border-neutral-200 bg-white p-8 text-center text-sm font-bold text-neutral-500 shadow-sm">
            Loading go-live checks...
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            {readiness.map((storeReadiness) => (
              <section key={storeReadiness.store.id} className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#5c4033]/10 text-[#5c4033]">
                      <StoreIcon size={20} />
                    </div>
                    <div>
                      <h2 className="text-xl font-black text-[#3e2723]">{storeReadiness.store.name}</h2>
                      <p className="text-xs font-bold uppercase tracking-[0.16em] text-neutral-400">{storeReadiness.store.code}</p>
                    </div>
                  </div>
                  <StatusBadge status={storeReadiness.status} />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
                  <Metric label="Active staff" value={storeReadiness.staffKnown ? storeReadiness.activeStaffCount : 'Admin check'} tone={storeReadiness.staffKnown ? 'neutral' : 'amber'} />
                  <Metric label="POS users" value={storeReadiness.staffKnown ? storeReadiness.posUserCount : 'Admin check'} tone={storeReadiness.staffKnown && storeReadiness.posUserCount === 0 ? 'red' : 'green'} />
                  <Metric label="KOT users" value={storeReadiness.staffKnown ? storeReadiness.kotUserCount : 'Admin check'} tone={storeReadiness.staffKnown && storeReadiness.kotUserCount === 0 ? 'red' : 'green'} />
                  <Metric label="Managers" value={storeReadiness.staffKnown ? storeReadiness.managerCount : 'Admin check'} />
                  <Metric label="Finished goods" value={storeReadiness.activeFinishedGoodsCount} tone={storeReadiness.activeFinishedGoodsCount > 0 ? 'green' : 'red'} />
                  <Metric label="Setup blockers" value={storeReadiness.setupBlockers.length} tone={storeReadiness.setupBlockers.length > 0 ? 'red' : 'green'} />
                  <Metric label="GST" value={storeReadiness.gstRateLabel} tone={storeReadiness.gstConfigured ? 'green' : 'amber'} />
                  <Metric label="Public snapshot" value={storeReadiness.publicSnapshotExists ? 'Exists' : 'Missing'} tone={storeReadiness.publicSnapshotExists ? 'green' : 'amber'} />
                  <Metric label="Negative stock" value={storeReadiness.negativeStockCount} tone={storeReadiness.negativeStockCount > 0 ? 'amber' : 'green'} />
                  <Metric label="Cost warnings" value={storeReadiness.missingCostWarningCount} tone={storeReadiness.missingCostWarningCount > 0 ? 'amber' : 'green'} />
                  <Metric label="Pending online" value={storeReadiness.pendingOnlineOrdersCount} tone={storeReadiness.pendingOnlineOrdersCount > 0 ? 'amber' : 'green'} />
                  <Metric label="Unsettled pay" value={storeReadiness.unsettledPayAtCounterCount} tone={storeReadiness.unsettledPayAtCounterCount > 0 ? 'amber' : 'green'} />
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                    <h3 className="text-sm font-black text-neutral-900">Blockers</h3>
                    {storeReadiness.blockers.length === 0 ? (
                      <p className="mt-2 text-sm font-bold text-emerald-700">No go-live blockers found.</p>
                    ) : (
                      <ul className="mt-2 space-y-1 text-sm font-semibold text-red-800">
                        {storeReadiness.blockers.map((blocker) => <li key={blocker}>- {blocker}</li>)}
                      </ul>
                    )}
                  </div>
                  <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                    <h3 className="text-sm font-black text-neutral-900">Warnings</h3>
                    {storeReadiness.warnings.length === 0 ? (
                      <p className="mt-2 text-sm font-bold text-emerald-700">No warnings.</p>
                    ) : (
                      <ul className="mt-2 space-y-1 text-sm font-semibold text-amber-800">
                        {storeReadiness.warnings.map((warning) => <li key={warning}>- {warning}</li>)}
                      </ul>
                    )}
                  </div>
                </div>

                {storeReadiness.setupBlockers.length > 0 && (
                  <div className="mt-4 overflow-x-auto rounded-2xl border border-red-100">
                    <table className="min-w-full text-left text-sm">
                      <thead className="bg-red-50 text-[10px] font-black uppercase tracking-widest text-red-700">
                        <tr>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Type</th>
                          <th className="px-3 py-2">Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-100">
                        {storeReadiness.setupBlockers.slice(0, 8).map((blocker) => (
                          <tr key={`${blocker.itemCode}_${blocker.type}_${blocker.detail}`}>
                            <td className="px-3 py-2 font-bold">{blocker.itemName} <span className="font-mono text-xs text-neutral-400">{blocker.itemCode}</span></td>
                            <td className="px-3 py-2">{blocker.type}</td>
                            <td className="px-3 py-2">{blocker.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                  <Metric label="Purchase route" value={storeReadiness.purchaseEntryRouteAccessible ? 'Allowed' : 'No access'} tone={storeReadiness.purchaseEntryRouteAccessible ? 'green' : 'amber'} />
                  <Metric label="Stock correction" value={storeReadiness.stockCorrectionRouteAccessible ? 'Allowed' : 'No access'} tone={storeReadiness.stockCorrectionRouteAccessible ? 'green' : 'amber'} />
                  <Metric label="Day close" value={storeReadiness.dayCloseRouteAccessible ? 'Allowed' : 'No access'} tone={storeReadiness.dayCloseRouteAccessible ? 'green' : 'amber'} />
                  <Metric label="KOT routes" value={storeReadiness.kotRoutesAccessible ? 'Allowed' : 'No access'} tone={storeReadiness.kotRoutesAccessible ? 'green' : 'red'} />
                  <Metric label="Last purchase" value={storeReadiness.lastPurchaseInward} />
                  <Metric label="Last stock movement" value={storeReadiness.lastStockMovement} />
                </div>
              </section>
            ))}

            <Section title="Where information is stored">
              <div className="overflow-x-auto rounded-2xl border border-neutral-200">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-neutral-50 text-[10px] font-black uppercase tracking-widest text-neutral-500">
                    <tr>
                      <th className="px-3 py-2">Information</th>
                      <th className="px-3 py-2">Firestore location</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {DATA_LOCATION_ROWS.map(([label, path]) => (
                      <tr key={label}>
                        <td className="px-3 py-2 font-bold text-neutral-800">{label}</td>
                        <td className="px-3 py-2 font-mono text-xs text-neutral-600">{path}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title="Copyable go-live checklist">
              <textarea
                readOnly
                className="min-h-64 w-full rounded-2xl border border-neutral-200 bg-neutral-50 p-4 font-mono text-xs text-neutral-700 outline-none"
                value={readiness.map((store) => [
                  `${store.store.name} (${store.store.code}) - ${store.status}`,
                  `[ ] POS user assigned: ${store.staffKnown ? store.posUserCount : 'Admin check required'}`,
                  `[ ] KOT user assigned: ${store.staffKnown ? store.kotUserCount : 'Admin check required'}`,
                  `[ ] GST ready: ${store.gstRateLabel}`,
                  `[ ] Menu ready: ${store.activeFinishedGoodsCount} active finished goods`,
                  `[ ] BOM blockers reviewed: ${store.setupBlockers.length}`,
                  `[ ] Inventory warnings reviewed: negative ${store.negativeStockCount}, cost ${store.missingCostWarningCount}`,
                  `[ ] Purchase entry tested: last ${store.lastPurchaseInward}`,
                  `[ ] Stock correction tested`,
                  `[ ] Day close tested`,
                  `[ ] Reports tested`,
                  `[ ] Public ordering snapshot: ${store.publicSnapshotExists ? 'exists' : 'missing'}`,
                ].join('\n')).join('\n\n')}
              />
            </Section>

            <Section title="Access model in use">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Metric label="Admin" value="All stores and modules" tone="green" />
                <Metric label="Store Manager" value="Assigned stores, operations, reports, inventory" tone="green" />
                <Metric label="Cashier" value="POS, Running, Online, all KOT views" tone="green" />
                <Metric label="Barista/Kitchen" value="KOT-only views" tone="green" />
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
