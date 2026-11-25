import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSearch,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store } from '../../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StockItemType, StoreStock } from '../../types/menu-management';

type CsvRow = Record<string, string>;
type ReportAction = 'UPDATE' | 'UNCHANGED' | 'BLOCKED';
type UploadMode = 'costing' | 'stock' | 'combined';
type TargetCollection = 'rawIngredients' | 'storeStock';

type ReportRow = {
  rowType: 'COSTING' | 'STOCK';
  rowNumber: number;
  collection: TargetCollection;
  docId: string;
  action: ReportAction;
  reason: string;
  hashBefore: string;
  hashAfter: string;
};

type WriteEntry = {
  rowType: 'COSTING' | 'STOCK';
  collection: TargetCollection;
  docId: string;
  docPath: string;
  action: ReportAction;
  reason: string;
  hashBefore: string;
  hashAfter: string;
  before?: Record<string, unknown>;
  update: Record<string, unknown>;
};

type PendingStockValues = Partial<Pick<StoreStock, 'openingStock' | 'currentStock' | 'minimumStock'>> & { confirmedZero?: boolean };

type ReadinessBlocker = {
  storeCode: string;
  stockItemType: string;
  stockItemCode: string;
  stockItemName: string;
  currentOpeningStock: number | null;
  currentCurrentStock: number | null;
  confirmedZero: boolean;
  blockerReason: string;
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
  stockBlockers: ReadinessBlocker[];
  checkoutBlockers: ReadinessBlocker[];
};

type DryRunResult = {
  batchId: string;
  mode: UploadMode;
  reportRows: ReportRow[];
  writeEntries: WriteEntry[];
  readiness: ReadinessStatus[];
  warnings: string[];
  counts: {
    rowsValid: number;
    rowsBlocked: number;
    costsToUpdate: number;
    stockRowsToUpdate: number;
    confirmedZeroRows: number;
    unchangedRows: number;
  };
};

type LiveSummary = {
  importBatchId: string;
  manifestId: string;
  costsUpdated: number;
  stockRowsUpdated: number;
  unchangedRows: number;
};

const REQUIRED_STORE_CODES = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];
const LIVE_CONFIRMATION = 'I understand this will update costing and opening stock only, and will not switch POS rollout.';
const BATCH_LIMIT = 400;

function cleanValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isBlank(value: unknown): boolean {
  return cleanValue(value) === '';
}

function toNumber(value: unknown, fallback = 0): number {
  const cleaned = cleanValue(value).replace(/,/g, '');
  if (!cleaned) return fallback;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumberStrict(value: unknown): { ok: boolean; value: number | null } {
  const cleaned = cleanValue(value).replace(/,/g, '');
  if (!cleaned) return { ok: false, value: null };
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, value: null };
}

function parseBool(value: unknown): boolean {
  return ['true', 'yes', 'y', '1', 'confirmed'].includes(cleanValue(value).toLowerCase());
}

function isReviewFlagged(notes: unknown): boolean {
  const text = cleanValue(notes).toLowerCase();
  return ['review', 'pending', 'zero_ok', 'zero ok', 'cost pending'].some((flag) => text.includes(flag));
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);

  const headers = rows[0]?.map((header) => header.trim()) || [];
  return rows.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = cleanValue(values[index]);
    });
    return record;
  });
}

function makeCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T)[]): string {
  const escapeCell = (value: unknown) => {
    const text = cleanValue(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };

  return [
    columns.map(String).join(','),
    ...rows.map((row) => columns.map((column) => escapeCell(row[column])).join(',')),
  ].join('\n');
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`Unable to read ${file.name}`));
    reader.readAsText(file);
  });
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

function pickComparable(existing: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  Object.keys(update).forEach((key) => {
    picked[key] = existing[key];
  });
  return picked;
}

function withId<T extends Record<string, unknown>>(id: string, data: T): T & { id: string } {
  return { id, ...data };
}

async function loadPhase7HData() {
  const [rawSnap, stockSnap, storesSnap, finishedSnap, prepSnap] = await Promise.all([
    getDocs(collection(db, 'rawIngredients')),
    getDocs(collection(db, 'storeStock')),
    getDocs(collection(db, 'stores')),
    getDocs(collection(db, 'finishedGoods')),
    getDocs(collection(db, 'prepItems')),
  ]);

  const rawIngredients = rawSnap.docs.map((snap) => withId(snap.id, snap.data() as RawIngredient & Record<string, unknown>));
  const storeStock = stockSnap.docs.map((snap) => withId(snap.id, snap.data() as StoreStock & Record<string, unknown>));
  const stores = storesSnap.docs.map((snap) => withId(snap.id, snap.data() as Store & Record<string, unknown>));
  const finishedGoods = finishedSnap.docs.map((snap) => withId(snap.id, snap.data() as FinishedGood & Record<string, unknown>));
  const prepItems = prepSnap.docs.map((snap) => withId(snap.id, snap.data() as PrepItem & Record<string, unknown>));
  const targetStores = REQUIRED_STORE_CODES
    .map((code) => stores.find((store) => store.code === code && store.isActive))
    .filter((store): store is Store & Record<string, unknown> & { id: string } => !!store);

  return { rawIngredients, storeStock, stores, targetStores, finishedGoods, prepItems };
}

function getStockDocId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}

type RequiredStockRow = {
  docId: string;
  stockItemType: StockItemType;
  stockItemCode: string;
  stockItemName: string;
  fallbackDocId?: string;
  fallbackStockItemType?: StockItemType;
};

function isStockItemType(value: string): value is StockItemType {
  return ['RAW_INGREDIENT', 'PREP_ITEM', 'BOUGHT_COMPONENT', 'FINISHED_GOOD', 'PACKAGING'].includes(value);
}

