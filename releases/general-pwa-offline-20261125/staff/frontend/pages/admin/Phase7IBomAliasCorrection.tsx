import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import {
  AlertCircle,
  FileSearch,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store } from '../../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StoreStock } from '../../types/menu-management';

type TargetCollection = 'prepItems' | 'finishedGoods';
type CorrectionAction = 'UPDATE' | 'UNCHANGED' | 'BLOCKED';

type AliasMapping = {
  oldCode: string;
  newCode: string;
};

type AffectedLine = {
  collectionName: TargetCollection;
  docId: string;
  itemName: string;
  bomLineIndex: number;
  oldComponentCode: string;
  oldComponentName: string;
  newComponentCode: string;
  newComponentName: string;
  quantity: number;
  uom: string;
  currentLineCost: number;
  replacementLineCost: number;
  costImpact: number;
};

type CorrectionEntry = {
  collectionName: TargetCollection;
  docId: string;
  docPath: string;
  itemName: string;
  action: CorrectionAction;
  reason: string;
  affectedLines: AffectedLine[];
  hashBefore: string;
  hashAfter: string;
  rollbackSnapshot: Record<string, unknown>;
  update: Record<string, unknown>;
};

type DryRunResult = {
  batchId: string;
  affectedLines: AffectedLine[];
  correctionEntries: CorrectionEntry[];
  validationBlockers: string[];
  counts: {
    affectedLines: number;
    docsToUpdate: number;
    unchangedDocs: number;
    blocked: number;
  };
};

type LiveSummary = {
  importBatchId: string;
  manifestId: string;
  updatedCount: number;
  unchangedCount: number;
};

const REQUIRED_STORE_CODES = ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'];
const LIVE_CONFIRMATION = 'I understand this will correct V2 BOM alias codes only, and will not switch POS rollout.';
const BATCH_LIMIT = 400;
const ALIAS_MAPPINGS: AliasMapping[] = [
  { oldCode: 'ROASTED_COFFEE', newCode: 'ROASTED_COFFEE_BEANS' },
  { oldCode: 'COW_MILK', newCode: 'FRESH_MILK' },
];

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

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
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

function stockDocId(storeId: string, rawCode: string): string {
  return `${storeId}_RAW_INGREDIENT_${rawCode}`;
}

function cloneBom(bom: BOMComponent[] | undefined): BOMComponent[] {
  return (bom || []).map((line) => ({ ...line }));
}

function recalculatePrepCost(prep: PrepItem, bom: BOMComponent[]): number {
  const totalCost = bom.reduce((sum, line) => sum + toNumber(line.lineCost), 0);
  const yieldQuantity = toNumber(prep.yieldQuantity, 1);
  return yieldQuantity > 0 ? roundMoney(totalCost / yieldQuantity) : 0;
}

function recalculateFinishedCosts(finishedGood: FinishedGood, bom: BOMComponent[]) {
  const recipeCost = Math.round((bom.reduce((sum, line) => sum + toNumber(line.lineCost), 0) + Number.EPSILON) * 100) / 100;
  const salePrice = toNumber(finishedGood.salePrice);
  const taxRate = toNumber(finishedGood.taxRate);
  const netPrice = salePrice / (1 + taxRate / 100);
  const grossMargin = netPrice > 0 ? Math.round(((netPrice - recipeCost) / netPrice + Number.EPSILON) * 10000) / 100 : 100;
  const cogsPercent = netPrice > 0 ? Math.round((recipeCost / netPrice + Number.EPSILON) * 10000) / 100 : 0;
  return { recipeCost, grossMargin, cogsPercent };
}

async function commitQueuedWrites(writeQueue: Array<(batch: ReturnType<typeof writeBatch>) => void>) {
  for (let index = 0; index < writeQueue.length; index += BATCH_LIMIT) {
    const batch = writeBatch(db);
    writeQueue.slice(index, index + BATCH_LIMIT).forEach((writeOperation) => writeOperation(batch));
    await batch.commit();
  }
}

