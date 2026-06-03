import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSearch,
  Loader2,
  ShieldAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StoreStock } from '../../types/menu-management';
import { Store } from '../../types';
import { useAuth } from '../../contexts/AuthContext';

type FileKey = 'raw' | 'prepSummary' | 'prepBom' | 'finishedBom' | 'finishedSummary';
type ReportAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'BLOCKED';
type ImportCollection = 'rawIngredients' | 'prepItems' | 'finishedGoods' | 'storeStock';

type CsvRow = Record<string, string>;

type FileConfig = {
  key: FileKey;
  label: string;
  expectedName: string;
  expectedRows: number;
};

type DryRunReportRow = {
  collection: string;
  docId: string;
  action: ReportAction;
  reason: string;
  hashBefore: string;
  hashAfter: string;
};

type ImportPayloadRecord = {
  collectionName: ImportCollection;
  docId: string;
  payload: Record<string, unknown>;
  existing?: Record<string, unknown>;
  action: ReportAction;
  reason: string;
  hashBefore: string;
  hashAfter: string;
};

type StoreStockBreakdown = {
  storeId: string;
  storeCode: string;
  storeName: string;
  rawIngredientRows: number;
  packagingRows: number;
  prepItemRows: number;
  boughtAndSoldRows: number;
  totalRows: number;
  zeroCurrentStockRows: number;
};

type DryRunResult = {
  batchId: string;
  rowCounts: Record<FileKey, number>;
  expectedCounts: Record<FileKey, number>;
  stores: Store[];
  missingStoreCodes: string[];
  payloadCounts: {
    rawIngredients: number;
    prepItems: number;
    finishedGoods: number;
    storeStock: number;
  };
  actionCounts: Record<ReportAction, number>;
  zeroCostCount: number;
  missingDependencies: string[];
  checkoutBlockers: string[];
  warnings: string[];
  storeStockBreakdown: StoreStockBreakdown[];
  reportRows: DryRunReportRow[];
  importPayloads: ImportPayloadRecord[];
  appSettingsPreview: {
    currentGlobalSource: string;
    requiredGlobalSource: 'LEGACY_MENU_ITEMS';
    storeOverrides: Record<string, string>;
  };
};

type LiveImportSummary = {
  importBatchId: string;
  manifestId: string;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  storeStockCreated: number;
  storeStockUpdated: number;
  posMenuSourceAfter: string;
};

type LiveImportGate = {
  ready: boolean;
  checks: {
    label: string;
    ok: boolean;
  }[];
  blockers: string[];
};

type LiveImportFailure = {
  stage: string;
  collection: string;
  docPath: string;
  code: string;
  message: string;
};

type PermissionCheck = {
  collection: ImportCollection | 'importManifests';
  ruleSummary: string;
  shouldAllow: boolean;
};

type QueuedWrite = {
  collection: string;
  docPath: string;
  apply: (batch: ReturnType<typeof writeBatch>) => void;
};

const FILES: FileConfig[] = [
  {
    key: 'raw',
    label: 'Final raw ingredients',
    expectedName: 'Coffee_Bond_Phase7D_Final_Raw_Ingredients.csv',
    expectedRows: 143,
  },
  {
    key: 'prepSummary',
    label: 'Prep item summary',
    expectedName: 'Coffee_Bond_New_Menu_Prep_Items_Summary.csv',
    expectedRows: 54,
  },
  {
    key: 'prepBom',
    label: 'Final prep BOM',
    expectedName: 'Coffee_Bond_Phase7D_Final_Prep_BOM.csv',
    expectedRows: 210,
  },
  {
    key: 'finishedBom',
    label: 'Final finished goods BOM',
    expectedName: 'Coffee_Bond_Phase7D_Final_Finished_Goods_BOM.csv',
    expectedRows: 306,
  },
  {
    key: 'finishedSummary',
    label: 'Final finished items summary',
    expectedName: 'Coffee_Bond_Phase7D_Final_Finished_Items_Summary.csv',
    expectedRows: 73,
  },
];

const REQUIRED_STORE_CODES = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];
const COMPARE_COLLECTIONS: ImportCollection[] = ['rawIngredients', 'prepItems', 'finishedGoods', 'storeStock'];
const LIVE_IMPORT_CONFIRMATION = 'I understand this will write Menu Management V2 data, but will not switch POS rollout.';
const LIVE_IMPORT_MAX_BATCH_WRITES = 400;
const BLOCKED_COLLECTIONS = ['menuItems', 'categories', 'inventoryItems', 'storeInventory', 'recipes', 'orders', 'kot', 'kotItems'];

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

function toBool(value: unknown, fallback = true): boolean {
  const cleaned = cleanValue(value).toLowerCase();
  if (!cleaned) return fallback;
  if (['false', 'no', '0', 'inactive'].includes(cleaned)) return false;
  if (['true', 'yes', '1', 'active'].includes(cleaned)) return true;
  return fallback;
}

function normalizeUom(value: unknown): string {
  const cleaned = cleanValue(value);
  const key = cleaned.toLowerCase().replace(/\./g, '');
  const aliases: Record<string, string> = {
    litre: 'L',
    liter: 'L',
    ltr: 'L',
    ltrs: 'L',
    litres: 'L',
    liters: 'L',
    l: 'L',
    millilitre: 'ML',
    milliliter: 'ML',
    millilitres: 'ML',
    milliliters: 'ML',
    ml: 'ML',
    kilogram: 'KG',
    kilograms: 'KG',
    kg: 'KG',
    gram: 'G',
    grams: 'G',
    g: 'G',
    piece: 'PCS',
    pieces: 'PCS',
    pcs: 'PCS',
    pc: 'PCS',
    bottle: 'BOTTLE',
    bottles: 'BOTTLE',
  };
  return aliases[key] || cleaned.toUpperCase();
}

function normalizeBomType(value: unknown): BOMComponent['componentType'] {
  const type = cleanValue(value).toUpperCase();
  if (type === 'RAW') return 'RAW_INGREDIENT';
  if (type === 'PREP') return 'PREP_ITEM';
  if (type === 'BOUGHT_COMPONENT') return 'BOUGHT_COMPONENT';
  if (type === 'FINISHED_GOOD') return 'FINISHED_GOOD';
  if (type === 'PACKAGING') return 'PACKAGING';
  return 'RAW_INGREDIENT';
}

function itemTypeFromProductionMode(productionMode: string, currentItemType: string): FinishedGood['itemType'] {
  if (productionMode === 'BOUGHT_AND_SOLD') return 'DIRECT_STOCK';
  if (productionMode === 'NO_STOCK') return 'NO_STOCK';
  if (currentItemType === 'DIRECT_STOCK' || currentItemType === 'NO_STOCK') return currentItemType as FinishedGood['itemType'];
  return 'MADE_TO_ORDER';
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

function pickComparable(existing: Record<string, unknown> | undefined, payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!existing) return undefined;
  const picked: Record<string, unknown> = {};
  Object.keys(payload).forEach((key) => {
    picked[key] = existing[key];
  });
  return picked;
}

function makeReportRow(
  collectionName: string,
  docId: string,
  payload: Record<string, unknown>,
  existing?: Record<string, unknown>,
  forcedAction?: ReportAction,
  forcedReason?: string,
): DryRunReportRow {
  const comparableExisting = pickComparable(existing, payload);
  const hashBefore = comparableExisting ? stableHash(comparableExisting) : '';
  const hashAfter = stableHash(payload);
  const action: ReportAction = forcedAction || (!existing ? 'CREATE' : hashBefore === hashAfter ? 'UNCHANGED' : 'UPDATE');
  const reason = forcedReason || (action === 'CREATE' ? 'Document does not exist.' : action === 'UPDATE' ? 'Existing document differs from dry-run payload.' : 'Existing document already matches dry-run payload.');

  return {
    collection: collectionName,
    docId,
    action,
    reason,
    hashBefore,
    hashAfter,
  };
}

