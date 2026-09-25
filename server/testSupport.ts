import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageStore, type StoredThreadEvent, type UsageStore } from './db.js';
import { parseSyncRecord, type ParsedSyncRecord, type SyncEventData } from './sync/protocol.js';
import type { RateLimitWindow, ThreadPartSummary } from './types.js';

/** Shared fixtures for the multi-device tests. */

/** A model with no public price, so the cost a test passes in is the cost used. */
export const TEST_MODEL = 'test-model-unpriced';

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function removeDir(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

export function openStore(directory: string, deviceId: string, options: { outbox?: boolean; file?: string } = {}): UsageStore {
  return createUsageStore({
    file: options.file ?? 'store.sqlite',
    provider: 'codex',
    dataDir: directory,
    deviceId,
    outbox: options.outbox
  });
}

/** A recent, minute-aligned base time: history queries only look back so far. */
export function baseTime(daysAgo = 2): number {
  const now = Math.floor(Date.now() / 1000);
  return now - daysAgo * 86_400 - (now % 3600);
}

export function sample(observedAt: number, usedPercent: number, resetsAt: number, durationMins = 300, key = 'five-hour'): RateLimitWindow {
  return {
    key,
    label: durationMins === 300 ? '5-hour window' : '7-day window',
    usedPercent,
    windowDurationMins: durationMins,
    resetsAt,
    observedAt
  };
}

export function partSummary(threadId: string, partId: string, overrides: Partial<ThreadPartSummary> = {}): ThreadPartSummary {
  return {
    threadId,
    partId,
    title: `Chat ${threadId}`,
    projectPath: '/home/user/project',
    startedAt: null,
    updatedAt: null,
    primaryModel: TEST_MODEL,
    models: [TEST_MODEL],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedApiCostUsd: null,
    pricingStatus: 'unknown',
    sourceFile: `/logs/${partId}`,
    partKind: 'main',
    userMessageCount: 1,
    source: 'cli',
    sourceLabel: null,
    ...overrides
  };
}

export function localEvent(
  eventKey: string,
  threadId: string,
  observedAt: number,
  costUsd: number | null,
  totalTokens = 1_000
): StoredThreadEvent {
  return {
    eventKey,
    threadId,
    sourceFile: '/logs/local.jsonl',
    observedAt,
    model: TEST_MODEL,
    inputTokens: totalTokens - 100,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedApiCostUsd: costUsd
  };
}

/** Store one local chat with its events, as the session scanner would. */
export function addLocalChat(store: UsageStore, threadId: string, events: StoredThreadEvent[]): void {
  store.replaceThreadData(partSummary(threadId, `${threadId}.jsonl`), events, []);
}

export function remoteEvent(
  eventId: string,
  threadId: string,
  observedAt: number,
  costUsd: number | null,
  totalTokens = 1_000,
  partId = `${threadId}.jsonl`
): SyncEventData {
  return {
    eventId,
    partId,
    threadId,
    partKind: 'main',
    observedAt,
    model: TEST_MODEL,
    inputTokens: totalTokens - 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedApiCostUsd: costUsd
  };
}

let seq = 0;

/** Validate records exactly as the server's upload endpoint does. */
export function parsed(records: Array<{ kind: string; key: string; data: unknown }>): ParsedSyncRecord[] {
  return records.map((record) => {
    seq += 1;
    const result = parseSyncRecord({ seq, ...record });
    if (typeof result === 'string') throw new Error(`invalid test record: ${result}`);
    return result;
  });
}

export function eventRecords(events: SyncEventData[]): ParsedSyncRecord[] {
  return parsed(events.map((event) => ({ kind: 'event', key: event.eventId, data: event })));
}

export function close(actual: number | undefined, expected: number, message?: string): void {
  if (actual === undefined || Math.abs(actual - expected) > 1e-6) {
    throw new Error(`${message ?? 'value'}: expected ${expected}, got ${actual}`);
  }
}
