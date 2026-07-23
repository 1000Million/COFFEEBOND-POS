import { FinishedGood, ProductImageAction, ProductImageAudit } from '../types/menu-management';
import type { PublicMenuAvailabilitySnapshot } from './publicMenuAvailability';

export const PRODUCT_IMAGE_STORAGE_PREFIX = 'menu-images';
export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_OUTPUT_WIDTH = 1200;
export const PRODUCT_IMAGE_OUTPUT_HEIGHT = 900;
export const PRODUCT_IMAGE_OUTPUT_ASPECT = PRODUCT_IMAGE_OUTPUT_WIDTH / PRODUCT_IMAGE_OUTPUT_HEIGHT;
export const PRODUCT_IMAGE_OUTPUT_MIME_TYPE = 'image/webp';
export const PRODUCT_IMAGE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
export const PRODUCT_IMAGE_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export type ProductImageFileCheck = {
  ok: boolean;
  message?: string;
};

export type ProductImagePersistenceInput = {
  product: {
    id?: string;
    code: string;
    name: string;
    imageUrl?: unknown;
    imageStoragePath?: unknown;
  };
  action: ProductImageAction;
  newImageUrl: string | null;
  newStoragePath: string | null;
  actorUid: string;
  actorEmail: string | null;
  timestamp: unknown;
};

export function sanitizeProductCodeForPath(code: string): string {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'PRODUCT';
}

export function formatProductImageTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0];
}

export function buildProductImageStoragePath(productCode: string, date = new Date()): string {
  return `${PRODUCT_IMAGE_STORAGE_PREFIX}/${sanitizeProductCodeForPath(productCode)}/card-${formatProductImageTimestamp(date)}.webp`;
}

export function buildNextProductImageStoragePath(
  productCode: string,
  previousStoragePath: string | null | undefined,
  date = new Date(),
): string {
  const firstPath = buildProductImageStoragePath(productCode, date);
  return firstPath === previousStoragePath
    ? buildProductImageStoragePath(productCode, new Date(date.getTime() + 1000))
    : firstPath;
}

export function buildProductImageUploadMetadata(productCode: string, productName: string, uploadedFrom: string) {
  return {
    contentType: PRODUCT_IMAGE_OUTPUT_MIME_TYPE,
    cacheControl: PRODUCT_IMAGE_CACHE_CONTROL,
    customMetadata: {
      productCode,
      productName,
      uploadedFrom,
    },
  };
}

export function isAllowedProductImageMimeType(mimeType: string): boolean {
  return PRODUCT_IMAGE_ALLOWED_MIME_TYPES.includes(String(mimeType || '').toLowerCase());
}

export function validateProductImageFile(file: Pick<File, 'type' | 'size'>): ProductImageFileCheck {
  if (!isAllowedProductImageMimeType(file.type)) {
    return { ok: false, message: 'Only JPG, JPEG, PNG, and WebP images are supported.' };
  }
  if (file.size <= 0) {
    return { ok: false, message: 'Selected image file is empty.' };
  }
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
    return { ok: false, message: 'Image must be 10 MB or smaller.' };
  }
  return { ok: true };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getCurrentProductImage(product: {
  imageUrl?: unknown;
  imageStoragePath?: unknown;
}): {
  imageUrl: string | null;
  imageStoragePath: string | null;
} {
  return {
    imageUrl: stringField(product.imageUrl) || null,
    imageStoragePath: stringField(product.imageStoragePath) || null,
  };
}

export function buildProductImagePatch(input: ProductImagePersistenceInput): Record<string, unknown> {
  const current = getCurrentProductImage(input.product);
  const previousImageUrl = current.imageUrl;
  const previousImageStoragePath = current.imageStoragePath;

  return {
    imageUrl: input.newImageUrl,
    imageStoragePath: input.newStoragePath,
    imageSource: input.newImageUrl ? 'ADMIN_UPLOAD' : null,
    imageUpdatedAt: input.timestamp,
    imageUpdatedBy: input.actorUid,
    previousImageUrl,
    previousImageStoragePath,
  };
}

export function buildProductImageAuditRecord(input: ProductImagePersistenceInput): ProductImageAudit {
  const current = getCurrentProductImage(input.product);
  return {
    action: input.action,
    productCode: input.product.code,
    productName: input.product.name,
    productDocumentPath: `finishedGoods/${input.product.id || input.product.code}`,
    previousImageUrl: current.imageUrl,
    newImageUrl: input.newImageUrl,
    previousStoragePath: current.imageStoragePath,
    newStoragePath: input.newStoragePath,
    performedByUid: input.actorUid,
    performedByEmail: input.actorEmail,
    timestamp: input.timestamp,
  };
}

export function patchPublicMenuAvailabilitySnapshot(
  snapshot: PublicMenuAvailabilitySnapshot,
  productCode: string,
  imageUrl: string | null,
): PublicMenuAvailabilitySnapshot | null {
  if (!snapshot?.menuItems || typeof snapshot.menuItems !== 'object') return null;
  const current = snapshot.menuItems[productCode];
  if (!current) return null;

  const nextMenuItems = {
    ...snapshot.menuItems,
    [productCode]: imageUrl
      ? { ...current, imageUrl }
      : Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'imageUrl')) as typeof current,
  };

  return {
    ...snapshot,
    menuItems: nextMenuItems,
  };
}

export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed.'));
    };
    image.src = url;
  });
}

export async function createCenteredProductImageBlob(
  file: File,
  width = PRODUCT_IMAGE_OUTPUT_WIDTH,
  height = PRODUCT_IMAGE_OUTPUT_HEIGHT,
  quality = 0.92,
): Promise<Blob> {
  const image = await loadImageFromFile(file);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image crop failed because the canvas context is unavailable.');

  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;

  if (sourceRatio > targetRatio) {
    sw = image.naturalHeight * targetRatio;
    sx = (image.naturalWidth - sw) / 2;
  } else {
    sh = image.naturalWidth / targetRatio;
    sy = (image.naturalHeight - sh) / 2;
  }

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to encode the product image.'));
          return;
        }
        resolve(blob);
      },
      PRODUCT_IMAGE_OUTPUT_MIME_TYPE,
      quality,
    );
  });
}

export async function prepareProductImageForUpload(
  file: File,
  converter: (input: File) => Promise<Blob> = createCenteredProductImageBlob,
): Promise<Blob> {
  const validation = validateProductImageFile(file);
  if (!validation.ok) throw new Error(validation.message || 'Invalid product image.');

  const blob = await converter(file);
  if (blob.type !== PRODUCT_IMAGE_OUTPUT_MIME_TYPE) {
    throw new Error('Product image conversion did not produce WebP output.');
  }
  if (blob.size <= 0 || blob.size > PRODUCT_IMAGE_MAX_BYTES) {
    throw new Error('Converted image must be between 1 byte and 10 MB.');
  }
  return blob;
}
