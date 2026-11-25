import crypto from 'node:crypto';

export const PHASE_1_PROJECT_ID = 'coffee-bond-pos';
export const PHASE_1_NAME = 'FOOD_BEVERAGE_ADD_ONS_PHASE_1';
export const PHASE_1_CONFIRMATION_FLAG = '--confirm-phase-1';
export const EXPECTED_PHASE_1_SOURCE_ASSIGNMENTS = 54;
export const EXPECTED_PHASE_1_DEFERRED_PRODUCTS = 10;
export const EXPECTED_PHASE_1_LEGACY_EXCLUSIONS = 1;

const PLANNED_GROUP_IDS = new Set(['food_add_on', 'beverage_add_on']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sameStrings(left, right) {
  return stableStringify(left || []) === stableStringify(right || []);
}

function hasPlannedGroup(row) {
  return (row.proposedAddOnGroupIds || []).some((groupId) => PLANNED_GROUP_IDS.has(groupId));
}

function buildDocumentUpdates(assignments) {
  const byTarget = new Map();
  const conflicts = [];

  assignments.forEach((assignment) => {
    const current = byTarget.get(assignment.targetPath);
    if (!current) {
      byTarget.set(assignment.targetPath, {
        targetPath: assignment.targetPath,
        targetDocumentId: assignment.targetPath.split('/').pop(),
        beforeAddOnGroupIds: assignment.existingAddOnGroupIds,
        afterAddOnGroupIds: assignment.proposedAddOnGroupIds,
        sourceAssignments: [{
          sourcePath: assignment.sourcePath,
          productCode: assignment.productCode,
          productName: assignment.productName,
          classification: assignment.classification,
          targetResolution: assignment.targetResolution,
        }],
      });
      return;
    }

    if (
      !sameStrings(current.beforeAddOnGroupIds, assignment.existingAddOnGroupIds)
      || !sameStrings(current.afterAddOnGroupIds, assignment.proposedAddOnGroupIds)
    ) {
      conflicts.push({
        targetPath: assignment.targetPath,
        existingPlan: current,
        conflictingAssignment: assignment,
      });
      return;
    }

    current.sourceAssignments.push({
      sourcePath: assignment.sourcePath,
      productCode: assignment.productCode,
      productName: assignment.productName,
      classification: assignment.classification,
      targetResolution: assignment.targetResolution,
    });
  });

  const documents = [...byTarget.values()]
    .map((document) => ({
      ...document,
      action: sameStrings(document.beforeAddOnGroupIds, document.afterAddOnGroupIds)
        ? 'KEEP'
        : 'UPDATE',
    }))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));

  return { documents, conflicts };
}

