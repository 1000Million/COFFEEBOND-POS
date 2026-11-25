import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCT_IMAGE_ALLOWED_MIME_TYPES,
  PRODUCT_IMAGE_CACHE_CONTROL,
  PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_OUTPUT_MIME_TYPE,
  buildProductImageAuditRecord,
  buildNextProductImageStoragePath,
  buildProductImagePatch,
  buildProductImageStoragePath,
  buildProductImageUploadMetadata,
  calculateCenteredProductImageCrop,
  calculateProductImageOutputSize,
  createCenteredProductImageBlob,
  patchPublicMenuAvailabilitySnapshot,
  prepareProductImageForUpload,
  sanitizeProductCodeForPath,
  validateProductImageFile,
} from '../frontend/lib/productImages';

const fixedDate = new Date('2026-07-21T10:11:12.000Z');
const baseProduct = {
  id: 'firestore-fg-menu-007',
  code: 'menu-007',
  name: 'Avocado & Quinoa Salad',
  imageUrl: 'https://cdn.example.com/old.webp',
  imageStoragePath: 'menu-images/MENU-007/card-20260720T101010.webp',
};

assert.equal(sanitizeProductCodeForPath(' menu-007 '), 'MENU_007');
assert.equal(buildProductImageStoragePath('menu-007', fixedDate), 'menu-images/MENU_007/card-20260721T101112.webp');
assert.equal(
  buildNextProductImageStoragePath('menu-007', 'menu-images/MENU_007/card-20260721T101112.webp', fixedDate),
  'menu-images/MENU_007/card-20260721T101113.webp',
);

for (const mimeType of PRODUCT_IMAGE_ALLOWED_MIME_TYPES) {
  assert.ok(validateProductImageFile({ type: mimeType, size: 1024 }).ok, `Expected ${mimeType} to be accepted`);
}
assert.equal(validateProductImageFile({ type: 'image/gif', size: 1024 }).ok, false);
assert.match(validateProductImageFile({ type: 'image/heic', size: 1024 }).message || '', /HEIC/);
assert.match(validateProductImageFile({ type: 'image/heif', size: 1024 }).message || '', /HEIF/);
assert.match(validateProductImageFile({ type: 'image\/svg+xml', size: 1024 }).message || '', /SVG/);
assert.equal(validateProductImageFile({ type: 'image/jpeg', size: 0 }).ok, false);
assert.equal(validateProductImageFile({ type: 'image/jpeg', size: PRODUCT_IMAGE_MAX_BYTES + 1 }).ok, false);

const convertedInputs: string[] = [];
for (const mimeType of ['image/jpeg', 'image/png', 'image/webp']) {
  const input = { type: mimeType, size: 1024 } as File;
  const output = await prepareProductImageForUpload(input, async (file) => {
    convertedInputs.push(file.type);
    return new Blob(['webp-output'], { type: PRODUCT_IMAGE_OUTPUT_MIME_TYPE });
  });
  assert.equal(output.type, PRODUCT_IMAGE_OUTPUT_MIME_TYPE);
}
assert.deepEqual(convertedInputs, ['image/jpeg', 'image/png', 'image/webp']);
await assert.rejects(
  () => prepareProductImageForUpload({ type: 'application/pdf', size: 1024 } as File, async () => new Blob(['x'], { type: PRODUCT_IMAGE_OUTPUT_MIME_TYPE })),
  /Only JPG, JPEG, PNG, and WebP/,
);
await assert.rejects(
  () => prepareProductImageForUpload(
    { type: 'image/jpeg', size: 1024 } as File,
    async () => new Blob([], { type: PRODUCT_IMAGE_OUTPUT_MIME_TYPE }),
  ),
  new RegExp(PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
);

const landscapeCrop = calculateCenteredProductImageCrop(4000, 2000);
assert.equal(landscapeCrop.sw / landscapeCrop.sh, 4 / 3);
assert.equal(landscapeCrop.sy, 0);
assert.ok(landscapeCrop.sx > 0);
const portraitCrop = calculateCenteredProductImageCrop(2000, 4000);
assert.equal(portraitCrop.sw / portraitCrop.sh, 4 / 3);
assert.equal(portraitCrop.sx, 0);
assert.ok(portraitCrop.sy > 0);
const largeOutput = calculateProductImageOutputSize(4000, 3000);
assert.deepEqual(largeOutput, { width: 1600, height: 1200 });
assert.equal(largeOutput.width / largeOutput.height, 4 / 3);
const smallOutput = calculateProductImageOutputSize(800, 600);
assert.deepEqual(smallOutput, { width: 800, height: 600 });

type FakeCanvasResult = Blob | null;
function conversionHarness(results: FakeCanvasResult[]) {
  const canvasSizes: Array<[number, number]> = [];
  const qualities: number[] = [];
  let cleanedUp = false;
  const dependencies = {
    decodeImage: async () => ({
      source: {} as CanvasImageSource,
      width: 4000,
      height: 3000,
      cleanup: () => {
        cleanedUp = true;
      },
    }),
    createCanvas: (width: number, height: number) => {
      canvasSizes.push([width, height]);
      return {
        width,
        height,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: () => undefined,
        }),
        toBlob: (callback: BlobCallback, _mimeType: string, quality: number) => {
          qualities.push(quality);
          callback(results.shift() ?? null);
        },
      } as unknown as HTMLCanvasElement;
    },
  };
  return { canvasSizes, qualities, dependencies, wasCleanedUp: () => cleanedUp };
}

