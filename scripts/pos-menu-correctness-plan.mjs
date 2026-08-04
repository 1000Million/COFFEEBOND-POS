import fs from 'node:fs';
import path from 'node:path';
import { readFirestoreCollection } from './firestore-read-only.mjs';

export const GOLDEN_I_STORE_ID = 'GOLDEN_I';
export const AUTHORITATIVE_PROTEIN_CODE = '36G_PROTEIN_POWER';
export const TEMPORARY_PROTEIN_CODE = '36_GM_PROTEIN_POWER';
export const LEGACY_PROTEIN_CODE = '36G_PROTIEN_POWER';
export const MEZZE_CODE = 'MEDITERRANEAN_MEZZE_PLATTER';
export const MEZZE_CATEGORY = {
  code: 'ALWAYS_AT_BOND',
  name: 'Always at Bond',
};

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

  const proteinStoreIds = uniqueStrings(protein.data.availableStoreIds);
  if (!proteinStoreIds.includes(GOLDEN_I_STORE_ID)) {
    operations.push({
      type: 'update',
      path: `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
      reason: 'Restore the authoritative 36G Protein Power Finished Good to Golden I POS availability.',
      before: { availableStoreIds: proteinStoreIds },
      after: { availableStoreIds: [...proteinStoreIds, GOLDEN_I_STORE_ID] },
    });
  }

  if (uniqueStrings(temporaryProtein.data.availableStoreIds).includes(GOLDEN_I_STORE_ID)) {
    warnings.push({
      path: `finishedGoods/${TEMPORARY_PROTEIN_CODE}`,
      reason: 'Temporary duplicate remains assigned to Golden I. Do not delete or deactivate until historical references are reviewed.',
      proposedAction: 'Prepare a separate retirement/deactivation review after the authoritative product is restored.',
    });
  }

  if (legacyProtein.data.isActive === true) {
    warnings.push({
      path: `menuItems/${LEGACY_PROTEIN_CODE}`,
      reason: 'Legacy typo-coded menu item exists outside Finished Goods V2 and is not assigned to stores.',
      proposedAction: 'Keep unchanged in this batch; do not revive legacy menuItems for POS.',
    });
  }

  const mezzeCategoryPatch = {};
  if (mezze.data.posCategoryCode !== MEZZE_CATEGORY.code) {
    mezzeCategoryPatch.posCategoryCode = MEZZE_CATEGORY.code;
  }
  if (mezze.data.posCategoryName !== MEZZE_CATEGORY.name) {
    mezzeCategoryPatch.posCategoryName = MEZZE_CATEGORY.name;
  }
  if (Object.keys(mezzeCategoryPatch).length > 0) {
    operations.push({
      type: 'update',
      path: `finishedGoods/${MEZZE_CODE}`,
      reason: 'Synchronize Mediterranean Mezze Platter to the approved Food category.',
      before: {
        posCategoryCode: mezze.data.posCategoryCode || null,
        posCategoryName: mezze.data.posCategoryName || null,
      },
      after: mezzeCategoryPatch,
    });
  }

  const snapshotUpdates = {};
  const snapshotProtein = menuItem(goldenSnapshot, AUTHORITATIVE_PROTEIN_CODE);
  if (!snapshotProtein) {
    snapshotUpdates[`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`] = {
      source: `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
      action: 'add after Finished Good store assignment is approved',
    };
    snapshotUpdates[`items.${AUTHORITATIVE_PROTEIN_CODE}`] = {
      available: true,
      publicStatus: 'AVAILABLE',
      publicMessage: 'Available',
    };
  }

  const snapshotMezze = menuItem(goldenSnapshot, MEZZE_CODE);
  if (snapshotMezze && (
    snapshotMezze.posCategoryCode !== MEZZE_CATEGORY.code
    || snapshotMezze.posCategoryName !== MEZZE_CATEGORY.name
  )) {
    snapshotUpdates[`menuItems.${MEZZE_CODE}.posCategoryCode`] = MEZZE_CATEGORY.code;
    snapshotUpdates[`menuItems.${MEZZE_CODE}.posCategoryName`] = MEZZE_CATEGORY.name;
  }

  if (Object.keys(snapshotUpdates).length > 0) {
    operations.push({
      type: 'update',
      path: `publicMenuAvailability/${GOLDEN_I_STORE_ID}`,
      reason: 'Refresh Golden I public menu snapshot for the approved product/category corrections only.',
      before: {
        [`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`]: clone(snapshotProtein),
        [`menuItems.${MEZZE_CODE}.posCategoryCode`]: snapshotMezze?.posCategoryCode || null,
        [`menuItems.${MEZZE_CODE}.posCategoryName`]: snapshotMezze?.posCategoryName || null,
      },
      after: snapshotUpdates,
    });
  }

  return {
    status: operations.length > 0 ? 'READY_FOR_OWNER_APPROVAL' : 'NO_CHANGES_REQUIRED',
    targetStore: GOLDEN_I_STORE_ID,
    operations,
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
    },
  };
}

async function main() {
  const [finishedGoods, menuItems, publicMenuAvailability] = await Promise.all([
    readFirestoreCollection('finishedGoods'),
    readFirestoreCollection('menuItems'),
    readFirestoreCollection('publicMenuAvailability'),
  ]);
  const plan = buildPosMenuCorrectnessPlan({ finishedGoods, menuItems, publicMenuAvailability });
  const outputDir = path.join(process.cwd(), 'reports', 'pos-menu-correctness');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'batch-1-dry-run.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`Dry-run only. Wrote ${outputPath}`);
  console.log(JSON.stringify({
    status: plan.status,
    operationCount: plan.operations.length,
    warningCount: plan.warnings.length,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
