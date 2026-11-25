import fs from 'node:fs';
import path from 'node:path';
import { readFirestoreCollection } from './firestore-read-only.mjs';
import {
  approvalMaps,
  loadApprovalManifest,
  validateApprovalSources,
} from './addon-product-reconciliation.mjs';
import { buildPhase1Plan } from './addon-group-phase-1.mjs';
import {
  BEVERAGE_ADD_ON_GROUP_ID,
  BEVERAGE_ADD_ON_OPTIONS,
  FOOD_ADD_ON_GROUP_ID,
  FOOD_ADD_ON_OPTIONS,
  buildAddonAssignment,
  buildProposedAddOnGroupDocuments,
  classifyProduct,
  isBeverageExcludedCategory,
  isRetailCoffeeExempt,
  normalizeLabel,
} from './addon-group-mapping-helpers.mjs';

const EXPECTED = {
  foodOptions: 15,
  beverageOptions: 12,
  foodProducts: 35,
  beverageProducts: 30,
  excludedProducts: 23,
};
const APPROVED_FINISHED_GOOD_CODE_ALIASES = new Map([
  ['FRUIT_SALAD_AND_GRANOLA_WITH_YOGURT', 'FRUIT_SALAD_GRANOLA_YOGURT'],
  ['PAN_CAKES', 'PANCAKES'],
  ['POTATO_AND_ONION_JAFFLE', 'POTATO_ONION_ZAFFLE'],
  ['SHROOM_JAFFLE', 'SHROOM_ZAFFLE'],
]);
const reportsDir = path.join(process.cwd(), 'reports');
const jsonPath = path.join(reportsDir, 'addon-group-deployment-dry-run.json');
const csvPath = path.join(reportsDir, 'addon-group-deployment-dry-run.csv');
const phase1ManifestPath = path.join(reportsDir, 'addon-group-phase-1-deployment-manifest.json');

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function categoryName(product) {
  return String(
    product.posCategoryName
    || product.categoryName
    || product.category
    || product.menuType
    || product.productDepartment
    || product.department
    || product.posSubcategoryName
    || '',
  ).trim() || 'Unknown';
}

function csv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function inventoryStatus(option) {
  return option.inventoryItemType
    && option.inventoryItemCode
    && Number(option.consumptionQuantity) > 0
    && option.consumptionUnit
    ? 'CONFIGURED'
    : 'NOT_CONFIGURED';
}