const retryHarness = conversionHarness([
  null,
  new Blob(['retry-webp'], { type: PRODUCT_IMAGE_OUTPUT_MIME_TYPE }),
]);
const retriedBlob = await createCenteredProductImageBlob(
  { type: 'image/jpeg', size: 1024 } as File,
  1600,
  1200,
  0.9,
  retryHarness.dependencies,
);
assert.equal(retriedBlob.type, PRODUCT_IMAGE_OUTPUT_MIME_TYPE);
assert.deepEqual(retryHarness.canvasSizes, [[1600, 1200], [1200, 900]]);
assert.deepEqual(retryHarness.qualities, [0.9, 0.78]);
assert.equal(retryHarness.wasCleanedUp(), true);

const zeroByteHarness = conversionHarness([
  new Blob([], { type: PRODUCT_IMAGE_OUTPUT_MIME_TYPE }),
  new Blob([], { type: PRODUCT_IMAGE_OUTPUT_MIME_TYPE }),
]);
await assert.rejects(
  () => createCenteredProductImageBlob(
    { type: 'image/png', size: 1024 } as File,
    1600,
    1200,
    0.9,
    zeroByteHarness.dependencies,
  ),
  new RegExp(PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
);
assert.equal(zeroByteHarness.wasCleanedUp(), true);

const uploadMetadata = buildProductImageUploadMetadata('MENU_007', 'Avocado Salad', 'test');
assert.equal(uploadMetadata.contentType, 'image/webp');
assert.equal(uploadMetadata.cacheControl, PRODUCT_IMAGE_CACHE_CONTROL);

const uploadPatch = buildProductImagePatch({
  product: baseProduct as any,
  action: 'UPLOAD',
  newImageUrl: 'https://cdn.example.com/new.webp',
  newStoragePath: 'menu-images/MENU_007/card-20260721T101112.webp',
  actorUid: 'uid-1',
  actorEmail: 'admin@coffeebond.in',
  timestamp: fixedDate,
});
assert.equal(uploadPatch.imageUrl, 'https://cdn.example.com/new.webp');
assert.equal(uploadPatch.previousImageUrl, 'https://cdn.example.com/old.webp');
assert.equal(uploadPatch.previousImageStoragePath, 'menu-images/MENU-007/card-20260720T101010.webp');
assert.equal(uploadPatch.imageSource, 'ADMIN_UPLOAD');

const removePatch = buildProductImagePatch({
  product: baseProduct as any,
  action: 'REMOVE',
  newImageUrl: null,
  newStoragePath: null,
  actorUid: 'uid-1',
  actorEmail: 'admin@coffeebond.in',
  timestamp: fixedDate,
});
assert.equal(removePatch.imageUrl, null);
assert.equal(removePatch.imageStoragePath, null);
assert.equal(removePatch.imageSource, null);

const audit = buildProductImageAuditRecord({
  product: baseProduct as any,
  action: 'REPLACE',
  newImageUrl: 'https://cdn.example.com/new.webp',
  newStoragePath: 'menu-images/MENU_007/card-20260721T101112.webp',
  actorUid: 'uid-1',
  actorEmail: 'admin@coffeebond.in',
  timestamp: fixedDate,
});
assert.equal(audit.productCode, 'menu-007');
assert.equal(audit.productDocumentPath, 'finishedGoods/firestore-fg-menu-007');
assert.equal(audit.previousImageUrl, 'https://cdn.example.com/old.webp');
assert.equal(audit.newStoragePath, 'menu-images/MENU_007/card-20260721T101112.webp');
assert.equal(audit.performedByEmail, 'admin@coffeebond.in');

const snapshot = {
  storeId: 'UDAY_PARK',
  storeCode: 'UDAY_PARK',
  storeName: 'Uday Park',
  items: {},
  menuItems: {
    MENU_007: {
      id: 'fg1',
      code: 'MENU_007',
      name: 'Avocado & Quinoa Salad',
      displayName: 'Avocado & Quinoa Salad',
      description: 'Fresh',
      posCategoryCode: 'SALAD',
      posCategoryName: 'Salads',
      salePrice: 280,
      prepStation: 'KITCHEN',
      itemType: 'MADE_TO_ORDER',
      sortOrder: 1,
      availableStoreIds: ['UDAY_PARK'],
      isSellable: true,
      isAvailable: true,
      isActive: true,
      taxRate: 5,
      imageUrl: 'https://cdn.example.com/old.webp',
    },
  },
  itemCount: 1,
  availableCount: 1,
  unavailableCount: 0,
};

const patchedSnapshot = patchPublicMenuAvailabilitySnapshot(snapshot as any, 'MENU_007', 'https://cdn.example.com/new.webp');
assert.ok(patchedSnapshot);
assert.equal(patchedSnapshot?.menuItems.MENU_007.imageUrl, 'https://cdn.example.com/new.webp');
const removedSnapshot = patchPublicMenuAvailabilitySnapshot(patchedSnapshot as any, 'MENU_007', null);
assert.ok(removedSnapshot);
assert.equal(Object.prototype.hasOwnProperty.call(removedSnapshot!.menuItems.MENU_007, 'imageUrl'), false);

const repoRoot = process.cwd();
const storageRules = fs.readFileSync(path.join(repoRoot, 'storage.rules'), 'utf8');
const menuRuleStart = storageRules.indexOf('match /menu-images/{productCode}/{fileName}');
assert.ok(menuRuleStart >= 0, 'Canonical menu image rule must exist.');
const menuRule = storageRules.slice(menuRuleStart, storageRules.indexOf('match /purchase-invoices/', menuRuleStart));
assert.match(menuRule, /allow read:\s*if true;/);
assert.match(menuRule, /allow create, update:\s*if isAdmin\(\)/);
assert.match(menuRule, /allow delete:\s*if isAdmin\(\);/);
assert.match(menuRule, /fileName\.matches\('\^card-\[0-9\]\{8\}T\[0-9\]\{6\}\\\\\.webp\$'\)/);
assert.match(storageRules, /request\.resource\.size\s*<=\s*10\s*\*\s*1024\s*\*\s*1024/);
assert.match(storageRules, /request\.resource\.contentType\s*==\s*'image\/webp'/);
assert.doesNotMatch(menuRule, /STORE_MANAGER|CASHIER|request\.auth\s*==\s*null/);
assert.match(storageRules, /function isAdmin\(\)\s*\{[\s\S]*isActiveStaff\(\)[\s\S]*userData\(\)\.role\s*==\s*'ADMIN'/);
assert.match(storageRules, /match \/\{allPaths=\*\*\}[\s\S]*allow read, write:\s*if false;/);

const forbiddenStoragePrefix = ['finished', 'good', 'images'].join('-');
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : [entryPath];
  });
}
const forbiddenApplicationReferences = sourceFiles(path.join(repoRoot, 'frontend'))
  .filter((filePath) => /\.(ts|tsx|js|jsx)$/.test(filePath))
  .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes(forbiddenStoragePrefix));
assert.deepEqual(forbiddenApplicationReferences, [], 'Application code must not reference the duplicate image path.');
const conversionSource = fs.readFileSync(path.join(repoRoot, 'frontend/lib/productImages.ts'), 'utf8');
assert.match(conversionSource, /createImageBitmap\(file,\s*\{\s*imageOrientation:\s*'from-image'\s*\}\)/);
assert.match(conversionSource, /new FileReader\(\)/);
assert.match(conversionSource, /PRODUCT_IMAGE_RETRY_WIDTH/);

console.log('product image helper tests passed');
