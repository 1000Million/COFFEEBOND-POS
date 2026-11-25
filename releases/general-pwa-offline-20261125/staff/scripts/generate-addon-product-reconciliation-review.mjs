import fs from 'node:fs';
import path from 'node:path';
import { readFirestoreCollection } from './firestore-read-only.mjs';
import {
  loadApprovalManifest,
  validateApprovalSources,
} from './addon-product-reconciliation.mjs';

const repoRoot = process.cwd();
const reportsDir = path.join(repoRoot, 'reports');
const deploymentReportPath = path.join(reportsDir, 'addon-group-deployment-dry-run.json');
const jsonPath = path.join(reportsDir, 'addon-product-reconciliation-review.json');
const csvPath = path.join(reportsDir, 'addon-product-reconciliation-review.csv');
const dedicatedJsonPath = path.join(reportsDir, 'addon-dedicated-finished-goods-review.json');
const dedicatedCsvPath = path.join(reportsDir, 'addon-dedicated-finished-goods-review.csv');

function csv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedicatedMissingFields(source) {
  const data = source.data;
  const missing = [
    'itemType',
    'productionMode',
    'bomOrExplicitNoStockDecision',
    'isSellable',
    'isAvailable',
  ];
  if (!(finiteNumber(data.price) > 0)) missing.push('salePrice');
  if (!data.categoryCode || !data.categoryName) missing.push('posCategoryCode/posCategoryName');
  if (finiteNumber(data.taxRate) === null) missing.push('taxRate');
  if (!data.prepStation) missing.push('prepStation');
  if (!Array.isArray(data.availableStoreIds) || data.availableStoreIds.length === 0) {
    missing.push('availableStoreIds');
  }
  return missing;
}

function buildDedicatedReview(entry, source, finishedByCode) {
  const existingTarget = finishedByCode.get(entry.approvedFinishedGoodCode) || null;
  const sourceBom = Array.isArray(source.data.bom) ? source.data.bom : [];
  const missingFields = existingTarget ? [] : dedicatedMissingFields(source);
  const safeToCreate = !existingTarget && missingFields.length === 0;
  return {
    menuItemDocumentId: source.id,
    menuItemDocumentPath: `menuItems/${source.id}`,
    productCode: source.data.code,
    productName: source.data.name || '',
    currentSellingPrice: finiteNumber(source.data.price),
    category: source.data.categoryName || null,
    categoryCode: source.data.categoryCode || null,
    taxRate: finiteNumber(source.data.taxRate),
    activeStatus: source.data.isActive === true,
    existingBomAvailability: sourceBom.length > 0 ? 'AVAILABLE_ON_MENU_ITEM' : 'NO_VERIFIED_BOM',
    existingBomLineCount: sourceBom.length,
    proposedFinishedGoodCode: entry.approvedFinishedGoodCode,
    proposedFinishedGoodName: source.data.name || entry.approvedFinishedGoodCode,
    existingFinishedGoodPath: existingTarget ? `finishedGoods/${existingTarget.id}` : null,
    requiredMissingFields: missingFields,
    safeToCreateStatus: existingTarget
      ? 'ALREADY_EXISTS_REVIEW_TARGET'
      : safeToCreate
        ? 'SAFE_TO_CREATE'
        : 'BLOCKED_MISSING_FINISHED_GOOD_DATA',
    applyReadyMigrationEntry: safeToCreate ? {
      documentPath: `finishedGoods/${entry.approvedFinishedGoodCode}`,
      verifiedSourcePath: `menuItems/${source.id}`,
      code: entry.approvedFinishedGoodCode,
      name: source.data.name,
      salePrice: finiteNumber(source.data.price),
      posCategoryCode: source.data.categoryCode,
      posCategoryName: source.data.categoryName,
      taxRate: finiteNumber(source.data.taxRate),
      prepStation: source.data.prepStation,
      availableStoreIds: source.data.availableStoreIds,
      isActive: source.data.isActive,
    } : null,
    ownerApprovalNote: entry.ownerApprovalNote,
    approvedAt: entry.approvedAt,
  };
}

