import React, { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { OfflineCashReceipt } from '../../components/pos/PosOfflineStatus';
import { auth } from '../../lib/firebase';
import { deviceIdentity, entries, getMeta, reconcile, register, synchronize, verifySnapshotForRead, type Entry, type Snapshot } from '../../lib/offline/journal';
import { exportRecoveryFile, importRecoveryFile } from '../../lib/offline/recoveryFile';
import { persistenceStatus } from '../../lib/offline/storage';
import './offlineCash.css';

const money = (amount: number) => `₹${Number(amount).toFixed(2)}`;
const journalStatus: Record<Entry['status'], string> = {
  PENDING: 'PENDING SYNC',
  UNCERTAIN: 'OUTCOME UNCERTAIN',
  CONFLICT: 'RECONCILIATION REQUIRED',
  SYNCED: 'SYNCED',
};

export default function OfflineCash() {
  const [user, setUser] = useState(auth.currentUser);
  const [checked, setChecked] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [list, setList] = useState<Entry[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [store, setStore] = useState(new URLSearchParams(location.search).get('storeId') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState('checking');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ deviceId: string; keyFingerprint: string } | null>(null);
  const reload = useCallback(async () => setList(await entries()), []);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The offline Cash action could not be completed.'); }
    finally { setBusy(false); }
  };

  useEffect(() => { void persistenceStatus().then(setStorage); }, []);
  useEffect(() => onAuthStateChanged(auth, next => { setUser(next); setChecked(true); }), []);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const showStorageError = () => { if (active) setError('The offline Cash journal could not be read from this browser.'); };
    void getMeta('snapshot').then(async saved => {
      if(!active || !user || saved?.uid!==user.uid || !saved?.storeId)return;
      await verifySnapshotForRead(saved);
      if(!active || user.uid!==auth.currentUser?.uid)return;
      setSnapshot(saved);
      setStore(current => current || saved.storeId);
    }).catch(showStorageError);
    void reload().catch(showStorageError);
    const checkConnectivity = () => {
      const current = ++generation;
      if (!navigator.onLine) { setOnline(false); return; }
      void fetch('/index.html', { method: 'HEAD', cache: 'no-store' })
        .then(response => { if (active && current === generation) setOnline(response.ok); })
        .catch(() => { if (active && current === generation) setOnline(false); });
    };
    checkConnectivity();
    const timer = window.setInterval(checkConnectivity, 10000);
    window.addEventListener('online', checkConnectivity);
    window.addEventListener('offline', checkConnectivity);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', checkConnectivity);
      window.removeEventListener('offline', checkConnectivity);
    };
  }, [reload,user]);
  useEffect(() => {
    if (!online || !user || !store) return;
    const sync = () => void synchronize(reload,store).catch(() => {
      setError('Could not check the original offline Cash references. The journal has been kept.');
    });
    sync();
    const timer = window.setInterval(sync, 15000);
    return () => window.clearInterval(timer);
  }, [online, user, store, reload]);
  useEffect(() => {
    const reply = (event: MessageEvent) => {
      if (event.data?.type === 'UPDATE_SAFETY_QUERY') {
        event.source?.postMessage({ type: 'UPDATE_SAFETY_REPLY', id: event.data.id, safe: false });
      }
    };
    navigator.serviceWorker?.addEventListener('message', reply);
    return () => navigator.serviceWorker?.removeEventListener('message', reply);
  }, []);

  const supervisor = snapshot?.uid === user?.uid && snapshot?.storeId === store
    && ['ADMIN', 'STORE_MANAGER'].includes(snapshot?.role || '');
  const mine = checked && user
    ? list.filter(entry => entry.payload.storeId === store && (entry.payload.uid === user.uid || (supervisor && entry.payload.deviceId===snapshot?.deviceId)))
    : [];
  const receipt = mine.find(entry => entry.id === receiptId);

  return <main className="offline-app">
    <header className="no-print">
      <div><h1>Offline Cash setup and journal</h1></div>
      <b className={online ? 'online' : 'offline'}>{online ? 'ONLINE' : 'OFFLINE'}</b>
      <a href="/pos">Return to POS</a>
    </header>
    <section className="no-print">
      <p>Use POS to take new Cash payments. Saved offline references and provisional receipts are available here.</p>
      {error && <div role="alert" className="error">{error}</div>}
      {notice && <div role="status" className="notice">{notice}</div>}
      {!checked ? <p>Restoring signed-in session…</p> : !user ? <form onSubmit={event => {
        event.preventDefault();
        void act(() => signInWithEmailAndPassword(auth, email, password));
      }}>
        <h2>Sign in to review this device</h2>
        <label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
        <button disabled={!online || busy}>Sign in</button>
      </form> : <>
        <div className="setup">
          <span>{user.email}</span>
          <label>Store ID<input value={store} disabled={busy} onChange={event => { setReceiptId(null); setStore(event.target.value); }} /></label>
          <button type="button" disabled={busy} onClick={() => void act(async () => {
            setIdentity(await deviceIdentity());
            setNotice('Public device identity is ready for owner approval. Enrollment and billing each require their existing approval.');
          })}>Create / show device identity</button>
          <button type="button" disabled={!online || busy || !store} onClick={() => void act(async () => {
            await register(store);
            setIdentity(await deviceIdentity());
            setNotice('Device enrolled under the separate approval. Cash billing requires an active policy for this user, store and device.');
          })}>Enroll approved device (Admin)</button>
          <button type="button" disabled={busy} onClick={() => void act(async () => {
            await signOut(auth);
            setReceiptId(null);
            setIdentity(null);
            setNotice('');
          })}>Sign out</button>
        </div>
        {identity && <section aria-label="Public device identity">
          <h2>Device identity for approval</h2>
          <p>Device ID: <code>{identity.deviceId}</code></p>
          <p>Public key fingerprint (SHA256 / SPKI): <code>{identity.keyFingerprint}</code></p>
          <p>The private key stays in this browser profile. Keep this profile for pending bills.</p>
        </section>}
        {snapshot?.uid === user.uid && snapshot.storeId === store && <p>Saved session for {snapshot.storeName} · {snapshot.role}</p>}
        <section className="journal">
          <h2>Saved till operations</h2>
          <p>Browser storage · {storage}</p>
          <button type="button" disabled={busy} onClick={() => void act(async () => {
            setStorage(await persistenceStatus(true));
          })}>Request persistent storage</button>
          <button type="button" disabled={!store || busy || !mine.some(e => e.payload.uid === user.uid)} onClick={() => void act(async () => {
            const blob = await exportRecoveryFile(store);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = 'coffee-bond-signed-journal.json'; link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 60000);
            setNotice('Recovery file prepared. Keep it with the store’s records.');
          })}>Save signed recovery file</button>
          <label>Restore signed records on this till<input type="file" accept=".json,application/json" disabled={!store || busy}
            onChange={event => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
              if (file) void act(async () => {
                const count = await importRecoveryFile(store, await file.text());
                await reload(); setNotice(`Restored ${count} missing records. Synchronization checks each original reference.`);
              });
            }}/></label>
          <button type="button" disabled={!online || busy} onClick={() => void act(async () => {
            await synchronize(reload,store);
            await reload();
          })}>Check original status and synchronize</button>
          {mine.length === 0 ? <p>No saved bills for this staff and store.</p> : mine.map(entry => <article key={entry.id}>
            <strong>{journalStatus[entry.status]}</strong>
            <p>{entry.id} · {entry.payload.receipt && entry.payload.totals ? money(entry.payload.totals.grandTotal) : (entry.payload.kind || entry.payload.type || 'Table operation')} {entry.payload.table && `· Table ${entry.payload.table.tableId}`}</p>
            {entry.result?.orderNumber && <p>Confirmed sale: {entry.result.orderNumber}</p>}
            {entry.conflicts?.length ? <p>{entry.conflicts.join(', ')}. Original Cash and snapshot retained.</p> : null}
            {entry.error && <p role="alert">{entry.error}</p>}
            {entry.payload.receipt && entry.payload.totals && <button type="button" onClick={() => setReceiptId(entry.id)}>View offline receipt</button>}
            {supervisor && entry.status === 'CONFLICT' && !entry.payload.kind && <button type="button" disabled={!online || busy} onClick={() => {
              const reason = window.prompt('Manager reconciliation: explain why the original received Cash and approved financial snapshot should be honored. Table revision/product-unavailable conflicts require separate operational review.');
              if (reason?.trim()) void act(async () => { await reconcile(entry, reason.trim()); await reload(); });
            }}>Manager reconciliation</button>}
          </article>)}
        </section>
      </>}
    </section>
    {receipt && <section className="receipt-preview">
      <div className="no-print">
        <button type="button" onClick={() => window.print()}>Print offline receipt</button>
        <button type="button" onClick={() => setReceiptId(null)}>Close receipt</button>
      </div>
      <OfflineCashReceipt entry={receipt} />
    </section>}
  </main>;
}
