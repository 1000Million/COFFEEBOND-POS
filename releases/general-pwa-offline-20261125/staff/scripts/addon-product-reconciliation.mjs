import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_MANIFEST_PATH = path.join(
  process.cwd(),
  'data',
  'imports',
  'addon-product-reconciliation-approvals.json',
);

export const APPROVED_ACTIONS = new Set([
  'MAP_EXISTING_FINISHED_GOOD',
  'REQUIRE_DEDICATED_FINISHED_GOOD',
  'EXCLUDE_LEGACY',
]);
export const PHASE_1_DISPOSITIONS = new Set([
  'ASSIGN_ADD_ON_GROUP',
  'DEFERRED_MISSING_FINISHED_GOOD_DATA',
  'EXCLUDED_LEGACY',
]);

export function loadApprovalManifest() {
  if (!fs.existsSync(APPROVAL_MANIFEST_PATH)) {
    throw new Error(`Missing owner approval manifest: ${APPROVAL_MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(APPROVAL_MANIFEST_PATH, 'utf8'));
  if (manifest.manifestVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('Unsupported add-on product approval manifest.');
  }
  if (
    manifest.phase1?.projectId !== 'coffee-bond-pos'
    || manifest.phase1?.approved !== true
    || manifest.phase1?.expectedSourceAssignments !== 54
    || manifest.phase1?.expectedDeferredProducts !== 10
  ) {
    throw new Error('Phase 1 owner approval metadata is missing or invalid.');
  }
  const documentIds = new Set();
  const productCodes = new Set();
  for (const entry of manifest.entries) {
    if (!entry.menuItemDocumentId || documentIds.has(entry.menuItemDocumentId)) {
      throw new Error(`Invalid or duplicate menuItems document ID: ${entry.menuItemDocumentId || '(missing)'}.`);
    }
    if (!entry.menuProductCode || productCodes.has(entry.menuProductCode)) {
      throw new Error(`Invalid or duplicate menu product code: ${entry.menuProductCode || '(missing)'}.`);
    }
    if (!APPROVED_ACTIONS.has(entry.approvedAction)) {
      throw new Error(`Unsupported approved action for ${entry.menuProductCode}: ${entry.approvedAction}.`);
    }
    if (!PHASE_1_DISPOSITIONS.has(entry.phase1Disposition)) {
      throw new Error(`Unsupported Phase 1 disposition for ${entry.menuProductCode}.`);
    }
    if (
      entry.approvedAction === 'MAP_EXISTING_FINISHED_GOOD'
      && entry.phase1Disposition !== 'ASSIGN_ADD_ON_GROUP'
    ) {
      throw new Error(`Existing mapping ${entry.menuProductCode} is not approved for Phase 1 assignment.`);
    }
    if (
      entry.approvedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD'
      && entry.phase1Disposition !== 'DEFERRED_MISSING_FINISHED_GOOD_DATA'
    ) {
      throw new Error(`Dedicated product ${entry.menuProductCode} is not explicitly deferred.`);
    }
    if (
      entry.approvedAction === 'EXCLUDE_LEGACY'
      && entry.phase1Disposition !== 'EXCLUDED_LEGACY'
    ) {
      throw new Error(`Legacy product ${entry.menuProductCode} is not explicitly excluded.`);
    }
    if (!entry.ownerApprovalNote || !entry.approvedAt) {
      throw new Error(`Missing owner approval audit fields for ${entry.menuProductCode}.`);
    }
    if (
      entry.approvedAction === 'MAP_EXISTING_FINISHED_GOOD'
      && (!entry.approvedFinishedGoodDocumentId || !entry.approvedFinishedGoodCode)
    ) {
      throw new Error(`Approved existing mapping lacks a Finished Good target for ${entry.menuProductCode}.`);
    }
    if (
      entry.approvedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD'
      && !entry.approvedFinishedGoodCode
    ) {
      throw new Error(`Dedicated Finished Good code is missing for ${entry.menuProductCode}.`);
    }
    if (entry.approvedAction === 'EXCLUDE_LEGACY' && !entry.exclusionReason) {
      throw new Error(`Legacy exclusion reason is missing for ${entry.menuProductCode}.`);
    }
    documentIds.add(entry.menuItemDocumentId);
    productCodes.add(entry.menuProductCode);
  }
  return manifest;
}

export function approvalMaps(manifest) {
  return {
    byDocumentId: new Map(manifest.entries.map((entry) => [entry.menuItemDocumentId, entry])),
    byProductCode: new Map(manifest.entries.map((entry) => [entry.menuProductCode, entry])),
  };
}

export function validateApprovalSources(manifest, menuDocuments, finishedDocuments) {
  const menuById = new Map(menuDocuments.map((document) => [document.id, document]));
  const finishedById = new Map(finishedDocuments.map((document) => [document.id, document]));
  for (const entry of manifest.entries) {
    const source = menuById.get(entry.menuItemDocumentId);
    if (!source || source.data.code !== entry.menuProductCode) {
      throw new Error(
        `Approval source mismatch for ${entry.menuProductCode}: expected menuItems/${entry.menuItemDocumentId}.`,
      );
    }
    if (entry.approvedAction === 'MAP_EXISTING_FINISHED_GOOD') {
      const target = finishedById.get(entry.approvedFinishedGoodDocumentId);
      if (
        !target
        || String(target.data.code || target.id).trim() !== entry.approvedFinishedGoodCode
      ) {
        throw new Error(
          `Approved target mismatch for ${entry.menuProductCode}: expected finishedGoods/${entry.approvedFinishedGoodDocumentId} with code ${entry.approvedFinishedGoodCode}.`,
        );
      }
    }
  }
}