async function main() {
  if (!fs.existsSync(deploymentReportPath)) {
    throw new Error('Run npm run dry-run:addon-group-deployment before generating the reconciliation review.');
  }

  const deploymentReport = JSON.parse(fs.readFileSync(deploymentReportPath, 'utf8'));
  const approvalManifest = loadApprovalManifest();
  const [menuDocuments, finishedDocuments] = await Promise.all([
    readFirestoreCollection('menuItems'),
    readFirestoreCollection('finishedGoods'),
  ]);
  validateApprovalSources(approvalManifest, menuDocuments, finishedDocuments);
  const menuById = new Map(menuDocuments.map((document) => [document.id, document]));
  const finishedById = new Map(finishedDocuments.map((document) => [document.id, document]));
  const finishedByCode = new Map(
    finishedDocuments.map((document) => [String(document.data.code || document.id).trim(), document]),
  );

  const rows = approvalManifest.entries.map((entry) => {
    const source = menuById.get(entry.menuItemDocumentId);
    const deploymentRow = deploymentReport.productUpdates.find(
      (row) => row.sourcePath === `menuItems/${entry.menuItemDocumentId}`,
    );
    if (!source || !deploymentRow) {
      throw new Error(`Missing reviewed source or deployment row for ${entry.menuProductCode}.`);
    }
    const target = entry.approvedFinishedGoodDocumentId
      ? finishedById.get(entry.approvedFinishedGoodDocumentId)
      : null;
    return {
      menuItemDocumentId: source.id,
      menuItemDocumentPath: `menuItems/${source.id}`,
      menuProductCode: source.data.code,
      menuProductName: source.data.name || '',
      assignedGroup: deploymentRow.proposedAddOnGroupIds.includes('food_add_on')
        ? 'Food Add On'
        : deploymentRow.proposedAddOnGroupIds.includes('beverage_add_on')
          ? 'Beverage Add On'
          : 'None',
      assignedGroupId: deploymentRow.proposedAddOnGroupIds[0] || null,
      approvedAction: entry.approvedAction,
      approvedFinishedGoodDocumentId: target?.id || entry.approvedFinishedGoodDocumentId,
      approvedFinishedGoodCode: target?.data.code || entry.approvedFinishedGoodCode,
      approvedFinishedGoodName: target?.data.name || target?.data.displayName || null,
      exclusionReason: entry.exclusionReason,
      ownerApprovalNote: entry.ownerApprovalNote,
      approvedAt: entry.approvedAt,
      deploymentStatus: entry.approvedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD'
        && !deploymentRow.targetPath
        ? 'DEFERRED_MISSING_FINISHED_GOOD_DATA'
        : 'APPROVED',
    };
  });

  const dedicatedRows = approvalManifest.entries
    .filter((entry) => entry.approvedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD')
    .map((entry) => buildDedicatedReview(entry, menuById.get(entry.menuItemDocumentId), finishedByCode));
  const safeToCreate = dedicatedRows.filter((row) => row.safeToCreateStatus === 'SAFE_TO_CREATE');
  const blocked = dedicatedRows.filter((row) => row.safeToCreateStatus === 'BLOCKED_MISSING_FINISHED_GOOD_DATA');

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    firestoreWritesPerformed: false,
    ownerApprovalManifestVersion: approvalManifest.manifestVersion,
    ownerApprovalCount: rows.length,
    rows,
  }, null, 2)}\n`);
  fs.writeFileSync(csvPath, [
    'menuItemDocumentId,menuProductCode,menuProductName,assignedGroup,approvedAction,approvedFinishedGoodDocumentId,approvedFinishedGoodCode,approvedFinishedGoodName,exclusionReason,ownerApprovalNote,approvedAt,deploymentStatus',
    ...rows.map((row) => [
      row.menuItemDocumentId,
      row.menuProductCode,
      row.menuProductName,
      row.assignedGroup,
      row.approvedAction,
      row.approvedFinishedGoodDocumentId,
      row.approvedFinishedGoodCode,
      row.approvedFinishedGoodName,
      row.exclusionReason,
      row.ownerApprovalNote,
      row.approvedAt,
      row.deploymentStatus,
    ].map(csv).join(',')),
  ].join('\n'));
  fs.writeFileSync(dedicatedJsonPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    firestoreWritesPerformed: false,
    dedicatedFinishedGoodCount: dedicatedRows.length,
    safeToCreateCount: safeToCreate.length,
    blockedMissingDataCount: blocked.length,
    rows: dedicatedRows,
  }, null, 2)}\n`);
  fs.writeFileSync(dedicatedCsvPath, [
    'menuItemDocumentId,productCode,productName,currentSellingPrice,category,taxRate,activeStatus,existingBomAvailability,proposedFinishedGoodCode,proposedFinishedGoodName,requiredMissingFields,safeToCreateStatus',
    ...dedicatedRows.map((row) => [
      row.menuItemDocumentId,
      row.productCode,
      row.productName,
      row.currentSellingPrice,
      row.category,
      row.taxRate,
      row.activeStatus,
      row.existingBomAvailability,
      row.proposedFinishedGoodCode,
      row.proposedFinishedGoodName,
      row.requiredMissingFields.join('|'),
      row.safeToCreateStatus,
    ].map(csv).join(',')),
  ].join('\n'));

  console.log(JSON.stringify({
    ok: true,
    firestoreWritesPerformed: false,
    ownerApprovalCount: rows.length,
    dedicatedFinishedGoodCount: dedicatedRows.length,
    safeToCreateCount: safeToCreate.length,
    blockedMissingDataCount: blocked.length,
    reports: { jsonPath, csvPath, dedicatedJsonPath, dedicatedCsvPath },
  }, null, 2));
}

main().catch((error) => {
  console.error('addon-product-reconciliation-review-failed', error);
  process.exitCode = 1;
});
