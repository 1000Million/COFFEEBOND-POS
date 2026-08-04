import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readFirestoreCollection } from './firestore-read-only.mjs';

export const SCHEMA_VERSION = 'pos-menu-correctness/3';
export const PROJECT_ID = 'coffee-bond-pos';
export const GOLDEN_I_STORE_ID = 'GOLDEN_I';
export const AUTHORITATIVE_PROTEIN_CODE = '36G_PROTEIN_POWER';
export const TEMPORARY_PROTEIN_CODE = '36_GM_PROTEIN_POWER';
export const LEGACY_PROTEIN_CODE = '36G_PROTIEN_POWER';
export const MEZZE_CODE = 'MEDITERRANEAN_MEZZE_PLATTER';
export const MEZZE_CATEGORY = {
  code: 'ALWAYS_AT_BOND',
  name: 'Always at Bond',
};

/**
 * Sentinel used in rollback payloads for field paths that did not exist before
 * the write. Rolling those back means deleting the field, not writing null.
 */
export const DELETE_SENTINEL = { $delete: true };

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))];
}

function documentById(documents, id) {
  return documents.find((document) => document.id === id) || null;
}

function requireDocument(documents, collection, id) {
  const document = documentById(documents, id);
  if (!document) throw new Error(`${collection}/${id} is missing.`);
  return document;
}

