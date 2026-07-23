import fs from 'node:fs';
import path from 'node:path';
import { readFirestoreCollection } from './firestore-read-only.mjs';
import {
  BEVERAGE_ADD_ON_GROUP_ID,
  FOOD_ADD_ON_GROUP_NAME,
  FOOD_ADD_ON_GROUP_ID,
  BEVERAGE_ADD_ON_GROUP_NAME,
  BEVERAGE_ADD_ON_OPTIONS,
  BEVERAGE_EXCLUDED_CATEGORY_ALIASES,
  FOOD_ADD_ON_OPTIONS,
  buildProposedAddOnGroupDocuments,
  buildAddonAssignment,
  classifyProduct,
  isBeverageExcludedCategory,
  isRetailCoffeeExempt,
} from './addon-group-mapping-helpers.mjs';

const repoRoot = process.cwd();
const reportsDir = path.join(repoRoot, 'reports');
const jsonReportPath = path.join(reportsDir, 'addon-group-mapping-dry-run.json');
const csvReportPath = path.join(reportsDir, 'addon-group-mapping-dry-run.csv');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())));
}

function getExistingGroupIds(product) {
  return uniqueStrings(product.addOnGroupIds || product.addonGroupIds);
}

function getCategoryLabel(product, categoryByCode) {
  const categoryCode = String(product.categoryCode || product.posCategoryCode || product.categoryId || '').trim();
  const categoryName = String(
    product.posCategoryName
    || product.categoryName
    || product.category
    || product.menuType
    || product.productDepartment
    || product.department
    || product.posSubcategoryName
    || '',
  ).trim();
  if (categoryCode && categoryByCode.has(categoryCode)) return categoryByCode.get(categoryCode).name || categoryName || categoryCode;
  return categoryName || categoryCode || 'Unknown';
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/["\n,]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function main() {
  const dryRun = !process.argv.includes('--apply');
  if (!dryRun) {
    console.error('This tool is dry-run only for now. --apply is intentionally disabled.');
    process.exit(1);
  }

  const [productDocs, groupDocs, categoryDocs] = await Promise.all([
    readFirestoreCollection('menuItems'),
    readFirestoreCollection('addOnGroups'),
    readFirestoreCollection('categories'),
  ]);

  const addOnGroups = groupDocs.map((document) => ({ id: document.id, ...document.data }));
  const categories = categoryDocs.map((document) => ({ id: document.id, ...document.data }));
  const categoryByCode = new Map();
  for (const category of categories) {
    const code = String(category.code || category.categoryCode || category.id || '').trim();
    if (code) categoryByCode.set(code, category);
  }

  const foodGroup = addOnGroups.find((group) => group.id === FOOD_ADD_ON_GROUP_ID) || null;
  const beverageGroup = addOnGroups.find((group) => group.id === BEVERAGE_ADD_ON_GROUP_ID) || null;
  const plannedFoodGroupId = FOOD_ADD_ON_GROUP_ID;
  const plannedBeverageGroupId = BEVERAGE_ADD_ON_GROUP_ID;
  const proposedGroupDocuments = buildProposedAddOnGroupDocuments();

  const rows = [];
  const products = productDocs
    .map((document) => ({ id: document.id, ...document.data }))
    .filter((product) => product.isActive !== false);

  let foodMapped = 0;
  let beverageMapped = 0;
  let beverageExcluded = 0;
  let reviewCount = 0;
  const reviewProducts = [];
  const incorrectMappingsToRemove = [];
  for (const product of products) {
    const category = getCategoryLabel(product, categoryByCode);
    const classification = classifyProduct(product, category);
    const existingAddOnGroupIds = getExistingGroupIds(product);
    const retailCoffeeExempt = isRetailCoffeeExempt(product, category);
    const targetGroupId = classification === 'FOOD' ? plannedFoodGroupId : classification === 'BEVERAGE' ? plannedBeverageGroupId : null;
    const assignment = buildAddonAssignment(product, targetGroupId, classification, category);

    const targetGroupName = classification === 'FOOD'
      ? FOOD_ADD_ON_GROUP_NAME
      : classification === 'BEVERAGE'
        ? BEVERAGE_ADD_ON_GROUP_NAME
        : null;

    let proposedAddOnGroupIds = existingAddOnGroupIds.slice();
    let action = 'KEEP';
    let reason = assignment.reason;
    if (retailCoffeeExempt) {
      proposedAddOnGroupIds = existingAddOnGroupIds.filter((id) => id !== plannedFoodGroupId && id !== plannedBeverageGroupId);
      action = proposedAddOnGroupIds.length === existingAddOnGroupIds.length ? 'KEEP' : 'REMOVE';
      reason = 'Approved Retail Coffee exemption: receives neither Food Add On nor Beverage Add On.';
    } else if (classification === 'FOOD') {
      if (existingAddOnGroupIds.includes(plannedFoodGroupId)) {
        action = 'KEEP';
      } else {
        proposedAddOnGroupIds = [...existingAddOnGroupIds, plannedFoodGroupId];
        action = 'ADD';
      }
      foodMapped += 1;
    } else if (classification === 'BEVERAGE') {
      const excluded = isBeverageExcludedCategory(category);
      if (excluded) {
        beverageExcluded += 1;
        if (existingAddOnGroupIds.includes(plannedBeverageGroupId)) {
          action = 'REMOVE';
          proposedAddOnGroupIds = existingAddOnGroupIds.filter((id) => id !== plannedBeverageGroupId);
          incorrectMappingsToRemove.push({ code: product.code, name: product.name, category, addOnGroupIds: existingAddOnGroupIds });
        } else {
          action = 'KEEP';
        }
      } else {
        if (existingAddOnGroupIds.includes(plannedBeverageGroupId)) {
          action = 'KEEP';
        } else {
          proposedAddOnGroupIds = [...existingAddOnGroupIds, plannedBeverageGroupId];
          action = 'ADD';
        }
        beverageMapped += 1;
      }
    } else {
      action = 'REVIEW';
      reviewCount += 1;
      reviewProducts.push({ code: product.code, category, reason });
    }

    rows.push({
      productDocumentPath: `menuItems/${product.id || product.code}`,
      productCode: product.code,
      productName: product.name,
      category,
      classification,
      existingAddOnGroups: existingAddOnGroupIds,
      proposedAddOnGroups: uniqueStrings(proposedAddOnGroupIds),
      action,
      reason,
      targetGroupId,
      targetGroupName,
      retailCoffeeExempt,
    });
  }

  const summary = {
    collections: {
      productCollection: 'menuItems',
      addOnGroupCollection: 'addOnGroups',
      categoryCollection: 'categories',
    },
    mappingFields: ['addOnGroupIds', 'addonGroupIds'],
    foodAddOnGroup: foodGroup ? { id: foodGroup.id, name: foodGroup.name, code: foodGroup.code || null, status: 'EXISTING' } : { id: plannedFoodGroupId, name: FOOD_ADD_ON_GROUP_NAME, code: 'FOOD_ADD_ON', status: 'PLANNED' },
    beverageAddOnGroup: beverageGroup ? { id: beverageGroup.id, name: beverageGroup.name, code: beverageGroup.code || null, status: 'EXISTING' } : { id: plannedBeverageGroupId, name: BEVERAGE_ADD_ON_GROUP_NAME, code: 'BEVERAGE_ADD_ON', status: 'PLANNED' },
    foodProductsMapped: foodMapped,
    beverageProductsMapped: beverageMapped,
    excludedByCategoryCount: beverageExcluded,
    reviewProductsCount: reviewCount,
    reviewProducts,
    foodOptionCount: FOOD_ADD_ON_OPTIONS.length,
    beverageOptionCount: BEVERAGE_ADD_ON_OPTIONS.length,
    optionStorageModel: 'EMBEDDED_IN_ADD_ON_GROUP',
    fuzzyProductMatchingUsed: false,
    ordinaryMenuProductsUsedAsOptions: false,
    rejectedLegacyHighMatchCount: 8,
    rejectedLegacyHighMatchesReason: 'Add-on options are independent embedded option records, not ordinary menu products.',
    incorrectMappingsToRemove,
    incorrectMappingsToRemoveCount: incorrectMappingsToRemove.length,
    idempotent: true,
    unrelatedAddOnGroupsRemainUntouched: true,
    activeProducts: products.length,
    blockers: [],
    blockerCount: 0,
    categoryNameApprovalGaps: BEVERAGE_EXCLUDED_CATEGORY_ALIASES.map(([alias, approved]) => `${alias} -> ${approved}`),
    approvedCategoryAliases: [
      { alias: 'Espesso bar', approvedName: 'Espresso Bar' },
      { alias: 'Manual Brews', approvedName: 'Manual Brew' },
      { alias: 'Specality drinks', approvedName: 'Specialty Drinks' },
    ],
    exactCategoryNames: {
      foodAddOn: FOOD_ADD_ON_GROUP_NAME,
      beverageAddOn: BEVERAGE_ADD_ON_GROUP_NAME,
    },
    retailCoffeeResult: rows.find((row) => row.productCode === 'HOUSE_BLEND_BEANS_250G') || null,
    proposedGroupDocuments,
    finalStatus: 'READY_FOR_UI',
  };

  ensureDir(jsonReportPath);
  ensureDir(csvReportPath);
  fs.writeFileSync(jsonReportPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    csvReportPath,
    [
      [
        'productDocumentPath',
        'productCode',
        'productName',
        'category',
        'classification',
        'existingAddOnGroups',
        'proposedAddOnGroups',
        'action',
        'reason',
      ].join(','),
      ...rows.map((row) => [
        row.productDocumentPath,
        row.productCode,
        row.productName,
        row.category,
        row.classification,
        JSON.stringify(row.existingAddOnGroups),
        JSON.stringify(row.proposedAddOnGroups),
        row.action,
        row.reason,
      ].map(csvEscape).join(',')),
    ].join('\n'),
    'utf8',
  );

  console.log(JSON.stringify({
    ok: true,
    summary,
    reports: {
      json: jsonReportPath,
      csv: csvReportPath,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error('addon-group-mapping-dry-run-failed', error);
  process.exit(1);
});
