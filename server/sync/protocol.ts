import type { ThreadMetadataInput } from '../db.js';
import type {
  PricingStatus,
  PromptMetric,
  ProviderId,
  RateLimitWindow,
  SessionPartKind,
  ThreadSource,
  TokenUsage,
  TrackerRole
} from '../types.js';

/**
 * Wire format between collectors and the central server.
 *
 * A collector never sends running totals. It sends the immutable token events
 * its logs contain, plus the descriptive records (session parts, prompts, chat
 * names, quota samples seen in local logs) the dashboard needs to show them.
 * Every record has a stable key, so sending one twice changes nothing.
 */
export const SYNC_PROTOCOL_VERSION = 1;

export type SyncRecordKind =
  | 'event'
  | 'part'
  | 'prompt'
  | 'thread'
  | 'sample'
  | 'remove-part'
  | 'remove-event'
  | 'remove-prompt';

export const SYNC_RECORD_KINDS: SyncRecordKind[] = [
  'event',
  'part',
  'prompt',
  'thread',
  'sample',
  'remove-part',
  'remove-event',
  'remove-prompt'
];

/** One API response's token usage, timestamped by the original log. */
export interface SyncEventData extends TokenUsage {
  eventId: string;
  partId: string;
  threadId: string;
  partKind: SessionPartKind;
  /** Unix seconds from the Codex or Claude log, never the upload time. */
  observedAt: number;
  model: string;
  estimatedApiCostUsd: number | null;
}

/** Descriptive metadata for one log file (or one sidechain inside it). */
export interface SyncPartData extends TokenUsage {
  partId: string;
  threadId: string;
  partKind: SessionPartKind;
  sourceFile: string;
  title: string | null;
  projectPath: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  primaryModel: string;
  models: string[];
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
  userMessageCount: number;
  source: ThreadSource;
  sourceLabel: string | null;
  reportedCostUsd: number | null;
}

export type SyncPromptData = PromptMetric & { partId: string };
export type SyncThreadData = ThreadMetadataInput;
export type SyncSampleData = RateLimitWindow;

export interface SyncRemovalData {
  partId?: string;
  eventId?: string;
  promptId?: string;
}

export interface SyncRecord {
  /** Outbox sequence number on the collector; echoed back in acknowledgements. */
  seq: number;
  kind: SyncRecordKind;
  key: string;
  data: unknown;
}

export interface UploadRequest {
  protocol: number;
  deviceId: string;
  deviceLabel: string;
  installId: string;
  provider: ProviderId;
  records: SyncRecord[];
}

export interface UploadResponse {
  ok: true;
  /** Sequence numbers now durably stored on the server. */
  acked: number[];
  /** Records that can never be stored (malformed); the collector drops them. */
  rejected: Array<{ seq: number; error: string }>;
  serverInstanceId: string;
  serverTime: number;
}

export interface ProviderSyncStatus {
  enabled: boolean;
  pending: number;
  /** Log timestamp of the oldest event or sample still waiting in the outbox. */
  oldestPendingAt: number | null;
  /** Start of the last completed full session scan, minus a safety margin. */
  scannedThrough: number | null;
  /** Everything logged before this has been delivered. */
  syncedThrough: number | null;
}

export interface CollectorStatusReport {
  role: TrackerRole;
  version: string;
  /** Collector clock, unix seconds, when the report was built. */
  now: number;
  watching: boolean;
  lastError: string | null;
  providers: Partial<Record<ProviderId, ProviderSyncStatus>>;
}

export interface HeartbeatRequest {
  protocol: number;
  deviceId: string;
  deviceLabel: string;
  installId: string;
  status: CollectorStatusReport;
}

export interface HeartbeatResponse {
  ok: true;
  serverInstanceId: string;
  serverTime: number;
}

const PART_KINDS = new Set<SessionPartKind>(['main', 'reviewer', 'subagent']);
const PRICING = new Set<PricingStatus>(['exact-model-match', 'partial', 'unknown']);
const SOURCES = new Set<ThreadSource>([
  'desktop',
  'cli',
  'ide',
  'exec',
  'cloud',
  'voice',
  'review',
  'subagent',
  'unknown'
]);
/** 2020-01-01; anything earlier is a unit mistake (milliseconds, or zero). */
const EARLIEST_TIMESTAMP = 1_577_836_800;
const MAX_TEXT = 20_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Invalid extends Error {}

function str(record: Json, key: string, max = 500): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Invalid(`${key} must be a non-empty string`);
  }
  return value;
}

function optStr(record: Json, key: string, max = MAX_TEXT): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) throw new Invalid(`${key} must be a string or null`);
  return value;
}