function menuItem(snapshot, code) {
  return snapshot?.data?.menuItems?.[code] || null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Deterministic canonical JSON: object keys are emitted in sorted order at every
 * depth so the checksum depends only on content, never on key insertion order
 * or on Firestore's field ordering.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function checksumOf(canonicalPayload) {
  return crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

/**
 * Canonical public-menu display entry.
 *
 * This mirrors sanitizedDisplayItem() in scripts/refresh-public-menu-availability.mjs,
 * which is the builder that produced every existing entry in
 * publicMenuAvailability/GOLDEN_I. That module cannot be imported here because it
 * executes main() at module load and exports nothing, so the shape is reproduced
 * exactly and pinned by a drift test in test-pos-menu-correctness.mjs.
 *
 * Field-presence rules are taken from the same source and are load-bearing:
 * optional fields are omitted (not written as null/empty) when the Finished Good
 * has no meaningful value, which is why live entries such as GREEN carry no
 * taxRate and no description.
 */
export function buildPublicMenuDisplayEntry(storeId, item) {
  const imageUrl = ['imageUrl', 'image', 'photoUrl', 'photo', 'thumbnailUrl', 'thumbnail']
    .map((key) => item[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0);

  const display = {
    id: item.code,
    code: item.code,
    name: item.name,
    posCategoryCode: item.posCategoryCode || 'MISC',
    posCategoryName: item.posCategoryName || 'Other',
    salePrice: toNumber(item.salePrice),
    prepStation: item.prepStation,
    itemType: item.itemType || 'MADE_TO_ORDER',
    sortOrder: toNumber(item.sortOrder),
    availableStoreIds: [storeId],
    isSellable: item.isSellable !== false,
    isAvailable: item.isAvailable !== false,
    isActive: item.isActive !== false,
  };

  if (item.displayName) display.displayName = item.displayName;
  if (item.description) display.description = item.description;
  if (item.productionMode) display.productionMode = item.productionMode;
  if (toNumber(item.taxRate) > 0) display.taxRate = toNumber(item.taxRate);
  if (imageUrl) display.imageUrl = imageUrl.trim();
  if (Array.isArray(item.addOnGroupIds)) {
    display.addOnGroupIds = uniqueStrings(item.addOnGroupIds);
    const sourceAllowlist = item.addOnOptionIdsByGroup;
    display.addOnOptionIdsByGroup = Object.fromEntries(
      display.addOnGroupIds.map((groupId) => [
        groupId,
        uniqueStrings(
          sourceAllowlist && typeof sourceAllowlist === 'object' && Array.isArray(sourceAllowlist[groupId])
            ? sourceAllowlist[groupId]
            : [],
        ),
      ]),
    );
  }

  return display;
}

export function buildPublicMenuAvailabilityEntry(itemCode) {
  return {
    itemCode,
    fgCode: itemCode,
    available: true,
    publicStatus: 'AVAILABLE',
    publicMessage: 'Available',
  };
}

/**
 * Fields the public menu entry cannot be published without. If the authoritative
 * Finished Good cannot supply one of these, the plan is blocked rather than
 * completed from guesswork or from the temporary duplicate.
 */
const REQUIRED_PUBLIC_ENTRY_FIELDS = [
  'id',
  'code',
  'name',
  'posCategoryCode',
  'posCategoryName',
  'salePrice',
  'prepStation',
  'itemType',
  'availableStoreIds',
  'isSellable',
  'isAvailable',
  'isActive',
];

const VALID_PREP_STATIONS = ['BARISTA', 'KITCHEN', 'BOTH', 'NONE'];

export function validatePublicMenuDisplayEntry(entry) {
  const problems = [];
  for (const field of REQUIRED_PUBLIC_ENTRY_FIELDS) {
    const value = entry[field];
    if (value === undefined || value === null || value === '') {
      problems.push(`${field} is missing on the authoritative Finished Good.`);
    }
  }
  if (toNumber(entry.salePrice) <= 0) {
    problems.push('salePrice must be greater than zero to be publicly displayable.');
  }
  if (!VALID_PREP_STATIONS.includes(entry.prepStation)) {
    problems.push(`prepStation must be one of ${VALID_PREP_STATIONS.join(', ')}.`);
  }
  return problems;
}

// Key order mirrors POSHome.tsx so the resolved rate matches what the POS charges.
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

function pickRate(data, keys, source) {
  if (!data || typeof data !== 'object') return null;
  for (const key of keys) {
    const rate = toNumber(data[key]);
    if (rate > 0) return { rate, source: `${source}.${key}` };
  }
  return null;
}

/** item rate -> store override -> store document -> application default. */
export function resolveEffectiveGst({ item, store, gstConfig, storeCode }) {
  const fromItem = pickRate(item, ITEM_TAX_RATE_KEYS, 'item');
  if (fromItem) return fromItem;

  const override = toNumber(gstConfig?.storeOverrides?.[storeCode]);
  if (override > 0) {
    return { rate: override, source: `appSettings/gstConfig.storeOverrides.${storeCode}` };
  }

  const fromStore = pickRate(store, STORE_TAX_RATE_KEYS, `stores/${storeCode}`);
  if (fromStore) return fromStore;

  const fromApp = pickRate(gstConfig, APP_TAX_RATE_KEYS, 'appSettings/gstConfig');
  if (fromApp) return fromApp;

  return { rate: 0, source: 'none' };
}

export function buildPosMenuCorrectnessPlan(input) {
  const finishedGoods = input.finishedGoods || [];
  const menuItems = input.menuItems || [];
  const snapshots = input.publicMenuAvailability || [];

  const protein = requireDocument(finishedGoods, 'finishedGoods', AUTHORITATIVE_PROTEIN_CODE);
  const temporaryProtein = requireDocument(finishedGoods, 'finishedGoods', TEMPORARY_PROTEIN_CODE);
  const legacyProtein = requireDocument(menuItems, 'menuItems', LEGACY_PROTEIN_CODE);
  const mezze = requireDocument(finishedGoods, 'finishedGoods', MEZZE_CODE);
  const goldenSnapshot = requireDocument(snapshots, 'publicMenuAvailability', GOLDEN_I_STORE_ID);

  const operations = [];
  const warnings = [];
  const blockers = [];

  // ---- Operation 1: authoritative Finished Good store assignment -----------
  const proteinStoreIds = uniqueStrings(protein.data.availableStoreIds);
  if (!proteinStoreIds.includes(GOLDEN_I_STORE_ID)) {
    operations.push({
      type: 'update',
      path: `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
      reason: 'Restore the authoritative 36G Protein Power Finished Good to Golden I POS availability.',
      fieldPaths: ['availableStoreIds'],
      before: { availableStoreIds: proteinStoreIds },
      after: { availableStoreIds: [...proteinStoreIds, GOLDEN_I_STORE_ID] },
      rollback: { availableStoreIds: proteinStoreIds },
    });
  }

  // ---- Operation 2: retire the temporary duplicate from Golden I only ------
  // The duplicate stays active everywhere else and its document is preserved in
  // full, so every historical reference remains resolvable.
  const temporaryStoreIds = uniqueStrings(temporaryProtein.data.availableStoreIds);
  if (temporaryStoreIds.includes(GOLDEN_I_STORE_ID)) {
    operations.push({
      type: 'update',
      path: `finishedGoods/${TEMPORARY_PROTEIN_CODE}`,
      reason: 'Withdraw the temporary duplicate from Golden I only, so exactly one 36 g Protein product remains visible in the Golden I POS.',
      fieldPaths: ['availableStoreIds'],
      before: { availableStoreIds: temporaryStoreIds },
      after: { availableStoreIds: temporaryStoreIds.filter((storeId) => storeId !== GOLDEN_I_STORE_ID) },
      rollback: { availableStoreIds: temporaryStoreIds },
    });
  }

  // ---- Operation 3: Mezze category on the Finished Good --------------------
  const mezzeCategoryPatch = {};
  if (mezze.data.posCategoryCode !== MEZZE_CATEGORY.code) {
    mezzeCategoryPatch.posCategoryCode = MEZZE_CATEGORY.code;
  }
  if (mezze.data.posCategoryName !== MEZZE_CATEGORY.name) {
    mezzeCategoryPatch.posCategoryName = MEZZE_CATEGORY.name;
  }
  if (Object.keys(mezzeCategoryPatch).length > 0) {
    const mezzeBefore = {
      posCategoryCode: mezze.data.posCategoryCode ?? null,
      posCategoryName: mezze.data.posCategoryName ?? null,
    };
    operations.push({
      type: 'update',
      path: `finishedGoods/${MEZZE_CODE}`,
      reason: 'Synchronize Mediterranean Mezze Platter to the approved Always at Bond category.',
      fieldPaths: ['posCategoryCode', 'posCategoryName'],
      before: mezzeBefore,
      after: { ...mezzeBefore, ...mezzeCategoryPatch },
      rollback: mezzeBefore,
    });
  }

  // ---- Operation 4: Golden I public snapshot -------------------------------
  const snapshotBefore = {};
  const snapshotAfter = {};
  const snapshotRollback = {};
  const snapshotFieldPaths = [];

  const snapshotProtein = menuItem(goldenSnapshot, AUTHORITATIVE_PROTEIN_CODE);
  const proteinEntry = buildPublicMenuDisplayEntry(GOLDEN_I_STORE_ID, protein.data);
  const proteinProblems = validatePublicMenuDisplayEntry(proteinEntry);
  if (proteinProblems.length > 0) {
    blockers.push({
      path: `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
      reason: 'The authoritative Finished Good cannot produce a complete public menu entry.',
      problems: proteinProblems,
    });
  }

  const currentItemCount = toNumber(goldenSnapshot.data.itemCount);
  const currentAvailableCount = toNumber(goldenSnapshot.data.availableCount);
  const currentUnavailableCount = toNumber(goldenSnapshot.data.unavailableCount);

  // The Golden I public catalogue is curated: refresh-public-menu-availability.mjs
  // republishes only codes already present in the snapshot. Catalogue MEMBERSHIP is
  // therefore preserved here and the protein entry is swapped in place, never added.
  //   - duplicate present  -> delete duplicate entries, publish authoritative entries (net 0)
  //   - duplicate absent   -> the catalogue carries no 36 g Protein entry; publishing one
  //                           would grow the catalogue, so nothing is published
  // Either way itemCount/availableCount are untouched and stay at their current values.
  const snapshotTemporary = menuItem(goldenSnapshot, TEMPORARY_PROTEIN_CODE);
  if (snapshotTemporary && proteinProblems.length === 0) {
    const temporaryMenuPath = `menuItems.${TEMPORARY_PROTEIN_CODE}`;
    const temporaryItemPath = `items.${TEMPORARY_PROTEIN_CODE}`;
    const proteinMenuPath = `menuItems.${AUTHORITATIVE_PROTEIN_CODE}`;
    const proteinItemPath = `items.${AUTHORITATIVE_PROTEIN_CODE}`;

    snapshotFieldPaths.push(temporaryMenuPath, temporaryItemPath, proteinMenuPath, proteinItemPath);

    snapshotBefore[temporaryMenuPath] = clone(snapshotTemporary);
    snapshotBefore[temporaryItemPath] = clone(goldenSnapshot.data.items?.[TEMPORARY_PROTEIN_CODE] ?? null);
    snapshotBefore[proteinMenuPath] = clone(snapshotProtein);
    snapshotBefore[proteinItemPath] = clone(goldenSnapshot.data.items?.[AUTHORITATIVE_PROTEIN_CODE] ?? null);

    snapshotAfter[temporaryMenuPath] = clone(DELETE_SENTINEL);
    snapshotAfter[temporaryItemPath] = clone(DELETE_SENTINEL);
    snapshotAfter[proteinMenuPath] = proteinEntry;
    snapshotAfter[proteinItemPath] = buildPublicMenuAvailabilityEntry(AUTHORITATIVE_PROTEIN_CODE);

    snapshotRollback[temporaryMenuPath] = clone(snapshotTemporary);
    snapshotRollback[temporaryItemPath] = clone(goldenSnapshot.data.items?.[TEMPORARY_PROTEIN_CODE] ?? null);
    snapshotRollback[proteinMenuPath] = clone(DELETE_SENTINEL);
    snapshotRollback[proteinItemPath] = clone(DELETE_SENTINEL);
  }

  const snapshotMezze = menuItem(goldenSnapshot, MEZZE_CODE);
  if (snapshotMezze && (
    snapshotMezze.posCategoryCode !== MEZZE_CATEGORY.code
    || snapshotMezze.posCategoryName !== MEZZE_CATEGORY.name
  )) {
    const codePath = `menuItems.${MEZZE_CODE}.posCategoryCode`;
    const namePath = `menuItems.${MEZZE_CODE}.posCategoryName`;
    snapshotFieldPaths.push(codePath, namePath);
    snapshotBefore[codePath] = snapshotMezze.posCategoryCode ?? null;
    snapshotBefore[namePath] = snapshotMezze.posCategoryName ?? null;
    snapshotAfter[codePath] = MEZZE_CATEGORY.code;
    snapshotAfter[namePath] = MEZZE_CATEGORY.name;
    snapshotRollback[codePath] = snapshotMezze.posCategoryCode ?? null;
    snapshotRollback[namePath] = snapshotMezze.posCategoryName ?? null;
  }

  if (snapshotFieldPaths.length > 0) {
    operations.push({
      type: 'update',
      path: `publicMenuAvailability/${GOLDEN_I_STORE_ID}`,
      reason: 'Publish the authoritative 36G Protein entry and the approved Mezze category to the Golden I snapshot.',
      fieldPaths: snapshotFieldPaths,
      before: snapshotBefore,
      after: snapshotAfter,
      rollback: snapshotRollback,
    });
  }

  // ---- GST fallback proof --------------------------------------------------
  // The POS resolves an item's rate as item -> store override -> store doc -> app
  // default (getItemTaxRate/pickTaxConfig in frontend/pages/pos/POSHome.tsx). A zero
  // or absent item rate falls through rather than zero-rating the line, so the
  // authoritative product's taxRate of 0 is safe only if a downstream source supplies
  // a positive rate. If none does, the batch is blocked.
  const gst = resolveEffectiveGst({
    item: protein.data,
    store: input.store || null,
    gstConfig: input.gstConfig || null,
    storeCode: GOLDEN_I_STORE_ID,
  });
  if (gst.rate <= 0) {
    blockers.push({
      path: `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
      reason: 'The authoritative product would be published zero-rated: no item, store override, store or application GST rate resolves above zero.',
      problems: [`Resolved rate ${gst.rate} from ${gst.source}.`],
    });
  }

  // ---- Report-only findings ------------------------------------------------
  warnings.push({
    path: `finishedGoods/${TEMPORARY_PROTEIN_CODE}`,
    reason: 'The temporary duplicate is withdrawn from Golden I only. Its document, every other store assignment and all historical references are preserved; it is neither deleted nor globally deactivated.',
    proposedAction: 'Schedule a separate retirement review for the remaining stores once the authoritative product is confirmed in service.',
  });

  if (toNumber(temporaryProtein.data.taxRate) !== toNumber(protein.data.taxRate)) {
    warnings.push({
      path: `finishedGoods/${TEMPORARY_PROTEIN_CODE}`,
      reason: `Duplicate taxRate (${toNumber(temporaryProtein.data.taxRate)}) differs from the authoritative product taxRate (${toNumber(protein.data.taxRate)}). The duplicate's rate is NOT copied; the authoritative product resolves to ${gst.rate}% via ${gst.source}.`,
      proposedAction: 'Owner to confirm the correct GST rate for 36G Protein Power in a separate, explicitly approved batch.',
    });
  }

  if (legacyProtein.data.isActive === true) {
    warnings.push({
      path: `menuItems/${LEGACY_PROTEIN_CODE}`,
      reason: 'Legacy typo-coded menu item exists outside Finished Goods V2 and is not assigned to stores.',
      proposedAction: 'Keep unchanged in this batch; do not revive legacy menuItems for POS.',
    });
  }

  const status = blockers.length > 0
    ? 'BLOCKED'
    : (operations.length > 0 ? 'READY_FOR_OWNER_APPROVAL' : 'NO_CHANGES_REQUIRED');

  const canonicalPayload = canonicalize({
    schemaVersion: SCHEMA_VERSION,
    projectId: PROJECT_ID,
    targetStore: GOLDEN_I_STORE_ID,
    operations,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    projectId: PROJECT_ID,
    targetStore: GOLDEN_I_STORE_ID,
    status,
    proposedWriteCount: operations.length,
    checksum: checksumOf(canonicalPayload),
    canonicalPayload,
    operations,
    blockers,
    warnings,
    evidence: {
      authoritativeProtein: {
        path: `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
        name: protein.data.displayName || protein.data.name,
        availableStoreIds: proteinStoreIds,
      },
      temporaryProtein: {
        path: `finishedGoods/${TEMPORARY_PROTEIN_CODE}`,
        name: temporaryProtein.data.displayName || temporaryProtein.data.name,
        availableStoreIds: uniqueStrings(temporaryProtein.data.availableStoreIds),
      },
      legacyProtein: {
        path: `menuItems/${LEGACY_PROTEIN_CODE}`,
        name: legacyProtein.data.name || legacyProtein.data.itemName,
        availableStoreIds: uniqueStrings(legacyProtein.data.availableStoreIds),
      },
      mezze: {
        path: `finishedGoods/${MEZZE_CODE}`,
        posCategoryCode: mezze.data.posCategoryCode || null,
        posCategoryName: mezze.data.posCategoryName || null,
      },
      goldenSnapshotCounts: {
        before: {
          itemCount: currentItemCount,
          availableCount: currentAvailableCount,
          unavailableCount: currentUnavailableCount,
        },
        after: {
          itemCount: currentItemCount,
          availableCount: currentAvailableCount,
          unavailableCount: currentUnavailableCount,
        },
        catalogueMembershipChanged: false,
        note: 'Catalogue membership is preserved. The protein entry is swapped in place when the duplicate is present, so no count moves.',
      },
      gst: {
        authoritativeItemTaxRate: toNumber(protein.data.taxRate),
        duplicateItemTaxRate: toNumber(temporaryProtein.data.taxRate),
        duplicateRateCopied: false,
        resolvedRate: gst.rate,
        resolvedSource: gst.source,
        chain: 'item rate -> store override -> store document -> application default',
      },
      goldenIPosVisibility: {
        rule: 'isActive === true && availableStoreIds includes GOLDEN_I (frontend/pages/pos/POSHome.tsx)',
        before: proteinCodesVisibleAtGoldenI(finishedGoods, GOLDEN_I_STORE_ID),
        after: proteinCodesVisibleAtGoldenI(applyPlannedStoreIds(finishedGoods, operations), GOLDEN_I_STORE_ID),
      },
    },
  };
}

/** Finished Goods matching the 36 g Protein family that the Golden I POS would list. */
export function proteinCodesVisibleAtGoldenI(finishedGoods, storeId) {
  return finishedGoods
    .filter((document) => [AUTHORITATIVE_PROTEIN_CODE, TEMPORARY_PROTEIN_CODE, LEGACY_PROTEIN_CODE].includes(document.id))
    .filter((document) => document.data.isActive === true
      && uniqueStrings(document.data.availableStoreIds).includes(storeId))
    .map((document) => document.id)
    .sort();
}

/** Projects the planned availableStoreIds onto a copy of the Finished Goods. */
function applyPlannedStoreIds(finishedGoods, operations) {
  return finishedGoods.map((document) => {
    const operation = operations.find((candidate) => candidate.path === `finishedGoods/${document.id}`);
    if (!operation || !operation.after.availableStoreIds) return document;
    return { id: document.id, data: { ...document.data, availableStoreIds: operation.after.availableStoreIds } };
  });
}

export async function readPosMenuCorrectnessInput() {
  const [finishedGoods, menuItems, publicMenuAvailability, stores, appSettings] = await Promise.all([
    readFirestoreCollection('finishedGoods'),
    readFirestoreCollection('menuItems'),
    readFirestoreCollection('publicMenuAvailability'),
    readFirestoreCollection('stores'),
    readFirestoreCollection('appSettings'),
  ]);
  return {
    finishedGoods,
    menuItems,
    publicMenuAvailability,
    // Read-only inputs used solely to prove the GST fallback; never written.
    store: stores.find((document) => document.id === GOLDEN_I_STORE_ID)?.data || null,
    gstConfig: appSettings.find((document) => document.id === 'gstConfig')?.data || null,
  };
}

export const DRY_RUN_REPORT_PATH = path.join('reports', 'pos-menu-correctness', 'batch-1-dry-run.json');

async function main() {
  const plan = buildPosMenuCorrectnessPlan(await readPosMenuCorrectnessInput());
  const outputPath = path.join(process.cwd(), DRY_RUN_REPORT_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`Dry-run only. No Firestore write was performed. Wrote ${outputPath}`);
  console.log(JSON.stringify({
    schemaVersion: plan.schemaVersion,
    projectId: plan.projectId,
    status: plan.status,
    proposedWriteCount: plan.proposedWriteCount,
    checksum: plan.checksum,
    blockerCount: plan.blockers.length,
    warningCount: plan.warnings.length,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
