import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanDisplayText } from './messageText.js';
import { estimateUsageCost } from './pricing.js';
import { ensureSchema, type LegacyPartRow } from './schema.js';
import {
  sampleRecordKey,
  type ParsedSyncRecord,
  type SyncEventData,
  type SyncPartData,
  type SyncPromptData,
  type SyncRecord,
  type SyncRecordKind
} from './sync/protocol.js';
import type {
  AccountSummary,
  CloudTask,
  DailyUsage,
  ModelUsageSummary,
  PricingStatus,
  PromptMetric,
  ProviderId,
  RateLimitWindow,
  SessionPartKind,
  ThreadPartSummary,
  ThreadSource,
  ThreadSummary,
  TokenUsage
} from './types.js';

/**
 * Bump when the meaning of stored thread metadata changes. Older builds stored
 * raw prompt text in display_name, so that column is cleared on upgrade and
 * repopulated from the provider's generated names.
 */
const METADATA_VERSION = '3';
const AUTO_REVIEW_MODEL = 'codex-auto-review';
/** Device id used when a caller does not configure one (tests, older callers). */
export const DEFAULT_DEVICE_ID = 'local';

export interface StoredThreadEvent extends TokenUsage {
  eventKey: string;
  threadId: string;
  sourceFile: string;
  observedAt: number;
  model: string;
  estimatedApiCostUsd: number | null;
}

export interface ThreadMetadataInput {
  threadId: string;
  /** Only ever a provider-generated (or user-set) chat name. Pass null when unknown. */
  displayName: string | null;
  preview: string | null;
  updatedAt: number;
  source?: ThreadSource | null;
  sourceLabel?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  gitBranch?: string | null;
  projectName?: string | null;
  archived?: boolean;
}

export interface TokenEventRow {
  observedAt: number;
  threadId: string;
  model: string;
  partKind: SessionPartKind;
  /** Device that logged the event. */
  deviceId?: string;
  totalTokens: number;
  estimatedApiCostUsd: number | null;
}

export interface PromptRunRow {
  threadId: string;
  startedAt: number;
  completedAt: number;
  primaryModel: string;
}

export type TokenTotals = TokenUsage & {
  threads: number;
  estimatedApiCostUsd: number;
  pricedThreads: number;
  unknownPriceThreads: number;
};

/** Lifetime figures computed from the store's own token events. */
export type LocalAccountStats = Pick<
  AccountSummary,
  'lifetimeTokens' | 'peakDailyTokens' | 'longestRunningTurnSec' | 'currentStreakDays' | 'longestStreakDays'
>;

/** One session part as a parser produced it. */
export interface IndexedPart {
  summary: ThreadPartSummary;
  events: StoredThreadEvent[];
  prompts: PromptMetric[];
  /** Quota samples embedded in the log, if the provider writes any. */
  limits?: RateLimitWindow[];
}

export type LocalFileStatus = 'indexed' | 'superseded' | 'empty';

/** Where one local log file was indexed up to. */
export interface LocalFileRecord {
  path: string;
  partIds: string[];
  modifiedMs: number;
  sizeBytes: number;
  parserVersion: string;
  status: LocalFileStatus;
  /** Byte offset just past the last newline the saved parser state covers. */
  tailOffset: number | null;
  /** Serialized parser state at `tailOffset`, for incremental parsing. */
  tailState: string | null;
  headLength: number | null;
  headHash: string | null;
  anchorHash: string | null;
  /** Another file whose changes require this one to be parsed again. */
  dependsOn: string | null;
  dependsStat: string | null;
  indexedAt: number;
}

export interface FileIndexUpdate {
  /**
   * `full` replaces everything the file produced before; `incremental` only adds
   * and updates rows produced by newly appended lines.
   */
  mode: 'full' | 'incremental';
  /** `null`: nothing indexable, leave stored rows alone. `[]`: superseded, remove them. */
  parts: IndexedPart[] | null;
  /** Part ids the file could have produced before it was tracked here (migrated rows). */
  candidatePartIds?: string[];
  metadata?: ThreadMetadataInput[];
  file: Omit<LocalFileRecord, 'path' | 'partIds' | 'indexedAt'>;
}

export interface OutboxStats {
  pending: number;
  /** Log timestamp of the oldest event or quota sample still waiting. */
  oldestPendingAt: number | null;
  oldestCreatedAt: number | null;
}

export interface ThreadLookupEntry {
  title: string;
  model: string;
  source: ThreadSource;
  sourceLabel: string | null;
  projectName: string | null;
  deviceIds: string[];
}

export interface CachedAttribution {
  signature: string;
  resultJson: string;
  computedAt: number;
}

export interface UsageStoreOptions {
  /** SQLite file name inside the data directory, or an absolute path. */
  file: string;
  provider: ProviderId;
  /** Directory holding the database. Defaults to ./data. */
  dataDir?: string;
  /** Device id stamped on everything this machine indexes. */
  deviceId?: string;
  /** Record every local change in the sync outbox (collector role). */
  outbox?: boolean;
  /** Stable part id for a row written by a pre-multi-device build. */
  legacyPartId?: (row: LegacyPartRow) => string;
}

interface PartRow {
  partId: string;
  deviceId: string;
  sourceFile: string;
  threadId: string;
  partKind: SessionPartKind;
  title: string | null;
  projectPath: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  primaryModel: string;
  userMessageCount: number;
  source: ThreadSource | null;
  sourceLabel: string | null;
  reportedCostUsd: number | null;
}

interface PartTotalsRow extends TokenUsage {
  partId: string;
  threadId: string;
  partKind: SessionPartKind;
  deviceId: string;
  estimatedApiCostUsd: number | null;
  pricedEvents: number;
  unpricedEvents: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

interface PartModelRow {
  partId: string;
  model: string;
  totalTokens: number;
}

interface MetadataRow {
  threadId: string;
  displayName: string | null;
  preview: string | null;
  updatedAt: number;
  source: ThreadSource | null;
  sourceLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  gitBranch: string | null;
  projectName: string | null;
  archived: number;
}

interface PromptRow extends TokenUsage {
  promptId: string;
  partId: string;
  deviceId: string;
  sourceFile: string;
  threadId: string;
  turnId: string | null;
  sequence: number;
  prompt: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  timingEstimated: number;
  primaryModel: string;
  modelsJson: string;
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
}

interface EventRow extends TokenUsage {
  eventKey: string;
  partId: string;
  deviceId: string;
  threadId: string;
  partKind: SessionPartKind;
  observedAt: number;
  model: string;
  estimatedApiCostUsd: number | null;
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

/** Temporary workspaces are named by hash, which is not a useful project label. */
function readableProjectName(name: string | null): string | null {
  if (!name) return null;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name) || /^[0-9a-f]{24,}$/i.test(name)) return null;
  return name;
}

function fallbackTitle(source: ThreadSource, sourceLabel: string | null, projectName: string | null): string {
  const readable = readableProjectName(projectName);
  const scope = readable ? ` in ${readable}` : '';
  switch (source) {
    case 'exec':
      return `${sourceLabel ? `${sourceLabel} run` : 'Scripted run'}${scope}`;
    case 'review':
      return `Auto-review session${scope}`;
    case 'subagent':
      return `Subagent session${scope}`;
    case 'cloud':
      return `Cloud task${scope}`;
    case 'voice':
      return `Voice session${scope}`;
    default:
      return `Untitled chat${scope}`;
  }
}