function makeCsv(rows: DryRunReportRow[]): string {
  const columns: (keyof DryRunReportRow)[] = ['collection', 'docId', 'action', 'reason', 'hashBefore', 'hashAfter'];
  const escapeCell = (value: unknown) => {
    const text = cleanValue(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };

  return [
    columns.join(','),
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

async function readCollectionMap(collectionName: string): Promise<Map<string, Record<string, unknown>>> {
  const snapshot = await getDocs(collection(db, collectionName));
  return new Map(snapshot.docs.map((docSnap) => [docSnap.id, docSnap.data() as Record<string, unknown>]));
}

function getPosGlobalSource(appSettings: Record<string, unknown>): string {
  return cleanValue(appSettings.globalSource || appSettings.source || 'LEGACY_MENU_ITEMS') || 'LEGACY_MENU_ITEMS';
}

function getLiveImportGate(result: DryRunResult | null): LiveImportGate {
  if (!result) {
    return {
      ready: false,
      checks: [],
      blockers: ['Run a successful dry-run first.'],
    };
  }

  const rowCountsOk = FILES.every((file) => result.rowCounts[file.key] === file.expectedRows);
  const missingReferencesOk = result.missingDependencies.length === 0;
  const storesOk = result.stores.length === REQUIRED_STORE_CODES.length && result.missingStoreCodes.length === 0;
  const sourceOk = result.appSettingsPreview.currentGlobalSource === 'LEGACY_MENU_ITEMS';

  const checks = [
    { label: 'Errors: 0', ok: rowCountsOk },
    { label: 'Missing references: 0', ok: missingReferencesOk },
    { label: 'Stores resolved: 3/3', ok: storesOk },
    { label: 'POS source: LEGACY_MENU_ITEMS', ok: sourceOk },
  ];

  return {
    ready: checks.every((check) => check.ok),
    checks,
    blockers: checks.filter((check) => !check.ok).map((check) => check.label),
  };
}

function getPermissionChecks(isUiAdmin: boolean): PermissionCheck[] {
  return [
    {
      collection: 'rawIngredients',
      ruleSummary: 'match /rawIngredients/{itemId}: allow write if isAdmin()',
      shouldAllow: isUiAdmin,
    },
    {
      collection: 'prepItems',
      ruleSummary: 'match /prepItems/{itemId}: allow write if isAdmin()',
      shouldAllow: isUiAdmin,
    },
    {
      collection: 'finishedGoods',
      ruleSummary: 'match /finishedGoods/{itemId}: allow write if isAdmin()',
      shouldAllow: isUiAdmin,
    },
    {
      collection: 'storeStock',
      ruleSummary: 'match /storeStock/{stockId}: Admin can create/update/delete',
      shouldAllow: isUiAdmin,
    },
    {
      collection: 'importManifests',
      ruleSummary: 'match /importManifests/{document=**}: allow read, write if isAdmin()',
      shouldAllow: isUiAdmin,
    },
  ];
}

function getErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return cleanValue((err as { code?: unknown }).code) || 'unknown';
  }
  return 'unknown';
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return cleanValue((err as { message?: unknown }).message) || 'Unknown error';
  }
  return cleanValue(err) || 'Unknown error';
}

function makeImportPayloadRecord(
  collectionName: ImportCollection,
  docId: string,
  payload: Record<string, unknown>,
  existing?: Record<string, unknown>,
  forcedAction?: ReportAction,
  forcedReason?: string,
): ImportPayloadRecord {
  const reportRow = makeReportRow(collectionName, docId, payload, existing, forcedAction, forcedReason);
  return {
    collectionName,
    docId,
    payload,
    existing,
    action: reportRow.action,
    reason: reportRow.reason,
    hashBefore: reportRow.hashBefore,
    hashAfter: reportRow.hashAfter,
  };
}

function toReportRow(entry: ImportPayloadRecord): DryRunReportRow {
  return {
    collection: entry.collectionName,
    docId: entry.docId,
    action: entry.action,
    reason: entry.reason,
    hashBefore: entry.hashBefore,
    hashAfter: entry.hashAfter,
  };
}

function buildLiveWritePayload(entry: ImportPayloadRecord, importBatchId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...entry.payload,
    updatedAt: serverTimestamp(),
    lastImportedAt: serverTimestamp(),
    importBatchId,
  };

  if (!entry.existing) {
    payload.createdAt = serverTimestamp();
  }

  return payload;
}

