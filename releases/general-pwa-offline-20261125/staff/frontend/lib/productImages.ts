import { FinishedGood, ProductImageAction, ProductImageAudit } from '../types/menu-management';
import type { PublicMenuAvailabilitySnapshot } from './publicMenuAvailability';

export const PRODUCT_IMAGE_STORAGE_PREFIX = 'menu-images';
export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_OUTPUT_WIDTH = 1600;
export const PRODUCT_IMAGE_OUTPUT_HEIGHT = 1200;
export const PRODUCT_IMAGE_OUTPUT_ASPECT = PRODUCT_IMAGE_OUTPUT_WIDTH / PRODUCT_IMAGE_OUTPUT_HEIGHT;
export const PRODUCT_IMAGE_OUTPUT_MIME_TYPE = 'image/webp';
export const PRODUCT_IMAGE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
export const PRODUCT_IMAGE_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE = 'This image could not be converted. Export it as JPG or PNG and try again.';
const PRODUCT_IMAGE_PRIMARY_QUALITY = 0.9;
const PRODUCT_IMAGE_RETRY_WIDTH = 1200;
const PRODUCT_IMAGE_RETRY_HEIGHT = 900;
const PRODUCT_IMAGE_RETRY_QUALITY = 0.78;

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

export type ProductImageCrop = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

export type ProductImageOutputSize = {
  width: number;
  height: number;
};

type DecodedProductImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
};

type ProductImageConversionDependencies = {
  decodeImage?: (file: File) => Promise<DecodedProductImage>;
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
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
  const mimeType = String(file.type || '').toLowerCase();
  if (['image/heic', 'image/heif'].includes(mimeType)) {
    return { ok: false, message: 'HEIC and HEIF images are not supported. Export the image as JPG or PNG and try again.' };
  }
  if (mimeType === 'image/svg+xml') {
    return { ok: false, message: 'SVG images are not supported. Export the image as JPG, PNG, or WebP and try again.' };
  }
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
    const reader = new FileReader();
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('Image decode failed.'));
    };
    reader.onerror = () => reject(new Error('Image file could not be read.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Image file could not be read.'));
        return;
      }
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function decodeProductImage(file: File): Promise<DecodedProductImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch {
      // Some store devices expose createImageBitmap but cannot decode every valid JPEG/PNG.
    }
  }

  const image = await loadImageFromFile(file);
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error('Image decode produced invalid dimensions.');
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () => undefined,
  };
}

export function calculateCenteredProductImageCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetAspect = PRODUCT_IMAGE_OUTPUT_ASPECT,
): ProductImageCrop {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetAspect <= 0) {
    throw new Error('Image dimensions are invalid.');
  }
  const sourceRatio = sourceWidth / sourceHeight;
  if (sourceRatio > targetAspect) {
    const sw = sourceHeight * targetAspect;
    return { sx: (sourceWidth - sw) / 2, sy: 0, sw, sh: sourceHeight };
  }
  const sh = sourceWidth / targetAspect;
  return { sx: 0, sy: (sourceHeight - sh) / 2, sw: sourceWidth, sh };
}

export function calculateProductImageOutputSize(
  cropWidth: number,
  cropHeight: number,
  maximumWidth = PRODUCT_IMAGE_OUTPUT_WIDTH,
  maximumHeight = PRODUCT_IMAGE_OUTPUT_HEIGHT,
): ProductImageOutputSize {
  if (cropWidth <= 0 || cropHeight <= 0 || maximumWidth <= 0 || maximumHeight <= 0) {
    throw new Error('Image dimensions are invalid.');
  }
  const scale = Math.min(1, maximumWidth / cropWidth, maximumHeight / cropHeight);
  const scaledWidth = Math.floor(cropWidth * scale);
  const width = Math.max(4, Math.floor(scaledWidth / 4) * 4);
  const height = width * 3 / 4;
  return {
    width: Math.min(width, maximumWidth),
    height: Math.min(height, maximumHeight),
  };
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function encodeCanvasAsWebP(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(resolve, PRODUCT_IMAGE_OUTPUT_MIME_TYPE, quality);
  });
}

function isValidWebPBlob(blob: Blob | null): blob is Blob {
  return Boolean(
    blob
    && blob.type.toLowerCase() === PRODUCT_IMAGE_OUTPUT_MIME_TYPE
    && blob.size > 0
    && blob.size <= PRODUCT_IMAGE_MAX_BYTES,
  );
}

async function renderProductImageAttempt(
  image: DecodedProductImage,
  maximumWidth: number,
  maximumHeight: number,
  quality: number,
  createCanvas: (width: number, height: number) => HTMLCanvasElement,
): Promise<Blob | null> {
  const crop = calculateCenteredProductImageCrop(image.width, image.height);
  const output = calculateProductImageOutputSize(crop.sw, crop.sh, maximumWidth, maximumHeight);
  const canvas = createCanvas(output.width, output.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image crop failed because the canvas context is unavailable.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image.source,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    output.width,
    output.height,
  );
  return encodeCanvasAsWebP(canvas, quality);
}

export async function createCenteredProductImageBlob(
  file: File,
  width = PRODUCT_IMAGE_OUTPUT_WIDTH,
  height = PRODUCT_IMAGE_OUTPUT_HEIGHT,
  quality = PRODUCT_IMAGE_PRIMARY_QUALITY,
  dependencies: ProductImageConversionDependencies = {},
): Promise<Blob> {
  const decodeImage = dependencies.decodeImage || decodeProductImage;
  const createCanvas = dependencies.createCanvas || defaultCreateCanvas;
  const image = await decodeImage(file);
  try {
    const primary = await renderProductImageAttempt(image, width, height, quality, createCanvas);
    if (isValidWebPBlob(primary)) return primary;

    const retry = await renderProductImageAttempt(
      image,
      PRODUCT_IMAGE_RETRY_WIDTH,
      PRODUCT_IMAGE_RETRY_HEIGHT,
      PRODUCT_IMAGE_RETRY_QUALITY,
      createCanvas,
    );
    if (isValidWebPBlob(retry)) return retry;
    throw new Error(PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE);
  } finally {
    image.cleanup();
  }
}

export async function prepareProductImageForUpload(
  file: File,
  converter: (input: File) => Promise<Blob> = createCenteredProductImageBlob,
): Promise<Blob> {
  const validation = validateProductImageFile(file);
  if (!validation.ok) throw new Error(validation.message || 'Invalid product image.');

  let blob: Blob;
  try {
    blob = await converter(file);
  } catch {
    throw new Error(PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE);
  }
  if (
    blob.type.toLowerCase() !== PRODUCT_IMAGE_OUTPUT_MIME_TYPE
    || blob.size <= 0
    || blob.size > PRODUCT_IMAGE_MAX_BYTES
  ) {
    throw new Error(PRODUCT_IMAGE_CONVERSION_ERROR_MESSAGE);
  }
  return blob;
}