async function main() {
  if (process.argv.includes('--apply')) {
    throw new Error('This command is a zero-write dry run. --apply is intentionally unsupported.');
  }
  const [menuDocs, finishedDocs, existingGroupDocs] = await Promise.all([
    readFirestoreCollection('menuItems'),
    readFirestoreCollection('finishedGoods'),
    readFirestoreCollection('addOnGroups'),
  ]);
  const approvalManifest = loadApprovalManifest();
  validateApprovalSources(approvalManifest, menuDocs, finishedDocs);
  const { byDocumentId: approvalsByDocumentId } = approvalMaps(approvalManifest);
  const activeMenuProducts = menuDocs
    .map(document => ({ id: document.id, ...document.data }))
    .filter(product => product.isActive !== false);
  const finishedByCode = new Map(
    finishedDocs.map(document => {
      const data = { id: document.id, ...document.data };
      return [String(data.code || document.id).trim(), data];
    }),
  );
  const finishedById = new Map(
    finishedDocs.map(document => [document.id, { id: document.id, ...document.data }]),
  );
  const finishedByNormalizedName = new Map();
  for (const finished of finishedByCode.values()) {
    const normalizedName = normalizeLabel(finished.name || finished.displayName);
    if (!normalizedName) continue;
    const matches = finishedByNormalizedName.get(normalizedName) || [];
    matches.push(finished);
    finishedByNormalizedName.set(normalizedName, matches);
  }
  const proposedGroups = buildProposedAddOnGroupDocuments();
  const existingGroups = new Map(existingGroupDocs.map(document => [document.id, document.data]));
  const rows = [];

  let foodMapped = 0;
  let beverageMapped = 0;
  let excluded = 0;
  let legacyExcluded = 0;
  let foodAssigned = 0;
  let beverageAssigned = 0;
  for (const product of activeMenuProducts) {
    const category = categoryName(product);
    const classification = classifyProduct(product, category);
    const retail = isRetailCoffeeExempt(product, category);
    const targetGroupId = classification === 'FOOD'
      ? FOOD_ADD_ON_GROUP_ID
      : classification === 'BEVERAGE'
        ? BEVERAGE_ADD_ON_GROUP_ID
        : null;
    const mapping = buildAddonAssignment(product, targetGroupId, classification, category);
    let proposedIds = uniqueStrings(mapping.proposedAddOnGroupIds);
    let reason = mapping.reason;
    const approval = approvalsByDocumentId.get(product.id) || null;
    if (retail) {
      proposedIds = uniqueStrings(product.addOnGroupIds).filter(id => ![FOOD_ADD_ON_GROUP_ID, BEVERAGE_ADD_ON_GROUP_ID].includes(id));
      reason = 'Approved Retail Coffee exemption.';
    } else if (classification === 'FOOD') {
      foodMapped += 1;
    } else if (classification === 'BEVERAGE' && isBeverageExcludedCategory(category)) {
      excluded += 1;
    } else if (classification === 'BEVERAGE') {
      beverageMapped += 1;
    }
    if (approval?.approvedAction === 'EXCLUDE_LEGACY') {
      proposedIds = uniqueStrings(product.addOnGroupIds)
        .filter(id => ![FOOD_ADD_ON_GROUP_ID, BEVERAGE_ADD_ON_GROUP_ID].includes(id));
      reason = approval.exclusionReason;
      legacyExcluded += 1;
    }
    if (proposedIds.includes(FOOD_ADD_ON_GROUP_ID)) foodAssigned += 1;
    if (proposedIds.includes(BEVERAGE_ADD_ON_GROUP_ID)) beverageAssigned += 1;
    const codeMatch = finishedByCode.get(String(product.code || '').trim());
    const approvedTargetCode = APPROVED_FINISHED_GOOD_CODE_ALIASES.get(String(product.code || '').trim());
    const approvedCodeMatch = approvedTargetCode ? finishedByCode.get(approvedTargetCode) : null;
    const nameMatches = finishedByNormalizedName.get(normalizeLabel(product.name)) || [];
    const ownerApprovedTarget = approval?.approvedAction === 'MAP_EXISTING_FINISHED_GOOD'
      ? finishedById.get(approval.approvedFinishedGoodDocumentId)
      : null;
    const ownerDedicatedTarget = approval?.approvedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD'
      ? finishedByCode.get(approval.approvedFinishedGoodCode)
      : null;
    const finished = approval?.approvedAction === 'EXCLUDE_LEGACY'
      ? null
      : ownerApprovedTarget
        || ownerDedicatedTarget
        || codeMatch
        || approvedCodeMatch
        || (nameMatches.length === 1 ? nameMatches[0] : null);
    const targetResolution = approval?.approvedAction === 'EXCLUDE_LEGACY'
      ? 'OWNER_EXCLUDED_LEGACY'
      : ownerApprovedTarget
        ? 'OWNER_APPROVED_MAPPING'
        : ownerDedicatedTarget
          ? 'OWNER_DEDICATED_FINISHED_GOOD'
      : codeMatch
      ? 'EXACT_CODE'
      : approvedCodeMatch
        ? 'APPROVED_PHASE_11A_PRODUCT_MAPPING'
      : finished
        ? 'EXACT_NORMALIZED_NAME'
        : 'NONE';
    const noTargetNeedsNoWrite = !finished && proposedIds.length === 0;
    const dedicatedTargetMissing = approval?.approvedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD'
      && !finished;
    rows.push({
      sourcePath: `menuItems/${product.id}`,
      targetPath: finished ? `finishedGoods/${finished.id}` : null,
      productCode: product.code,
      productName: product.name,
      category,
      classification,
      existingAddOnGroupIds: uniqueStrings(finished?.addOnGroupIds),
      proposedAddOnGroupIds: proposedIds,
      targetResolution,
      ownerApprovedAction: approval?.approvedAction || null,
      ownerApprovedAt: approval?.approvedAt || null,
      ownerApprovalNote: approval?.ownerApprovalNote || null,
      action: noTargetNeedsNoWrite
        ? approval?.approvedAction === 'EXCLUDE_LEGACY'
          ? 'EXCLUDE_LEGACY'
          : 'SKIP_NO_TARGET_NO_ADD_ON'
        : dedicatedTargetMissing
        ? 'DEFERRED_MISSING_FINISHED_GOOD_DATA'
        : !finished
        ? 'BLOCKED_UNRESOLVED_FINISHED_GOOD'
        : JSON.stringify(uniqueStrings(finished.addOnGroupIds)) === JSON.stringify(proposedIds)
          ? 'KEEP'
          : 'UPDATE',
      reason,
    });
  }

  const inventoryAudit = Object.values(proposedGroups).flatMap(group => group.options.map(option => ({
    groupId: group.id,
    groupName: group.name,
    optionId: option.id,
    optionName: option.name,
    sellingPrice: option.price,
    active: option.isActive,
    productCount: rows.filter(row => row.proposedAddOnGroupIds.includes(group.id)).length,
    inventoryMappingStatus: inventoryStatus(option),
    inventoryItemType: option.inventoryItemType || null,
    inventoryItemCode: option.inventoryItemCode || null,
    consumptionQuantity: option.consumptionQuantity || null,
    consumptionUnit: option.consumptionUnit || null,
    readinessResult: inventoryStatus(option) === 'CONFIGURED' ? 'READY_FOR_INVENTORY' : 'PRICING_ONLY',
  })));
  const blockers = [];
  if (FOOD_ADD_ON_OPTIONS.length !== EXPECTED.foodOptions) blockers.push(`Expected ${EXPECTED.foodOptions} Food options.`);
  if (BEVERAGE_ADD_ON_OPTIONS.length !== EXPECTED.beverageOptions) blockers.push(`Expected ${EXPECTED.beverageOptions} Beverage options.`);
  if (foodMapped !== EXPECTED.foodProducts) blockers.push(`Expected ${EXPECTED.foodProducts} mapped food products; found ${foodMapped}.`);
  if (beverageMapped !== EXPECTED.beverageProducts) blockers.push(`Expected ${EXPECTED.beverageProducts} mapped beverage products; found ${beverageMapped}.`);
  if (excluded !== EXPECTED.excludedProducts) blockers.push(`Expected ${EXPECTED.excludedProducts} excluded products; found ${excluded}.`);
  const missingPrices = inventoryAudit.filter(option => !(Number(option.sellingPrice) >= 0));
  const duplicateOptionIds = Object.values(proposedGroups).flatMap(group => {
    const seen = new Set();
    return group.options.filter(option => seen.has(option.id) || !seen.add(option.id)).map(option => `${group.id}:${option.id}`);
  });
  const invalidSelectionRules = Object.values(proposedGroups).filter(group => (
    Number(group.minimumSelections) < 0
    || (group.maximumSelections !== undefined && group.maximumSelections !== null && Number(group.maximumSelections) < Number(group.minimumSelections))
  ));
  const missingFinishedGoods = rows.filter(row => !row.targetPath && row.proposedAddOnGroupIds.length > 0);
  const dedicatedFinishedGoods = rows.filter(row => row.ownerApprovedAction === 'REQUIRE_DEDICATED_FINISHED_GOOD');
  const unresolvedOwnerDecisions = rows.filter(row => (
    !row.targetPath
    && row.proposedAddOnGroupIds.length > 0
    && !row.ownerApprovedAction
  ));
  const skippedMissingFinishedGoods = rows.filter(row => !row.targetPath && row.proposedAddOnGroupIds.length === 0);
  if (missingFinishedGoods.length) blockers.push(`${missingFinishedGoods.length} owner-approved dedicated Finished Goods still require operational data and creation.`);
  if (unresolvedOwnerDecisions.length) blockers.push(`${unresolvedOwnerDecisions.length} eligible products still require an owner reconciliation decision.`);
  if (missingPrices.length) blockers.push(`${missingPrices.length} options have missing prices.`);
  if (duplicateOptionIds.length) blockers.push(`${duplicateOptionIds.length} duplicate option IDs found.`);
  if (invalidSelectionRules.length) blockers.push(`${invalidSelectionRules.length} invalid selection rules found.`);

  const summary = {
    zeroWritesPerformed: true,
    groupCreatesOrUpdates: Object.keys(proposedGroups).map(id => ({
      path: `addOnGroups/${id}`,
      action: existingGroups.has(id) ? 'UPDATE' : 'CREATE',
    })),
    productCollection: 'finishedGoods',
    productMappingField: 'addOnGroupIds',
    foodOptionCount: FOOD_ADD_ON_OPTIONS.length,
    beverageOptionCount: BEVERAGE_ADD_ON_OPTIONS.length,
    mappedFoodProductCount: foodMapped,
    mappedBeverageProductCount: beverageMapped,
    foodProductsAssignedToGroup: foodAssigned,
    beverageProductsAssignedToGroup: beverageAssigned,
    excludedProductCount: excluded,
    legacyExcludedProductCount: legacyExcluded,
    ownerApprovalManifestVersion: approvalManifest.manifestVersion,
    ownerApprovalManifestTimestamp: approvalManifest.ownerApprovedAt,
    ownerApprovalEntryCount: approvalManifest.entries.length,
    ownerApprovedExistingMappingCount: rows.filter(row => row.targetResolution === 'OWNER_APPROVED_MAPPING').length,
    ownerDedicatedFinishedGoodCount: dedicatedFinishedGoods.length,
    ownerDedicatedFinishedGoodsReadyCount: dedicatedFinishedGoods.filter(row => row.targetPath).length,
    ownerDedicatedFinishedGoodsBlockedCount: dedicatedFinishedGoods.filter(row => !row.targetPath).length,
    unresolvedOwnerDecisionCount: unresolvedOwnerDecisions.length,
    unresolvedOwnerDecisionCodes: unresolvedOwnerDecisions.map(row => row.productCode),
    retailCoffee: rows.find(row => row.productCode === 'HOUSE_BLEND_BEANS_250G') || null,
    missingPrices,
    duplicateOptionIds,
    invalidSelectionRules: invalidSelectionRules.map(group => group.id),
    missingFinishedGoodCodes: missingFinishedGoods.map(row => row.productCode),
    skippedMissingFinishedGoodCodes: skippedMissingFinishedGoods.map(row => row.productCode),
    exactNameResolutionCount: rows.filter(row => row.targetResolution === 'EXACT_NORMALIZED_NAME').length,
    approvedProductMappingResolutionCount: rows.filter(row => row.targetResolution === 'APPROVED_PHASE_11A_PRODUCT_MAPPING').length,
    ownerApprovedMappingResolutionCount: rows.filter(row => row.targetResolution === 'OWNER_APPROVED_MAPPING').length,
    inventoryConfiguredOptionCount: inventoryAudit.filter(option => option.inventoryMappingStatus === 'CONFIGURED').length,
    inventoryNotConfiguredOptionCount: inventoryAudit.filter(option => option.inventoryMappingStatus === 'NOT_CONFIGURED').length,
    fuzzyProductMatchingUsed: false,
    blockers,
    fullDeploymentApplyReadiness: blockers.length === 0 ? 'READY' : 'BLOCKED',
  };

  const report = { summary, proposedGroups, productUpdates: rows, inventoryAudit };
  const phase1Plan = buildPhase1Plan({ report, approvalManifest });
  summary.phase1ApplyReadiness = phase1Plan.applyReadiness;
  summary.phase1Blockers = phase1Plan.phase1Blockers;
  summary.phase1SourceProductAssignmentCount = phase1Plan.counts.sourceProductAssignments;
  summary.phase1UniqueFinishedGoodDocumentCount = phase1Plan.counts.uniqueFinishedGoodDocuments;
  summary.phase1FinishedGoodUpdateCount = phase1Plan.counts.finishedGoodDocumentsToUpdate;
  summary.phase1DuplicateSourceAssignmentsConsolidated = phase1Plan.counts.duplicateSourceAssignmentsConsolidated;
  summary.phase1DeferredProductCount = phase1Plan.counts.deferredProducts;
  summary.phase1FirestoreWriteCount = phase1Plan.counts.firstApplyFirestoreWrites;
  summary.phase1DryRunChecksum = phase1Plan.dryRunChecksum;
  summary.applyReadiness = phase1Plan.applyReadiness;

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(phase1ManifestPath, `${JSON.stringify(phase1Plan, null, 2)}\n`);
  fs.writeFileSync(csvPath, [
    'sourcePath,targetPath,targetResolution,productCode,productName,category,classification,existingAddOnGroupIds,proposedAddOnGroupIds,ownerApprovedAction,ownerApprovedAt,action,reason',
    ...rows.map(row => [
      row.sourcePath,
      row.targetPath,
      row.targetResolution,
      row.productCode,
      row.productName,
      row.category,
      row.classification,
      JSON.stringify(row.existingAddOnGroupIds),
      JSON.stringify(row.proposedAddOnGroupIds),
      row.ownerApprovedAction,
      row.ownerApprovedAt,
      row.action,
      row.reason,
    ].map(csv).join(',')),
  ].join('\n'));
  console.log(JSON.stringify({
    summary,
    phase1Manifest: {
      path: phase1ManifestPath,
      deploymentId: phase1Plan.deploymentId,
      dryRunChecksum: phase1Plan.dryRunChecksum,
      counts: phase1Plan.counts,
    },
    reports: { jsonPath, csvPath },
  }, null, 2));
}

main().catch(error => {
  console.error('addon-group-deployment-dry-run-failed', error);
  process.exitCode = 1;
});