function count(record: Json, key: string, required = true): number {
  const value = record[key];
  if (value === undefined && !required) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Invalid(`${key} must be a non-negative number`);
  }
  return Math.round(value);
}

function timestamp(record: Json, key: string, nowSeconds: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Invalid(`${key} must be a timestamp`);
  // Log timestamps are seconds; a week of clock skew is tolerated, not more.
  if (value < EARLIEST_TIMESTAMP || value > nowSeconds + 7 * 86_400) {
    throw new Invalid(`${key} is outside the accepted range`);
  }
  return Math.round(value);
}

function optTimestamp(record: Json, key: string, nowSeconds: number): number | null {
  return record[key] === null || record[key] === undefined ? null : timestamp(record, key, nowSeconds);
}

function optNumber(record: Json, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Invalid(`${key} must be a number or null`);
  return value;
}

function usage(record: Json): TokenUsage {
  const inputTokens = count(record, 'inputTokens');
  const cachedInputTokens = Math.min(count(record, 'cachedInputTokens'), inputTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens: count(record, 'outputTokens'),
    reasoningOutputTokens: count(record, 'reasoningOutputTokens'),
    totalTokens: count(record, 'totalTokens'),
    cacheWriteInputTokens: count(record, 'cacheWriteInputTokens', false),
    cacheWrite1hInputTokens: count(record, 'cacheWrite1hInputTokens', false)
  };
}

function partKind(record: Json): SessionPartKind {
  const value = record.partKind;
  if (typeof value !== 'string' || !PART_KINDS.has(value as SessionPartKind)) throw new Invalid('partKind is invalid');
  return value as SessionPartKind;
}

function parseEvent(data: Json, key: string, now: number): SyncEventData {
  const eventId = str(data, 'eventId', 200);
  if (eventId !== key) throw new Invalid('eventId does not match the record key');
  return {
    eventId,
    partId: str(data, 'partId', 1_000),
    threadId: str(data, 'threadId', 200),
    partKind: partKind(data),
    observedAt: timestamp(data, 'observedAt', now),
    model: str(data, 'model', 200),
    ...usage(data),
    estimatedApiCostUsd: optNumber(data, 'estimatedApiCostUsd')
  };
}

function parsePart(data: Json, key: string, now: number): SyncPartData {
  const partId = str(data, 'partId', 1_000);
  if (partId !== key) throw new Invalid('partId does not match the record key');
  const models = Array.isArray(data.models) ? data.models.filter((item): item is string => typeof item === 'string') : [];
  const pricing = typeof data.pricingStatus === 'string' && PRICING.has(data.pricingStatus as PricingStatus)
    ? data.pricingStatus as PricingStatus
    : 'unknown';
  const source = typeof data.source === 'string' && SOURCES.has(data.source as ThreadSource)
    ? data.source as ThreadSource
    : 'unknown';
  return {
    partId,
    threadId: str(data, 'threadId', 200),
    partKind: partKind(data),
    sourceFile: optStr(data, 'sourceFile', 2_000) ?? partId,
    title: optStr(data, 'title', 2_000),
    projectPath: optStr(data, 'projectPath', 2_000),
    startedAt: optTimestamp(data, 'startedAt', now),
    updatedAt: optTimestamp(data, 'updatedAt', now),
    primaryModel: optStr(data, 'primaryModel', 200) ?? 'unknown',
    models: models.slice(0, 50),
    ...usage(data),
    estimatedApiCostUsd: optNumber(data, 'estimatedApiCostUsd'),
    pricingStatus: pricing,
    userMessageCount: count(data, 'userMessageCount', false),
    source,
    sourceLabel: optStr(data, 'sourceLabel', 200),
    reportedCostUsd: optNumber(data, 'reportedCostUsd')
  };
}

function parsePrompt(data: Json, key: string, now: number): SyncPromptData {
  const promptId = str(data, 'promptId', 200);
  if (promptId !== key) throw new Invalid('promptId does not match the record key');
  const models = Array.isArray(data.models) ? data.models.filter((item): item is string => typeof item === 'string') : [];
  const pricing = typeof data.pricingStatus === 'string' && PRICING.has(data.pricingStatus as PricingStatus)
    ? data.pricingStatus as PricingStatus
    : 'unknown';
  return {
    promptId,
    partId: str(data, 'partId', 1_000),
    sourceFile: optStr(data, 'sourceFile', 2_000) ?? '',
    threadId: str(data, 'threadId', 200),
    turnId: optStr(data, 'turnId', 200),
    sequence: count(data, 'sequence'),
    prompt: optStr(data, 'prompt', MAX_TEXT) ?? '',
    startedAt: timestamp(data, 'startedAt', now),
    completedAt: optTimestamp(data, 'completedAt', now),
    durationMs: optNumber(data, 'durationMs'),
    timeToFirstTokenMs: optNumber(data, 'timeToFirstTokenMs'),
    timingEstimated: data.timingEstimated === true,
    primaryModel: optStr(data, 'primaryModel', 200) ?? 'unknown',
    models: models.slice(0, 50),
    ...usage(data),
    estimatedApiCostUsd: optNumber(data, 'estimatedApiCostUsd'),
    pricingStatus: pricing
  };
}

