#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports/menu-image-import');
const PROCESSED_DIR = path.join(REPORT_DIR, 'processed');
const PROJECT_ID = 'coffee-bond-pos';
const STORAGE_BUCKET = 'coffee-bond-pos.firebasestorage.app';
const IMAGE_FIELD_CANDIDATES = ['imageUrl', 'imageURL', 'image', 'photoUrl', 'photoURL', 'photo', 'thumbnailUrl', 'thumbnail'];
const HIGH_CONFIDENCE_STATUSES = new Set(['READY', 'ALREADY_CONFIGURED']);
const RUN_TIMESTAMP = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];

function sanitizeProductCodeForPath(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'PRODUCT';
}

function proposedImageStoragePath(productCode) {
  return `menu-images/${sanitizeProductCodeForPath(productCode)}/card-${RUN_TIMESTAMP}.webp`;
}

function isCanonicalImageStoragePath(storagePath, productCode) {
  const prefix = `menu-images/${sanitizeProductCodeForPath(productCode)}/`;
  return String(storagePath || '').startsWith(prefix)
    && /^card-[0-9]{8}T[0-9]{6}\.webp$/.test(String(storagePath).slice(prefix.length));
}

function readArgValue(name, fallback = '') {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : fallback;
}

function parseEnvFile(text) {
  const env = {};
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  });
  return env;
}