export function buildPhase1Plan({ report, approvalManifest }) {
  const assignments = report.productUpdates
    .filter((row) => row.targetPath && hasPlannedGroup(row))
    .map((row) => ({
      sourcePath: row.sourcePath,
      targetPath: row.targetPath,
      productCode: row.productCode,
      productName: row.productName,
      classification: row.classification,
      targetResolution: row.targetResolution,
      existingAddOnGroupIds: row.existingAddOnGroupIds || [],
      proposedAddOnGroupIds: row.proposedAddOnGroupIds || [],
      ownerApprovedAction: row.ownerApprovedAction,
      ownerApprovedAt: row.ownerApprovedAt,
    }))
    .sort((left, right) => (
      left.targetPath.localeCompare(right.targetPath)
      || left.sourcePath.localeCompare(right.sourcePath)
    ));

  const deferredProducts = report.productUpdates
    .filter((row) => row.action === 'DEFERRED_MISSING_FINISHED_GOOD_DATA')
    .map((row) => ({
      sourcePath: row.sourcePath,
      productCode: row.productCode,
      productName: row.productName,
      classification: row.classification,
      status: 'DEFERRED_MISSING_FINISHED_GOOD_DATA',
      currentAddOnGroupIds: row.existingAddOnGroupIds || [],
      phase1AddOnGroupIds: [],
      proposedPhase2AddOnGroupIds: row.proposedAddOnGroupIds || [],
      ownerApprovalNote: row.ownerApprovalNote,
    }))
    .sort((left, right) => left.productCode.localeCompare(right.productCode));

  const excludedProducts = report.productUpdates
    .filter((row) => (
      row.action === 'EXCLUDE_LEGACY'
      || row.reason === 'Approved Retail Coffee exemption.'
      || (
        row.classification === 'BEVERAGE'
        && !hasPlannedGroup(row)
      )
    ))
    .map((row) => ({
      sourcePath: row.sourcePath,
      targetPath: row.targetPath,
      productCode: row.productCode,
      productName: row.productName,
      category: row.category,
      status: row.action === 'EXCLUDE_LEGACY'
        ? 'EXCLUDED_LEGACY'
        : row.reason === 'Approved Retail Coffee exemption.'
          ? 'EXCLUDED_RETAIL_COFFEE'
          : 'EXCLUDED_BEVERAGE_CATEGORY',
      beforeAddOnGroupIds: row.existingAddOnGroupIds || [],
      afterAddOnGroupIds: row.proposedAddOnGroupIds || [],
      reason: row.reason,
    }))
    .sort((left, right) => left.productCode.localeCompare(right.productCode));

  const unresolvedOutsideDeferrals = report.productUpdates.filter((row) => (
    hasPlannedGroup(row)
    && !row.targetPath
    && row.action !== 'DEFERRED_MISSING_FINISHED_GOOD_DATA'
  ));
  const legacyExclusions = excludedProducts.filter((row) => row.status === 'EXCLUDED_LEGACY');
  const retailCoffee = excludedProducts.find((row) => row.status === 'EXCLUDED_RETAIL_COFFEE');
  const { documents, conflicts } = buildDocumentUpdates(assignments);
  const documentsToUpdate = documents.filter((document) => document.action === 'UPDATE');
  const duplicateSourceAssignments = documents
    .filter((document) => document.sourceAssignments.length > 1)
    .flatMap((document) => document.sourceAssignments.slice(1).map((source) => ({
      targetPath: document.targetPath,
      sourcePath: source.sourcePath,
      productCode: source.productCode,
    })));

  const phase1Blockers = [];
  if (assignments.length !== EXPECTED_PHASE_1_SOURCE_ASSIGNMENTS) {
    phase1Blockers.push(
      `Expected ${EXPECTED_PHASE_1_SOURCE_ASSIGNMENTS} Phase 1 source assignments; found ${assignments.length}.`,
    );
  }
  if (deferredProducts.length !== EXPECTED_PHASE_1_DEFERRED_PRODUCTS) {
    phase1Blockers.push(
      `Expected ${EXPECTED_PHASE_1_DEFERRED_PRODUCTS} deferred products; found ${deferredProducts.length}.`,
    );
  }
  if (legacyExclusions.length !== EXPECTED_PHASE_1_LEGACY_EXCLUSIONS) {
    phase1Blockers.push(
      `Expected ${EXPECTED_PHASE_1_LEGACY_EXCLUSIONS} legacy exclusion; found ${legacyExclusions.length}.`,
    );
  }
  if (!retailCoffee || hasPlannedGroup(retailCoffee)) {
    phase1Blockers.push('Retail Coffee exemption is missing or invalid.');
  }
  if (unresolvedOutsideDeferrals.length > 0) {
    phase1Blockers.push(
      `${unresolvedOutsideDeferrals.length} unresolved mappings exist outside the approved deferrals.`,
    );
  }
  if (conflicts.length > 0) {
    phase1Blockers.push(`${conflicts.length} duplicate Finished Good targets have conflicting plans.`);
  }
  if (report.summary.inventoryConfiguredOptionCount !== 0
    || report.summary.inventoryNotConfiguredOptionCount !== 27) {
    phase1Blockers.push('Expected all 27 Phase 1 add-on options to remain inventory NOT_CONFIGURED.');
  }
  if (report.summary.fuzzyProductMatchingUsed === true) {
    phase1Blockers.push('Fuzzy product matching must remain disabled.');
  }

  const approvalManifestChecksum = sha256(approvalManifest);
  const checksumPayload = {
    schemaVersion: 1,
    projectId: PHASE_1_PROJECT_ID,
    deploymentPhase: PHASE_1_NAME,
    approvalManifestVersion: approvalManifest.manifestVersion,
    approvalManifestChecksum,
    proposedGroups: report.proposedGroups,
    assignedProducts: assignments,
    finishedGoodDocumentPlan: documents,
    deferredProducts,
    excludedProducts,
    inventoryAudit: report.inventoryAudit.map((option) => ({
      groupId: option.groupId,
      optionId: option.optionId,
      inventoryMappingStatus: option.inventoryMappingStatus,
      readinessResult: option.readinessResult,
    })),
  };
  const dryRunChecksum = sha256(checksumPayload);
  const deploymentId = `phase1-${dryRunChecksum.slice(0, 20)}`;
  const firstApplyWriteCount = 2 + documentsToUpdate.length + 1;

  return {
    schemaVersion: 1,
    projectId: PHASE_1_PROJECT_ID,
    deploymentPhase: PHASE_1_NAME,
    deploymentId,
    generatedAt: new Date().toISOString(),
    operatorUid: 'REQUIRED_AT_APPLY',
    appliedAt: 'SERVER_TIMESTAMP_AT_APPLY',
    dryRunChecksum,
    approvalManifestChecksum,
    applyReadiness: phase1Blockers.length === 0 ? 'READY_PHASE_1' : 'BLOCKED',
    phase1Blockers,
    counts: {
      sourceProductAssignments: assignments.length,
      uniqueFinishedGoodDocuments: documents.length,
      finishedGoodDocumentsToUpdate: documentsToUpdate.length,
      duplicateSourceAssignmentsConsolidated: duplicateSourceAssignments.length,
      deferredProducts: deferredProducts.length,
      excludedProducts: excludedProducts.length,
      legacyExclusions: legacyExclusions.length,
      inventoryConfiguredOptions: report.summary.inventoryConfiguredOptionCount,
      inventoryNotConfiguredOptions: report.summary.inventoryNotConfiguredOptionCount,
      firstApplyFirestoreWrites: firstApplyWriteCount,
    },
    groupDocumentPlan: Object.entries(report.proposedGroups)
      .map(([groupId, payload]) => ({
        documentPath: `addOnGroups/${groupId}`,
        action: report.summary.groupCreatesOrUpdates.find((group) => group.path === `addOnGroups/${groupId}`)?.action || 'UPSERT',
        payload,
      }))
      .sort((left, right) => left.documentPath.localeCompare(right.documentPath)),
    assignedProducts: assignments,
    finishedGoodDocumentPlan: documents,
    deferredProducts,
    excludedProducts,
    duplicateSourceAssignments,
    unresolvedOutsideDeferrals: unresolvedOutsideDeferrals.map((row) => ({
      sourcePath: row.sourcePath,
      productCode: row.productCode,
      action: row.action,
    })),
    inventoryLimitation: {
      status: 'PRICING_ONLY',
      inventoryTrackingStatus: 'NOT_CONFIGURED',
      optionCount: report.summary.inventoryNotConfiguredOptionCount,
      checkoutBlocked: false,
      assumedStockMovementsCreated: false,
      note: 'Phase 1 supports pricing, GST, receipts, KOT, and reporting. Add-on stock deduction is deferred.',
    },
    auditDocumentPlan: {
      documentPath: `addOnGroupAudit/${deploymentId}`,
      createOnly: true,
      payloadIncludes: [
        'assignedProducts',
        'deferredProducts',
        'excludedProducts',
        'beforeAndAfterValues',
        'operatorUid',
        'appliedAt',
        'dryRunChecksum',
      ],
    },
    checksumPayload,
  };
}