function parseThread(data: Json, key: string, now: number): SyncThreadData {
  const threadId = str(data, 'threadId', 200);
  if (threadId !== key) throw new Invalid('threadId does not match the record key');
  const source = typeof data.source === 'string' && SOURCES.has(data.source as ThreadSource)
    ? data.source as ThreadSource
    : null;
  return {
    threadId,
    displayName: optStr(data, 'displayName', 500),
    preview: optStr(data, 'preview', 2_000),
    updatedAt: optTimestamp(data, 'updatedAt', now) ?? now,
    source,
    sourceLabel: optStr(data, 'sourceLabel', 200),
    model: optStr(data, 'model', 200),
    reasoningEffort: optStr(data, 'reasoningEffort', 60),
    gitBranch: optStr(data, 'gitBranch', 300),
    projectName: optStr(data, 'projectName', 300),
    archived: typeof data.archived === 'boolean' ? data.archived : undefined
  };
}

function parseSample(data: Json, now: number): SyncSampleData {
  const usedPercent = optNumber(data, 'usedPercent');
  if (usedPercent === null || usedPercent < 0) throw new Invalid('usedPercent must be a non-negative number');
  return {
    key: str(data, 'key', 200),
    label: optStr(data, 'label', 200) ?? str(data, 'key', 200),
    usedPercent,
    windowDurationMins: count(data, 'windowDurationMins'),
    resetsAt: timestamp(data, 'resetsAt', now + 30 * 86_400),
    observedAt: timestamp(data, 'observedAt', now)
  };
}

export type ParsedSyncRecord =
  | { seq: number; kind: 'event'; data: SyncEventData }
  | { seq: number; kind: 'part'; data: SyncPartData }
  | { seq: number; kind: 'prompt'; data: SyncPromptData }
  | { seq: number; kind: 'thread'; data: SyncThreadData }
  | { seq: number; kind: 'sample'; data: SyncSampleData }
  | { seq: number; kind: 'remove-part'; data: { partId: string } }
  | { seq: number; kind: 'remove-event'; data: { eventId: string } }
  | { seq: number; kind: 'remove-prompt'; data: { promptId: string } };

/**
 * Validate one uploaded record. Returns an error string instead of throwing so
 * one malformed record does not block the rest of its batch.
 */
export function parseSyncRecord(raw: unknown, nowSeconds = Math.floor(Date.now() / 1000)): ParsedSyncRecord | string {
  if (!isRecord(raw)) return 'record must be an object';
  const seq = raw.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return 'seq must be a non-negative integer';
  const kind = raw.kind;
  const key = raw.key;
  if (typeof kind !== 'string' || !SYNC_RECORD_KINDS.includes(kind as SyncRecordKind)) return 'unknown record kind';
  if (typeof key !== 'string' || key.length === 0 || key.length > 1_000) return 'key must be a non-empty string';
  if (!isRecord(raw.data)) return 'data must be an object';
  const data = raw.data;
  try {
    switch (kind as SyncRecordKind) {
      case 'event':
        return { seq, kind: 'event', data: parseEvent(data, key, nowSeconds) };
      case 'part':
        return { seq, kind: 'part', data: parsePart(data, key, nowSeconds) };
      case 'prompt':
        return { seq, kind: 'prompt', data: parsePrompt(data, key, nowSeconds) };
      case 'thread':
        return { seq, kind: 'thread', data: parseThread(data, key, nowSeconds) };
      case 'sample':
        return { seq, kind: 'sample', data: parseSample(data, nowSeconds) };
      case 'remove-part':
        return { seq, kind: 'remove-part', data: { partId: key } };
      case 'remove-event':
        return { seq, kind: 'remove-event', data: { eventId: key } };
      case 'remove-prompt':
        return { seq, kind: 'remove-prompt', data: { promptId: key } };
    }
  } catch (error) {
    return error instanceof Invalid ? error.message : `invalid record: ${(error as Error).message}`;
  }
}

export function sampleRecordKey(sample: Pick<RateLimitWindow, 'observedAt' | 'key' | 'resetsAt'>): string {
  return `${sample.observedAt}|${sample.key}|${sample.resetsAt}`;
}