function projectNameFromPath(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const parts = projectPath.replace(/^\\\\\?\\/, '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

function streakFromDates(dates: string[], today: string, yesterday: string): {
  currentStreakDays: number;
  longestStreakDays: number;
} {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return { currentStreakDays: 0, longestStreakDays: 0 };
  const dayMs = 86_400_000;
  const toDay = (value: string): number => Math.round(Date.parse(`${value}T00:00:00Z`) / dayMs);
  let longest = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (toDay(sorted[index]) - toDay(sorted[index - 1]) === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
  }
  const last = sorted.at(-1)!;
  // The current streak only counts if it reaches today or yesterday.
  const current = last === today || last === yesterday ? run : 0;
  return { currentStreakDays: current, longestStreakDays: longest };
}

function localDateString(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function partIdOf(summary: Pick<ThreadPartSummary, 'partId' | 'sourceFile'>): string {
  return summary.partId ?? summary.sourceFile;
}

function eventData(event: StoredThreadEvent, summary: ThreadPartSummary): SyncEventData {
  return {
    eventId: event.eventKey,
    partId: partIdOf(summary),
    threadId: event.threadId,
    partKind: summary.partKind,
    observedAt: event.observedAt,
    model: event.model,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0,
    cacheWrite1hInputTokens: event.cacheWrite1hInputTokens ?? 0,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
    totalTokens: event.totalTokens,
    estimatedApiCostUsd: event.estimatedApiCostUsd
  };
}

function partData(summary: ThreadPartSummary): SyncPartData {
  return {
    partId: partIdOf(summary),
    threadId: summary.threadId,
    partKind: summary.partKind,
    sourceFile: summary.sourceFile,
    title: summary.title,
    projectPath: summary.projectPath,
    startedAt: summary.startedAt,
    updatedAt: summary.updatedAt,
    primaryModel: summary.primaryModel,
    models: summary.models,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    cacheWriteInputTokens: summary.cacheWriteInputTokens ?? 0,
    cacheWrite1hInputTokens: summary.cacheWrite1hInputTokens ?? 0,
    outputTokens: summary.outputTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    totalTokens: summary.totalTokens,
    estimatedApiCostUsd: summary.estimatedApiCostUsd,
    pricingStatus: summary.pricingStatus,
    userMessageCount: summary.userMessageCount,
    source: summary.source,
    sourceLabel: summary.sourceLabel,
    reportedCostUsd: summary.reportedCostUsd ?? null
  };
}

function promptData(prompt: PromptMetric, partId: string): SyncPromptData {
  return {
    ...prompt,
    partId,
    cacheWriteInputTokens: prompt.cacheWriteInputTokens ?? 0,
    cacheWrite1hInputTokens: prompt.cacheWrite1hInputTokens ?? 0
  };
}

function eventSignature(value: Omit<SyncEventData, 'eventId' | 'partId'>): string {
  return [
    value.threadId,
    value.partKind,
    value.observedAt,
    value.model,
    value.inputTokens,
    value.cachedInputTokens,
    value.cacheWriteInputTokens ?? 0,
    value.cacheWrite1hInputTokens ?? 0,
    value.outputTokens,
    value.reasoningOutputTokens,
    value.totalTokens,
    value.estimatedApiCostUsd ?? 'null'
  ].join('|');
}

function partSignature(value: SyncPartData): string {
  return JSON.stringify([
    value.threadId, value.partKind, value.sourceFile, value.title, value.projectPath, value.startedAt,
    value.updatedAt, value.primaryModel, value.models, value.inputTokens, value.cachedInputTokens,
    value.cacheWriteInputTokens ?? 0, value.cacheWrite1hInputTokens ?? 0, value.outputTokens,
    value.reasoningOutputTokens, value.totalTokens, value.estimatedApiCostUsd, value.pricingStatus,
    value.userMessageCount, value.source, value.sourceLabel, value.reportedCostUsd
  ]);
}

function promptSignature(value: SyncPromptData): string {
  return JSON.stringify([
    value.partId, value.sourceFile, value.threadId, value.turnId, value.sequence, value.prompt, value.startedAt,
    value.completedAt, value.durationMs, value.timeToFirstTokenMs, Boolean(value.timingEstimated),
    value.primaryModel, value.models, value.inputTokens, value.cachedInputTokens,
    value.cacheWriteInputTokens ?? 0, value.cacheWrite1hInputTokens ?? 0, value.outputTokens,
    value.reasoningOutputTokens, value.totalTokens, value.estimatedApiCostUsd, value.pricingStatus
  ]);
}

export type UsageStore = ReturnType<typeof createUsageStore>;

/**
 * Open (or create) one provider's usage database. Every provider gets its own
 * file so Codex and Claude Code histories never mix. On the central server the
 * same store also holds the events collectors upload, stamped with their device.
 */
export function createUsageStore(options: UsageStoreOptions) {
  const dataDir = options.dataDir ?? path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.isAbsolute(options.file) ? options.file : path.join(dataDir, options.file);
  const localDeviceId = options.deviceId ?? DEFAULT_DEVICE_ID;
  const outboxEnabled = options.outbox === true;
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  // Every commit (and so every outbox row and every acknowledged upload) must
  // survive a power cut.
  db.exec('PRAGMA synchronous = FULL;');

  ensureSchema(db, {
    deviceId: localDeviceId,
    legacyPartId: options.legacyPartId ?? ((row) => row.sourceFile)
  });

  function getMeta(key: string): string | null {
    const row = db.prepare('SELECT value FROM dashboard_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  function setMeta(key: string, value: string): void {
    db.prepare(`
      INSERT INTO dashboard_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  if (getMeta('metadata_version') !== METADATA_VERSION) {
    db.exec('UPDATE thread_metadata SET display_name = NULL');
    setMeta('metadata_version', METADATA_VERSION);
  }
  if (getMeta('provider') === null) setMeta('provider', options.provider);

  // A configured DEVICE_ID that changed renames this machine's own rows, so its
  // history stays one device instead of splitting in two.
  const previousDeviceId = getMeta('local_device_id');
  if (previousDeviceId !== localDeviceId) {
    if (previousDeviceId) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const table of ['session_parts', 'session_part_token_events', 'prompt_metrics', 'rate_limit_snapshots']) {
          db.prepare(`UPDATE ${table} SET device_id = ? WHERE device_id = ?`).run(localDeviceId, previousDeviceId);
        }
        // Cached window results name the devices they split usage between.
        db.exec('DELETE FROM window_attribution;');
        db.exec('COMMIT;');
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    }
    setMeta('local_device_id', localDeviceId);
  }

  // ---------------------------------------------------------------------------
  // Transactions and change tracking
  // ---------------------------------------------------------------------------

  let depth = 0;
  let changedRange: [number, number] | null = null;
  let summariesDirty = false;
  let outboxDirty = false;
  const outboxListeners = new Set<() => void>();

  let summaryCache: { builtAt: number; version: number; value: ThreadSummary[] } | null = null;
  let summaryVersion = 0;
  /** Bumped after every commit that changed events or quota samples; lets callers memoize. */
  let eventVersion = 0;
  let sampleVersion = 0;
  let samplesDirty = false;

  /** Call after any write that changes thread rows so the summary cache is rebuilt. */
  function invalidateThreadSummaries(): void {
    summaryVersion += 1;
  }

  /** Remember that events around `observedAt` changed. */
  function touch(observedAt: number | null | undefined): void {
    summariesDirty = true;
    if (observedAt === null || observedAt === undefined || !Number.isFinite(observedAt)) return;
    changedRange = changedRange
      ? [Math.min(changedRange[0], observedAt), Math.max(changedRange[1], observedAt)]
      : [observedAt, observedAt];
  }

  const deleteAttributionStatement = db.prepare(
    'DELETE FROM window_attribution WHERE bank_start <= ? AND bank_end >= ?'
  );

  function transaction<T>(work: () => T): T {
    if (depth > 0) {
      depth += 1;
      try {
        return work();
      } finally {
        depth -= 1;
      }
    }
    db.exec('BEGIN IMMEDIATE;');
    depth = 1;
    try {
      const result = work();
      // Cached attribution for every bank that overlaps a changed event is
      // dropped in the same transaction, so it can never outlive its inputs.
      if (changedRange) deleteAttributionStatement.run(changedRange[1], changedRange[0]);
      db.exec('COMMIT;');
      if (changedRange) eventVersion += 1;
      if (samplesDirty) sampleVersion += 1;
      if (summariesDirty) invalidateThreadSummaries();
      if (outboxDirty) for (const listener of outboxListeners) listener();
      return result;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    } finally {
      depth = 0;
      changedRange = null;
      summariesDirty = false;
      samplesDirty = false;
      outboxDirty = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Outbox (collector role)
  // ---------------------------------------------------------------------------

  /** Server instance this device last exported its full history to. */
  let bootstrapInstance = getMeta('sync_bootstrap_instance');
  const insertOutboxStatement = db.prepare(`
    INSERT OR REPLACE INTO sync_outbox (kind, record_key, part_id, observed_at, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteOutboxKeyStatement = db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND record_key = ?');
  const OPPOSITE: Partial<Record<SyncRecordKind, SyncRecordKind>> = {
    event: 'remove-event',
    'remove-event': 'event',
    prompt: 'remove-prompt',
    'remove-prompt': 'prompt',
    part: 'remove-part',
    'remove-part': 'part'
  };

  /**
   * Queue a record for the central server. A newer record for the same key
   * replaces the pending one and gets a new sequence number, so an upload that
   * was already in flight for the old version cannot acknowledge the new one.
   */
  function enqueue(
    kind: SyncRecordKind,
    key: string,
    data: unknown,
    partId: string | null,
    observedAt: number | null
  ): void {
    if (!outboxEnabled) return;
    const opposite = OPPOSITE[kind];
    if (opposite) deleteOutboxKeyStatement.run(opposite, key);
    if (kind === 'remove-part') {
      // Nothing else about a removed part is worth sending.
      db.prepare(`
        DELETE FROM sync_outbox
        WHERE part_id = ? AND kind IN ('event', 'prompt', 'remove-event', 'remove-prompt')
      `).run(key);
    }
    outboxDirty = true;
    // Until the first full export reaches a server, it holds nothing from this
    // device, so a removal would only be noise.
    if (kind.startsWith('remove-') && bootstrapInstance === null) return;
    insertOutboxStatement.run(kind, key, partId, observedAt, JSON.stringify(data), Math.floor(Date.now() / 1000));
  }

  function readOutbox(limit: number): SyncRecord[] {
    return rows<{ seq: number; kind: SyncRecordKind; key: string; payload: string }>(db.prepare(`
      SELECT seq, kind, record_key AS key, payload FROM sync_outbox ORDER BY seq ASC LIMIT ?
    `).all(Math.max(1, Math.floor(limit)))).map((row) => ({
      seq: row.seq,
      kind: row.kind,
      key: row.key,
      data: JSON.parse(row.payload) as unknown
    }));
  }

  /** Delete records the server acknowledged. Returns how many were removed. */
  function ackOutbox(seqs: number[]): number {
    if (seqs.length === 0) return 0;
    const statement = db.prepare('DELETE FROM sync_outbox WHERE seq = ?');
    let removed = 0;
    transaction(() => {
      for (const seq of seqs) removed += Number(statement.run(seq).changes);
    });
    return removed;
  }

  function outboxStats(): OutboxStats {
    const row = db.prepare(`
      SELECT COUNT(*) AS pending,
             MIN(CASE WHEN kind IN ('event', 'sample') THEN observed_at END) AS oldestPendingAt,
             MIN(created_at) AS oldestCreatedAt
      FROM sync_outbox
    `).get() as { pending: number; oldestPendingAt: number | null; oldestCreatedAt: number | null };
    return row;
  }

  function onOutboxChange(listener: () => void): () => void {
    outboxListeners.add(listener);
    return () => outboxListeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Quota samples
  // ---------------------------------------------------------------------------

  const insertSnapshotStatement = db.prepare(`
    INSERT OR IGNORE INTO rate_limit_snapshots
      (observed_at, limit_key, label, used_percent, duration_mins, resets_at, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function insertSamples(limits: RateLimitWindow[], deviceId: string): number {
    let inserted = 0;
    for (const limit of limits) {
      const result = insertSnapshotStatement.run(
        limit.observedAt,
        limit.key,
        limit.label,
        limit.usedPercent,
        limit.windowDurationMins,
        limit.resetsAt,
        deviceId
      );
      if (Number(result.changes) > 0) {
        inserted += 1;
        samplesDirty = true;
        enqueue('sample', sampleRecordKey(limit), limit, null, limit.observedAt);
      }
    }
    return inserted;
  }

  function insertRateLimitSnapshot(limit: RateLimitWindow): void {
    transaction(() => insertSamples([limit], localDeviceId));
  }

  /** Store quota samples; returns how many were new. */
  function insertRateLimitSnapshots(limits: RateLimitWindow[]): number {
    if (limits.length === 0) return 0;
    return transaction(() => insertSamples(limits, localDeviceId));
  }

  /** The most recent stored sample for a window key, if any. */
  function getLatestRateLimitSnapshot(key: string): RateLimitWindow | null {
    const row = db.prepare(`
      SELECT limit_key AS key, label, used_percent AS usedPercent,
             duration_mins AS windowDurationMins, resets_at AS resetsAt,
             observed_at AS observedAt
      FROM rate_limit_snapshots
      WHERE limit_key = ?
      ORDER BY observed_at DESC
      LIMIT 1
    `).get(key) as RateLimitWindow | undefined;
    return row ?? null;
  }

  /**
   * Samples for one window duration. `keys` restricts the query to specific
   * window keys; without it every source that logged the duration is merged,
   * which is what the Codex provider relies on.
   */
  function getRateLimitHistory(
    durationMins: number,
    resetAt?: number,
    lookbackDays = 8,
    keys?: string[]
  ): RateLimitWindow[] {
    const minObserved = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
    const keyFilter = keys && keys.length > 0
      ? ` AND limit_key IN (${keys.map(() => '?').join(', ')})`
      : '';
    const keyParams = keys && keys.length > 0 ? keys : [];
    const result = resetAt !== undefined
      ? db.prepare(`
          SELECT limit_key AS key, label, used_percent AS usedPercent,
                 duration_mins AS windowDurationMins, resets_at AS resetsAt,
                 observed_at AS observedAt
          FROM rate_limit_snapshots
          WHERE duration_mins = ? AND resets_at = ?${keyFilter}
          ORDER BY observed_at ASC
        `).all(durationMins, resetAt, ...keyParams)
      : db.prepare(`
          SELECT limit_key AS key, label, used_percent AS usedPercent,
                 duration_mins AS windowDurationMins, resets_at AS resetsAt,
                 observed_at AS observedAt
          FROM rate_limit_snapshots
          WHERE duration_mins = ? AND observed_at >= ?${keyFilter}
          ORDER BY observed_at ASC
        `).all(durationMins, minObserved, ...keyParams);
    return rows<RateLimitWindow>(result);
  }

  function upsertAccountDailyUsage(items: DailyUsage[]): void {
    const statement = db.prepare(`
      INSERT INTO account_daily_usage (usage_date, tokens, observed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(usage_date) DO UPDATE SET
        tokens = excluded.tokens,
        observed_at = excluded.observed_at
    `);
    const now = Math.floor(Date.now() / 1000);
    transaction(() => {
      for (const item of items) statement.run(item.date, item.tokens, now);
    });
  }

  function getAccountDailyUsage(days = 7): DailyUsage[] {
    const result = db.prepare(`
      SELECT usage_date AS date, tokens, 'account' AS source
      FROM account_daily_usage
      ORDER BY usage_date DESC
      LIMIT ?
    `).all(days);
    return rows<DailyUsage>(result).reverse();
  }

  // ---------------------------------------------------------------------------
  // Events, parts, and prompts
  // ---------------------------------------------------------------------------

  const EVENT_COLUMNS = `
    event_key AS eventKey, part_id AS partId, device_id AS deviceId, thread_id AS threadId,
    part_kind AS partKind, observed_at AS observedAt, model, input_tokens AS inputTokens,
    cached_input_tokens AS cachedInputTokens, cache_write_input_tokens AS cacheWriteInputTokens,
    cache_write_1h_input_tokens AS cacheWrite1hInputTokens, output_tokens AS outputTokens,
    reasoning_output_tokens AS reasoningOutputTokens, total_tokens AS totalTokens,
    estimated_cost_usd AS estimatedApiCostUsd
  `;
  const selectEventStatement = db.prepare(`SELECT ${EVENT_COLUMNS} FROM session_part_token_events WHERE event_key = ?`);
  const selectPartEventsStatement = db.prepare(`
    SELECT ${EVENT_COLUMNS} FROM session_part_token_events WHERE part_id = ? AND device_id = ?
  `);
  const insertEventStatement = db.prepare(`
    INSERT INTO session_part_token_events (
      event_key, part_id, device_id, thread_id, part_kind, observed_at, model, input_tokens,
      cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens, output_tokens,
      reasoning_output_tokens, total_tokens, estimated_cost_usd, written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEventStatement = db.prepare(`
    UPDATE session_part_token_events SET
      thread_id = ?, part_kind = ?, observed_at = ?, model = ?, input_tokens = ?, cached_input_tokens = ?,
      cache_write_input_tokens = ?, cache_write_1h_input_tokens = ?, output_tokens = ?,
      reasoning_output_tokens = ?, total_tokens = ?, estimated_cost_usd = ?, written_at = ?
    WHERE event_key = ?
  `);
  const deleteEventStatement = db.prepare('DELETE FROM session_part_token_events WHERE event_key = ?');

  /**
   * Insert or update one event. The first device (and part) to report an event
   * owns it; the same event reported again from elsewhere, for example a
   * transcript copied between machines, is not counted a second time.
   */
  function writeEvent(
    event: SyncEventData,
    deviceId: string,
    known?: EventRow | null
  ): 'inserted' | 'updated' | 'unchanged' | 'foreign' {
    const existing = known === undefined
      ? (selectEventStatement.get(event.eventId) as EventRow | undefined) ?? null
      : known;
    const now = Math.floor(Date.now() / 1000);
    if (!existing) {
      insertEventStatement.run(
        event.eventId, event.partId, deviceId, event.threadId, event.partKind, event.observedAt, event.model,
        event.inputTokens, event.cachedInputTokens, event.cacheWriteInputTokens ?? 0,
        event.cacheWrite1hInputTokens ?? 0, event.outputTokens, event.reasoningOutputTokens,
        event.totalTokens, event.estimatedApiCostUsd, now
      );
      touch(event.observedAt);
      enqueue('event', event.eventId, event, event.partId, event.observedAt);
      return 'inserted';
    }
    if (existing.deviceId !== deviceId || existing.partId !== event.partId) return 'foreign';
    if (eventSignature(existing) === eventSignature(event)) return 'unchanged';
    updateEventStatement.run(
      event.threadId, event.partKind, event.observedAt, event.model, event.inputTokens,
      event.cachedInputTokens, event.cacheWriteInputTokens ?? 0, event.cacheWrite1hInputTokens ?? 0,
      event.outputTokens, event.reasoningOutputTokens, event.totalTokens, event.estimatedApiCostUsd, now,
      event.eventId
    );
    touch(existing.observedAt);
    touch(event.observedAt);
    enqueue('event', event.eventId, event, event.partId, event.observedAt);
    return 'updated';
  }

  function removeEventRow(eventId: string, deviceId: string, partId: string | null): boolean {
    const existing = (selectEventStatement.get(eventId) as EventRow | undefined) ?? null;
    if (!existing || existing.deviceId !== deviceId) return false;
    deleteEventStatement.run(eventId);
    touch(existing.observedAt);
    enqueue('remove-event', eventId, { eventId, partId: partId ?? existing.partId }, existing.partId, null);
    return true;
  }

  const selectPartStatement = db.prepare(`
    SELECT part_id AS partId, device_id AS deviceId, source_file AS sourceFile, thread_id AS threadId,
           part_kind AS partKind, title, project_path AS projectPath, started_at AS startedAt,
           updated_at AS updatedAt, primary_model AS primaryModel, models_json AS modelsJson,
           input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens,
           cache_write_input_tokens AS cacheWriteInputTokens,
           cache_write_1h_input_tokens AS cacheWrite1hInputTokens, output_tokens AS outputTokens,
           reasoning_output_tokens AS reasoningOutputTokens, total_tokens AS totalTokens,
           estimated_cost_usd AS estimatedApiCostUsd, pricing_status AS pricingStatus,
           user_message_count AS userMessageCount, source, source_label AS sourceLabel,
           reported_cost_usd AS reportedCostUsd
    FROM session_parts WHERE part_id = ?
  `);
  const upsertPartStatement = db.prepare(`
    INSERT INTO session_parts (
      part_id, device_id, source_file, thread_id, part_kind, title, project_path, started_at, updated_at,
      primary_model, models_json, input_tokens, cached_input_tokens, cache_write_input_tokens,
      cache_write_1h_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      estimated_cost_usd, pricing_status, user_message_count, source, source_label, reported_cost_usd, written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(part_id) DO UPDATE SET
      source_file = excluded.source_file,
      thread_id = excluded.thread_id,
      part_kind = excluded.part_kind,
      title = excluded.title,
      project_path = excluded.project_path,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      primary_model = excluded.primary_model,
      models_json = excluded.models_json,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      cache_write_input_tokens = excluded.cache_write_input_tokens,
      cache_write_1h_input_tokens = excluded.cache_write_1h_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      estimated_cost_usd = excluded.estimated_cost_usd,
      pricing_status = excluded.pricing_status,
      user_message_count = excluded.user_message_count,
      source = excluded.source,
      source_label = excluded.source_label,
      reported_cost_usd = excluded.reported_cost_usd,
      written_at = excluded.written_at
  `);

  /** Insert or update a part's descriptive row. Returns true when it changed. */
  function writePart(part: SyncPartData, deviceId: string): boolean {
    const existing = selectPartStatement.get(part.partId) as
      | (Omit<SyncPartData, 'models'> & { deviceId: string; modelsJson: string })
      | undefined;
    if (existing) {
      if (existing.deviceId !== deviceId) return false;
      const current: SyncPartData = { ...existing, models: JSON.parse(existing.modelsJson) as string[] };
      if (partSignature(current) === partSignature(part)) return false;
    }
    upsertPartStatement.run(
      part.partId, deviceId, part.sourceFile, part.threadId, part.partKind, part.title, part.projectPath,
      part.startedAt, part.updatedAt, part.primaryModel, JSON.stringify(part.models), part.inputTokens,
      part.cachedInputTokens, part.cacheWriteInputTokens ?? 0, part.cacheWrite1hInputTokens ?? 0,
      part.outputTokens, part.reasoningOutputTokens, part.totalTokens, part.estimatedApiCostUsd,
      part.pricingStatus, part.userMessageCount, part.source, part.sourceLabel, part.reportedCostUsd,
      Math.floor(Date.now() / 1000)
    );
    summariesDirty = true;
    enqueue('part', part.partId, part, part.partId, null);
    return true;
  }

  /** Remove a part with its events and prompts. Only the owning device can. */
  function removePartRows(partId: string, deviceId: string): boolean {
    const range = db.prepare(`
      SELECT MIN(observed_at) AS first, MAX(observed_at) AS last, COUNT(*) AS events
      FROM session_part_token_events WHERE part_id = ? AND device_id = ?
    `).get(partId, deviceId) as { first: number | null; last: number | null; events: number };
    const events = db.prepare('DELETE FROM session_part_token_events WHERE part_id = ? AND device_id = ?')
      .run(partId, deviceId);
    const prompts = db.prepare('DELETE FROM prompt_metrics WHERE part_id = ? AND device_id = ?').run(partId, deviceId);
    const parts = db.prepare('DELETE FROM session_parts WHERE part_id = ? AND device_id = ?').run(partId, deviceId);
    const changed = Number(events.changes) + Number(prompts.changes) + Number(parts.changes) > 0;
    if (range.events > 0) {
      touch(range.first);
      touch(range.last);
    }
    if (changed) {
      summariesDirty = true;
      enqueue('remove-part', partId, { partId }, partId, null);
    }
    return changed;
  }

  const PROMPT_COLUMNS = `
    prompt_id AS promptId, part_id AS partId, device_id AS deviceId, source_file AS sourceFile,
    thread_id AS threadId, turn_id AS turnId, sequence_number AS sequence, prompt_text AS prompt,
    started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs,
    time_to_first_token_ms AS timeToFirstTokenMs, timing_estimated AS timingEstimated,
    primary_model AS primaryModel, models_json AS modelsJson, input_tokens AS inputTokens,
    cached_input_tokens AS cachedInputTokens, cache_write_input_tokens AS cacheWriteInputTokens,
    cache_write_1h_input_tokens AS cacheWrite1hInputTokens, output_tokens AS outputTokens,
    reasoning_output_tokens AS reasoningOutputTokens, total_tokens AS totalTokens,
    estimated_cost_usd AS estimatedApiCostUsd, pricing_status AS pricingStatus
  `;
  const selectPromptStatement = db.prepare(`SELECT ${PROMPT_COLUMNS} FROM prompt_metrics WHERE prompt_id = ?`);
  const upsertPromptStatement = db.prepare(`
    INSERT INTO prompt_metrics (
      prompt_id, part_id, device_id, source_file, thread_id, turn_id, sequence_number, prompt_text,
      started_at, completed_at, duration_ms, time_to_first_token_ms, timing_estimated, primary_model,
      models_json, input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens,
      output_tokens, reasoning_output_tokens, total_tokens, estimated_cost_usd, pricing_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(prompt_id) DO UPDATE SET
      part_id = excluded.part_id,
      source_file = excluded.source_file,
      thread_id = excluded.thread_id,
      turn_id = excluded.turn_id,
      sequence_number = excluded.sequence_number,
      prompt_text = excluded.prompt_text,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      duration_ms = excluded.duration_ms,
      time_to_first_token_ms = excluded.time_to_first_token_ms,
      timing_estimated = excluded.timing_estimated,
      primary_model = excluded.primary_model,
      models_json = excluded.models_json,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      cache_write_input_tokens = excluded.cache_write_input_tokens,
      cache_write_1h_input_tokens = excluded.cache_write_1h_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      estimated_cost_usd = excluded.estimated_cost_usd,
      pricing_status = excluded.pricing_status
  `);

  function promptFromRow(row: PromptRow): SyncPromptData {
    const { modelsJson, deviceId: _deviceId, timingEstimated, ...rest } = row;
    return { ...rest, timingEstimated: Boolean(timingEstimated), models: JSON.parse(modelsJson) as string[] };
  }

  function writePrompt(prompt: SyncPromptData, deviceId: string, known?: PromptRow | null): boolean {
    const existing = known === undefined
      ? (selectPromptStatement.get(prompt.promptId) as PromptRow | undefined) ?? null
      : known;
    if (existing) {
      if (existing.deviceId !== deviceId) return false;
      if (promptSignature(promptFromRow(existing)) === promptSignature(prompt)) return false;
    }
    upsertPromptStatement.run(
      prompt.promptId, prompt.partId, deviceId, prompt.sourceFile, prompt.threadId, prompt.turnId,
      prompt.sequence, prompt.prompt, prompt.startedAt, prompt.completedAt, prompt.durationMs,
      prompt.timeToFirstTokenMs, prompt.timingEstimated ? 1 : 0, prompt.primaryModel,
      JSON.stringify(prompt.models), prompt.inputTokens, prompt.cachedInputTokens,
      prompt.cacheWriteInputTokens ?? 0, prompt.cacheWrite1hInputTokens ?? 0, prompt.outputTokens,
      prompt.reasoningOutputTokens, prompt.totalTokens, prompt.estimatedApiCostUsd, prompt.pricingStatus
    );
    summariesDirty = true;
    enqueue('prompt', prompt.promptId, prompt, prompt.partId, null);
    return true;
  }

  function removePromptRow(promptId: string, deviceId: string): boolean {
    const existing = (selectPromptStatement.get(promptId) as PromptRow | undefined) ?? null;
    if (!existing || existing.deviceId !== deviceId) return false;
    db.prepare('DELETE FROM prompt_metrics WHERE prompt_id = ?').run(promptId);
    summariesDirty = true;
    enqueue('remove-prompt', promptId, { promptId, partId: existing.partId }, existing.partId, null);
    return true;
  }

  /**
   * Make the stored rows for one part exactly match a fresh full parse: add and
   * update what the parse produced, delete what it no longer contains.
   */
  function replacePart(part: IndexedPart): boolean {
    const partId = partIdOf(part.summary);
    let changed = writePart(partData(part.summary), localDeviceId);

    const existingEvents = new Map(
      rows<EventRow>(selectPartEventsStatement.all(partId, localDeviceId)).map((row) => [row.eventKey, row])
    );
    const seenEvents = new Set<string>();
    for (const event of part.events) {
      seenEvents.add(event.eventKey);
      const result = writeEvent(eventData(event, part.summary), localDeviceId, existingEvents.get(event.eventKey));
      if (result === 'inserted' || result === 'updated') changed = true;
    }
    for (const eventKey of existingEvents.keys()) {
      if (!seenEvents.has(eventKey)) changed = removeEventRow(eventKey, localDeviceId, partId) || changed;
    }

    const existingPrompts = new Map(
      rows<PromptRow>(db.prepare(`
        SELECT ${PROMPT_COLUMNS} FROM prompt_metrics WHERE part_id = ? AND device_id = ?
      `).all(partId, localDeviceId)).map((row) => [row.promptId, row])
    );
    const seenPrompts = new Set<string>();
    for (const prompt of part.prompts) {
      seenPrompts.add(prompt.promptId);
      changed = writePrompt(promptData(prompt, partId), localDeviceId, existingPrompts.get(prompt.promptId)) || changed;
    }
    for (const promptId of existingPrompts.keys()) {
      if (!seenPrompts.has(promptId)) changed = removePromptRow(promptId, localDeviceId) || changed;
    }
    return changed;
  }

  /** Add the rows produced by newly appended log lines. */
  function mergePart(part: IndexedPart): boolean {
    const partId = partIdOf(part.summary);
    let changed = writePart(partData(part.summary), localDeviceId);
    for (const event of part.events) {
      const result = writeEvent(eventData(event, part.summary), localDeviceId);
      if (result === 'inserted' || result === 'updated') changed = true;
    }
    for (const prompt of part.prompts) changed = writePrompt(promptData(prompt, partId), localDeviceId) || changed;
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Local file index
  // ---------------------------------------------------------------------------

  const selectLocalFileStatement = db.prepare(`
    SELECT path, part_ids AS partIds, modified_ms AS modifiedMs, size_bytes AS sizeBytes,
           parser_version AS parserVersion, status, tail_offset AS tailOffset, tail_state AS tailState,
           head_length AS headLength, head_hash AS headHash, anchor_hash AS anchorHash,
           depends_on AS dependsOn, depends_stat AS dependsStat, indexed_at AS indexedAt
    FROM local_files WHERE path = ?
  `);
  const upsertLocalFileStatement = db.prepare(`
    INSERT INTO local_files (
      path, part_ids, modified_ms, size_bytes, parser_version, status, tail_offset, tail_state,
      head_length, head_hash, anchor_hash, depends_on, depends_stat, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      part_ids = excluded.part_ids,
      modified_ms = excluded.modified_ms,
      size_bytes = excluded.size_bytes,
      parser_version = excluded.parser_version,
      status = excluded.status,
      tail_offset = excluded.tail_offset,
      tail_state = excluded.tail_state,
      head_length = excluded.head_length,
      head_hash = excluded.head_hash,
      anchor_hash = excluded.anchor_hash,
      depends_on = excluded.depends_on,
      depends_stat = excluded.depends_stat,
      indexed_at = excluded.indexed_at
  `);

  function getLocalFile(filePath: string): LocalFileRecord | null {
    const row = selectLocalFileStatement.get(filePath) as (Omit<LocalFileRecord, 'partIds'> & { partIds: string }) | undefined;
    if (!row) return null;
    let partIds: string[] = [];
    try {
      partIds = JSON.parse(row.partIds) as string[];
    } catch {
      partIds = [];
    }
    return { ...row, partIds };
  }

  /** Files whose indexing depends on one of `paths` (Claude continuations). */
  function filesDependingOn(paths: string[]): string[] {
    if (paths.length === 0) return [];
    const statement = db.prepare('SELECT path FROM local_files WHERE depends_on = ?');
    return [...new Set(paths.flatMap((item) => rows<{ path: string }>(statement.all(item)).map((row) => row.path)))];
  }

  function listLocalFiles(): string[] {
    return rows<{ path: string }>(db.prepare('SELECT path FROM local_files').all()).map((row) => row.path);
  }

  /**
   * Store the result of parsing one local file, together with where parsing
   * stopped, in one transaction. A crash in between leaves the previous offset
   * in place, so the lines are simply parsed again.
   */
  function applyFileIndex(filePath: string, update: FileIndexUpdate): { changed: boolean } {
    return transaction(() => {
      const previous = getLocalFile(filePath);
      const previousIds = previous ? previous.partIds : (update.candidatePartIds ?? []);
      let changed = false;
      let partIds = previousIds;
      if (update.parts !== null) {
        const ids = update.parts.map((part) => partIdOf(part.summary));
        if (update.mode === 'full') {
          for (const id of previousIds) {
            if (!ids.includes(id)) changed = removePartRows(id, localDeviceId) || changed;
          }
          for (const part of update.parts) changed = replacePart(part) || changed;
          partIds = ids;
        } else {
          for (const part of update.parts) changed = mergePart(part) || changed;
          partIds = [...new Set([...previousIds, ...ids])];
        }
        for (const part of update.parts) {
          if (part.limits && part.limits.length > 0) insertSamples(part.limits, localDeviceId);
        }
      }
      if (update.metadata && update.metadata.length > 0) changed = upsertMetadataRows(update.metadata) || changed;
      upsertLocalFileStatement.run(
        filePath, JSON.stringify(partIds), update.file.modifiedMs, update.file.sizeBytes, update.file.parserVersion,
        update.file.status, update.file.tailOffset, update.file.tailState, update.file.headLength,
        update.file.headHash, update.file.anchorHash, update.file.dependsOn, update.file.dependsStat,
        Math.floor(Date.now() / 1000)
      );
      return { changed };
    });
  }

  /** Replace one part's rows. Kept for tests and simple callers. */
  function replaceThreadData(
    summary: ThreadPartSummary,
    events: StoredThreadEvent[],
    prompts: PromptMetric[],
    _fileState?: { modifiedMs: number; sizeBytes: number }
  ): void {
    transaction(() => {
      replacePart({ summary, events, prompts });
    });
  }

  /** Remove parts (by part id) this device produced, with their events and prompts. */
  function removeSessionParts(partIds: string[]): void {
    if (partIds.length === 0) return;
    transaction(() => {
      for (const partId of partIds) removePartRows(partId, localDeviceId);
    });
  }

  // ---------------------------------------------------------------------------
  // Chat metadata
  // ---------------------------------------------------------------------------

  const selectMetadataStatement = db.prepare(`
    SELECT thread_id AS threadId, display_name AS displayName, preview, updated_at AS updatedAt,
           source, source_label AS sourceLabel, model, reasoning_effort AS reasoningEffort,
           git_branch AS gitBranch, project_name AS projectName, archived
    FROM thread_metadata WHERE thread_id = ?
  `);
  const upsertMetadataStatement = db.prepare(`
    INSERT INTO thread_metadata (
      thread_id, display_name, preview, updated_at, source, source_label, model,
      reasoning_effort, git_branch, project_name, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      display_name = excluded.display_name,
      preview = excluded.preview,
      updated_at = excluded.updated_at,
      source = excluded.source,
      source_label = excluded.source_label,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      git_branch = excluded.git_branch,
      project_name = excluded.project_name,
      archived = excluded.archived
  `);

  /**
   * Merge chat metadata: known values win over unknown ones, the newest
   * timestamp wins, and an unknown archived flag keeps the stored one. Only rows
   * that actually change are written (and queued for the server).
   */
  function upsertMetadataRows(items: ThreadMetadataInput[]): boolean {
    let changed = false;
    for (const item of items) {
      const existing = (selectMetadataStatement.get(item.threadId) as MetadataRow | undefined) ?? null;
      const merged: MetadataRow = {
        threadId: item.threadId,
        displayName: item.displayName ?? existing?.displayName ?? null,
        preview: item.preview ?? existing?.preview ?? null,
        updatedAt: existing ? Math.max(item.updatedAt, existing.updatedAt) : item.updatedAt,
        source: item.source ?? existing?.source ?? null,
        sourceLabel: item.sourceLabel ?? existing?.sourceLabel ?? null,
        model: item.model ?? existing?.model ?? null,
        reasoningEffort: item.reasoningEffort ?? existing?.reasoningEffort ?? null,
        gitBranch: item.gitBranch ?? existing?.gitBranch ?? null,
        projectName: item.projectName ?? existing?.projectName ?? null,
        archived: item.archived === undefined ? (existing?.archived ?? 0) : item.archived ? 1 : 0
      };
      if (existing && JSON.stringify(existing) === JSON.stringify(merged)) continue;
      upsertMetadataStatement.run(
        merged.threadId, merged.displayName, merged.preview, merged.updatedAt, merged.source,
        merged.sourceLabel, merged.model, merged.reasoningEffort, merged.gitBranch, merged.projectName,
        merged.archived
      );
      enqueue('thread', merged.threadId, {
        threadId: merged.threadId,
        displayName: merged.displayName,
        preview: merged.preview,
        updatedAt: merged.updatedAt,
        source: merged.source,
        sourceLabel: merged.sourceLabel,
        model: merged.model,
        reasoningEffort: merged.reasoningEffort,
        gitBranch: merged.gitBranch,
        projectName: merged.projectName,
        archived: merged.archived === 1
      } satisfies ThreadMetadataInput, null, null);
      summariesDirty = true;
      changed = true;
    }
    return changed;
  }

  function upsertThreadMetadata(items: ThreadMetadataInput[]): boolean {
    if (items.length === 0) return false;
    return transaction(() => upsertMetadataRows(items));
  }

  // ---------------------------------------------------------------------------
  // Remote ingestion (server role)
  // ---------------------------------------------------------------------------

  /**
   * Store validated records from a collector. Everything is written in one
   * transaction; the returned sequence numbers are only acknowledged after it
   * committed. Costs are recomputed with this server's price table so every
   * device is priced the same way.
   */
  function ingestRemoteRecords(deviceId: string, records: ParsedSyncRecord[]): { acked: number[] } {
    if (records.length === 0) return { acked: [] };
    return transaction(() => {
      for (const record of records) {
        switch (record.kind) {
          case 'event': {
            const priced = estimateUsageCost(record.data.model, record.data, record.data.observedAt);
            writeEvent({ ...record.data, estimatedApiCostUsd: priced ?? record.data.estimatedApiCostUsd }, deviceId);
            break;
          }
          case 'part':
            writePart(record.data, deviceId);
            break;
          case 'prompt':
            writePrompt(record.data, deviceId);
            break;
          case 'thread':
            upsertMetadataRows([record.data]);
            break;
          case 'sample':
            insertSamples([record.data], deviceId);
            break;
          case 'remove-part':
            removePartRows(record.data.partId, deviceId);
            break;
          case 'remove-event':
            removeEventRow(record.data.eventId, deviceId, null);
            break;
          case 'remove-prompt':
            removePromptRow(record.data.promptId, deviceId);
            break;
        }
      }
      return { acked: records.map((record) => record.seq) };
    });
  }

  /**
   * Queue everything this device has ever indexed. A collector does this the
   * first time it reaches a server (or a server whose database was reset), so
   * history collected before multi-device mode is not lost. Uploads are
   * idempotent, so records the server already has cost nothing.
   */
  function exportAllToOutbox(serverInstanceId: string): number {
    if (!outboxEnabled) return 0;
    let queued = 0;
    transaction(() => {
      setMeta('sync_bootstrap_instance', serverInstanceId);
      const partRows = rows<Omit<SyncPartData, 'models'> & { modelsJson: string }>(db.prepare(`
        SELECT part_id AS partId, thread_id AS threadId, part_kind AS partKind, source_file AS sourceFile,
               title, project_path AS projectPath, started_at AS startedAt, updated_at AS updatedAt,
               primary_model AS primaryModel, models_json AS modelsJson, input_tokens AS inputTokens,
               cached_input_tokens AS cachedInputTokens, cache_write_input_tokens AS cacheWriteInputTokens,
               cache_write_1h_input_tokens AS cacheWrite1hInputTokens, output_tokens AS outputTokens,
               reasoning_output_tokens AS reasoningOutputTokens, total_tokens AS totalTokens,
               estimated_cost_usd AS estimatedApiCostUsd, pricing_status AS pricingStatus,
               user_message_count AS userMessageCount, COALESCE(source, 'unknown') AS source,
               source_label AS sourceLabel, reported_cost_usd AS reportedCostUsd
        FROM session_parts WHERE device_id = ?
      `).all(localDeviceId));
      for (const { modelsJson, ...row } of partRows) {
        enqueue('part', row.partId, { ...row, models: JSON.parse(modelsJson) as string[] }, row.partId, null);
        queued += 1;
      }
      for (const row of rows<EventRow>(db.prepare(`
        SELECT ${EVENT_COLUMNS} FROM session_part_token_events WHERE device_id = ? ORDER BY observed_at ASC
      `).all(localDeviceId))) {
        const { eventKey, deviceId: _deviceId, ...rest } = row;
        enqueue('event', eventKey, { eventId: eventKey, ...rest } satisfies SyncEventData, row.partId, row.observedAt);
        queued += 1;
      }
      for (const row of rows<PromptRow>(db.prepare(`
        SELECT ${PROMPT_COLUMNS} FROM prompt_metrics WHERE device_id = ?
      `).all(localDeviceId))) {
        enqueue('prompt', row.promptId, promptFromRow(row), row.partId, null);
        queued += 1;
      }
      for (const row of rows<MetadataRow>(db.prepare(`
        SELECT thread_id AS threadId, display_name AS displayName, preview, updated_at AS updatedAt,
               source, source_label AS sourceLabel, model, reasoning_effort AS reasoningEffort,
               git_branch AS gitBranch, project_name AS projectName, archived
        FROM thread_metadata
      `).all())) {
        enqueue('thread', row.threadId, { ...row, archived: row.archived === 1 }, null, null);
        queued += 1;
      }
      for (const row of rows<RateLimitWindow>(db.prepare(`
        SELECT limit_key AS key, label, used_percent AS usedPercent, duration_mins AS windowDurationMins,
               resets_at AS resetsAt, observed_at AS observedAt
        FROM rate_limit_snapshots WHERE device_id IS NULL OR device_id = ?
        ORDER BY observed_at ASC
      `).all(localDeviceId))) {
        enqueue('sample', sampleRecordKey(row), row, null, row.observedAt);
        queued += 1;
      }
    });
    bootstrapInstance = serverInstanceId;
    return queued;
  }

  // ---------------------------------------------------------------------------
  // Thread summaries (derived from events, so nothing can be counted twice)
  // ---------------------------------------------------------------------------

  function getPromptMap(): Map<string, PromptMetric[]> {
    const promptRows = rows<PromptRow>(db.prepare(`
      SELECT ${PROMPT_COLUMNS} FROM prompt_metrics ORDER BY started_at ASC, sequence_number ASC
    `).all());
    const map = new Map<string, PromptMetric[]>();
    for (const row of promptRows) {
      const { partId: _partId, deviceId: _deviceId, modelsJson, timingEstimated, ...rest } = row;
      const item: PromptMetric = {
        ...rest,
        timingEstimated: Boolean(timingEstimated),
        models: JSON.parse(modelsJson) as string[]
      };
      const list = map.get(row.threadId) ?? [];
      list.push(item);
      map.set(row.threadId, list);
    }
    return map;
  }

  function buildThreadSummaries(): ThreadSummary[] {
    const now = Date.now();
    if (summaryCache && summaryCache.version === summaryVersion && now - summaryCache.builtAt < 15_000) {
      return summaryCache.value;
    }

    const descriptors = rows<PartRow>(db.prepare(`
      SELECT part_id AS partId, device_id AS deviceId, source_file AS sourceFile, thread_id AS threadId,
             part_kind AS partKind, title, project_path AS projectPath, started_at AS startedAt,
             updated_at AS updatedAt, primary_model AS primaryModel, user_message_count AS userMessageCount,
             source, source_label AS sourceLabel, reported_cost_usd AS reportedCostUsd
      FROM session_parts
    `).all());
    const totals = new Map(rows<PartTotalsRow>(db.prepare(`
      SELECT part_id AS partId, MIN(thread_id) AS threadId, MIN(part_kind) AS partKind,
             MIN(device_id) AS deviceId,
             SUM(input_tokens) AS inputTokens, SUM(cached_input_tokens) AS cachedInputTokens,
             SUM(cache_write_input_tokens) AS cacheWriteInputTokens,
             SUM(cache_write_1h_input_tokens) AS cacheWrite1hInputTokens,
             SUM(output_tokens) AS outputTokens, SUM(reasoning_output_tokens) AS reasoningOutputTokens,
             SUM(total_tokens) AS totalTokens, SUM(estimated_cost_usd) AS estimatedApiCostUsd,
             SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS pricedEvents,
             SUM(CASE WHEN estimated_cost_usd IS NULL AND lower(model) <> '${AUTO_REVIEW_MODEL}' THEN 1 ELSE 0 END)
               AS unpricedEvents,
             MIN(observed_at) AS firstEventAt, MAX(observed_at) AS lastEventAt
      FROM session_part_token_events
      GROUP BY part_id
    `).all()).map((row) => [row.partId, row]));
    const partModels = new Map<string, Array<{ model: string; tokens: number }>>();
    for (const row of rows<PartModelRow>(db.prepare(`
      SELECT part_id AS partId, model, SUM(total_tokens) AS totalTokens
      FROM session_part_token_events
      GROUP BY part_id, model
      ORDER BY totalTokens DESC
    `).all())) {
      const list = partModels.get(row.partId) ?? [];
      list.push({ model: row.model, tokens: row.totalTokens });
      partModels.set(row.partId, list);
    }

    // Every part with a descriptor, plus parts whose events arrived before
    // their descriptor (possible while a collector is still uploading).
    type Part = PartRow & { totals: PartTotalsRow | null };
    const parts: Part[] = descriptors.map((row) => ({ ...row, totals: totals.get(row.partId) ?? null }));
    const described = new Set(descriptors.map((row) => row.partId));
    for (const row of totals.values()) {
      if (described.has(row.partId)) continue;
      parts.push({
        partId: row.partId,
        deviceId: row.deviceId,
        sourceFile: row.partId,
        threadId: row.threadId,
        partKind: row.partKind,
        title: null,
        projectPath: null,
        startedAt: row.firstEventAt,
        updatedAt: row.lastEventAt,
        primaryModel: partModels.get(row.partId)?.[0]?.model ?? 'unknown',
        userMessageCount: 0,
        source: null,
        sourceLabel: null,
        reportedCostUsd: null,
        totals: row
      });
    }
    parts.sort((a, b) => (a.startedAt ?? a.updatedAt ?? 0) - (b.startedAt ?? b.updatedAt ?? 0));

    const metadata = new Map(
      rows<MetadataRow>(db.prepare(`
        SELECT thread_id AS threadId, display_name AS displayName, preview, updated_at AS updatedAt,
               source, source_label AS sourceLabel, model, reasoning_effort AS reasoningEffort,
               git_branch AS gitBranch, project_name AS projectName, archived
        FROM thread_metadata
      `).all()).map((row) => [row.threadId, row])
    );
    const promptMap = getPromptMap();

    const modelWeights = new Map<string, Map<string, number>>();
    for (const part of parts) {
      if (part.partKind !== 'main') continue;
      for (const entry of partModels.get(part.partId) ?? []) {
        if (entry.model.toLowerCase() === AUTO_REVIEW_MODEL) continue;
        const weights = modelWeights.get(part.threadId) ?? new Map<string, number>();
        weights.set(entry.model, (weights.get(entry.model) ?? 0) + entry.tokens);
        modelWeights.set(part.threadId, weights);
      }
    }

    type Draft = ThreadSummary & { hasPriced: boolean; hasUnpriced: boolean; promptTitle: string | null };
    const grouped = new Map<string, Draft>();
    for (const part of parts) {
      const partTotals = part.totals;
      const priced = partTotals?.pricedEvents ?? 0;
      const partPricing: PricingStatus = priced === 0
        ? 'unknown'
        : (partTotals?.unpricedEvents ?? 0) > 0
          ? 'partial'
          : 'exact-model-match';
      const partCost = priced > 0 ? (partTotals?.estimatedApiCostUsd ?? 0) : null;
      const startedAt = part.startedAt ?? partTotals?.firstEventAt ?? null;
      const updatedAt = part.updatedAt ?? partTotals?.lastEventAt ?? null;

      let thread = grouped.get(part.threadId);
      if (!thread) {
        thread = {
          threadId: part.threadId,
          title: '',
          titleSource: 'fallback',
          preview: null,
          projectPath: part.partKind === 'main' ? part.projectPath : null,
          projectName: null,
          source: part.partKind === 'main' ? (part.source ?? 'unknown') : 'unknown',
          sourceLabel: part.partKind === 'main' ? part.sourceLabel : null,
          reasoningEffort: null,
          gitBranch: null,
          archived: false,
          startedAt,
          updatedAt,
          primaryModel: part.partKind === 'main' ? part.primaryModel : 'unknown',
          models: [],
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          estimatedApiCostUsd: null,
          pricingStatus: 'unknown',
          sourceFile: part.sourceFile,
          userMessageCount: 0,
          reviewerTokens: 0,
          subagentTokens: 0,
          partCount: 0,
          reportedCostUsd: null,
          deviceIds: [],
          prompts: [],
          usage: { fiveHour: null, sevenDay: null },
          hasPriced: false,
          hasUnpriced: false,
          promptTitle: null
        };
        grouped.set(part.threadId, thread);
      }

      if (part.partKind === 'main') {
        thread.promptTitle ??= part.title;
        if (!thread.projectPath && part.projectPath) thread.projectPath = part.projectPath;
        if (thread.primaryModel === 'unknown' && part.primaryModel !== 'unknown') {
          thread.primaryModel = part.primaryModel;
        }
        if (thread.source === 'unknown' && part.source) thread.source = part.source;
        thread.sourceLabel ??= part.sourceLabel;
        thread.sourceFile = part.sourceFile;
        thread.userMessageCount += part.userMessageCount;
        // Review sessions are priced by their parent; only main and subagent parts
        // decide whether a thread's cost estimate is complete.
        if (partPricing !== 'exact-model-match') thread.hasUnpriced = true;
      } else if (part.partKind === 'subagent' && partPricing !== 'exact-model-match') {
        thread.hasUnpriced = true;
      }
      if (part.reportedCostUsd !== null && part.reportedCostUsd !== undefined) {
        thread.reportedCostUsd = (thread.reportedCostUsd ?? 0) + part.reportedCostUsd;
      }
      if (!thread.deviceIds.includes(part.deviceId)) thread.deviceIds.push(part.deviceId);

      thread.startedAt = thread.startedAt === null
        ? startedAt
        : startedAt === null
          ? thread.startedAt
          : Math.min(thread.startedAt, startedAt);
      thread.updatedAt = thread.updatedAt === null
        ? updatedAt
        : updatedAt === null
          ? thread.updatedAt
          : Math.max(thread.updatedAt, updatedAt);
      if (partTotals) {
        thread.inputTokens += partTotals.inputTokens;
        thread.cachedInputTokens += partTotals.cachedInputTokens;
        thread.outputTokens += partTotals.outputTokens;
        thread.reasoningOutputTokens += partTotals.reasoningOutputTokens;
        thread.totalTokens += partTotals.totalTokens;
        thread.cacheWriteInputTokens = (thread.cacheWriteInputTokens ?? 0) + (partTotals.cacheWriteInputTokens ?? 0);
        thread.cacheWrite1hInputTokens =
          (thread.cacheWrite1hInputTokens ?? 0) + (partTotals.cacheWrite1hInputTokens ?? 0);
        if (part.partKind === 'reviewer') thread.reviewerTokens += partTotals.totalTokens;
        if (part.partKind === 'subagent') thread.subagentTokens += partTotals.totalTokens;
      }
      thread.partCount += 1;
      for (const entry of partModels.get(part.partId) ?? []) {
        if (!thread.models.includes(entry.model)) thread.models.push(entry.model);
      }
      if (partCost !== null) {
        thread.estimatedApiCostUsd = (thread.estimatedApiCostUsd ?? 0) + partCost;
        thread.hasPriced = true;
      }
    }

    for (const thread of grouped.values()) {
      const weights = modelWeights.get(thread.threadId);
      const weightedPrimary = weights
        ? [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        : null;
      if (weightedPrimary) thread.primaryModel = weightedPrimary;
      if (thread.primaryModel === AUTO_REVIEW_MODEL) thread.primaryModel = 'unknown';
      thread.pricingStatus = !thread.hasPriced
        ? 'unknown'
        : thread.hasUnpriced
          ? 'partial'
          : 'exact-model-match';
      thread.prompts = promptMap.get(thread.threadId) ?? [];

      const stored = metadata.get(thread.threadId);
      if (stored) {
        if (stored.source && (thread.source === 'unknown' || stored.source !== 'unknown')) {
          thread.source = stored.source;
        }
        thread.sourceLabel = stored.sourceLabel ?? thread.sourceLabel;
        thread.reasoningEffort = stored.reasoningEffort;
        thread.gitBranch = stored.gitBranch;
        thread.projectName = stored.projectName;
        thread.archived = stored.archived === 1;
        if (thread.primaryModel === 'unknown' && stored.model) thread.primaryModel = stored.model;
      }
      thread.projectName ??= projectNameFromPath(thread.projectPath);

      const displayName = cleanDisplayText(stored?.displayName ?? null, 160);
      const preview = cleanDisplayText(stored?.preview ?? null, 160);
      const promptTitle = cleanDisplayText(thread.promptTitle, 160);
      thread.preview = preview ?? promptTitle;
      // Scripted runs share one generic prompt, so the script label is the better name.
      const labelled = thread.source === 'exec' && thread.sourceLabel !== null;
      if (displayName) {
        thread.title = displayName;
        thread.titleSource = 'generated';
      } else if (labelled) {
        thread.title = fallbackTitle(thread.source, thread.sourceLabel, thread.projectName);
        thread.titleSource = 'fallback';
      } else if (preview) {
        thread.title = preview;
        thread.titleSource = 'preview';
      } else if (promptTitle) {
        thread.title = promptTitle;
        thread.titleSource = 'prompt';
      } else {
        thread.title = fallbackTitle(thread.source, thread.sourceLabel, thread.projectName);
        thread.titleSource = 'fallback';
      }
      if (thread.preview === thread.title) thread.preview = null;
    }

    const value = [...grouped.values()]
      .map(({ hasPriced: _hasPriced, hasUnpriced: _hasUnpriced, promptTitle: _promptTitle, ...thread }) => thread)
      .sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
    summaryCache = { builtAt: now, version: summaryVersion, value };
    return value;
  }

  function getThreadSummaries(limit = 100): ThreadSummary[] {
    return buildThreadSummaries().slice(0, limit);
  }

  function getThreadTitleMap(): Map<string, { title: string; model: string }> {
    return new Map(
      buildThreadSummaries().map((thread) => [
        thread.threadId,
        { title: thread.title, model: thread.primaryModel }
      ])
    );
  }

  function getThreadLookup(): Map<string, ThreadLookupEntry> {
    return new Map(
      buildThreadSummaries().map((thread) => [
        thread.threadId,
        {
          title: thread.title,
          model: thread.primaryModel,
          source: thread.source,
          sourceLabel: thread.sourceLabel,
          projectName: thread.projectName,
          deviceIds: thread.deviceIds
        }
      ])
    );
  }

  function getTokenTotals(): TokenTotals {
    const summaries = buildThreadSummaries();
    return summaries.reduce<TokenTotals>(
      (total, thread) => {
        total.threads += 1;
        total.inputTokens += thread.inputTokens;
        total.cachedInputTokens += thread.cachedInputTokens;
        total.outputTokens += thread.outputTokens;
        total.reasoningOutputTokens += thread.reasoningOutputTokens;
        total.totalTokens += thread.totalTokens;
        total.cacheWriteInputTokens = (total.cacheWriteInputTokens ?? 0) + (thread.cacheWriteInputTokens ?? 0);
        total.cacheWrite1hInputTokens =
          (total.cacheWrite1hInputTokens ?? 0) + (thread.cacheWrite1hInputTokens ?? 0);
        total.estimatedApiCostUsd += thread.estimatedApiCostUsd ?? 0;
        if (thread.estimatedApiCostUsd !== null) total.pricedThreads += 1;
        if (thread.pricingStatus !== 'exact-model-match') total.unknownPriceThreads += 1;
        return total;
      },
      {
        threads: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        cacheWriteInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        estimatedApiCostUsd: 0,
        pricedThreads: 0,
        unknownPriceThreads: 0
      }
    );
  }

  function getLocalDailyUsage(days = 7): DailyUsage[] {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const result = db.prepare(`
      SELECT date(observed_at, 'unixepoch', 'localtime') AS date,
             SUM(total_tokens) AS tokens,
             'local' AS source
      FROM session_part_token_events
      WHERE observed_at >= ?
      GROUP BY date(observed_at, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `).all(since);
    return rows<DailyUsage>(result);
  }

  /** Lifetime statistics derived from every token event this store has indexed. */
  function getLocalAccountStats(): LocalAccountStats {
    const daily = rows<{ date: string; tokens: number }>(db.prepare(`
      SELECT date(observed_at, 'unixepoch', 'localtime') AS date, SUM(total_tokens) AS tokens
      FROM session_part_token_events
      GROUP BY date(observed_at, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `).all());
    if (daily.length === 0) {
      return {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null
      };
    }
    const lifetimeTokens = daily.reduce((sum, row) => sum + row.tokens, 0);
    const peakDailyTokens = Math.max(...daily.map((row) => row.tokens));
    const longest = db.prepare(`
      SELECT MAX(duration_ms) AS durationMs FROM prompt_metrics WHERE duration_ms IS NOT NULL
    `).get() as { durationMs: number | null } | undefined;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const streak = streakFromDates(
      daily.map((row) => row.date),
      localDateString(nowSeconds),
      localDateString(nowSeconds - 86400)
    );
    return {
      lifetimeTokens,
      peakDailyTokens,
      longestRunningTurnSec: longest?.durationMs ? Math.round(longest.durationMs / 1000) : null,
      currentStreakDays: streak.currentStreakDays,
      longestStreakDays: streak.longestStreakDays
    };
  }

  /** Token events inside a time range, from every device, in log-time order. */
  function getTokenEventsBetween(start: number, end: number): TokenEventRow[] {
    return rows<TokenEventRow>(db.prepare(`
      SELECT observed_at AS observedAt, thread_id AS threadId, model, part_kind AS partKind,
             device_id AS deviceId, total_tokens AS totalTokens, estimated_cost_usd AS estimatedApiCostUsd
      FROM session_part_token_events
      WHERE observed_at >= ? AND observed_at <= ?
      ORDER BY observed_at ASC, event_key ASC
    `).all(start, end));
  }

  /** Completed prompt runs overlapping a time range. */
  function getPromptRunsBetween(start: number, end: number): PromptRunRow[] {
    return rows<PromptRunRow>(db.prepare(`
      SELECT thread_id AS threadId, started_at AS startedAt, completed_at AS completedAt,
             primary_model AS primaryModel
      FROM prompt_metrics
      WHERE completed_at IS NOT NULL AND completed_at >= ? AND started_at <= ?
      ORDER BY started_at ASC
    `).all(start, end));
  }

  /** Tokens by local weekday (0 = Sunday) and hour of day for the last `days` days. */
  function getHourlyActivity(days = 30): number[][] {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const result = rows<{ weekday: string; hour: string; tokens: number }>(db.prepare(`
      SELECT strftime('%w', observed_at, 'unixepoch', 'localtime') AS weekday,
             strftime('%H', observed_at, 'unixepoch', 'localtime') AS hour,
             SUM(total_tokens) AS tokens
      FROM session_part_token_events
      WHERE observed_at >= ?
      GROUP BY weekday, hour
    `).all(since));
    for (const row of result) {
      const weekday = Number(row.weekday);
      const hour = Number(row.hour);
      if (Number.isInteger(weekday) && Number.isInteger(hour)) grid[weekday][hour] = row.tokens;
    }
    return grid;
  }

  function getModelUsageSummaries(): ModelUsageSummary[] {
    const result = rows<{
      model: string;
      threads: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
      cacheWriteInputTokens: number;
      cacheWrite1hInputTokens: number;
      estimatedApiCostUsd: number;
      pricedEvents: number;
      eventCount: number;
    }>(db.prepare(`
      SELECT model,
             COUNT(DISTINCT thread_id) AS threads,
             SUM(input_tokens) AS inputTokens,
             SUM(cached_input_tokens) AS cachedInputTokens,
             SUM(output_tokens) AS outputTokens,
             SUM(reasoning_output_tokens) AS reasoningOutputTokens,
             SUM(total_tokens) AS totalTokens,
             SUM(cache_write_input_tokens) AS cacheWriteInputTokens,
             SUM(cache_write_1h_input_tokens) AS cacheWrite1hInputTokens,
             COALESCE(SUM(estimated_cost_usd), 0) AS estimatedApiCostUsd,
             SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS pricedEvents,
             COUNT(*) AS eventCount
      FROM session_part_token_events
      GROUP BY model
      ORDER BY totalTokens DESC
    `).all());

    return result.map(({ pricedEvents, eventCount, ...row }) => ({
      ...row,
      pricingStatus: pricedEvents === 0
        ? 'unknown'
        : pricedEvents < eventCount
          ? 'partial'
          : 'exact-model-match'
    }));
  }

  /** Event counts per device, for the device list and multi-device detection. */
  function getDeviceUsage(): Array<{ deviceId: string; events: number; tokens: number; lastEventAt: number | null }> {
    return rows(db.prepare(`
      SELECT device_id AS deviceId, COUNT(*) AS events, SUM(total_tokens) AS tokens, MAX(observed_at) AS lastEventAt
      FROM session_part_token_events
      GROUP BY device_id
    `).all());
  }

  // ---------------------------------------------------------------------------
  // Per-window attribution cache
  // ---------------------------------------------------------------------------

  function getWindowAttribution(scope: string, durationMins: number, resetsAt: number): CachedAttribution | null {
    const row = db.prepare(`
      SELECT signature, result_json AS resultJson, computed_at AS computedAt
      FROM window_attribution WHERE scope = ? AND duration_mins = ? AND resets_at = ?
    `).get(scope, durationMins, resetsAt) as CachedAttribution | undefined;
    return row ?? null;
  }

  function putWindowAttribution(row: {
    scope: string;
    durationMins: number;
    resetsAt: number;
    bankStart: number;
    bankEnd: number;
    signature: string;
    resultJson: string;
  }): void {
    db.prepare(`
      INSERT INTO window_attribution (scope, duration_mins, resets_at, bank_start, bank_end, signature, computed_at, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, duration_mins, resets_at) DO UPDATE SET
        bank_start = excluded.bank_start,
        bank_end = excluded.bank_end,
        signature = excluded.signature,
        computed_at = excluded.computed_at,
        result_json = excluded.result_json
    `).run(
      row.scope, row.durationMins, row.resetsAt, row.bankStart, row.bankEnd, row.signature,
      Math.floor(Date.now() / 1000), row.resultJson
    );
  }

  function clearWindowAttribution(): void {
    db.exec('DELETE FROM window_attribution');
  }

  function countWindowAttribution(): number {
    return (db.prepare('SELECT COUNT(*) AS count FROM window_attribution').get() as { count: number }).count;
  }

  // ---------------------------------------------------------------------------
  // Cloud tasks
  // ---------------------------------------------------------------------------

  function upsertCloudTasks(tasks: CloudTask[]): void {
    const now = Math.floor(Date.now() / 1000);
    const statement = db.prepare(`
      INSERT INTO cloud_tasks (
        task_id, title, status, updated_at, environment_label, url, is_review,
        files_changed, lines_added, lines_removed, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        updated_at = COALESCE(excluded.updated_at, cloud_tasks.updated_at),
        environment_label = COALESCE(excluded.environment_label, cloud_tasks.environment_label),
        url = COALESCE(excluded.url, cloud_tasks.url),
        is_review = excluded.is_review,
        files_changed = COALESCE(excluded.files_changed, cloud_tasks.files_changed),
        lines_added = COALESCE(excluded.lines_added, cloud_tasks.lines_added),
        lines_removed = COALESCE(excluded.lines_removed, cloud_tasks.lines_removed),
        last_seen_at = excluded.last_seen_at
    `);
    transaction(() => {
      for (const task of tasks) {
        statement.run(
          task.id,
          task.title,
          task.status,
          task.updatedAt,
          task.environmentLabel,
          task.url,
          task.isReview ? 1 : 0,
          task.filesChanged,
          task.linesAdded,
          task.linesRemoved,
          now,
          now
        );
      }
    });
  }

  function getCloudTasks(limit = 20): CloudTask[] {
    return rows<{
      id: string;
      title: string;
      status: string;
      updatedAt: number | null;
      environmentLabel: string | null;
      url: string | null;
      isReview: number;
      filesChanged: number | null;
      linesAdded: number | null;
      linesRemoved: number | null;
      firstSeenAt: number;
    }>(db.prepare(`
      SELECT task_id AS id, title, status, updated_at AS updatedAt,
             environment_label AS environmentLabel, url, is_review AS isReview,
             files_changed AS filesChanged, lines_added AS linesAdded,
             lines_removed AS linesRemoved, first_seen_at AS firstSeenAt
      FROM cloud_tasks
      ORDER BY COALESCE(updated_at, first_seen_at) DESC
      LIMIT ?
    `).all(limit)).map((row) => ({ ...row, isReview: row.isReview === 1 }));
  }

  /** Cloud tasks whose last update landed inside a time range. */
  function countCloudTasksBetween(start: number, end: number): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM cloud_tasks
      WHERE COALESCE(updated_at, first_seen_at) >= ? AND COALESCE(updated_at, first_seen_at) <= ?
    `).get(start, end) as { count: number };
    return row.count;
  }

  function close(): void {
    outboxListeners.clear();
    db.close();
  }

  return {
    provider: options.provider,
    filePath,
    deviceId: localDeviceId,
    outboxEnabled,
    getMeta,
    setMeta,
    insertRateLimitSnapshot,
    insertRateLimitSnapshots,
    getLatestRateLimitSnapshot,
    getRateLimitHistory,
    upsertAccountDailyUsage,
    getAccountDailyUsage,
    getLocalFile,
    listLocalFiles,
    filesDependingOn,
    applyFileIndex,
    replaceThreadData,
    removeSessionParts,
    upsertThreadMetadata,
    ingestRemoteRecords,
    readOutbox,
    ackOutbox,
    outboxStats,
    onOutboxChange,
    exportAllToOutbox,
    exportedToInstance: () => bootstrapInstance,
    eventVersion: () => eventVersion,
    sampleVersion: () => sampleVersion,
    invalidateThreadSummaries,
    getThreadSummaries,
    getThreadTitleMap,
    getThreadLookup,
    getTokenTotals,
    getLocalDailyUsage,
    getLocalAccountStats,
    getTokenEventsBetween,
    getPromptRunsBetween,
    getHourlyActivity,
    getModelUsageSummaries,
    getDeviceUsage,
    getWindowAttribution,
    putWindowAttribution,
    clearWindowAttribution,
    countWindowAttribution,
    upsertCloudTasks,
    getCloudTasks,
    countCloudTasksBetween,
    close
  };
}
