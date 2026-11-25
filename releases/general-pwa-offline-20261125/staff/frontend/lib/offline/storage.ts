const databaseName = 'coffee-bond-offline-cash-v1';

function storageError(error: unknown, fallback: string): Error {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') return Error('Device storage is full. The operation was not saved. Keep the journal and free space outside this app.');
  if (name === 'SecurityError' || name === 'NotAllowedError') return Error('Browser storage access was denied. Use the enrolled browser profile and allow site storage.');
  if (name === 'ConstraintError') return Error('This local operation or table revision is already recorded. Review its original reference.');
  return error instanceof Error ? error : Error(fallback);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(databaseName, 1); }
    catch (error) { reject(storageError(error, 'Cannot open the local till journal.')); return; }
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(Error('A browser window is blocking the journal. Close other POS windows and retry.'));
    };
    request.onupgradeneeded = () => {
      for (const name of ['meta', 'entries', 'closures']) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, {keyPath:'id'});
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(storageError(request.error, 'Cannot open the local till journal.'));
  });
}

export async function transaction<T>(stores: string[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction, done: (value:T) => void) => void): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve,reject) => {
      const tx = db.transaction(stores, mode, mode === 'readwrite' ? {durability:'strict'} : undefined);
      let value:T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(storageError(tx.error, 'Journal transaction aborted. No changes were saved.'));
      try { run(tx, result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } catch (error) {
    throw storageError(error, 'Local journal unavailable.');
  } finally { db.close(); }
}

export async function persistenceStatus(request = false): Promise<'persistent'|'best-effort'|'unavailable'> {
  try {
    const storage = navigator.storage;
    if (!storage?.persisted) return 'unavailable';
    if (await storage.persisted()) return 'persistent';
    return request && storage.persist && await storage.persist() ? 'persistent' : 'best-effort';
  } catch { return 'unavailable'; }
}