function getExistingConfirmedZero(stock: (StoreStock & Record<string, unknown>) | undefined): boolean {
  return stock?.confirmedZero === true;
}

function makeReadinessBlocker(
  store: Store & { id: string },
  requirement: RequiredStockRow,
  stock: (StoreStock & { id: string } & Record<string, unknown>) | undefined,
  pending: PendingStockValues | undefined,
  reason: string,
): ReadinessBlocker {
  return {
    storeCode: store.code,
    stockItemType: stock?.stockItemType || requirement.stockItemType,
    stockItemCode: stock?.stockItemCode || requirement.stockItemCode,
    stockItemName: stock?.stockItemName || requirement.stockItemName,
    currentOpeningStock: stock ? pending?.openingStock ?? toNumber(stock.openingStock) : null,
    currentCurrentStock: stock ? pending?.currentStock ?? toNumber(stock.currentStock) : null,
    confirmedZero: pending?.confirmedZero ?? getExistingConfirmedZero(stock),
    blockerReason: reason,
  };
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
  pendingRawCosts: Map<string, number>,
  pendingStock: Map<string, PendingStockValues>,
): ReadinessStatus[] {
  const rawByCode = new Map(rawIngredients.map((raw) => [raw.code, raw]));
  const prepByCode = new Map(prepItems.map((prep) => [prep.code, prep]));
  const finishedByCode = new Map(finishedGoods.map((finishedGood) => [finishedGood.code, finishedGood]));
  const stockById = new Map(stockRows.map((row) => [row.id, row as StoreStock & { id: string } & Record<string, unknown>]));
  const activeRawCodes = rawIngredients.filter((raw) => raw.isActive !== false).map((raw) => raw.code);

  return stores.map((store) => {
    const costingIssues = activeRawCodes.filter((code) => {
      const raw = rawByCode.get(code);
      const pendingCost = pendingRawCosts.get(code);
      const purchaseCost = pendingCost ?? toNumber(raw?.purchaseCost);
      const conversionFactor = toNumber(raw?.conversionFactor);
      return purchaseCost <= 0 || conversionFactor <= 0;
    }).length;

    const activeSellable = finishedGoods.filter((fg) => (
      fg.isActive !== false
      && fg.isSellable !== false
      && (!Array.isArray(fg.availableStoreIds) || fg.availableStoreIds.length === 0 || fg.availableStoreIds.includes(store.id))
    ));
    const requiredStockRows = new Map<string, RequiredStockRow>();
    const checkoutBlockers: ReadinessBlocker[] = [];

    const addRequiredStock = (requirement: RequiredStockRow) => {
      if (!requiredStockRows.has(requirement.docId)) {
        requiredStockRows.set(requirement.docId, requirement);
      }
    };

    activeSellable.forEach((fg) => {
      const usesBom = fg.itemType === 'MADE_TO_ORDER' || (fg.itemType === 'DIRECT_STOCK' && Array.isArray(fg.bom) && fg.bom.length > 0);
      if ((fg.productionMode === 'MADE_TO_ORDER' || fg.productionMode === 'ASSEMBLED_TO_ORDER' || usesBom) && (!fg.bom || fg.bom.length === 0)) {
        checkoutBlockers.push({
          storeCode: store.code,
          stockItemType: 'FINISHED_GOOD',
          stockItemCode: fg.code,
          stockItemName: fg.name,
          currentOpeningStock: null,
          currentCurrentStock: null,
          confirmedZero: false,
          blockerReason: 'Sellable item requires a BOM before checkout can use FINISHED_GOODS.',
        });
      }

      if (usesBom) {
        fg.bom?.forEach((line) => {
          if (!line.componentCode || !isStockItemType(line.componentType)) return;
          const stockItemType = line.componentType;
          const fallbackStockItemType = stockItemType === 'PACKAGING' ? 'RAW_INGREDIENT' : undefined;
          addRequiredStock({
            docId: getStockDocId(store.id, stockItemType, line.componentCode),
            stockItemType,
            stockItemCode: line.componentCode,
            stockItemName: componentName(line, rawByCode, prepByCode, finishedByCode),
            fallbackDocId: fallbackStockItemType ? getStockDocId(store.id, fallbackStockItemType, line.componentCode) : undefined,
            fallbackStockItemType,
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

    const stockBlockers: ReadinessBlocker[] = [];
    requiredStockRows.forEach((requirement) => {
      let existing = stockById.get(requirement.docId);
      let pending = pendingStock.get(requirement.docId);
      if (!existing && requirement.fallbackDocId) {
        existing = stockById.get(requirement.fallbackDocId);
        pending = pendingStock.get(requirement.fallbackDocId);
      }

      if (!existing) {
        const missingReason = requirement.fallbackDocId
          ? `Missing required stock row ${requirement.docId}; fallback ${requirement.fallbackDocId} was also not found.`
          : `Missing required stock row ${requirement.docId}.`;
        const blocker = makeReadinessBlocker(store, requirement, undefined, undefined, missingReason);
        stockBlockers.push(blocker);
        checkoutBlockers.push(blocker);
        return;
      }
      const openingStock = pending?.openingStock ?? toNumber(existing.openingStock);
      const currentStock = pending?.currentStock ?? toNumber(existing.currentStock);
      const confirmedZero = pending?.confirmedZero ?? getExistingConfirmedZero(existing);
      if ((openingStock <= 0 || currentStock <= 0) && !confirmedZero) {
        const blocker = makeReadinessBlocker(
          store,
          requirement,
          existing,
          pending,
          'Opening/current stock must be greater than 0, unless confirmedZero is stored as true.',
        );
        stockBlockers.push(blocker);
        checkoutBlockers.push(blocker);
      }
    });

    const costingComplete = costingIssues === 0;
    const stockLoaded = stockBlockers.length === 0;
    const checkoutSafe = costingComplete && stockLoaded && checkoutBlockers.length === 0;

    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      costingComplete,
      stockLoaded,
      checkoutSafe,
      eligibleForFinishedGoodsPilot: checkoutSafe,
      costingIssues,
      stockIssues: stockBlockers.length,
      checkoutIssues: checkoutBlockers.length,
      stockBlockers,
      checkoutBlockers,
    };
  });
}

function makeReportRow(
  rowType: 'COSTING' | 'STOCK',
  rowNumber: number,
  collectionName: TargetCollection,
  docId: string,
  action: ReportAction,
  reason: string,
  before: Record<string, unknown>,
  update: Record<string, unknown>,
): ReportRow {
  const hashBefore = before ? stableHash(pickComparable(before, update)) : '';
  const hashAfter = stableHash(update);
  return {
    rowType,
    rowNumber,
    collection: collectionName,
    docId,
    action,
    reason,
    hashBefore,
    hashAfter,
  };
}

async function commitQueuedWrites(writeQueue: Array<(batch: ReturnType<typeof writeBatch>) => void>) {
  for (let index = 0; index < writeQueue.length; index += BATCH_LIMIT) {
    const batch = writeBatch(db);
    writeQueue.slice(index, index + BATCH_LIMIT).forEach((writeOperation) => writeOperation(batch));
    await batch.commit();
  }
}

export default function Phase7HStockCosting() {
  const { staffProfile } = useAuth();
  const [costingFile, setCostingFile] = useState<File | null>(null);
  const [stockFile, setStockFile] = useState<File | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isRunningDryRun, setIsRunningDryRun] = useState(false);
  const [isWritingLive, setIsWritingLive] = useState(false);
  const [error, setError] = useState('');
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [liveSummary, setLiveSummary] = useState<LiveSummary | null>(null);
  const [freshReadiness, setFreshReadiness] = useState<ReadinessStatus[] | null>(null);
  const [readinessRefreshedAt, setReadinessRefreshedAt] = useState('');
  const [isRefreshingReadiness, setIsRefreshingReadiness] = useState(false);

  const liveReady = !!dryRun
    && dryRun.counts.rowsBlocked === 0
    && staffProfile?.role === 'ADMIN'
    && confirmationText.trim() === LIVE_CONFIRMATION
    && !isWritingLive;

  const refreshReadinessFromFirestore = async (showSpinner = true) => {
    if (showSpinner) setIsRefreshingReadiness(true);
    setError('');
    try {
      const data = await loadPhase7HData();
      const readiness = buildReadiness(
        data.targetStores,
        data.rawIngredients,
        data.storeStock,
        data.finishedGoods,
        data.prepItems,
        new Map(),
        new Map(),
      );
      setFreshReadiness(readiness);
      setReadinessRefreshedAt(new Date().toLocaleString());
      return readiness;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to refresh readiness from Firestore.');
      return null;
    } finally {
      if (showSpinner) setIsRefreshingReadiness(false);
    }
  };

  const runDryRun = async () => {
    if (!costingFile && !stockFile) {
      setError('Upload a costing CSV, stock CSV, or both before running dry-run.');
      return;
    }

    setIsRunningDryRun(true);
    setError('');
    setDryRun(null);
    setLiveSummary(null);
    setFreshReadiness(null);
    setReadinessRefreshedAt('');

    try {
      const data = await loadPhase7HData();
      const rawByCode = new Map(data.rawIngredients.map((raw) => [raw.code, raw]));
      const stockById = new Map(data.storeStock.map((row) => [row.id, row]));
      const targetStoresById = new Map(data.targetStores.map((store) => [store.id, store]));
      const targetStoreCodes = new Set(data.targetStores.map((store) => store.code));
      const reportRows: ReportRow[] = [];
      const writeEntries: WriteEntry[] = [];
      const warnings: string[] = ['No POS source switch is performed in Phase 7H.'];
      const pendingRawCosts = new Map<string, number>();
      const pendingStock = new Map<string, Partial<Pick<StoreStock, 'openingStock' | 'currentStock' | 'minimumStock'>> & { confirmedZero?: boolean }>();
      let confirmedZeroRows = 0;

      if (data.targetStores.length !== REQUIRED_STORE_CODES.length) {
        warnings.push(`Only ${data.targetStores.length}/3 target stores resolved. Stock upload rows for missing stores will be blocked.`);
      }

      if (costingFile) {
        const rows = parseCsv(await readFile(costingFile));
        rows.forEach((row, index) => {
          const rowNumber = index + 2;
          const code = cleanValue(row.code);
          const raw = rawByCode.get(code);
          const notes = cleanValue(row.notes);
          const reviewFlagged = isReviewFlagged(notes);

          if (!code || !raw) {
            reportRows.push({
              rowType: 'COSTING',
              rowNumber,
              collection: 'rawIngredients',
              docId: code || '(blank)',
              action: 'BLOCKED',
              reason: 'Raw ingredient code does not exist.',
              hashBefore: '',
              hashAfter: '',
            });
            return;
          }

          const conversionFactor = toNumber(raw.conversionFactor);
          if (conversionFactor <= 0) {
            reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, 'BLOCKED', 'Existing conversionFactor must be greater than 0.', raw, {}));
            return;
          }

          if (isBlank(row.newPurchaseCost)) {
            if (toNumber(raw.purchaseCost) <= 0 && !reviewFlagged) {
              reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, 'BLOCKED', 'newPurchaseCost is blank while current cost is zero. Add a cost or flag notes for review.', raw, {}));
              return;
            }
            const reason = reviewFlagged && toNumber(raw.purchaseCost) <= 0
              ? 'Cost remains zero and is explicitly flagged for review.'
              : 'No new purchase cost provided; existing cost is preserved.';
            reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, 'UNCHANGED', reason, raw, {
              purchaseCost: raw.purchaseCost,
              costPerUsageUnit: raw.costPerUsageUnit,
            }));
            return;
          }

          const parsed = parseNumberStrict(row.newPurchaseCost);
          if (!parsed.ok || parsed.value === null) {
            reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, 'BLOCKED', 'newPurchaseCost must be numeric.', raw, {}));
            return;
          }

          if (parsed.value <= 0) {
            if (reviewFlagged) {
              reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, 'UNCHANGED', 'Zero cost is explicitly flagged for review; previous cost is preserved.', raw, {
                purchaseCost: raw.purchaseCost,
                costPerUsageUnit: raw.costPerUsageUnit,
              }));
              return;
            }
            reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, 'BLOCKED', 'newPurchaseCost must be greater than 0 unless notes explicitly flag review.', raw, {}));
            return;
          }

          const costPerUsageUnit = Math.round(((parsed.value / conversionFactor) + Number.EPSILON) * 10000) / 10000;
          const update = {
            purchaseCost: parsed.value,
            costPerUsageUnit,
          };
          const beforeComparable = pickComparable(raw, update);
          const action: ReportAction = stableHash(beforeComparable) === stableHash(update) ? 'UNCHANGED' : 'UPDATE';
          const reason = action === 'UPDATE' ? 'Valid new purchase cost will be applied.' : 'Cost already matches uploaded value.';
          reportRows.push(makeReportRow('COSTING', rowNumber, 'rawIngredients', code, action, reason, raw, update));
          pendingRawCosts.set(code, parsed.value);
          if (action === 'UPDATE') {
            writeEntries.push({
              rowType: 'COSTING',
              collection: 'rawIngredients',
              docId: code,
              docPath: `rawIngredients/${code}`,
              action,
              reason,
              hashBefore: stableHash(beforeComparable),
              hashAfter: stableHash(update),
              before: raw,
              update,
            });
          }
        });
      }

      if (stockFile) {
        const rows = parseCsv(await readFile(stockFile));
        rows.forEach((row, index) => {
          const rowNumber = index + 2;
          const storeId = cleanValue(row.storeId);
          const storeCode = cleanValue(row.storeCode);
          const stockItemType = cleanValue(row.stockItemType).toUpperCase();
          const stockItemCode = cleanValue(row.stockItemCode);
          const store = targetStoresById.get(storeId);
          const confirmedZero = parseBool(row.confirmedZero);

          if (!store || !targetStoreCodes.has(storeCode)) {
            reportRows.push({
              rowType: 'STOCK',
              rowNumber,
              collection: 'storeStock',
              docId: storeId || '(blank)',
              action: 'BLOCKED',
              reason: 'Store must exist and be one of Uday Park, Noida Sector 29, or Noida Sector 51.',
              hashBefore: '',
              hashAfter: '',
            });
            return;
          }

          if (!stockItemType || !stockItemCode) {
            reportRows.push({
              rowType: 'STOCK',
              rowNumber,
              collection: 'storeStock',
              docId: '(blank)',
              action: 'BLOCKED',
              reason: 'stockItemType and stockItemCode are required.',
              hashBefore: '',
              hashAfter: '',
            });
            return;
          }

          const docId = getStockDocId(store.id, stockItemType, stockItemCode);
          const stock = stockById.get(docId);
          if (!stock) {
            reportRows.push({
              rowType: 'STOCK',
              rowNumber,
              collection: 'storeStock',
              docId,
              action: 'BLOCKED',
              reason: 'storeStock row does not exist. Unknown stock item codes are blocked.',
              hashBefore: '',
              hashAfter: '',
            });
            return;
          }

          const update: Record<string, number> = {};
          const fields = [
            ['newOpeningStock', 'openingStock'],
            ['newCurrentStock', 'currentStock'],
            ['minimumStock', 'minimumStock'],
          ] as const;

          for (const [csvField, docField] of fields) {
            if (isBlank(row[csvField])) continue;
            const parsed = parseNumberStrict(row[csvField]);
            if (!parsed.ok || parsed.value === null) {
              reportRows.push(makeReportRow('STOCK', rowNumber, 'storeStock', docId, 'BLOCKED', `${csvField} must be numeric.`, stock, {}));
              return;
            }
            if (parsed.value < 0) {
              reportRows.push(makeReportRow('STOCK', rowNumber, 'storeStock', docId, 'BLOCKED', `${csvField} must be greater than or equal to 0.`, stock, {}));
              return;
            }
            update[docField] = parsed.value;
          }

          const finalOpening = update.openingStock ?? toNumber(stock.openingStock);
          const finalCurrent = update.currentStock ?? toNumber(stock.currentStock);
          if ((finalOpening <= 0 || finalCurrent <= 0) && !confirmedZero) {
            reportRows.push(makeReportRow('STOCK', rowNumber, 'storeStock', docId, 'BLOCKED', 'Zero opening/current stock requires confirmedZero = TRUE.', stock, update));
            return;
          }

          if (confirmedZero) confirmedZeroRows += 1;
          if (Object.keys(update).length === 0) {
            reportRows.push(makeReportRow('STOCK', rowNumber, 'storeStock', docId, 'UNCHANGED', 'No new stock values provided; existing stock is preserved.', stock, {
              openingStock: stock.openingStock,
              currentStock: stock.currentStock,
              minimumStock: stock.minimumStock,
            }));
            pendingStock.set(docId, { confirmedZero });
            return;
          }

          const beforeComparable = pickComparable(stock, update);
          const action: ReportAction = stableHash(beforeComparable) === stableHash(update) ? 'UNCHANGED' : 'UPDATE';
          const reason = action === 'UPDATE' ? 'Valid stock values will be applied.' : 'Stock values already match uploaded values.';
          reportRows.push(makeReportRow('STOCK', rowNumber, 'storeStock', docId, action, reason, stock, update));
          pendingStock.set(docId, {
            openingStock: update.openingStock,
            currentStock: update.currentStock,
            minimumStock: update.minimumStock,
            confirmedZero,
          });
          if (action === 'UPDATE') {
            writeEntries.push({
              rowType: 'STOCK',
              collection: 'storeStock',
              docId,
              docPath: `storeStock/${docId}`,
              action,
              reason,
              hashBefore: stableHash(beforeComparable),
              hashAfter: stableHash(update),
              before: stock,
              update,
            });
          }
        });
      }

      const readiness = buildReadiness(
        data.targetStores,
        data.rawIngredients,
        data.storeStock,
        data.finishedGoods,
        data.prepItems,
        pendingRawCosts,
        pendingStock,
      );

      const rowsBlocked = reportRows.filter((row) => row.action === 'BLOCKED').length;
      const unchangedRows = reportRows.filter((row) => row.action === 'UNCHANGED').length;
      const costsToUpdate = writeEntries.filter((entry) => entry.collection === 'rawIngredients').length;
      const stockRowsToUpdate = writeEntries.filter((entry) => entry.collection === 'storeStock').length;

      setDryRun({
        batchId: `phase7h-dry-run-${new Date().toISOString()}`,
        mode: costingFile && stockFile ? 'combined' : costingFile ? 'costing' : 'stock',
        reportRows,
        writeEntries,
        readiness,
        warnings,
        counts: {
          rowsValid: reportRows.length - rowsBlocked,
          rowsBlocked,
          costsToUpdate,
          stockRowsToUpdate,
          confirmedZeroRows,
          unchangedRows,
        },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Phase 7H dry-run failed.');
    } finally {
      setIsRunningDryRun(false);
    }
  };

  const exportCostingSheet = async () => {
    setIsExporting(true);
    setError('');
    try {
      const { rawIngredients } = await loadPhase7HData();
      const rows = rawIngredients
        .filter((raw) => raw.isActive !== false)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((raw) => ({
          code: raw.code,
          name: raw.name,
          category: raw.category,
          purchaseUOM: raw.purchaseUOM,
          usageUOM: raw.usageUOM,
          conversionFactor: raw.conversionFactor,
          currentPurchaseCost: raw.purchaseCost,
          newPurchaseCost: '',
          supplierName: raw.supplierName || '',
          notes: '',
        }));
      downloadText(
        'Coffee_Bond_Phase7H_Raw_Ingredients_Costing.csv',
        makeCsv(rows, ['code', 'name', 'category', 'purchaseUOM', 'usageUOM', 'conversionFactor', 'currentPurchaseCost', 'newPurchaseCost', 'supplierName', 'notes']),
        'text/csv;charset=utf-8;',
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to export costing sheet.');
    } finally {
      setIsExporting(false);
    }
  };

  const exportStockSheet = async () => {
    setIsExporting(true);
    setError('');
    try {
      const { targetStores, storeStock } = await loadPhase7HData();
      const targetStoreIds = new Set(targetStores.map((store) => store.id));
      const storeById = new Map(targetStores.map((store) => [store.id, store]));
      const rows = storeStock
        .filter((stock) => targetStoreIds.has(stock.storeId))
        .sort((a, b) => `${a.storeName}_${a.stockItemType}_${a.stockItemName}`.localeCompare(`${b.storeName}_${b.stockItemType}_${b.stockItemName}`))
        .map((stock) => {
          const store = storeById.get(stock.storeId);
          return {
            storeId: stock.storeId,
            storeCode: store?.code || '',
            storeName: store?.name || stock.storeName,
            stockItemType: stock.stockItemType,
            stockItemCode: stock.stockItemCode,
            stockItemName: stock.stockItemName,
            uom: stock.uom,
            currentOpeningStock: stock.openingStock,
            currentCurrentStock: stock.currentStock,
            newOpeningStock: '',
            newCurrentStock: '',
            minimumStock: stock.minimumStock,
            confirmedZero: '',
            notes: '',
          };
        });
      downloadText(
        'Coffee_Bond_Phase7H_Opening_Stock.csv',
        makeCsv(rows, ['storeId', 'storeCode', 'storeName', 'stockItemType', 'stockItemCode', 'stockItemName', 'uom', 'currentOpeningStock', 'currentCurrentStock', 'newOpeningStock', 'newCurrentStock', 'minimumStock', 'confirmedZero', 'notes']),
        'text/csv;charset=utf-8;',
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to export opening stock sheet.');
    } finally {
      setIsExporting(false);
    }
  };

  const downloadCsvReport = () => {
    if (!dryRun) return;
    downloadText(
      'Coffee_Bond_Phase7H_Dry_Run_Report.csv',
      makeCsv(dryRun.reportRows, ['rowType', 'rowNumber', 'collection', 'docId', 'action', 'reason', 'hashBefore', 'hashAfter']),
      'text/csv;charset=utf-8;',
    );
  };

  const downloadJsonReport = () => {
    if (!dryRun) return;
    downloadText('Coffee_Bond_Phase7H_Dry_Run_Report.json', JSON.stringify(dryRun, null, 2), 'application/json;charset=utf-8;');
  };

  const runLiveWrite = async () => {
    if (!dryRun || dryRun.counts.rowsBlocked > 0) {
      setError('Live write is blocked until dry-run has zero blocked rows.');
      return;
    }
    if (staffProfile?.role !== 'ADMIN') {
      setError('Only Admin users can run the live Phase 7H write.');
      return;
    }
    if (confirmationText.trim() !== LIVE_CONFIRMATION) {
      setError('Type the confirmation text exactly before running live write.');
      return;
    }
    if (!window.confirm(`${LIVE_CONFIRMATION}\n\nThis writes only rawIngredients cost fields, storeStock stock fields, and importManifests audit records. Continue?`)) {
      return;
    }

    setIsWritingLive(true);
    setError('');
    setLiveSummary(null);

    let importBatchId = '';
    try {
      importBatchId = `phase7h-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const adminName = staffProfile.displayName || staffProfile.name || staffProfile.email || 'Admin';
      const manifestRef = doc(db, 'importManifests', importBatchId);
      const docPathsTouched = dryRun.writeEntries.map((entry) => entry.docPath);

      await setDoc(manifestRef, {
        importBatchId,
        phase: 'PHASE_7H_STOCK_COSTING',
        mode: dryRun.mode,
        status: 'STARTED',
        dryRunBatchId: dryRun.batchId,
        createdAt: serverTimestamp(),
        createdBy: {
          uid: staffProfile.uid,
          name: adminName,
          email: staffProfile.email || '',
          role: staffProfile.role,
        },
        docPathsTouched,
        totals: {
          update: dryRun.writeEntries.length,
          unchanged: dryRun.counts.unchangedRows,
          blocked: dryRun.counts.rowsBlocked,
          costUpdates: dryRun.counts.costsToUpdate,
          stockUpdates: dryRun.counts.stockRowsToUpdate,
        },
        warnings: dryRun.warnings,
        readiness: dryRun.readiness,
        rolloutSwitchChanged: false,
        legacyCollectionsChanged: false,
      });

      const writeQueue: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
      dryRun.writeEntries.forEach((entry, index) => {
        const entryId = `${String(index + 1).padStart(4, '0')}_${stableHash(entry.docPath)}`;
        writeQueue.push((batch) => {
          batch.set(doc(db, 'importManifests', importBatchId, 'entries', entryId), {
            importBatchId,
            phase: 'PHASE_7H_STOCK_COSTING',
            collection: entry.collection,
            docId: entry.docId,
            docPath: entry.docPath,
            action: entry.action,
            reason: entry.reason,
            hashBefore: entry.hashBefore,
            hashAfter: entry.hashAfter,
            rollbackSnapshot: entry.before || null,
            createdAt: serverTimestamp(),
          });
        });

        writeQueue.push((batch) => {
          batch.set(doc(db, entry.collection, entry.docId), {
            ...entry.update,
            updatedAt: serverTimestamp(),
            phase7HImportBatchId: importBatchId,
            lastStockCostingUploadAt: serverTimestamp(),
          }, { merge: true });
        });
      });

      await commitQueuedWrites(writeQueue);
      await setDoc(manifestRef, {
        status: 'COMPLETED',
        completedAt: serverTimestamp(),
      }, { merge: true });

      setLiveSummary({
        importBatchId,
        manifestId: importBatchId,
        costsUpdated: dryRun.counts.costsToUpdate,
        stockRowsUpdated: dryRun.counts.stockRowsToUpdate,
        unchangedRows: dryRun.counts.unchangedRows,
      });
      await refreshReadinessFromFirestore(false);
    } catch (err: unknown) {
      if (importBatchId) {
        try {
          await setDoc(doc(db, 'importManifests', importBatchId), {
            status: 'FAILED_OR_PARTIAL',
            failedAt: serverTimestamp(),
            failureMessage: err instanceof Error ? err.message : 'Phase 7H live write failed.',
          }, { merge: true });
        } catch {
          // Keep the original error visible if the failure manifest cannot be written.
        }
      }
      setError(err instanceof Error ? err.message : 'Phase 7H live write failed.');
    } finally {
      setIsWritingLive(false);
    }
  };

  const blockedRows = useMemo(() => dryRun?.reportRows.filter((row) => row.action === 'BLOCKED') || [], [dryRun]);
  const displayedReadiness = freshReadiness || dryRun?.readiness || [];
  const readinessSource = freshReadiness
    ? 'Latest Firestore data'
    : dryRun
      ? 'Dry-run preview with uploaded values'
      : 'No readiness loaded yet';

  return (
    <div className="max-w-6xl mx-auto w-full pb-20 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Coffee Bond Menu Management</p>
          <h1 className="text-3xl font-black text-[#5c4033]">Phase 7H Stock + Costing Upload</h1>
          <p className="text-neutral-600 mt-2">Export, validate, and safely upload raw ingredient costs and opening stock. POS stays on legacy.</p>
        </div>
        <Link to="/admin" className="text-sm font-bold text-[#5c4033] hover:underline">
          Back to Admin Dashboard
        </Link>
      </div>

      <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-5 flex gap-4">
        <ShieldAlert className="w-6 h-6 shrink-0 mt-0.5" />
        <div>
          <h2 className="font-black text-lg">No POS rollout in Phase 7H</h2>
          <p className="text-sm mt-1">This page never switches appSettings/posMenuSource, never touches legacy collections, and never changes checkout behavior.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 flex gap-3 text-sm">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Export Costing Sheet" description="Download all active raw ingredients with blank newPurchaseCost cells for costing entry.">
          <button
            type="button"
            onClick={exportCostingSheet}
            disabled={isExporting}
            className="w-full px-5 py-3 rounded-xl bg-[#5c4033] text-white font-black flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isExporting ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
            Export Costing CSV
          </button>
        </Panel>

        <Panel title="Export Opening Stock Sheet" description="Download storeStock rows for Uday Park, Noida Sector 29, and Noida Sector 51.">
          <button
            type="button"
            onClick={exportStockSheet}
            disabled={isExporting}
            className="w-full px-5 py-3 rounded-xl bg-[#5c4033] text-white font-black flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isExporting ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
            Export Opening Stock CSV
          </button>
        </Panel>
      </div>

      <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
            <Upload size={20} />
          </div>
          <div>
            <h2 className="text-xl font-black text-neutral-800">Upload CSVs For Dry-Run</h2>
            <p className="text-sm text-neutral-500">Upload costing, stock, or both. Nothing is written until the guarded live confirmation.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FilePicker
            title="Updated Costing CSV"
            description="Use the exported costing sheet and fill newPurchaseCost."
            file={costingFile}
            onChange={(file) => {
              setCostingFile(file);
              setDryRun(null);
              setLiveSummary(null);
            }}
          />
          <FilePicker
            title="Opening Stock CSV"
            description="Use the exported stock sheet and fill newOpeningStock/newCurrentStock."
            file={stockFile}
            onChange={(file) => {
              setStockFile(file);
              setDryRun(null);
              setLiveSummary(null);
            }}
          />
        </div>

        <button
          type="button"
          onClick={runDryRun}
          disabled={(!costingFile && !stockFile) || isRunningDryRun}
          className="mt-6 w-full md:w-auto px-6 py-3 bg-[#5c4033] text-white font-black rounded-xl hover:bg-[#3e2723] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isRunningDryRun ? <Loader2 size={18} className="animate-spin" /> : <FileSearch size={18} />}
          {isRunningDryRun ? 'Running Dry-Run...' : 'Run Phase 7H Dry-Run'}
        </button>
      </div>

      <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-5">
          <div>
            <h2 className="text-xl font-black text-neutral-800">Readiness Status</h2>
            <p className="text-sm text-neutral-500 mt-1">
              Source: <span className="font-bold text-neutral-700">{readinessSource}</span>
              {readinessRefreshedAt && <span> | Last refreshed: {readinessRefreshedAt}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshReadinessFromFirestore()}
            disabled={isRefreshingReadiness}
            className="px-4 py-2 rounded-xl bg-neutral-100 text-neutral-800 font-bold flex items-center justify-center gap-2 hover:bg-neutral-200 disabled:opacity-50"
          >
            {isRefreshingReadiness ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh Readiness from Firestore
          </button>
        </div>

        {displayedReadiness.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-5 text-sm text-neutral-600">
            Run a dry-run or refresh from Firestore to view rollout readiness.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {displayedReadiness.map((store) => (
              <ReadinessStoreCard key={store.storeId} store={store} />
            ))}
          </div>
        )}
      </div>

      {dryRun && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <SummaryCard label="Rows Valid" value={dryRun.counts.rowsValid} tone="emerald" />
            <SummaryCard label="Blocked" value={dryRun.counts.rowsBlocked} tone="red" />
            <SummaryCard label="Costs Update" value={dryRun.counts.costsToUpdate} tone="amber" />
            <SummaryCard label="Stock Update" value={dryRun.counts.stockRowsToUpdate} tone="amber" />
            <SummaryCard label="Confirmed Zero" value={dryRun.counts.confirmedZeroRows} tone="neutral" />
            <SummaryCard label="Unchanged" value={dryRun.counts.unchangedRows} tone="neutral" />
          </div>

          {dryRun.warnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-5">
              <h2 className="font-black mb-3">Warnings</h2>
              <ul className="space-y-2 text-sm">
                {dryRun.warnings.map((warning) => (
                  <li key={warning} className="flex gap-2">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {blockedRows.length > 0 && (
            <div className="bg-red-50 border border-red-200 text-red-900 rounded-2xl p-5">
              <h2 className="font-black mb-3">Blocked Rows</h2>
              <div className="max-h-[320px] overflow-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-red-700 border-b border-red-200">
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4">Row</th>
                      <th className="py-2 pr-4">Doc</th>
                      <th className="py-2 pr-4">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blockedRows.slice(0, 100).map((row) => (
                      <tr key={`${row.rowType}-${row.rowNumber}-${row.docId}`} className="border-b border-red-100 last:border-0">
                        <td className="py-2 pr-4 font-bold">{row.rowType}</td>
                        <td className="py-2 pr-4">{row.rowNumber}</td>
                        <td className="py-2 pr-4 font-mono">{row.docId}</td>
                        <td className="py-2 pr-4">{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {blockedRows.length > 100 && <p className="text-xs mt-3">Showing first 100 blocked rows. Download the report for all rows.</p>}
            </div>
          )}

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
              <div>
                <h2 className="text-xl font-black text-neutral-800">Dry-Run Report</h2>
                <p className="text-sm text-neutral-500">Download the report before live write for review and sign-off.</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <button type="button" onClick={downloadCsvReport} className="px-4 py-2 rounded-xl bg-neutral-100 text-neutral-800 font-bold flex items-center justify-center gap-2 hover:bg-neutral-200">
                  <Download size={16} />
                  CSV
                </button>
                <button type="button" onClick={downloadJsonReport} className="px-4 py-2 rounded-xl bg-neutral-100 text-neutral-800 font-bold flex items-center justify-center gap-2 hover:bg-neutral-200">
                  <Download size={16} />
                  JSON
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Guarded Live Write</p>
                <h2 className="text-xl font-black text-neutral-800">Update Costs + Opening Stock</h2>
                <p className="text-sm text-neutral-600 mt-2">Writes only valid raw ingredient cost fields, storeStock stock fields, and importManifests audit records.</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${dryRun.counts.rowsBlocked === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {dryRun.counts.rowsBlocked === 0 ? 'READY AFTER CONFIRMATION' : 'BLOCKED'}
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
              onClick={runLiveWrite}
              disabled={!liveReady}
              className="mt-5 w-full md:w-auto px-6 py-3 bg-red-700 text-white font-black rounded-xl hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isWritingLive ? <Loader2 size={18} className="animate-spin" /> : <ShieldAlert size={18} />}
              {isWritingLive ? 'Writing...' : 'Run Guarded Live Write'}
            </button>

            {liveSummary && (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                <p className="font-black">Phase 7H write complete. POS rollout was not changed.</p>
                <p className="text-sm mt-2">Costs updated: {liveSummary.costsUpdated} | Stock rows updated: {liveSummary.stockRowsUpdated} | Unchanged rows: {liveSummary.unchangedRows}</p>
                <p className="text-xs mt-2">Manifest ID: <span className="font-mono">{liveSummary.manifestId}</span></p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
      <h2 className="text-xl font-black text-neutral-800">{title}</h2>
      <p className="text-sm text-neutral-500 mt-2 mb-5">{description}</p>
      {children}
    </div>
  );
}

function FilePicker({ title, description, file, onChange }: { title: string; description: string; file: File | null; onChange: (file: File | null) => void }) {
  return (
    <label className="border border-neutral-200 rounded-xl p-4 bg-neutral-50 block">
      <span className="block text-sm font-black text-neutral-800">{title}</span>
      <span className="block text-xs text-neutral-500 mb-3">{description}</span>
      <input
        type="file"
        accept=".csv"
        onChange={(event) => onChange(event.target.files?.[0] || null)}
        className="block w-full text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-[#5c4033] file:px-4 file:py-2 file:text-sm file:font-bold file:text-white"
      />
      <span className="mt-2 block text-xs text-neutral-500">{file ? file.name : 'No file selected'}</span>
    </label>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'emerald' | 'amber' | 'red' | 'neutral' }) {
  const toneClass = {
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    red: 'bg-red-50 text-red-800 border-red-200',
    neutral: 'bg-neutral-50 text-neutral-800 border-neutral-200',
  }[tone];

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${toneClass}`}>
      <p className="text-xs uppercase tracking-wide font-black opacity-75">{label}</p>
      <p className="text-3xl font-black mt-2">{value}</p>
    </div>
  );
}

function readinessBlockerKey(blocker: ReadinessBlocker): string {
  return `${blocker.storeCode}_${blocker.stockItemType}_${blocker.stockItemCode}_${blocker.blockerReason}`;
}

function ReadinessStoreCard({ store }: { store: ReadinessStatus }) {
  const blockers = [
    ...store.stockBlockers,
    ...store.checkoutBlockers.filter((blocker) => !store.stockBlockers.some((stockBlocker) => readinessBlockerKey(stockBlocker) === readinessBlockerKey(blocker))),
  ];

  return (
    <div className="border border-neutral-200 rounded-xl p-4">
      <p className="font-black text-neutral-800">{store.storeName}</p>
      <p className="text-xs text-neutral-500 mb-3">{store.storeCode}</p>
      <StatusLine label="Costing complete" ok={store.costingComplete} detail={`${store.costingIssues} issue(s)`} />
      <StatusLine label="Stock loaded" ok={store.stockLoaded} detail={`${store.stockIssues} issue(s)`} />
      <StatusLine label="Checkout safe" ok={store.checkoutSafe} detail={`${store.checkoutIssues} issue(s)`} />
      <StatusLine
        label={store.checkoutSafe ? 'Eligible for FINISHED_GOODS pilot' : 'Not eligible for FINISHED_GOODS pilot'}
        ok={store.eligibleForFinishedGoodsPilot}
      />

      {blockers.length > 0 ? (
        <details className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3">
          <summary className="cursor-pointer text-sm font-black text-red-800">
            Show exact blocker rows ({blockers.length})
          </summary>
          <div className="mt-3 max-h-64 overflow-auto">
            <table className="min-w-[720px] text-xs">
              <thead>
                <tr className="text-left uppercase text-red-700 border-b border-red-200">
                  <th className="py-2 pr-3">Store</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Code</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Opening</th>
                  <th className="py-2 pr-3">Current</th>
                  <th className="py-2 pr-3">Confirmed Zero</th>
                  <th className="py-2 pr-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {blockers.map((blocker) => (
                  <tr key={readinessBlockerKey(blocker)} className="border-b border-red-100 last:border-0">
                    <td className="py-2 pr-3 font-bold">{blocker.storeCode}</td>
                    <td className="py-2 pr-3">{blocker.stockItemType}</td>
                    <td className="py-2 pr-3 font-mono">{blocker.stockItemCode}</td>
                    <td className="py-2 pr-3">{blocker.stockItemName}</td>
                    <td className="py-2 pr-3">{blocker.currentOpeningStock ?? 'Missing'}</td>
                    <td className="py-2 pr-3">{blocker.currentCurrentStock ?? 'Missing'}</td>
                    <td className="py-2 pr-3">{blocker.confirmedZero ? 'TRUE' : 'FALSE'}</td>
                    <td className="py-2 pr-3">{blocker.blockerReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <p className="mt-4 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 text-xs font-bold text-emerald-800">
          No stock or checkout blocker rows found for this store.
        </p>
      )}
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
