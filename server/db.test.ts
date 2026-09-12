import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUsageStore } from './db.js';
import type { ThreadPartSummary } from './types.js';

function summary(overrides: Partial<ThreadPartSummary> = {}): ThreadPartSummary {
  return {
    threadId: 'thread-1',
    title: 'Fix the dashboard',
    projectPath: 'C:\\repo\\dashboard',
    startedAt: 1_000,
    updatedAt: 2_000,
    primaryModel: 'claude-fable-5-1',
    models: ['claude-fable-5-1'],
    inputTokens: 1_000,
    cachedInputTokens: 600,
    cacheWriteInputTokens: 200,
    cacheWrite1hInputTokens: 200,
    outputTokens: 100,
    reasoningOutputTokens: 10,
    totalTokens: 1_100,
    estimatedApiCostUsd: 0.5,
    pricingStatus: 'exact-model-match',
    sourceFile: 'C:\\transcripts\\thread-1.jsonl',
    partKind: 'main',
    userMessageCount: 1,
    source: 'cli',
    sourceLabel: null,
    reportedCostUsd: 0.52,
    ...overrides
  };
}

test('stores per-provider parts with cache writes and provider-reported cost', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-store-'));
  const store = createUsageStore({ file: 'test.sqlite', provider: 'claude', dataDir: directory });
  try {
    store.replaceThreadData(summary(), [
      {
        eventKey: 'e1',
        threadId: 'thread-1',
        sourceFile: 'C:\\transcripts\\thread-1.jsonl',
        observedAt: 1_500,
        model: 'claude-fable-5-1',
        inputTokens: 1_000,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 200,
        cacheWrite1hInputTokens: 200,
        outputTokens: 100,
        reasoningOutputTokens: 10,
        totalTokens: 1_100,
        estimatedApiCostUsd: 0.5
      }
    ], [], { modifiedMs: 1, sizeBytes: 1 });
    store.replaceThreadData(
      summary({ sourceFile: 'C:\\transcripts\\thread-1.jsonl#sidechain', partKind: 'subagent', title: null, userMessageCount: 0, reportedCostUsd: null, totalTokens: 300, inputTokens: 250, outputTokens: 50, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWrite1hInputTokens: 0 }),
      [],
      [],
      { modifiedMs: 1, sizeBytes: 1 }
    );

    // Metadata without an archived flag must not violate the NOT NULL column,
    // and must not reset a stored archived flag either.
    store.upsertThreadMetadata([{ threadId: 'thread-1', displayName: 'Dashboard work', preview: null, updatedAt: 2_000, archived: true }]);
    store.upsertThreadMetadata([{ threadId: 'thread-1', displayName: null, preview: null, updatedAt: 2_001, reasoningEffort: 'xhigh' }]);

    const [thread] = store.getThreadSummaries();
    assert.equal(thread.title, 'Dashboard work');
    assert.equal(thread.titleSource, 'generated');
    assert.equal(thread.archived, true);
    assert.equal(thread.reasoningEffort, 'xhigh');
    assert.equal(thread.partCount, 2);
    assert.equal(thread.subagentTokens, 300);
    assert.equal(thread.totalTokens, 1_400);
    assert.equal(thread.cacheWriteInputTokens, 200);
    assert.equal(thread.cacheWrite1hInputTokens, 200);
    assert.equal(thread.reportedCostUsd, 0.52);
    assert.equal(thread.preview, 'Fix the dashboard');

    const [model] = store.getModelUsageSummaries();
    assert.equal(model.cacheWriteInputTokens, 200);
    assert.equal(store.getTokenTotals().cacheWriteInputTokens, 200);

    const stats = store.getLocalAccountStats();
    assert.equal(stats.lifetimeTokens, 1_100);
    assert.equal(stats.peakDailyTokens, 1_100);

    store.insertRateLimitSnapshots([
      { key: 'claude:seven-day', label: '7-day window', usedPercent: 40, windowDurationMins: 10_080, resetsAt: 9_000, observedAt: 100 },
      { key: 'claude:seven-day-scoped:fable', label: '7-day Fable window', usedPercent: 70, windowDurationMins: 10_080, resetsAt: 9_001, observedAt: 100 }
    ]);
    assert.equal(store.getRateLimitHistory(10_080, undefined, 100_000).length, 2);
    assert.equal(store.getRateLimitHistory(10_080, undefined, 100_000, ['claude:seven-day']).length, 1);
    assert.equal(store.getLatestRateLimitSnapshot('claude:seven-day-scoped:fable')?.usedPercent, 70);

    store.removeSessionParts(['C:\\transcripts\\thread-1.jsonl', 'C:\\transcripts\\thread-1.jsonl#sidechain']);
    assert.equal(store.getThreadSummaries().length, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