function buildStoreStockImportPayload(payload: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> {
  if (!existing) return payload;

  return {
    storeId: payload.storeId,
    storeName: payload.storeName,
    stockItemType: payload.stockItemType,
    stockItemCode: payload.stockItemCode,
    stockItemName: payload.stockItemName,
    uom: payload.uom,
    costPerUnit: payload.costPerUnit,
    importSource: payload.importSource,
    importVersion: payload.importVersion,
  };
}

async function commitWriteQueue(
  writeQueue: QueuedWrite[],
  onFailure: (failure: LiveImportFailure) => void,
) {
  for (let index = 0; index < writeQueue.length; index += LIVE_IMPORT_MAX_BATCH_WRITES) {
    const chunk = writeQueue.slice(index, index + LIVE_IMPORT_MAX_BATCH_WRITES);
    const batch = writeBatch(db);
    chunk.forEach((writeOperation) => {
      writeOperation.apply(batch);
    });
    try {
      await batch.commit();
    } catch (err: unknown) {
      const firstWrite = chunk[0];
      onFailure({
        stage: `Committing live import batch ${Math.floor(index / LIVE_IMPORT_MAX_BATCH_WRITES) + 1}`,
        collection: firstWrite?.collection || 'unknown',
        docPath: firstWrite?.docPath || 'unknown',
        code: getErrorCode(err),
        message: getErrorMessage(err),
      });
      throw err;
    }
  }
}

export default function Phase7FDryRunImport() {
  const { firebaseUser, staffProfile } = useAuth();
  const [selectedFiles, setSelectedFiles] = useState<Record<FileKey, File | null>>({
    raw: null,
    prepSummary: null,
    prepBom: null,
    finishedBom: null,
    finishedSummary: null,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [isResettingSource, setIsResettingSource] = useState(false);
  const [isLiveImporting, setIsLiveImporting] = useState(false);
  const [error, setError] = useState('');
  const [resetMessage, setResetMessage] = useState('');
  const [liveConfirmText, setLiveConfirmText] = useState('');
  const [liveImportSummary, setLiveImportSummary] = useState<LiveImportSummary | null>(null);
  const [firstWriteAttemptPath, setFirstWriteAttemptPath] = useState('');
  const [liveImportFailure, setLiveImportFailure] = useState<LiveImportFailure | null>(null);
  const [result, setResult] = useState<DryRunResult | null>(null);

  const allFilesSelected = useMemo(() => FILES.every((file) => selectedFiles[file.key]), [selectedFiles]);
  const liveGate = useMemo(() => getLiveImportGate(result), [result]);
  const isUiAdmin = staffProfile?.role === 'ADMIN';
  const permissionChecks = useMemo(() => getPermissionChecks(isUiAdmin), [isUiAdmin]);
  const canRunLiveImport = !!result
    && liveGate.ready
    && isUiAdmin
    && liveConfirmText.trim() === LIVE_IMPORT_CONFIRMATION
    && !isLiveImporting;

  const handleFileChange = (key: FileKey, file: File | null) => {
    setSelectedFiles((current) => ({ ...current, [key]: file }));
    setResult(null);
    setError('');
    setResetMessage('');
    setLiveConfirmText('');
    setLiveImportSummary(null);
    setFirstWriteAttemptPath('');
    setLiveImportFailure(null);
  };

  const resetPosSourceToLegacy = async () => {
    if (staffProfile?.role !== 'ADMIN') {
      setError('Only an Admin can reset the POS source.');
      return;
    }

    const confirmed = window.confirm(
      'Emergency reset POS source?\n\nThis will update only appSettings/posMenuSource:\n- globalSource = LEGACY_MENU_ITEMS\n- storeOverrides = {}\n\nIt will not import menu data and will not modify rawIngredients, prepItems, finishedGoods, storeStock, menuItems, inventoryItems, recipes, or storeInventory.\n\nContinue?',
    );
    if (!confirmed) return;

    setIsResettingSource(true);
    setError('');
    setResetMessage('');

    try {
      await setDoc(doc(db, 'appSettings', 'posMenuSource'), {
        globalSource: 'LEGACY_MENU_ITEMS',
        storeOverrides: {},
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile.uid,
        updatedByName: staffProfile.displayName || staffProfile.name || staffProfile.email || 'Admin',
        resetReason: 'Phase 7F emergency reset before import and stock setup',
      }, { merge: true });

      setResetMessage('POS source reset complete. globalSource is now LEGACY_MENU_ITEMS and storeOverrides is empty.');
      setResult((current) => {
        if (!current) return current;
        const reportRows = current.reportRows.map((row) => (
          row.collection === 'appSettings' && row.docId === 'posMenuSource'
            ? {
              ...row,
              action: 'UNCHANGED' as ReportAction,
              reason: 'Emergency reset applied. appSettings/posMenuSource now matches required legacy source.',
              hashBefore: row.hashAfter,
            }
            : row
        ));
        const actionCounts = reportRows.reduce<Record<ReportAction, number>>((counts, row) => {
          counts[row.action] += 1;
          return counts;
        }, { CREATE: 0, UPDATE: 0, UNCHANGED: 0, BLOCKED: 0 });

        return {
          ...current,
          actionCounts,
          checkoutBlockers: current.checkoutBlockers.filter((blocker) => !blocker.includes('appSettings/posMenuSource globalSource')),
          appSettingsPreview: {
            ...current.appSettingsPreview,
            currentGlobalSource: 'LEGACY_MENU_ITEMS',
            storeOverrides: {},
          },
          reportRows,
        };
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to reset POS source.');
    } finally {
      setIsResettingSource(false);
    }
  };

  const runLiveImport = async () => {
    if (!result) {
      setError('Run a successful dry-run before live import.');
      return;
    }
    if (staffProfile?.role !== 'ADMIN') {
      setError('Only an Admin can run the guarded live import.');
      return;
    }
    if (!liveGate.ready) {
      setError(`Live import is blocked: ${liveGate.blockers.join(', ')}`);
      return;
    }
    if (liveConfirmText.trim() !== LIVE_IMPORT_CONFIRMATION) {
      setError('Type the confirmation text exactly before running live import.');
      return;
    }

    const confirmed = window.confirm(
      `${LIVE_IMPORT_CONFIRMATION}\n\nThis writes only rawIngredients, prepItems, finishedGoods, storeStock, and importManifests. It will not switch POS rollout and will not touch legacy collections.\n\nContinue with live import?`,
    );
    if (!confirmed) return;

    let importBatchId = '';
    setIsLiveImporting(true);
    setError('');
    setLiveImportSummary(null);
    setFirstWriteAttemptPath('');
    setLiveImportFailure(null);

    const recordFailure = (failure: LiveImportFailure) => {
      setLiveImportFailure(failure);
    };

    const runStage = async <T,>(
      stage: string,
      collectionName: string,
      docPath: string,
      action: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await action();
      } catch (err: unknown) {
        recordFailure({
          stage,
          collection: collectionName,
          docPath,
          code: getErrorCode(err),
          message: getErrorMessage(err),
        });
        throw err;
      }
    };

    try {
      const appSettingsDoc = await runStage(
        'Reading POS source safety setting',
        'appSettings',
        'appSettings/posMenuSource',
        () => getDoc(doc(db, 'appSettings', 'posMenuSource')),
      );
      const appSettings = appSettingsDoc.exists() ? appSettingsDoc.data() as Record<string, unknown> : {};
      const currentGlobalSource = getPosGlobalSource(appSettings);
      if (currentGlobalSource !== 'LEGACY_MENU_ITEMS') {
        throw new Error(`Live import blocked because appSettings/posMenuSource is ${currentGlobalSource}. Reset it to LEGACY_MENU_ITEMS first.`);
      }

      const latestExistingMaps: Record<ImportCollection, Map<string, Record<string, unknown>>> = {
        rawIngredients: await runStage('Reading latest rawIngredients for comparison', 'rawIngredients', 'rawIngredients/*', () => readCollectionMap('rawIngredients')),
        prepItems: await runStage('Reading latest prepItems for comparison', 'prepItems', 'prepItems/*', () => readCollectionMap('prepItems')),
        finishedGoods: await runStage('Reading latest finishedGoods for comparison', 'finishedGoods', 'finishedGoods/*', () => readCollectionMap('finishedGoods')),
        storeStock: await runStage('Reading latest storeStock for comparison', 'storeStock', 'storeStock/*', () => readCollectionMap('storeStock')),
      };

      const liveEntries = result.importPayloads.map((entry) => {
        const existing = latestExistingMaps[entry.collectionName].get(entry.docId);
        const payload = entry.collectionName === 'storeStock'
          ? buildStoreStockImportPayload(entry.payload, existing)
          : entry.payload;
        return makeImportPayloadRecord(
          entry.collectionName,
          entry.docId,
          payload,
          existing,
          undefined,
          entry.collectionName === 'storeStock' && existing
            ? 'Existing stock quantity fields are preserved; metadata is safely merged.'
            : undefined,
        );
      });

      const disallowedEntry = liveEntries.find((entry) => !COMPARE_COLLECTIONS.includes(entry.collectionName));
      if (disallowedEntry) {
        throw new Error(`Live import blocked by collection safety check: ${disallowedEntry.collectionName}/${disallowedEntry.docId}`);
      }

      const actions = liveEntries.reduce<Record<ReportAction, number>>((counts, entry) => {
        counts[entry.action] += 1;
        return counts;
      }, { CREATE: 0, UPDATE: 0, UNCHANGED: 0, BLOCKED: 0 });

      if (actions.BLOCKED > 0) {
        throw new Error('Live import blocked because the latest comparison still has BLOCKED rows.');
      }

      importBatchId = `phase7g-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const adminName = staffProfile.displayName || staffProfile.name || staffProfile.email || 'Admin';
      const docPathsTouched = liveEntries.map((entry) => `${entry.collectionName}/${entry.docId}`);
      const manifestRef = doc(db, 'importManifests', importBatchId);
      const firstWritePath = `importManifests/${importBatchId}`;
      setFirstWriteAttemptPath(firstWritePath);
      console.info(`[Phase 7G] First write path attempted: ${firstWritePath}`);

      await runStage('Creating import manifest header', 'importManifests', firstWritePath, () => setDoc(manifestRef, {
        importBatchId,
        mode: 'LIVE_IMPORT_NO_POS_ROLLOUT',
        status: 'STARTED',
        dryRunBatchId: result.batchId,
        createdAt: serverTimestamp(),
        createdBy: {
          uid: staffProfile.uid,
          name: adminName,
          email: staffProfile.email || '',
          role: staffProfile.role,
        },
        allowedCollections: COMPARE_COLLECTIONS,
        blockedCollections: BLOCKED_COLLECTIONS,
        posMenuSourceBefore: currentGlobalSource,
        docPathsTouched,
        totals: {
          create: actions.CREATE,
          update: actions.UPDATE,
          unchanged: actions.UNCHANGED,
          blocked: actions.BLOCKED,
          total: liveEntries.length,
        },
        storeStockRows: {
          create: liveEntries.filter((entry) => entry.collectionName === 'storeStock' && entry.action === 'CREATE').length,
          update: liveEntries.filter((entry) => entry.collectionName === 'storeStock' && entry.action === 'UPDATE').length,
          unchanged: liveEntries.filter((entry) => entry.collectionName === 'storeStock' && entry.action === 'UNCHANGED').length,
        },
        zeroCostCount: result.zeroCostCount,
        warnings: result.warnings,
        rollbackStrategy: 'Use importManifests/{importBatchId}/entries. CREATE rows can be deleted if rollback is approved. UPDATE rows include rollbackSnapshot for manual restore. UNCHANGED rows require no rollback.',
      }));

      const writeQueue: QueuedWrite[] = [];
      liveEntries.forEach((entry, index) => {
        const docPath = `${entry.collectionName}/${entry.docId}`;
        const entryId = `${String(index + 1).padStart(4, '0')}_${stableHash(docPath)}`;
        const manifestEntryPath = `importManifests/${importBatchId}/entries/${entryId}`;
        const rollbackAction = entry.action === 'CREATE'
          ? 'DELETE_CREATED_DOC'
          : entry.action === 'UPDATE'
            ? 'RESTORE_ROLLBACK_SNAPSHOT'
            : 'NONE';

        writeQueue.push({
          collection: 'importManifests',
          docPath: manifestEntryPath,
          apply: (batch) => {
            batch.set(doc(db, 'importManifests', importBatchId, 'entries', entryId), {
              importBatchId,
              collection: entry.collectionName,
              docId: entry.docId,
              docPath,
              action: entry.action,
              reason: entry.reason,
              hashBefore: entry.hashBefore,
              hashAfter: entry.hashAfter,
              rollbackAction,
              rollbackSnapshot: entry.action === 'UPDATE' ? entry.existing || null : null,
              createdAt: serverTimestamp(),
            });
          },
        });

        if (entry.action === 'CREATE' || entry.action === 'UPDATE') {
          writeQueue.push({
            collection: entry.collectionName,
            docPath,
            apply: (batch) => {
              batch.set(
                doc(db, entry.collectionName, entry.docId),
                buildLiveWritePayload(entry, importBatchId),
                { merge: true },
              );
            },
          });
        }
      });

      await commitWriteQueue(writeQueue, recordFailure);

      const appSettingsAfterDoc = await runStage(
        'Verifying POS source after live import',
        'appSettings',
        'appSettings/posMenuSource',
        () => getDoc(doc(db, 'appSettings', 'posMenuSource')),
      );
      const appSettingsAfter = appSettingsAfterDoc.exists() ? appSettingsAfterDoc.data() as Record<string, unknown> : {};
      const posMenuSourceAfter = getPosGlobalSource(appSettingsAfter);

      await runStage('Completing import manifest', 'importManifests', firstWritePath, () => setDoc(manifestRef, {
        status: 'COMPLETED',
        completedAt: serverTimestamp(),
        posMenuSourceAfter,
      }, { merge: true }));

      const nextReportRows = [
        ...liveEntries.map(toReportRow),
        ...result.reportRows.filter((row) => row.collection === 'dependency-check' || row.collection === 'appSettings'),
      ];
      const nextActionCounts = nextReportRows.reduce<Record<ReportAction, number>>((counts, row) => {
        counts[row.action] += 1;
        return counts;
      }, { CREATE: 0, UPDATE: 0, UNCHANGED: 0, BLOCKED: 0 });

      setResult((current) => current ? {
        ...current,
        importPayloads: liveEntries,
        reportRows: nextReportRows,
        actionCounts: nextActionCounts,
        appSettingsPreview: {
          ...current.appSettingsPreview,
          currentGlobalSource: posMenuSourceAfter,
        },
      } : current);

      setLiveImportSummary({
        importBatchId,
        manifestId: importBatchId,
        createdCount: actions.CREATE,
        updatedCount: actions.UPDATE,
        unchangedCount: actions.UNCHANGED,
        storeStockCreated: liveEntries.filter((entry) => entry.collectionName === 'storeStock' && entry.action === 'CREATE').length,
        storeStockUpdated: liveEntries.filter((entry) => entry.collectionName === 'storeStock' && entry.action === 'UPDATE').length,
        posMenuSourceAfter,
      });

      if (posMenuSourceAfter !== 'LEGACY_MENU_ITEMS') {
        setError(`Live import completed, but POS source is now ${posMenuSourceAfter}. Reset it to LEGACY_MENU_ITEMS before continuing.`);
      }
    } catch (err: unknown) {
      if (importBatchId) {
        try {
          await setDoc(doc(db, 'importManifests', importBatchId), {
            status: 'FAILED_OR_PARTIAL',
            failedAt: serverTimestamp(),
            failureMessage: err instanceof Error ? err.message : 'Live import failed.',
          }, { merge: true });
        } catch {
          // Keep the original error visible if the failure manifest cannot be written.
        }
      }
      setError(err instanceof Error ? err.message : 'Live import failed.');
    } finally {
      setIsLiveImporting(false);
    }
  };

  const runDryRun = async () => {
    if (!allFilesSelected) {
      setError('Select all five Phase 7F CSV files before running dry-run.');
      return;
    }

    setIsRunning(true);
    setError('');
    setResult(null);
    setLiveConfirmText('');
    setLiveImportSummary(null);
    setFirstWriteAttemptPath('');
    setLiveImportFailure(null);

    try {
      const batchId = `phase7f-dry-run-${new Date().toISOString()}`;
      const texts = await Promise.all(
        FILES.map(async (fileConfig) => {
          const file = selectedFiles[fileConfig.key];
          if (!file) throw new Error(`Missing file: ${fileConfig.label}`);
          return [fileConfig.key, await readFile(file)] as const;
        }),
      );

      const rowsByKey = Object.fromEntries(texts.map(([key, text]) => [key, parseCsv(text)])) as Record<FileKey, CsvRow[]>;
      const rowCounts = Object.fromEntries(FILES.map((file) => [file.key, rowsByKey[file.key].length])) as Record<FileKey, number>;
      const expectedCounts = Object.fromEntries(FILES.map((file) => [file.key, file.expectedRows])) as Record<FileKey, number>;

      const missingDependencies: string[] = [];
      const checkoutBlockers: string[] = [];
      const warnings = [
        'Default mode is dry-run. Live import requires the guarded Phase 7G confirmation and writes only Menu Management V2 collections plus importManifests.',
        'globalSource must remain LEGACY_MENU_ITEMS until a separate rollout step is approved.',
        'Rollout cannot happen until opening/current stock is loaded for the pilot store.',
        'Existing storeStock quantity fields are preserved during live import.',
      ];

      FILES.forEach((file) => {
        if (rowCounts[file.key] !== file.expectedRows) {
          checkoutBlockers.push(`${file.label} row count is ${rowCounts[file.key]}, expected ${file.expectedRows}.`);
        }
      });

      const existingMaps: Record<(typeof COMPARE_COLLECTIONS)[number], Map<string, Record<string, unknown>>> = {
        rawIngredients: await readCollectionMap('rawIngredients'),
        prepItems: await readCollectionMap('prepItems'),
        finishedGoods: await readCollectionMap('finishedGoods'),
        storeStock: await readCollectionMap('storeStock'),
      };

      const storesSnapshot = await getDocs(collection(db, 'stores'));
      const allStores = storesSnapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }) as Store);
      const stores = REQUIRED_STORE_CODES
        .map((code) => allStores.find((store) => store.code === code && store.isActive))
        .filter((store): store is Store => !!store);
      const missingStoreCodes = REQUIRED_STORE_CODES.filter((code) => !stores.some((store) => store.code === code));

      missingStoreCodes.forEach((code) => {
        checkoutBlockers.push(`Required active store not found: ${code}.`);
      });

      const rawPayloads = new Map<string, RawIngredient & Record<string, unknown>>();
      rowsByKey.raw.forEach((row) => {
        const code = cleanValue(row.code);
        if (!code) return;
        const purchaseCost = toNumber(row.purchaseCost);
        const conversionFactor = toNumber(row.conversionFactor, 1);
        const costPerUsageUnit = toNumber(row.costPerUsageUnit, conversionFactor > 0 ? purchaseCost / conversionFactor : 0);

        rawPayloads.set(code, {
          code,
          name: cleanValue(row.name),
          category: cleanValue(row.category) || 'OTHER',
          purchaseUOM: normalizeUom(row.purchaseUOM),
          usageUOM: normalizeUom(row.usageUOM),
          conversionFactor,
          purchaseCost,
          costPerUsageUnit,
          supplierName: cleanValue(row.supplierName),
          isActive: toBool(row.isActive, true),
          importSource: 'PHASE_7D_FINAL_STRUCTURAL',
          importVersion: 1,
        });
      });

      const rawCodes = new Set(rawPayloads.keys());
      const zeroCostCount = Array.from(rawPayloads.values()).filter((raw) => raw.isActive && (raw.purchaseCost <= 0 || raw.costPerUsageUnit <= 0)).length;
      if (zeroCostCount > 0) {
        warnings.push(`${zeroCostCount} zero-cost ingredients detected. Costing is incomplete.`);
      }

      const prepSummaryByCode = new Map(rowsByKey.prepSummary.map((row) => [cleanValue(row.prepCode), row]));
      const prepBomByCode = new Map<string, CsvRow[]>();
      rowsByKey.prepBom.forEach((row) => {
        const code = cleanValue(row.prepCode);
        if (!code) return;
        if (!prepBomByCode.has(code)) prepBomByCode.set(code, []);
        prepBomByCode.get(code)!.push(row);
      });

      const prepPayloads = new Map<string, PrepItem & Record<string, unknown>>();
      prepSummaryByCode.forEach((summary, code) => {
        if (!code) return;
        const bomRows = prepBomByCode.get(code) || [];
        const bom: BOMComponent[] = bomRows
          .filter((row) => cleanValue(row.bomComponentCode))
          .map((row) => {
            const componentType = normalizeBomType(row.bomComponentType);
            const componentCode = cleanValue(row.bomComponentCode);
            const quantity = toNumber(row.bomQuantity);
            const rawCost = componentType === 'RAW_INGREDIENT' || componentType === 'PACKAGING'
              ? rawPayloads.get(componentCode)?.costPerUsageUnit || 0
              : 0;

            return {
              componentType,
              componentCode,
              componentName: cleanValue(row.bomComponentName) || componentCode,
              quantity,
              uom: normalizeUom(row.bomUOM),
              costPerUnit: rawCost,
              lineCost: Math.round((rawCost * quantity + Number.EPSILON) * 10000) / 10000,
            };
          });
        const recipeCost = bom.reduce((sum, line) => sum + line.lineCost, 0);
        const yieldQuantity = toNumber(summary.yieldQuantity, 1);
        const costPerUnit = yieldQuantity > 0 ? Math.round((recipeCost / yieldQuantity + Number.EPSILON) * 10000) / 10000 : 0;

        prepPayloads.set(code, {
          code,
          name: cleanValue(summary.prepName),
          outputUOM: normalizeUom(summary.outputUOM),
          defaultBatchSize: toNumber(summary.defaultBatchSize),
          yieldQuantity,
          yieldUOM: normalizeUom(summary.yieldUOM),
          costPerUnit,
          isStockTracked: toBool(summary.isStockTracked, true),
          bom,
          bomVersion: 1,
          isActive: toBool(summary.isActive, true),
          importSource: 'PHASE_7D_FINAL_STRUCTURAL',
          importVersion: 1,
        });
      });

      const prepCodes = new Set(prepPayloads.keys());
      rowsByKey.prepBom.forEach((row, index) => {
        const componentCode = cleanValue(row.bomComponentCode);
        const componentType = normalizeBomType(row.bomComponentType);
        if (!componentCode) return;
        if ((componentType === 'RAW_INGREDIENT' || componentType === 'PACKAGING') && !rawCodes.has(componentCode)) {
          missingDependencies.push(`Prep BOM row ${index + 2}: missing raw ingredient ${componentCode}.`);
        }
        if (componentType === 'PREP_ITEM' && !prepCodes.has(componentCode)) {
          missingDependencies.push(`Prep BOM row ${index + 2}: missing prep item ${componentCode}.`);
        }
      });

      const finishedSummaryByCode = new Map(rowsByKey.finishedSummary.map((row) => [cleanValue(row.fgCode), row]));
      const finishedBomByCode = new Map<string, CsvRow[]>();
      rowsByKey.finishedBom.forEach((row) => {
        const code = cleanValue(row.fgCode);
        if (!code) return;
        if (!finishedBomByCode.has(code)) finishedBomByCode.set(code, []);
        finishedBomByCode.get(code)!.push(row);
      });

      const finishedPayloads = new Map<string, FinishedGood & Record<string, unknown>>();
      finishedSummaryByCode.forEach((summary, code) => {
        if (!code) return;
        const productionMode = cleanValue(summary.productionMode) || 'MADE_TO_ORDER';
        const itemType = itemTypeFromProductionMode(productionMode, cleanValue(summary.itemType));
        const bomRows = finishedBomByCode.get(code) || [];
        const bom: BOMComponent[] = bomRows
          .filter((row) => cleanValue(row.bomComponentCode))
          .map((row) => {
            const componentType = normalizeBomType(row.bomComponentType);
            const componentCode = cleanValue(row.bomComponentCode);
            const quantity = toNumber(row.bomQuantity);
            let costPerUnit = 0;
            if (componentType === 'RAW_INGREDIENT' || componentType === 'PACKAGING') {
              costPerUnit = rawPayloads.get(componentCode)?.costPerUsageUnit || 0;
            } else if (componentType === 'PREP_ITEM') {
              costPerUnit = prepPayloads.get(componentCode)?.costPerUnit || 0;
            } else if (componentType === 'FINISHED_GOOD') {
              costPerUnit = finishedPayloads.get(componentCode)?.recipeCost || 0;
            }

            return {
              componentType,
              componentCode,
              componentName: cleanValue(row.bomComponentName) || componentCode,
              quantity,
              uom: normalizeUom(row.bomUOM),
              costPerUnit,
              lineCost: Math.round((costPerUnit * quantity + Number.EPSILON) * 10000) / 10000,
            };
          });
        const recipeCost = Math.round((bom.reduce((sum, line) => sum + line.lineCost, 0) + Number.EPSILON) * 100) / 100;
        const salePrice = toNumber(summary.salePrice);
        const taxRate = toNumber(summary.taxRate);
        const netPrice = salePrice / (1 + taxRate / 100);
        const grossMargin = netPrice > 0 ? Math.round(((netPrice - recipeCost) / netPrice + Number.EPSILON) * 10000) / 100 : 100;
        const cogsPercent = netPrice > 0 ? Math.round((recipeCost / netPrice + Number.EPSILON) * 10000) / 100 : 0;

        finishedPayloads.set(code, {
          code,
          name: cleanValue(summary.fgName),
          displayName: cleanValue(summary.fgName),
          description: '',
          posCategoryCode: cleanValue(summary.posCategoryCode),
          posCategoryName: cleanValue(summary.posCategoryName),
          salePrice,
          productionMode: productionMode as FinishedGood['productionMode'],
          itemType,
          prepStation: cleanValue(summary.prepStation) as FinishedGood['prepStation'],
          taxRate,
          bom,
          bomVersion: 1,
          recipeCost,
          grossMargin,
          cogsPercent,
          sortOrder: 999,
          availableStoreIds: stores.map((store) => store.id),
          isSellable: toBool(summary.isSellable, true),
          isAvailable: true,
          isActive: toBool(summary.isActive, true),
          importSource: 'PHASE_7D_FINAL_STRUCTURAL',
          importVersion: 1,
        });
      });

      const finishedCodes = new Set(finishedPayloads.keys());
      rowsByKey.finishedBom.forEach((row, index) => {
        const componentCode = cleanValue(row.bomComponentCode);
        const componentType = normalizeBomType(row.bomComponentType);
        if (!componentCode) return;
        if ((componentType === 'RAW_INGREDIENT' || componentType === 'PACKAGING') && !rawCodes.has(componentCode)) {
          missingDependencies.push(`Finished BOM row ${index + 2}: missing raw ingredient ${componentCode}.`);
        }
        if (componentType === 'PREP_ITEM' && !prepCodes.has(componentCode)) {
          missingDependencies.push(`Finished BOM row ${index + 2}: missing prep item ${componentCode}.`);
        }
        if (componentType === 'FINISHED_GOOD' && !finishedCodes.has(componentCode)) {
          missingDependencies.push(`Finished BOM row ${index + 2}: missing finished good ${componentCode}.`);
        }
      });

      finishedPayloads.forEach((finishedGood) => {
        if ((finishedGood.productionMode === 'MADE_TO_ORDER' || finishedGood.productionMode === 'ASSEMBLED_TO_ORDER') && finishedGood.isActive && finishedGood.isSellable && finishedGood.bom.length === 0) {
          checkoutBlockers.push(`${finishedGood.code} requires a BOM before checkout can use Finished Goods source.`);
        }
        if (finishedGood.availableStoreIds.length === 0 && finishedGood.isActive && finishedGood.isSellable) {
          checkoutBlockers.push(`${finishedGood.code} has no available stores.`);
        }
      });

      const storeStockPayloads = new Map<string, StoreStock & Record<string, unknown>>();
      stores.forEach((store) => {
        rawPayloads.forEach((raw) => {
          if (!raw.isActive) return;
          const stockItemType = raw.category.toUpperCase().includes('PACKAGING') ? 'PACKAGING' : 'RAW_INGREDIENT';
          const id = `${store.id}_${stockItemType}_${raw.code}`;
          storeStockPayloads.set(id, {
            storeId: store.id,
            storeName: store.name,
            stockItemType,
            stockItemCode: raw.code,
            stockItemName: raw.name,
            uom: raw.usageUOM,
            openingStock: 0,
            currentStock: 0,
            minimumStock: 0,
            costPerUnit: raw.costPerUsageUnit,
            importSource: 'PHASE_7D_FINAL_STRUCTURAL',
            importVersion: 1,
          });
        });

        prepPayloads.forEach((prep) => {
          if (!prep.isActive) return;
          const id = `${store.id}_PREP_ITEM_${prep.code}`;
          storeStockPayloads.set(id, {
            storeId: store.id,
            storeName: store.name,
            stockItemType: 'PREP_ITEM',
            stockItemCode: prep.code,
            stockItemName: prep.name,
            uom: prep.yieldUOM || prep.outputUOM,
            openingStock: 0,
            currentStock: 0,
            minimumStock: 0,
            costPerUnit: prep.costPerUnit,
            importSource: 'PHASE_7D_FINAL_STRUCTURAL',
            importVersion: 1,
          });
        });

        finishedPayloads.forEach((finishedGood) => {
          if (!finishedGood.isActive || finishedGood.itemType !== 'DIRECT_STOCK') return;
          const id = `${store.id}_FINISHED_GOOD_${finishedGood.code}`;
          storeStockPayloads.set(id, {
            storeId: store.id,
            storeName: store.name,
            stockItemType: 'FINISHED_GOOD',
            stockItemCode: finishedGood.code,
            stockItemName: finishedGood.name,
            uom: 'PCS',
            openingStock: 0,
            currentStock: 0,
            minimumStock: 0,
            costPerUnit: finishedGood.recipeCost,
            importSource: 'PHASE_7D_FINAL_STRUCTURAL',
            importVersion: 1,
          });
        });
      });

      const storeStockBreakdown = stores.map((store) => {
        const rows = Array.from(storeStockPayloads.entries()).filter(([, payload]) => payload.storeId === store.id);
        const zeroCurrentStockRows = rows.filter(([id, payload]) => {
          const existing = existingMaps.storeStock.get(id);
          if (!existing) return payload.currentStock <= 0;
          return toNumber(existing.currentStock) <= 0;
        }).length;

        return {
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
          rawIngredientRows: rows.filter(([, payload]) => payload.stockItemType === 'RAW_INGREDIENT').length,
          packagingRows: rows.filter(([, payload]) => payload.stockItemType === 'PACKAGING').length,
          prepItemRows: rows.filter(([, payload]) => payload.stockItemType === 'PREP_ITEM').length,
          boughtAndSoldRows: rows.filter(([, payload]) => payload.stockItemType === 'FINISHED_GOOD').length,
          totalRows: rows.length,
          zeroCurrentStockRows,
        };
      });

      const zeroStockRows = storeStockBreakdown.reduce((total, store) => total + store.zeroCurrentStockRows, 0);
      if (zeroStockRows > 0) {
        checkoutBlockers.push(`${zeroStockRows} generated or existing storeStock rows have zero opening/current stock. Rollout must wait until stock is loaded.`);
        warnings.push('Opening/current stock is missing or zero for generated storeStock rows.');
      }

      const importPayloads: ImportPayloadRecord[] = [];
      rawPayloads.forEach((payload, docId) => {
        importPayloads.push(makeImportPayloadRecord('rawIngredients', docId, payload, existingMaps.rawIngredients.get(docId)));
      });
      prepPayloads.forEach((payload, docId) => {
        importPayloads.push(makeImportPayloadRecord('prepItems', docId, payload, existingMaps.prepItems.get(docId)));
      });
      finishedPayloads.forEach((payload, docId) => {
        importPayloads.push(makeImportPayloadRecord('finishedGoods', docId, payload, existingMaps.finishedGoods.get(docId)));
      });
      storeStockPayloads.forEach((payload, docId) => {
        const existing = existingMaps.storeStock.get(docId);
        const importPayload = buildStoreStockImportPayload(payload, existing);
        importPayloads.push(makeImportPayloadRecord(
          'storeStock',
          docId,
          importPayload,
          existing,
          undefined,
          existing ? 'Existing stock quantity fields are preserved; metadata is compared for safe merge updates.' : undefined,
        ));
      });

      const reportRows: DryRunReportRow[] = importPayloads.map(toReportRow);

      missingDependencies.forEach((dependency, index) => {
        reportRows.push({
          collection: 'dependency-check',
          docId: `missing-${index + 1}`,
          action: 'BLOCKED',
          reason: dependency,
          hashBefore: '',
          hashAfter: '',
        });
      });

      const appSettingsDoc = await getDoc(doc(db, 'appSettings', 'posMenuSource'));
      const appSettings = appSettingsDoc.exists() ? appSettingsDoc.data() as Record<string, unknown> : {};
      const currentGlobalSource = getPosGlobalSource(appSettings);
      const storeOverrides = (appSettings.storeOverrides || {}) as Record<string, string>;
      if (currentGlobalSource !== 'LEGACY_MENU_ITEMS') {
        checkoutBlockers.push(`Current appSettings/posMenuSource globalSource is ${currentGlobalSource}. It must remain LEGACY_MENU_ITEMS during import dry-run and stock setup.`);
      }
      reportRows.push({
        collection: 'appSettings',
        docId: 'posMenuSource',
        action: currentGlobalSource === 'LEGACY_MENU_ITEMS' ? 'UNCHANGED' : 'BLOCKED',
        reason: 'Dry-run preview only. appSettings is changed only by the separate confirmed emergency reset action.',
        hashBefore: appSettingsDoc.exists() ? stableHash(appSettings) : '',
        hashAfter: stableHash({ globalSource: 'LEGACY_MENU_ITEMS', storeOverrides }),
      });

      const actionCounts = reportRows.reduce<Record<ReportAction, number>>((counts, row) => {
        counts[row.action] += 1;
        return counts;
      }, { CREATE: 0, UPDATE: 0, UNCHANGED: 0, BLOCKED: 0 });

      setResult({
        batchId,
        rowCounts,
        expectedCounts,
        stores,
        missingStoreCodes,
        payloadCounts: {
          rawIngredients: rawPayloads.size,
          prepItems: prepPayloads.size,
          finishedGoods: finishedPayloads.size,
          storeStock: storeStockPayloads.size,
        },
        actionCounts,
        zeroCostCount,
        missingDependencies,
        checkoutBlockers,
        warnings,
        storeStockBreakdown,
        reportRows,
        importPayloads,
        appSettingsPreview: {
          currentGlobalSource,
          requiredGlobalSource: 'LEGACY_MENU_ITEMS',
          storeOverrides,
        },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Dry-run failed.');
    } finally {
      setIsRunning(false);
    }
  };

  const downloadCsvReport = () => {
    if (!result) return;
    downloadText('Coffee_Bond_Phase7F_Dry_Run_Report.csv', makeCsv(result.reportRows), 'text/csv;charset=utf-8;');
  };

  const downloadJsonReport = () => {
    if (!result) return;
    downloadText('Coffee_Bond_Phase7F_Dry_Run_Report.json', JSON.stringify(result, null, 2), 'application/json;charset=utf-8;');
  };

  return (
    <div className="max-w-6xl mx-auto w-full pb-20 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Coffee Bond Menu Import</p>
          <h1 className="text-3xl font-black text-[#5c4033]">Phase 7F Dry-Run Import</h1>
          <p className="text-neutral-600 mt-2">Parse final CSVs, build Firestore payloads in memory, and compare them with existing data.</p>
        </div>
        <Link to="/admin" className="text-sm font-bold text-[#5c4033] hover:underline">
          Back to Admin Dashboard
        </Link>
      </div>

      <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-5 flex gap-4">
        <ShieldAlert className="w-6 h-6 shrink-0 mt-0.5" />
        <div>
          <h2 className="font-black text-lg">Default mode is dry-run</h2>
          <p className="text-sm mt-1">This screen reads Firestore for comparison first. The only writes available here are the explicit POS source reset and the guarded Phase 7G live import after a successful dry-run.</p>
        </div>
      </div>

      <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
            <Upload size={20} />
          </div>
          <div>
            <h2 className="text-xl font-black text-neutral-800">Select Final CSV Files</h2>
            <p className="text-sm text-neutral-500">Use the Phase 7D files plus the existing prep item summary.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {FILES.map((file) => (
            <label key={file.key} className="border border-neutral-200 rounded-xl p-4 bg-neutral-50 block">
              <span className="block text-sm font-black text-neutral-800">{file.label}</span>
              <span className="block text-xs text-neutral-500 mb-3">{file.expectedName}</span>
              <input
                type="file"
                accept=".csv"
                onChange={(event) => handleFileChange(file.key, event.target.files?.[0] || null)}
                className="block w-full text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-[#5c4033] file:px-4 file:py-2 file:text-sm file:font-bold file:text-white"
              />
              <span className="mt-2 block text-xs text-neutral-500">Expected rows: {file.expectedRows}</span>
            </label>
          ))}
        </div>

        {error && (
          <div className="mt-5 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 flex gap-3 text-sm">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={runDryRun}
          disabled={!allFilesSelected || isRunning}
          className="mt-6 w-full md:w-auto px-6 py-3 bg-[#5c4033] text-white font-black rounded-xl hover:bg-[#3e2723] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isRunning ? <Loader2 size={18} className="animate-spin" /> : <FileSearch size={18} />}
          {isRunning ? 'Running Dry-Run...' : 'Run Dry-Run'}
        </button>
      </div>

      {result && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SummaryCard label="Raw Payloads" value={result.payloadCounts.rawIngredients} />
            <SummaryCard label="Prep Payloads" value={result.payloadCounts.prepItems} />
            <SummaryCard label="Finished Goods" value={result.payloadCounts.finishedGoods} />
            <SummaryCard label="Store Stock Rows" value={result.payloadCounts.storeStock} />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SummaryCard label="CREATE" value={result.actionCounts.CREATE} tone="emerald" />
            <SummaryCard label="UPDATE" value={result.actionCounts.UPDATE} tone="amber" />
            <SummaryCard label="UNCHANGED" value={result.actionCounts.UNCHANGED} tone="neutral" />
            <SummaryCard label="BLOCKED" value={result.actionCounts.BLOCKED} tone="red" />
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-black text-neutral-800 mb-4">Row Count Validation</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
              {FILES.map((file) => {
                const count = result.rowCounts[file.key];
                const ok = count === file.expectedRows;
                return (
                  <div key={file.key} className={`rounded-xl border p-4 ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                    <div className="flex items-center gap-2 font-black">
                      {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                      {count} / {file.expectedRows}
                    </div>
                    <p className="text-xs mt-1">{file.label}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <InfoPanel title="Warnings" items={result.warnings} tone="amber" />
            <InfoPanel title="Checkout Blockers" items={result.checkoutBlockers} tone="red" emptyText="No checkout blockers found by dry-run." />
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-black text-neutral-800 mb-4">Store Resolution</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {REQUIRED_STORE_CODES.map((code) => {
                const store = result.stores.find((item) => item.code === code);
                return (
                  <div key={code} className={`rounded-xl border p-4 ${store ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                    <p className="font-black text-sm">{code}</p>
                    <p className="text-xs text-neutral-600 mt-1">{store ? `${store.name} (${store.id})` : 'Missing active store'}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm overflow-x-auto">
            <h2 className="text-xl font-black text-neutral-800 mb-4">Generated StoreStock Rows</h2>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500 border-b">
                  <th className="py-2 pr-4">Store</th>
                  <th className="py-2 pr-4">Raw</th>
                  <th className="py-2 pr-4">Packaging</th>
                  <th className="py-2 pr-4">Prep</th>
                  <th className="py-2 pr-4">Bought & Sold</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Zero Stock</th>
                </tr>
              </thead>
              <tbody>
                {result.storeStockBreakdown.map((store) => (
                  <tr key={store.storeId} className="border-b last:border-0">
                    <td className="py-3 pr-4 font-bold">{store.storeName}</td>
                    <td className="py-3 pr-4">{store.rawIngredientRows}</td>
                    <td className="py-3 pr-4">{store.packagingRows}</td>
                    <td className="py-3 pr-4">{store.prepItemRows}</td>
                    <td className="py-3 pr-4">{store.boughtAndSoldRows}</td>
                    <td className="py-3 pr-4 font-bold">{store.totalRows}</td>
                    <td className="py-3 pr-4 text-amber-700 font-bold">{store.zeroCurrentStockRows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-black text-neutral-800 mb-3">POS Source Preview</h2>
            <p className="text-sm text-neutral-600">Current global source: <strong>{result.appSettingsPreview.currentGlobalSource}</strong></p>
            <p className="text-sm text-neutral-600">Required during import: <strong>{result.appSettingsPreview.requiredGlobalSource}</strong></p>
            <p className="text-xs text-neutral-500 mt-2">Dry-run does not switch appSettings/posMenuSource. The reset below is a separate explicit admin action.</p>
            {result.appSettingsPreview.currentGlobalSource !== 'LEGACY_MENU_ITEMS' && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
                <p className="text-sm font-bold text-red-800">Emergency reset required before import and stock setup.</p>
                <p className="text-xs text-red-700 mt-1">This action updates only appSettings/posMenuSource and clears store overrides.</p>
                <button
                  type="button"
                  onClick={resetPosSourceToLegacy}
                  disabled={isResettingSource || staffProfile?.role !== 'ADMIN'}
                  className="mt-3 w-full md:w-auto px-4 py-2 rounded-xl bg-red-700 text-white font-black hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isResettingSource ? <Loader2 size={16} className="animate-spin" /> : <ShieldAlert size={16} />}
                  Reset POS Source to Legacy
                </button>
              </div>
            )}
            {resetMessage && (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">
                {resetMessage}
              </div>
            )}
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Phase 7G</p>
                <h2 className="text-xl font-black text-neutral-800">Permission Diagnostics</h2>
                <p className="text-sm text-neutral-600 mt-2">
                  This shows the profile data used by the UI and what the local Firestore rules should allow. If this says allowed but Firebase still denies writes, deploy rules to the active project.
                </p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${isUiAdmin ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                UI Admin: {isUiAdmin ? 'YES' : 'NO'}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5 text-sm">
              <DiagnosticField label="Firebase Auth UID" value={firebaseUser?.uid || 'Not signed in'} />
              <DiagnosticField label="Profile Document Path" value={firebaseUser?.uid ? `users/${firebaseUser.uid}` : 'users/{missing-auth-uid}'} />
              <DiagnosticField label="Role From Firestore Profile" value={staffProfile?.role || 'Missing profile role'} />
              <DiagnosticField label="isActive" value={staffProfile?.isActive === false ? 'false' : staffProfile?.isActive === true ? 'true' : 'Not set'} />
              <DiagnosticField label="assignedStoreIds" value={(staffProfile?.assignedStoreIds || []).length > 0 ? staffProfile!.assignedStoreIds.join(', ') : '[]'} />
              <DiagnosticField label="storeIds" value={(staffProfile?.storeIds || []).length > 0 ? staffProfile!.storeIds.join(', ') : '[]'} />
            </div>

            <div className="mt-5 overflow-x-auto border border-neutral-100 rounded-xl">
              <table className="min-w-full text-xs">
                <thead className="bg-neutral-50">
                  <tr className="text-left text-neutral-500 uppercase">
                    <th className="p-3">Write Target</th>
                    <th className="p-3">Local Rule</th>
                    <th className="p-3">Should Allow</th>
                  </tr>
                </thead>
                <tbody>
                  {permissionChecks.map((check) => (
                    <tr key={check.collection} className="border-t border-neutral-100">
                      <td className="p-3 font-mono">{check.collection}</td>
                      <td className="p-3 text-neutral-600">{check.ruleSummary}</td>
                      <td className="p-3">
                        <span className={`rounded-full px-2 py-1 font-black ${check.shouldAllow ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                          {check.shouldAllow ? 'YES' : 'NO'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                <p className="text-xs uppercase tracking-wide font-black text-neutral-500">First Write Path Attempted</p>
                <p className="mt-2 text-sm font-mono text-neutral-800 break-all">
                  {firstWriteAttemptPath || 'Not attempted yet. First write will be importManifests/{importBatchId}.'}
                </p>
              </div>
              <div className={`rounded-xl border p-4 ${liveImportFailure ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
                <p className="text-xs uppercase tracking-wide font-black opacity-70">Latest Live Import Failure</p>
                {liveImportFailure ? (
                  <div className="mt-2 space-y-1 text-sm">
                    <p><strong>Stage:</strong> {liveImportFailure.stage}</p>
                    <p><strong>Collection:</strong> {liveImportFailure.collection}</p>
                    <p><strong>Doc path:</strong> <span className="font-mono break-all">{liveImportFailure.docPath}</span></p>
                    <p><strong>Firebase code:</strong> {liveImportFailure.code}</p>
                    <p><strong>Message:</strong> {liveImportFailure.message}</p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm">No live import failure captured yet.</p>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Phase 7G</p>
                <h2 className="text-xl font-black text-neutral-800">Guarded Live Import</h2>
                <p className="text-sm text-neutral-600 mt-2">
                  Writes Menu Management V2 data only. POS remains on LEGACY_MENU_ITEMS and legacy collections are untouched.
                </p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${liveGate.ready ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {liveGate.ready ? 'READY AFTER CONFIRMATION' : 'BLOCKED'}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-5">
              {liveGate.checks.map((check) => (
                <div key={check.label} className={`rounded-xl border p-4 flex items-center gap-2 ${check.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                  {check.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                  <span className="text-sm font-black">{check.label}</span>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
              <p className="text-sm font-black">Cost and stock warnings stay active after import.</p>
              <p className="text-xs mt-1">The live import can proceed with zero costs, but POS rollout and checkout on Finished Goods must wait until costing and opening stock are loaded.</p>
            </div>

            <label className="block mt-5">
              <span className="block text-sm font-black text-neutral-800 mb-2">Type this exact confirmation before live import:</span>
              <code className="block text-xs bg-neutral-100 border border-neutral-200 rounded-xl p-3 text-neutral-700 whitespace-pre-wrap">{LIVE_IMPORT_CONFIRMATION}</code>
              <input
                type="text"
                value={liveConfirmText}
                onChange={(event) => setLiveConfirmText(event.target.value)}
                className="mt-3 w-full border border-neutral-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-[#5c4033] focus:border-transparent"
                placeholder="Paste the confirmation text here"
              />
            </label>

            <button
              type="button"
              onClick={runLiveImport}
              disabled={!canRunLiveImport}
              className="mt-5 w-full md:w-auto px-6 py-3 bg-red-700 text-white font-black rounded-xl hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLiveImporting ? <Loader2 size={18} className="animate-spin" /> : <ShieldAlert size={18} />}
              {isLiveImporting ? 'Running Live Import...' : 'Run Live Import'}
            </button>

            {staffProfile?.role !== 'ADMIN' && (
              <p className="text-xs text-red-700 font-bold mt-3">Only Admin users can run live import.</p>
            )}

            {liveImportSummary && (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                <p className="font-black">Live import complete. POS source remains {liveImportSummary.posMenuSourceAfter}.</p>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-4 text-sm">
                  <SummaryMini label="Created" value={liveImportSummary.createdCount} />
                  <SummaryMini label="Updated" value={liveImportSummary.updatedCount} />
                  <SummaryMini label="Unchanged" value={liveImportSummary.unchangedCount} />
                  <SummaryMini label="Stock Created" value={liveImportSummary.storeStockCreated} />
                  <SummaryMini label="Stock Updated" value={liveImportSummary.storeStockUpdated} />
                </div>
                <p className="text-xs mt-3">Manifest ID: <span className="font-mono">{liveImportSummary.manifestId}</span></p>
              </div>
            )}
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
              <div>
                <h2 className="text-xl font-black text-neutral-800">Dry-Run Report</h2>
                <p className="text-sm text-neutral-500">Hashes compare the dry-run payload with existing Firestore docs.</p>
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
            <div className="max-h-[420px] overflow-auto border border-neutral-100 rounded-xl">
              <table className="min-w-full text-xs">
                <thead className="bg-neutral-50 sticky top-0">
                  <tr className="text-left text-neutral-500 uppercase">
                    <th className="p-3">Collection</th>
                    <th className="p-3">Doc ID</th>
                    <th className="p-3">Action</th>
                    <th className="p-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.reportRows.slice(0, 200).map((row, index) => (
                    <tr key={`${row.collection}-${row.docId}-${index}`} className="border-t border-neutral-100">
                      <td className="p-3 font-bold">{row.collection}</td>
                      <td className="p-3 font-mono">{row.docId}</td>
                      <td className="p-3">
                        <span className={`rounded-full px-2 py-1 font-black ${actionClassName(row.action)}`}>{row.action}</span>
                      </td>
                      <td className="p-3 text-neutral-600">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.reportRows.length > 200 && (
              <p className="text-xs text-neutral-500 mt-3">Showing first 200 rows. Download CSV or JSON for the full {result.reportRows.length}-row report.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone = 'brown' }: { label: string; value: number; tone?: 'brown' | 'emerald' | 'amber' | 'red' | 'neutral' }) {
  const toneClass = {
    brown: 'bg-[#5c4033] text-white',
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

function SummaryMini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-white/70 p-3">
      <p className="text-xs uppercase tracking-wide font-black opacity-70">{label}</p>
      <p className="text-2xl font-black mt-1">{value}</p>
    </div>
  );
}

function DiagnosticField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
      <p className="text-xs uppercase tracking-wide font-black text-neutral-500">{label}</p>
      <p className="mt-2 text-sm font-mono text-neutral-800 break-all">{value}</p>
    </div>
  );
}

function InfoPanel({ title, items, tone, emptyText = 'None' }: { title: string; items: string[]; tone: 'amber' | 'red'; emptyText?: string }) {
  const panelClass = tone === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-red-50 border-red-200 text-red-900';
  return (
    <div className={`border rounded-2xl p-5 ${panelClass}`}>
      <h2 className="text-lg font-black mb-3">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm opacity-80">{emptyText}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li key={item} className="flex gap-2">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function actionClassName(action: ReportAction): string {
  if (action === 'CREATE') return 'bg-emerald-50 text-emerald-700';
  if (action === 'UPDATE') return 'bg-amber-50 text-amber-700';
  if (action === 'BLOCKED') return 'bg-red-50 text-red-700';
  return 'bg-neutral-100 text-neutral-700';
}
