import { getDownloadURL, getMetadata, ref, uploadBytesResumable, type FirebaseStorage } from 'firebase/storage';
import { buildProductImageUploadMetadata } from './productImages';

// A local journal is saved BEFORE Storage is touched. Retries reuse the same
// object and audit ID, including after a reload; no financial journal is used.
export type ImageSaveIntent = {
  id: string; actorUid: string; actorEmail: string | null;
  productDocumentId: string; productCode: string; productName: string;
  action: 'UPLOAD' | 'REPLACE'; storagePath: string; downloadUrl: string | null;
  previousImageUrl: string | null; previousImageStoragePath: string | null;
  blob: Blob; fileName: string; contentSHA256: string;
};
export async function imageJournal<T>(uid: string, operation: 'get' | 'put' | 'delete', value?: ImageSaveIntent): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    const timer = setTimeout(() => {
      expired = true;
      transaction?.abort();
      database?.close();
      reject(new Error('Saving the local retry record timed out. Close other idle Images tabs and retry.'));
    }, 25_000);
    const fail = (error: unknown) => { clearTimeout(timer); database?.close(); reject(error); };
    const open = indexedDB.open('coffee-bond-product-image-save', 1);
    open.onupgradeneeded = () => {
      if (expired) { open.transaction?.abort(); return; }
      open.result.createObjectStore('pending');
    };
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const db = database = open.result;
      if (expired) { db.close(); return; }
      const tx = transaction = db.transaction('pending', operation === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('pending');
      const req = operation === 'get' ? store.get(uid) : operation === 'put' ? store.put(value, uid) : store.delete(uid);
      tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(req.result as T); };
      tx.onabort = tx.onerror = () => fail(tx.error || new Error('Unable to preserve the image retry.'));
    };
  });
}

export function imageDeadline<T>(work: Promise<T>, stage: string, ms = 30_000, cancel?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancel?.();
      reject(new Error(`${stage} timed out. Check your connection and retry this saved image. Its outcome will be checked before retrying.`));
    }, ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function imageSaveError(error: unknown): string {
  const code = (error as {code?: string})?.code || '';
  if (/unauthorized|permission-denied/.test(code)) return `${code}: Your account cannot save this image. Sign in as an active Admin; no permission rules were changed.`;
  if (/unauthenticated/.test(code)) return `${code}: Your sign-in expired. Sign in again as the same Admin and retry the saved image.`;
  return `${code ? `${code}: ` : ''}${error instanceof Error ? error.message : 'Image save failed. Check your connection and retry.'}`;
}
export async function uploadImageIntent(storage: FirebaseStorage, intent: ImageSaveIntent, progress: (percent: number) => void): Promise<string> {
  const target = ref(storage, intent.storagePath);
  const existing = await imageDeadline(getMetadata(target).catch(error => {
    if (error.code === 'storage/object-not-found') return null;
    throw error;
  }), 'Checking saved upload');
  if (existing) {
    if (existing.customMetadata?.imageSaveId !== intent.id || existing.customMetadata?.contentSHA256 !== intent.contentSHA256 || existing.size !== intent.blob.size) {
      throw new Error('This Storage path belongs to another image. Nothing was overwritten; ask an Admin to reconcile this saved attempt.');
    }
  } else {
    const metadata = buildProductImageUploadMetadata(intent.productCode, intent.productName, 'admin-product-images');
    const task = uploadBytesResumable(target, intent.blob, {...metadata, customMetadata: {...metadata.customMetadata, imageSaveId: intent.id, contentSHA256: intent.contentSHA256}});
    let unsubscribe = () => {};
    try {
      await imageDeadline(new Promise<void>((resolve, reject) => {
        unsubscribe = task.on('state_changed', snap => progress(snap.totalBytes ? Math.round(snap.bytesTransferred / snap.totalBytes * 100) : 0), reject, resolve);
      }), 'Image upload', 90_000, () => task.cancel());
    } finally { unsubscribe(); }
  }
  progress(100);
  return imageDeadline(getDownloadURL(target), 'Retrieving saved image URL');
}
