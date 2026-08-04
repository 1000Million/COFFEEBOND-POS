import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { deleteApp, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import {
  customerMenuCategory,
  trustedDietaryClassification,
} from '../frontend/lib/customerMenuPresentation';

const STORE_CODE = 'GOLDEN_I';
const EXPECTED_PROJECT_ID = 'coffee-bond-pos';
const DIETARY_FIELDS = [
  'dietaryClassification',
  'dietaryType',
  'foodType',
  'vegNonVeg',
  'isVegetarian',
  'isVeg',
] as const;

const CATEGORY_REVIEWS: Record<string, string> = {
  BOND_FRAPPE: 'Source category is MIS / Misc. The customer UI now shows Other; owner source-data confirmation is still required.',
  MEDITERRANEAN_MEZZE_PLATTER: 'Source category is ESP / Espresso Bar. The customer UI therefore shows Coffee; owner source-data correction is required.',
};

type PublicMenuItem = Record<string, unknown> & {
  id?: string;
  code?: string;
  name?: string;
  displayName?: string;
  posCategoryCode?: string;
  posCategoryName?: string;
  isActive?: boolean;
  isSellable?: boolean;
  salePrice?: number;
  sortOrder?: number;
};

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function timestampValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const timestamp = value as { toDate?: () => Date };
  return typeof timestamp.toDate === 'function' ? timestamp.toDate().toISOString() : null;
}

const root = process.cwd();
loadEnvFile(resolve(root, '.env'));
const env = process.env;
if (env.VITE_FIREBASE_PROJECT_ID !== EXPECTED_PROJECT_ID) {
  throw new Error(`Expected Firebase project ${EXPECTED_PROJECT_ID}; found ${env.VITE_FIREBASE_PROJECT_ID || 'missing project ID'}.`);
}

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
}, 'pwa-customer-menu-audit');

try {
  const snapshot = await getDoc(doc(getFirestore(app), 'publicMenuAvailability', STORE_CODE));
  if (!snapshot.exists()) throw new Error(`publicMenuAvailability/${STORE_CODE} does not exist.`);

  const data = snapshot.data() as Record<string, unknown>;
  const menuItems = Object.values((data.menuItems || {}) as Record<string, PublicMenuItem>);
  const availability = (data.items || {}) as Record<string, { available?: boolean; publicStatus?: string }>;

  const rows = menuItems
    .map((item) => {
      const code = String(item.code || item.id || '');
      const trustedDietary = trustedDietaryClassification(item);
      const presentDietaryFields = DIETARY_FIELDS.filter((field) => item[field] !== undefined && item[field] !== null && item[field] !== '');
      return {
        documentId: String(item.id || ''),
        code,
        name: String(item.displayName || item.name || ''),
        sourceCategoryCode: String(item.posCategoryCode || ''),
        sourceCategoryName: String(item.posCategoryName || ''),
        customerDisplayCategory: customerMenuCategory({
          posCategoryCode: String(item.posCategoryCode || ''),
          posCategoryName: String(item.posCategoryName || ''),
        }),
        isActive: item.isActive === true,
        isSellable: item.isSellable === true,
        salePrice: Number(item.salePrice || 0),
        available: availability[code]?.available !== false,
        publicStatus: String(availability[code]?.publicStatus || ''),
        dietaryClassification: trustedDietary,
        dietaryFieldsPresent: presentDietaryFields,
        dietaryDataStatus: trustedDietary ? 'TRUSTED_VALUE_PRESENT' : 'MISSING_TRUSTED_DIETARY_CLASSIFICATION',
        categoryReviewStatus: CATEGORY_REVIEWS[code] ? 'SOURCE_DATA_REVIEW' : 'NO_CODE_LEVEL_MISMATCH_FOUND',
        categoryReviewReason: CATEGORY_REVIEWS[code] || '',
        sortOrder: Number(item.sortOrder || 0),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      projectId: EXPECTED_PROJECT_ID,
      documentPath: `publicMenuAvailability/${STORE_CODE}`,
      snapshotUpdatedAt: timestampValue(data.updatedAt),
      readOnly: true,
    },
    summary: {
      products: rows.length,
      productsWithTrustedDietaryClassification: rows.filter((row) => row.dietaryClassification).length,
      productsMissingTrustedDietaryClassification: rows.filter((row) => !row.dietaryClassification).length,
      sourceCategoryRecordsNeedingOwnerReview: rows.filter((row) => row.categoryReviewStatus === 'SOURCE_DATA_REVIEW').length,
    },
    rows,
  };

  const outputDir = resolve(root, 'reports/pwa-customer-ux');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolve(outputDir, 'customer-menu-data-audit.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  const headers = [
    'Document ID',
    'Code',
    'Name',
    'Source Category Code',
    'Source Category Name',
    'Customer Display Category',
    'Active',
    'Sellable',
    'Available',
    'Dietary Data Status',
    'Dietary Classification',
    'Category Review Status',
    'Category Review Reason',
  ];
  const csvRows = rows.map((row) => [
    row.documentId,
    row.code,
    row.name,
    row.sourceCategoryCode,
    row.sourceCategoryName,
    row.customerDisplayCategory,
    row.isActive,
    row.isSellable,
    row.available,
    row.dietaryDataStatus,
    row.dietaryClassification || '',
    row.categoryReviewStatus,
    row.categoryReviewReason,
  ].map(csvCell).join(','));
  writeFileSync(
    resolve(outputDir, 'customer-menu-data-audit.csv'),
    `${headers.map(csvCell).join(',')}\n${csvRows.join('\n')}\n`,
    'utf8',
  );

  console.log(JSON.stringify(report.summary, null, 2));
  console.log('No Firestore writes were performed.');
} finally {
  await deleteApp(app);
}