async function loadFirebaseConfig() {
  const envPath = path.join(ROOT, '.env');
  const env = parseEnvFile(await fs.readFile(envPath, 'utf8').catch(() => ''));
  const required = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID',
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing Firebase web config in .env: ${missing.join(', ')}`);
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID || PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ].join('\n');
}

function parseCsv(text) {
  const rows = [];
  let current = '';
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(current);
      current = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(current);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }
  row.push(current);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  if (rows.length === 0) return [];
  const headers = rows.shift();
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}

function normalizeImageValue(record) {
  for (const key of IMAGE_FIELD_CANDIDATES) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { field: key, url: value.trim() };
    }
  }
  return { field: '', url: '' };
}

function productName(item) {
  return item.displayName || item.name || item.itemName || item.code || item.itemCode || '';
}

function productCode(item) {
  return item.code || item.itemCode || item.fgCode || item.id || '';
}

async function loadCustomerMenu() {
  const firebaseConfig = await loadFirebaseConfig();
  const app = initializeApp(firebaseConfig, `menu-image-dry-run-${Date.now()}`);
  const db = getFirestore(app);
  const storeSnap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
  const stores = storeSnap.docs
    .map((storeDoc) => ({ id: storeDoc.id, ...(storeDoc.data() || {}) }))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));

  const docs = [];
  const productMap = new Map();
  for (const store of stores) {
    const snapshotId = store.code || store.id;
    const availabilitySnap = await getDoc(doc(db, 'publicMenuAvailability', snapshotId));
    const availability = availabilitySnap.exists() ? availabilitySnap.data() || {} : {};
    const menuItems = availability.menuItems && typeof availability.menuItems === 'object'
      ? Object.values(availability.menuItems)
      : [];
    docs.push({
      storeId: store.id,
      storeCode: store.code || store.id,
      storeName: store.name || store.displayName || store.id,
      sourcePath: `publicMenuAvailability/${snapshotId}`,
      menuItemCount: menuItems.length,
    });
    menuItems.forEach((rawItem) => {
      const item = rawItem || {};
      const code = productCode(item);
      if (!code) return;
      const image = normalizeImageValue(item);
      const previous = productMap.get(code);
      const sourcePath = `publicMenuAvailability/${snapshotId}.menuItems.${code}`;
      const next = {
        productCode: code,
        productName: productName(item),
        category: item.posCategoryName || item.category || item.posCategoryCode || '',
        currentImageField: image.field,
        currentImageURL: image.url,
        sourceDocumentPath: sourcePath,
        stores: previous ? Array.from(new Set([...previous.stores, store.code || store.id])) : [store.code || store.id],
        placeholderCurrentlyDisplayed: image.url ? 'no' : 'yes',
      };
      productMap.set(code, previous ? { ...previous, ...next, stores: next.stores } : next);
    });
  }

  await deleteApp(app);

  return { stores, docs, products: Array.from(productMap.values()).sort((a, b) => a.productCode.localeCompare(b.productCode)) };
}

function defaultDiscoveredImages() {
  const websiteRejectedUrls = [
    'https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1605666807755-a226b80d0d5d?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1515823662972-da6a2e4d3002?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1600093463592-8e36ae95ef56?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1521017430205-9591428e2650?auto=format&fit=crop&q=80&w=800',
    'https://images.unsplash.com/photo-1541462608143-67571c6738dd?q=80&w=2000&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1497935586351-b67a49e012bf?auto=format&fit=crop&q=80&w=1200',
  ];

  return websiteRejectedUrls.map((sourceURL) => ({
      sourceFile: '',
      sourceURL,
      sourcePage: 'https://coffeebond.in',
      suggestedProductCode: '',
      suggestedProductName: '',
      matchConfidence: 'UNMATCHED',
      matchReason: 'Coffee Bond website bundle references Unsplash imagery; not Coffee Bond-owned product photography.',
      ownershipStatus: 'NOT_COFFEE_BOND_OWNED',
      approvedForUpload: 'false',
    }));
}

async function ensureSeedReports(products) {
  await fs.mkdir(PROCESSED_DIR, { recursive: true });

  const discoveredPath = path.join(REPORT_DIR, 'discovered-images.csv');
  await fs.writeFile(discoveredPath, `${toCsv(defaultDiscoveredImages(), [
    'sourceFile',
    'sourceURL',
    'sourcePage',
    'suggestedProductCode',
    'suggestedProductName',
    'matchConfidence',
    'matchReason',
    'ownershipStatus',
    'approvedForUpload',
  ])}\n`);

  const mappingPath = path.join(REPORT_DIR, 'product-image-mapping.csv');
  try {
    await fs.access(mappingPath);
  } catch {
    const rows = products.map((product) => ({
      productDocumentPath: product.sourceDocumentPath,
      productCode: product.productCode,
      productName: product.productName,
      category: product.category,
      currentImageURL: product.currentImageURL,
      proposedSourceImage: '',
      proposedStoragePath: proposedImageStoragePath(product.productCode),
      matchConfidence: product.currentImageURL ? 'EXACT' : 'UNMATCHED',
      status: product.currentImageURL ? 'ALREADY_CONFIGURED' : 'NO_IMAGE_FOUND',
      notes: product.currentImageURL ? 'Existing public menu image URL is already configured.' : 'No Coffee Bond-owned product photograph found yet.',
    }));
    await fs.writeFile(mappingPath, `${toCsv(rows, [
      'productDocumentPath',
      'productCode',
      'productName',
      'category',
      'currentImageURL',
      'proposedSourceImage',
      'proposedStoragePath',
      'matchConfidence',
      'status',
      'notes',
    ])}\n`);
  }
}

async function fileStats(sourceFile) {
  if (!sourceFile) return { exists: false, sizeBytes: 0, mimeType: '', dimensions: '' };
  const resolved = path.isAbsolute(sourceFile) ? sourceFile : path.join(ROOT, sourceFile);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) return { exists: false, sizeBytes: 0, mimeType: '', dimensions: '' };
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = extension === '.webp' ? 'image/webp'
    : extension === '.png' ? 'image/png'
      : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg'
        : '';
  return { exists: true, sizeBytes: stat.size, mimeType, dimensions: 'not-inspected' };
}

async function validateDryRun(products) {
  await ensureSeedReports(products);
  const mappingRows = parseCsv(await fs.readFile(path.join(REPORT_DIR, 'product-image-mapping.csv'), 'utf8'));
  const productCodes = new Set(products.map((product) => product.productCode));
  const rows = [];
  let ready = 0;
  let blocked = 0;
  let partial = 0;

  for (const row of mappingRows) {
    const local = await fileStats(row.proposedSourceImage);
    const targetFound = productCodes.has(row.productCode);
    const status = row.status || 'NO_IMAGE_FOUND';
    const confidence = row.matchConfidence || 'UNMATCHED';
    const canUpload = status === 'READY'
      && ['EXACT', 'HIGH'].includes(confidence)
      && targetFound
      && local.exists
      && local.mimeType.startsWith('image/')
      && isCanonicalImageStoragePath(row.proposedStoragePath, row.productCode);
    if (canUpload || status === 'ALREADY_CONFIGURED') ready += 1;
    else if (status === 'REVIEW') partial += 1;
    else blocked += 1;
    rows.push({
      ...row,
      targetProductFound: targetFound,
      localFileExists: local.exists,
      localFileSizeBytes: local.sizeBytes,
      localMimeType: local.mimeType,
      localDimensions: local.dimensions,
      proposedFirestoreField: 'imageUrl',
      storageBucket: STORAGE_BUCKET,
      dryRunCanApply: canUpload,
      dryRunReason: canUpload
        ? 'Ready for explicit owner-approved upload.'
        : status === 'ALREADY_CONFIGURED'
          ? 'No upload needed.'
          : !targetFound
            ? 'Target product was not found in public menu snapshot.'
            : status === 'REVIEW'
              ? 'Owner review required before upload.'
              : 'No approved Coffee Bond-owned image is mapped.',
    });
  }

  const result = blocked > 0 ? 'BLOCKED' : partial > 0 ? 'PARTIAL' : 'READY';
  return { result, ready, partial, blocked, rows };
}

function renderReviewHtml(rows) {
  const body = rows.map((row) => {
    const imagePath = row.proposedSourceImage || '';
    const src = imagePath ? path.relative(REPORT_DIR, path.isAbsolute(imagePath) ? imagePath : path.join(ROOT, imagePath)) : '';
    return `<article class="card">
      <div class="thumb">${src ? `<img src="${src}" alt="${row.productName}">` : '<span>No approved image</span>'}</div>
      <div>
        <h2>${row.productName || row.productCode}</h2>
        <p><strong>Code:</strong> ${row.productCode}</p>
        <p><strong>Current:</strong> ${row.currentImageURL || 'placeholder'}</p>
        <p><strong>Source:</strong> ${row.proposedSourceImage || 'none'}</p>
        <p><strong>Confidence:</strong> ${row.matchConfidence}</p>
        <p><strong>Destination:</strong> ${row.proposedStoragePath}</p>
        <p><strong>Status:</strong> ${row.status}</p>
        <p>${row.notes || row.dryRunReason || ''}</p>
      </div>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coffee Bond Menu Image Review</title>
  <style>
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #fbf7f1; color: #38251d; }
    main { max-width: 1100px; margin: 0 auto; padding: 32px 18px; }
    h1 { margin: 0 0 8px; }
    .card { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 18px; background: white; border: 1px solid #e7ddd3; border-radius: 18px; padding: 14px; margin: 14px 0; box-shadow: 0 10px 24px rgba(56, 37, 29, 0.06); }
    .thumb { aspect-ratio: 4 / 3; border-radius: 14px; background: #f2e7da; display: flex; align-items: center; justify-content: center; color: #8b756a; overflow: hidden; text-align: center; padding: 10px; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    p { margin: 4px 0; color: #6d5b52; }
    @media (max-width: 640px) { .card { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Coffee Bond Menu Image Review</h1>
    <p>Local contact sheet. No Firestore writes or Storage uploads have been made.</p>
    ${body}
  </main>
</body>
</html>`;
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const { stores, docs, products } = await loadCustomerMenu();

  const auditRows = products.map((product) => ({
    productCode: product.productCode,
    productName: product.productName,
    category: product.category,
    existingImageField: product.currentImageField,
    existingImageURL: product.currentImageURL,
    currentSourceDocumentPath: product.sourceDocumentPath,
    placeholderCurrentlyDisplayed: product.placeholderCurrentlyDisplayed,
    recommendedAction: product.currentImageURL ? 'Verify image ownership and keep.' : 'Find exact Coffee Bond-owned product photograph.',
    stores: product.stores,
  }));
  await fs.writeFile(path.join(REPORT_DIR, 'current-image-audit.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    sourceCollections: ['stores', 'publicMenuAvailability'],
    applicationImageFieldOrder: IMAGE_FIELD_CANDIDATES,
    stores: docs,
    products: auditRows,
  }, null, 2));

  const dryRun = await validateDryRun(products);
  await fs.writeFile(path.join(REPORT_DIR, 'dry-run.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
    result: dryRun.result,
    counts: {
      products: products.length,
      readyOrAlreadyConfigured: dryRun.ready,
      review: dryRun.partial,
      blocked: dryRun.blocked,
    },
    writes: {
      firestore: 0,
      storageUploads: 0,
    },
    rows: dryRun.rows,
  }, null, 2));
  await fs.writeFile(path.join(REPORT_DIR, 'dry-run.csv'), `${toCsv(dryRun.rows, [
    'productDocumentPath',
    'productCode',
    'productName',
    'category',
    'currentImageURL',
    'proposedSourceImage',
    'proposedStoragePath',
    'matchConfidence',
    'status',
    'targetProductFound',
    'localFileExists',
    'localFileSizeBytes',
    'localMimeType',
    'proposedFirestoreField',
    'storageBucket',
    'dryRunCanApply',
    'dryRunReason',
    'notes',
  ])}\n`);
  await fs.writeFile(path.join(REPORT_DIR, 'image-review.html'), renderReviewHtml(dryRun.rows));

  console.log(`Menu image dry-run result: ${dryRun.result}`);
  console.log(`Products: ${products.length}`);
  console.log(`Ready/already configured: ${dryRun.ready}`);
  console.log(`Review: ${dryRun.partial}`);
  console.log(`Blocked: ${dryRun.blocked}`);
  console.log(`Reports: ${path.relative(ROOT, REPORT_DIR)}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
