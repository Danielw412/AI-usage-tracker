import type { UsageStore } from '../db.js';
import type { ProviderId, TrackerRole } from '../types.js';
import {
  SYNC_PROTOCOL_VERSION,
  type CollectorStatusReport,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type ProviderSyncStatus,
  type UploadRequest,
  type UploadResponse
} from './protocol.js';

export interface SyncSource {
  provider: ProviderId;
  store: UsageStore;
  enabled: boolean;
  /** Start of the last completed full scan of local logs, minus a margin. */
  scannedThrough: () => number | null;
}

export interface SyncClientOptions {
  centralUrl: string;
  secret: string;
  deviceId: string;
  deviceLabel: string;
  installId: string;
  role?: TrackerRole;
  version: string;
  sources: SyncSource[];
  batchSize: number;
  debounceMs: number;
  heartbeatMs: number;
  maxBackoffMs: number;
  /** First retry delay; doubles on every consecutive failure. */
  initialBackoffMs?: number;
  requestTimeoutMs?: number;
  watching?: () => boolean;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export type SyncState = 'starting' | 'synced' | 'syncing' | 'offline' | 'unauthorized' | 'rejected';

export interface CollectorSyncStatus {
  centralUrl: string;
  state: SyncState;
  online: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRetryAt: number | null;
  serverInstanceId: string | null;
  uploadedRecords: number;
  rejectedRecords: number;
  pending: Partial<Record<ProviderId, number>>;
  oldestPendingAt: number | null;
}

class SyncHttpError extends Error {
  constructor(message: string, readonly state: SyncState, readonly permanent = false) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

function seconds(ms = Date.now()): number {
  return Math.floor(ms / 1000);
}

/**
 * Collector side of synchronization. Local changes land in each store's
 * outbox inside the same transaction that indexed them; this client uploads
 * the outbox in batches, deletes exactly what the server acknowledged, and
 * keeps everything else queued across restarts. While the server is
 * unreachable it retries with exponential backoff and logs only when the
 * connection state changes.
 */
export function createSyncClient(options: SyncClientOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? ((message: string) => console.log(message));
  const initialBackoffMs = options.initialBackoffMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const base = options.centralUrl.replace(/\/+$/, '');

  let state: SyncState = 'starting';
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let nextRetryAt: number | null = null;
  let serverInstanceId: string | null = null;
  let uploadedRecords = 0;
  let rejectedRecords = 0;
  let inFlight: Promise<boolean> | null = null;
  let again = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const unsubscribers: Array<() => void> = [];

  async function post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.secret}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new SyncHttpError(cause ? `${cause} ${base}` : `cannot reach ${base}: ${(error as Error).message}`, 'offline');
    }
    if (response.ok) return (await response.json()) as T;
    let detail = '';
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === 'string') detail = payload.error;
    } catch {
      // Not JSON; the status code is enough.
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncHttpError(detail || 'the server rejected the sync secret', 'unauthorized');
    }
    if (response.status === 400 || response.status === 409) {
      throw new SyncHttpError(detail || `the server refused the request (${response.status})`, 'rejected');
    }
    throw new SyncHttpError(detail || `server answered ${response.status}`, 'offline');
  }

  function statusReport(): CollectorStatusReport {
    const providers: CollectorStatusReport['providers'] = {};
    for (const source of options.sources) {
      const stats = source.store.outboxStats();
      const scanned = source.enabled ? source.scannedThrough() : null;
      const syncedThrough = scanned === null
        ? null
        : stats.oldestPendingAt !== null
          ? Math.min(scanned, stats.oldestPendingAt - 1)
          : scanned;
      const report: ProviderSyncStatus = {
        enabled: source.enabled,
        pending: stats.pending,
        oldestPendingAt: stats.oldestPendingAt,
        scannedThrough: scanned,
        syncedThrough
      };
      providers[source.provider] = report;
    }
    return {
      role: options.role ?? 'collector',
      version: options.version,
      now: seconds(),
      watching: options.watching?.() ?? false,
      lastError: consecutiveFailures > 0 ? lastError : null,
      providers
    };
  }

  function identity() {
    return {
      protocol: SYNC_PROTOCOL_VERSION,
      deviceId: options.deviceId,
      deviceLabel: options.deviceLabel,
      installId: options.installId
    };
  }

  /**
   * A server we have not exported our history to (first contact, or a server
   * whose database was replaced) gets everything, not just new changes.
   */
  function noteServer(instanceId: string): boolean {
    serverInstanceId = instanceId;
    let exported = false;
    for (const source of options.sources) {
      if (source.store.exportedToInstance() === instanceId) continue;
      const queued = source.store.exportAllToOutbox(instanceId);
      if (queued > 0) {
        log(`Queued ${queued} ${source.provider} records to send this device's full history to the central server.`);
        exported = true;
      }
    }
    return exported;
  }

  async function heartbeat(): Promise<void> {
    const request: HeartbeatRequest = { ...identity(), status: statusReport() };
    const response = await post<HeartbeatResponse>('/api/sync/heartbeat', request);
    noteServer(response.serverInstanceId);
  }

  async function drain(source: SyncSource): Promise<number> {
    let uploaded = 0;
    while (!stopped) {
      const records = source.store.readOutbox(options.batchSize);
      if (records.length === 0) break;
      const request: UploadRequest = { ...identity(), provider: source.provider, records };
      const response = await post<UploadResponse>('/api/sync/upload', request);
      const done = [...response.acked, ...response.rejected.map((item) => item.seq)];
      source.store.ackOutbox(done);
      uploaded += response.acked.length;
      uploadedRecords += response.acked.length;
      if (response.rejected.length > 0) {
        rejectedRecords += response.rejected.length;
        log(`The central server rejected ${response.rejected.length} ${source.provider} records: ${response.rejected[0].error}`);
      }
      if (done.length === 0) throw new SyncHttpError('the server acknowledged nothing', 'offline');
      noteServer(response.serverInstanceId);
    }
    return uploaded;
  }

  /** The server answered: whatever broke the connection is over. */
  function markConnected(): void {
    if (consecutiveFailures > 0) {
      const pending = options.sources.reduce((sum, source) => sum + source.store.outboxStats().pending, 0);
      log(`Reconnected to the central server at ${base}; uploading ${pending} queued records.`);
    }
    consecutiveFailures = 0;
    nextRetryAt = null;
    lastError = null;
  }

  function markSynced(): void {
    lastSuccessAt = seconds();
    state = 'synced';
  }

  function scheduleRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    const exponent = Math.min(consecutiveFailures - 1, 20);
    const delay = Math.min(options.maxBackoffMs, initialBackoffMs * 2 ** exponent);
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    nextRetryAt = seconds(Date.now() + jittered);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      nextRetryAt = null;
      void flush();
    }, jittered);
    retryTimer.unref();
  }

  function markFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const nextState = error instanceof SyncHttpError ? error.state : 'offline';
    const pending = options.sources.reduce((sum, source) => sum + source.store.outboxStats().pending, 0);
    // Log on state changes only; a server that stays down is reported once.
    if (consecutiveFailures === 0 || nextState !== state || message !== lastError) {
      const hint = nextState === 'offline' ? 'keeping usage queued locally and retrying' : 'will retry';
      log(`Central server sync failed (${message}); ${hint}. ${pending} records pending.`);
    }
    consecutiveFailures += 1;
    lastError = message;
    state = nextState;
    if (!stopped) scheduleRetry();
  }

  /** Upload everything queued, then report status. Resolves true on success. */
  function flush(): Promise<boolean> {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      lastAttemptAt = seconds();
      if (state !== 'offline') state = 'syncing';
      try {
        // Learn which server this is first, so a new one gets our full history.
        await heartbeat();
        markConnected();
        do {
          again = false;
          for (const source of options.sources) await drain(source);
        } while (again && !stopped);
        // Report the drained queue, so the server knows how far this device is synced.
        await heartbeat();
        markSynced();
        return true;
      } catch (error) {
        markFailure(error);
        return false;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** Local changes arrived: upload soon, coalescing bursts. */
  function kick(): void {
    if (stopped || retryTimer) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, options.debounceMs);
    debounceTimer.unref();
  }

  function start(): void {
    stopped = false;
    for (const source of options.sources) unsubscribers.push(source.store.onOutboxChange(kick));
    heartbeatTimer = setInterval(() => {
      if (!retryTimer) void flush();
    }, options.heartbeatMs);
    heartbeatTimer.unref();
    void flush();
  }

  function stop(): void {
    stopped = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    for (const timer of [debounceTimer, retryTimer]) if (timer) clearTimeout(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    debounceTimer = null;
    retryTimer = null;
    heartbeatTimer = null;
  }

  function status(): CollectorSyncStatus {
    let oldestPendingAt: number | null = null;
    const pending: CollectorSyncStatus['pending'] = {};
    for (const source of options.sources) {
      const stats = source.store.outboxStats();
      pending[source.provider] = stats.pending;
      if (stats.oldestPendingAt !== null) {
        oldestPendingAt = oldestPendingAt === null ? stats.oldestPendingAt : Math.min(oldestPendingAt, stats.oldestPendingAt);
      }
    }
    return {
      centralUrl: base,
      state,
      online: consecutiveFailures === 0 && lastSuccessAt !== null,
      lastAttemptAt,
      lastSuccessAt,
      lastError,
      consecutiveFailures,
      nextRetryAt,
      serverInstanceId,
      uploadedRecords,
      rejectedRecords,
      pending,
      oldestPendingAt
    };
  }

  return { start, stop, flush, kick, status };
}

export type SyncClient = ReturnType<typeof createSyncClient>;
