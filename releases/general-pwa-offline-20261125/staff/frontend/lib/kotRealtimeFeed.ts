// Read-only lifecycle shared by the station and Ready to Serve screens.
export const KOT_RESYNC_INTERVAL_MS = 15_000;
export type KotReadGate = { busy: boolean };
export type KotFeedState = { loading: boolean; error: string };
export type KotFeedOptions<Q, T> = {
  queries: Array<{ storeId: string; query: Q }>;
  subscribe: (query: Q, next: (items: T[]) => void, error: (error: unknown) => void) => () => void;
  readServer: (query: Q) => Promise<T[]>;
  publish: (items: T[], state: KotFeedState) => void;
  readGate?: KotReadGate;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
};

function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-z/-]+$/.test(code) ? code : 'unavailable';
}

export function createKotRealtimeFeed<Q, T>(options: KotFeedOptions<Q, T>) {
  let active = true;
  let pendingRead: Promise<void> | null = null;
  const gate = options.readGate || { busy: false };
  const entries = [...new Map(options.queries.map(entry => [entry.storeId, entry])).values()]
    .sort((a, b) => a.storeId.localeCompare(b.storeId));
  const rows = new Map<string, T[]>();
  const versions = new Map<string, number>();
  const errors = new Map<string, string>();
  const failedListeners = new Set<string>();
  const listenerGenerations = new Map<string, number>();
  const unsubscribes = new Map<string, () => void>();

  const publish = () => {
    if (!active) return;
    const failed = errors.size > 0;
    options.publish(entries.flatMap(entry => rows.get(entry.storeId) || []), {
      loading: !failed && entries.some(entry => !rows.has(entry.storeId)),
      error: failed
        ? `Ticket updates are delayed (${[...new Set(errors.values())].sort().join(', ')}). Retrying automatically.`
        : '',
    });
  };
  const attach = (entry: typeof entries[number]) => {
    if (!active) return;
    const generation = (listenerGenerations.get(entry.storeId) || 0) + 1;
    listenerGenerations.set(entry.storeId, generation);
    const isCurrent = () => active && listenerGenerations.get(entry.storeId) === generation;
    unsubscribes.get(entry.storeId)?.();
    unsubscribes.delete(entry.storeId);
    failedListeners.delete(entry.storeId);
    try {
      const unsubscribe = options.subscribe(entry.query, items => {
        if (!isCurrent()) return;
        versions.set(entry.storeId, (versions.get(entry.storeId) || 0) + 1);
        rows.set(entry.storeId, items);
        errors.delete(entry.storeId);
        publish();
      }, error => {
        if (!isCurrent()) return;
        failedListeners.add(entry.storeId);
        errors.set(entry.storeId, safeErrorCode(error));
        // Keep last known rows. A failed query is not an empty successful result.
        publish();
      });
      unsubscribes.set(entry.storeId, unsubscribe);
    } catch (error) {
      failedListeners.add(entry.storeId);
      errors.set(entry.storeId, safeErrorCode(error));
      publish();
    }
  };

  const resync = (): Promise<void> => {
    if (!active || entries.length === 0) return Promise.resolve();
    if (pendingRead) return pendingRead;
    // Shared across auth/store generations: don't overlap an uncancellable old read.
    if (gate.busy) return Promise.resolve();
    gate.busy = true;
    for (const entry of entries) if (failedListeners.has(entry.storeId)) attach(entry);
    const startedVersions = new Map(versions);
    pendingRead = Promise.allSettled(entries.map(entry => Promise.resolve().then(() => options.readServer(entry.query))))
      .then(results => {
        if (!active) return;
        results.forEach((result, index) => {
          const storeId = entries[index].storeId;
          // A newer listener snapshot always wins over a read started earlier.
          if ((versions.get(storeId) || 0) !== (startedVersions.get(storeId) || 0)) return;
          if (result.status === 'fulfilled') {
            rows.set(storeId, result.value);
            errors.delete(storeId);
          } else {
            errors.set(storeId, safeErrorCode(result.reason));
          }
        });
        // Publish all refreshed stores together, never clear rows while reading.
        publish();
      }).finally(() => {
        gate.busy = false;
        pendingRead = null;
      });
    return pendingRead;
  };

  publish();
  entries.forEach(attach);
  const schedule = options.schedule || ((callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  });
  const stopTimer = entries.length ? schedule(() => { void resync(); }, KOT_RESYNC_INTERVAL_MS) : () => {};
  return {
    resync,
    dispose: () => {
      active = false;
      stopTimer();
      unsubscribes.forEach(unsubscribe => unsubscribe());
      unsubscribes.clear();
    },
  };
}