export default function Phase7IBomAliasCorrection() {
  const { staffProfile } = useAuth();
  const [isRunningDryRun, setIsRunningDryRun] = useState(false);
  const [isWritingLive, setIsWritingLive] = useState(false);
  const [error, setError] = useState('');
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [liveSummary, setLiveSummary] = useState<LiveSummary | null>(null);

  const isAdmin = staffProfile?.role === 'ADMIN';
  const liveReady = !!dryRun
    && dryRun.counts.blocked === 0
    && dryRun.counts.docsToUpdate > 0
    && isAdmin
    && confirmationText.trim() === LIVE_CONFIRMATION
    && !isWritingLive;

  const aliasByOldCode = useMemo(() => new Map(ALIAS_MAPPINGS.map((mapping) => [mapping.oldCode, mapping])), []);

  const runDryRun = async () => {
    setIsRunningDryRun(true);
    setError('');
    setDryRun(null);
    setLiveSummary(null);

    try {
      const [prepSnap, finishedSnap, rawSnap, stockSnap, storesSnap] = await Promise.all([
        getDocs(collection(db, 'prepItems')),
        getDocs(collection(db, 'finishedGoods')),
        getDocs(collection(db, 'rawIngredients')),
        getDocs(collection(db, 'storeStock')),
        getDocs(collection(db, 'stores')),
      ]);

      const prepItems = prepSnap.docs.map((snap) => withId(snap.id, snap.data() as PrepItem & Record<string, unknown>));
      const finishedGoods = finishedSnap.docs.map((snap) => withId(snap.id, snap.data() as FinishedGood & Record<string, unknown>));
      const rawIngredients = rawSnap.docs.map((snap) => withId(snap.id, snap.data() as RawIngredient & Record<string, unknown>));
      const storeStock = stockSnap.docs.map((snap) => withId(snap.id, snap.data() as StoreStock & Record<string, unknown>));
      const stores = storesSnap.docs.map((snap) => withId(snap.id, snap.data() as Store & Record<string, unknown>));
      const validationBlockers: string[] = [];
      const affectedLines: AffectedLine[] = [];
      const correctionEntries: CorrectionEntry[] = [];
      const rawByCode = new Map(rawIngredients.map((raw) => [raw.code, raw]));
      const stockById = new Map(storeStock.map((stock) => [stock.id, stock]));
      const targetStores = REQUIRED_STORE_CODES
        .map((storeCode) => stores.find((store) => store.code === storeCode && store.isActive))
        .filter((store): store is Store & Record<string, unknown> & { id: string } => !!store);

      if (!isAdmin) {
        validationBlockers.push('Current user is not ADMIN.');
      }

      REQUIRED_STORE_CODES.forEach((storeCode) => {
        if (!targetStores.some((store) => store.code === storeCode)) {
          validationBlockers.push(`Target store ${storeCode} is missing or inactive.`);
        }
      });

      ALIAS_MAPPINGS.forEach((mapping) => {
        const canonicalRaw = rawByCode.get(mapping.newCode);
        if (!canonicalRaw) {
          validationBlockers.push(`Canonical rawIngredient ${mapping.newCode} does not exist.`);
          return;
        }

        targetStores.forEach((store) => {
          const id = stockDocId(store.id, mapping.newCode);
          if (!stockById.has(id)) {
            validationBlockers.push(`Canonical storeStock row ${id} does not exist for ${store.code}.`);
          }
        });
      });

      const scanItem = (
        collectionName: TargetCollection,
        item: (PrepItem | FinishedGood) & Record<string, unknown> & { id: string },
      ) => {
        if (!Array.isArray(item.bom)) {
          validationBlockers.push(`${collectionName}/${item.id} has no editable bom array.`);
          return;
        }

        const nextBom = cloneBom(item.bom);
        const itemLines: AffectedLine[] = [];
        let changed = false;

        nextBom.forEach((line, index) => {
          if (line.componentType !== 'RAW_INGREDIENT') return;
          const mapping = aliasByOldCode.get(line.componentCode);
          if (!mapping) return;

          const canonicalRaw = rawByCode.get(mapping.newCode);
          if (!canonicalRaw) {
            validationBlockers.push(`${collectionName}/${item.id} line ${index + 1} cannot map ${mapping.oldCode}; canonical raw ingredient is missing.`);
            return;
          }

          const quantity = toNumber(line.quantity);
          const oldLineCost = toNumber(line.lineCost, roundMoney(toNumber(line.costPerUnit) * quantity));
          const newCostPerUnit = toNumber(canonicalRaw.costPerUsageUnit);
          const newLineCost = roundMoney(newCostPerUnit * quantity);
          const affectedLine: AffectedLine = {
            collectionName,
            docId: item.id,
            itemName: cleanValue(item.name) || item.id,
            bomLineIndex: index,
            oldComponentCode: line.componentCode,
            oldComponentName: cleanValue(line.componentName) || line.componentCode,
            newComponentCode: mapping.newCode,
            newComponentName: canonicalRaw.name,
            quantity,
            uom: line.uom,
            currentLineCost: oldLineCost,
            replacementLineCost: newLineCost,
            costImpact: roundMoney(newLineCost - oldLineCost),
          };

          itemLines.push(affectedLine);
          affectedLines.push(affectedLine);
          nextBom[index] = {
            ...line,
            componentCode: mapping.newCode,
            componentName: canonicalRaw.name,
            costPerUnit: newCostPerUnit,
            lineCost: newLineCost,
          };
          changed = true;
        });

        if (!changed) return;

        let update: Record<string, unknown>;
        if (collectionName === 'prepItems') {
          const prep = item as PrepItem & Record<string, unknown> & { id: string };
          update = {
            bom: nextBom,
            bomVersion: toNumber(prep.bomVersion, 1) + 1,
            costPerUnit: recalculatePrepCost(prep, nextBom),
          };
        } else {
          const finishedGood = item as FinishedGood & Record<string, unknown> & { id: string };
          update = {
            bom: nextBom,
            bomVersion: toNumber(finishedGood.bomVersion, 1) + 1,
            ...recalculateFinishedCosts(finishedGood, nextBom),
          };
        }

        const logicalAfter = { ...item, ...update };
        delete logicalAfter.id;
        const logicalBefore = { ...item };
        delete logicalBefore.id;
        const hashBefore = stableHash(logicalBefore);
        const hashAfter = stableHash(logicalAfter);
        const action: CorrectionAction = hashBefore === hashAfter ? 'UNCHANGED' : 'UPDATE';

        correctionEntries.push({
          collectionName,
          docId: item.id,
          docPath: `${collectionName}/${item.id}`,
          itemName: cleanValue(item.name) || item.id,
          action,
          reason: action === 'UPDATE' ? 'Alias BOM component codes will be replaced with canonical raw ingredient codes.' : 'Document already matches the corrected payload.',
          affectedLines: itemLines,
          hashBefore,
          hashAfter,
          rollbackSnapshot: logicalBefore,
          update,
        });
      };

      prepItems.forEach((item) => scanItem('prepItems', item));
      finishedGoods.forEach((item) => scanItem('finishedGoods', item));

      setDryRun({
        batchId: `phase7i-dry-run-${new Date().toISOString()}`,
        affectedLines,
        correctionEntries,
        validationBlockers,
        counts: {
          affectedLines: affectedLines.length,
          docsToUpdate: correctionEntries.filter((entry) => entry.action === 'UPDATE').length,
          unchangedDocs: correctionEntries.filter((entry) => entry.action === 'UNCHANGED').length,
          blocked: validationBlockers.length,
        },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Phase 7I dry-run scan failed.');
    } finally {
      setIsRunningDryRun(false);
    }
  };

  const runLiveCorrection = async () => {
    if (!dryRun || dryRun.counts.blocked > 0) {
      setError('Live correction is blocked until dry-run has zero blockers.');
      return;
    }
    if (!isAdmin) {
      setError('Only Admin users can run Phase 7I live correction.');
      return;
    }
    if (dryRun.counts.docsToUpdate === 0) {
      setError('No affected BOM documents need correction.');
      return;
    }
    if (confirmationText.trim() !== LIVE_CONFIRMATION) {
      setError('Type the confirmation text exactly before running live correction.');
      return;
    }
    if (!window.confirm(`${LIVE_CONFIRMATION}\n\nThis writes only affected prepItems, finishedGoods, and one importManifests audit record. Continue?`)) {
      return;
    }

    setIsWritingLive(true);
    setError('');
    setLiveSummary(null);

    let importBatchId = '';
    try {
      importBatchId = `phase7i-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const adminName = staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin';
      const updateEntries = dryRun.correctionEntries.filter((entry) => entry.action === 'UPDATE');
      const unchangedEntries = dryRun.correctionEntries.filter((entry) => entry.action === 'UNCHANGED');
      const manifestRef = doc(db, 'importManifests', importBatchId);
      const affectedDocPaths = updateEntries.map((entry) => entry.docPath);
      const manifestEntries = dryRun.correctionEntries.map((entry) => ({
        collection: entry.collectionName,
        docId: entry.docId,
        docPath: entry.docPath,
        itemName: entry.itemName,
        action: entry.action,
        reason: entry.reason,
        hashBefore: entry.hashBefore,
        hashAfter: entry.hashAfter,
        rollbackSnapshot: entry.action === 'UPDATE' ? entry.rollbackSnapshot : null,
        affectedLines: entry.affectedLines,
      }));

      await setDoc(manifestRef, {
        importBatchId,
        phase: 'PHASE_7I_BOM_ALIAS_CORRECTION',
        status: 'STARTED',
        dryRunBatchId: dryRun.batchId,
        createdAt: serverTimestamp(),
        createdBy: {
          uid: staffProfile?.uid || '',
          name: adminName,
          email: staffProfile?.email || '',
          role: staffProfile?.role || '',
        },
        mappingsApplied: ALIAS_MAPPINGS,
        affectedDocPaths,
        entries: manifestEntries,
        totals: {
          affectedLines: dryRun.counts.affectedLines,
          update: updateEntries.length,
          unchanged: unchangedEntries.length,
          blocked: dryRun.counts.blocked,
        },
        rolloutSwitchChanged: false,
        legacyCollectionsChanged: false,
        checkoutBehaviorChanged: false,
      });

      const writeQueue: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
      updateEntries.forEach((entry) => {
        writeQueue.push((batch) => {
          batch.set(doc(db, entry.collectionName, entry.docId), {
            ...entry.update,
            updatedAt: serverTimestamp(),
            phase7IImportBatchId: importBatchId,
            lastBomAliasCorrectionAt: serverTimestamp(),
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
        updatedCount: updateEntries.length,
        unchangedCount: unchangedEntries.length,
      });
    } catch (err: unknown) {
      if (importBatchId) {
        try {
          await setDoc(doc(db, 'importManifests', importBatchId), {
            status: 'FAILED_OR_PARTIAL',
            failedAt: serverTimestamp(),
            failureMessage: err instanceof Error ? err.message : 'Phase 7I live correction failed.',
          }, { merge: true });
        } catch {
          // Keep the original error visible if the failure manifest cannot be written.
        }
      }
      setError(err instanceof Error ? err.message : 'Phase 7I live correction failed.');
    } finally {
      setIsWritingLive(false);
    }
  };

  const updateEntries = dryRun?.correctionEntries.filter((entry) => entry.action === 'UPDATE') || [];

  return (
    <div className="max-w-6xl mx-auto w-full pb-20 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Coffee Bond Menu Management</p>
          <h1 className="text-3xl font-black text-[#5c4033]">Phase 7I BOM Alias Correction</h1>
          <p className="text-neutral-600 mt-2">Dry-run and guarded correction for V2 BOM aliases only. POS stays on legacy.</p>
        </div>
        <Link to="/admin" className="text-sm font-bold text-[#5c4033] hover:underline">
          Back to Admin Dashboard
        </Link>
      </div>

      <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-5 flex gap-4">
        <ShieldAlert className="w-6 h-6 shrink-0 mt-0.5" />
        <div>
          <h2 className="font-black text-lg">No POS rollout in Phase 7I</h2>
          <p className="text-sm mt-1">This page never switches appSettings/posMenuSource, never writes rawIngredients or storeStock, and never changes checkout behavior.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 flex gap-3 text-sm">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-neutral-800">Dry-Run Scan</h2>
            <p className="text-sm text-neutral-500 mt-2">
              Reads prepItems, finishedGoods, rawIngredients, and storeStock to find RAW_INGREDIENT BOM lines using ROASTED_COFFEE or COW_MILK.
            </p>
          </div>
          <button
            type="button"
            onClick={runDryRun}
            disabled={isRunningDryRun}
            className="px-6 py-3 bg-[#5c4033] text-white font-black rounded-xl hover:bg-[#3e2723] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isRunningDryRun ? <Loader2 size={18} className="animate-spin" /> : <FileSearch size={18} />}
            {isRunningDryRun ? 'Scanning...' : 'Run Phase 7I Dry-Run Scan'}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          {ALIAS_MAPPINGS.map((mapping) => (
            <div key={mapping.oldCode} className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-amber-900">
              <p className="text-xs uppercase tracking-wide font-black opacity-70">Replacement</p>
              <p className="font-mono font-black mt-1">{mapping.oldCode} -&gt; {mapping.newCode}</p>
            </div>
          ))}
        </div>
      </div>

      {dryRun && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SummaryCard label="Affected Lines" value={dryRun.counts.affectedLines} tone="amber" />
            <SummaryCard label="Docs Update" value={dryRun.counts.docsToUpdate} tone="emerald" />
            <SummaryCard label="Unchanged" value={dryRun.counts.unchangedDocs} tone="neutral" />
            <SummaryCard label="Blocked" value={dryRun.counts.blocked} tone="red" />
          </div>

          {dryRun.validationBlockers.length > 0 && (
            <div className="bg-red-50 border border-red-200 text-red-900 rounded-2xl p-5">
              <h2 className="font-black mb-3">Validation Blockers</h2>
              <ul className="space-y-2 text-sm">
                {dryRun.validationBlockers.map((blocker) => (
                  <li key={blocker} className="flex gap-2">
                    <XCircle size={16} className="shrink-0 mt-0.5" />
                    <span>{blocker}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-black text-neutral-800 mb-4">Affected BOM Lines</h2>
            {dryRun.affectedLines.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 border border-emerald-100 px-4 py-3 text-sm font-bold text-emerald-800">
                No alias BOM lines found. Nothing needs correction.
              </p>
            ) : (
              <div className="max-h-[440px] overflow-auto">
                <table className="min-w-[1120px] text-xs">
                  <thead>
                    <tr className="text-left uppercase text-neutral-500 border-b border-neutral-200">
                      <th className="py-2 pr-4">Collection</th>
                      <th className="py-2 pr-4">Doc ID</th>
                      <th className="py-2 pr-4">Item</th>
                      <th className="py-2 pr-4">Line</th>
                      <th className="py-2 pr-4">Old Code</th>
                      <th className="py-2 pr-4">Old Name</th>
                      <th className="py-2 pr-4">New Code</th>
                      <th className="py-2 pr-4">New Name</th>
                      <th className="py-2 pr-4">Qty</th>
                      <th className="py-2 pr-4">UOM</th>
                      <th className="py-2 pr-4">Current Cost</th>
                      <th className="py-2 pr-4">New Cost</th>
                      <th className="py-2 pr-4">Impact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dryRun.affectedLines.map((line) => (
                      <tr key={`${line.collectionName}-${line.docId}-${line.bomLineIndex}`} className="border-b border-neutral-100 last:border-0">
                        <td className="py-2 pr-4 font-bold">{line.collectionName}</td>
                        <td className="py-2 pr-4 font-mono">{line.docId}</td>
                        <td className="py-2 pr-4">{line.itemName}</td>
                        <td className="py-2 pr-4">{line.bomLineIndex + 1}</td>
                        <td className="py-2 pr-4 font-mono">{line.oldComponentCode}</td>
                        <td className="py-2 pr-4">{line.oldComponentName}</td>
                        <td className="py-2 pr-4 font-mono">{line.newComponentCode}</td>
                        <td className="py-2 pr-4">{line.newComponentName}</td>
                        <td className="py-2 pr-4">{line.quantity}</td>
                        <td className="py-2 pr-4">{line.uom}</td>
                        <td className="py-2 pr-4">{line.currentLineCost}</td>
                        <td className="py-2 pr-4">{line.replacementLineCost}</td>
                        <td className="py-2 pr-4">{line.costImpact}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-black text-neutral-800 mb-4">Document Update Preview</h2>
            {updateEntries.length === 0 ? (
              <p className="text-sm text-neutral-500">No documents are queued for update.</p>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {dryRun.correctionEntries.map((entry) => (
                  <div key={entry.docPath} className="rounded-xl border border-neutral-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-wide font-black text-neutral-500">{entry.collectionName}</p>
                        <p className="font-mono text-sm font-black text-neutral-800 break-all">{entry.docId}</p>
                        <p className="text-sm text-neutral-500 mt-1">{entry.itemName}</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs font-black ${entry.action === 'UPDATE' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-600'}`}>
                        {entry.action}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-neutral-500">Lines: {entry.affectedLines.length}</p>
                    <p className="mt-2 text-xs font-mono text-neutral-500">before {entry.hashBefore} - after {entry.hashAfter}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-amber-700 uppercase tracking-wide">Guarded Live Correction</p>
                <h2 className="text-xl font-black text-neutral-800">Correct V2 BOM Alias Codes</h2>
                <p className="text-sm text-neutral-600 mt-2">Writes only affected prepItems, finishedGoods, and importManifests audit data.</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${dryRun.counts.blocked === 0 && dryRun.counts.docsToUpdate > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {dryRun.counts.blocked === 0 && dryRun.counts.docsToUpdate > 0 ? 'READY AFTER CONFIRMATION' : 'BLOCKED'}
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
              onClick={runLiveCorrection}
              disabled={!liveReady}
              className="mt-5 w-full md:w-auto px-6 py-3 bg-red-700 text-white font-black rounded-xl hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isWritingLive ? <Loader2 size={18} className="animate-spin" /> : <ShieldAlert size={18} />}
              {isWritingLive ? 'Correcting...' : 'Run Guarded Live Correction'}
            </button>

            {liveSummary && (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                <p className="font-black">Phase 7I correction complete. POS rollout was not changed.</p>
                <p className="text-sm mt-2">Updated docs: {liveSummary.updatedCount} | Unchanged docs: {liveSummary.unchangedCount}</p>
                <p className="text-xs mt-2">Manifest ID: <span className="font-mono">{liveSummary.manifestId}</span></p>
                <p className="text-sm mt-3 font-bold">Return to Phase 7H and click Refresh Readiness from Firestore.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
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
