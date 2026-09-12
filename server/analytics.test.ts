import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChartPoints,
  calculateProjection,
  estimateModelEfficiencyForHistory,
  mergedBankHistories
} from './analytics.js';
import type { LimitProjection, RateLimitWindow } from './types.js';

function point(
  observedAt: number,
  usedPercent: number,
  resetsAt = 16_000
): RateLimitWindow {
  return {
    key: 'five-hour',
    label: '5-hour window',
    usedPercent,
    windowDurationMins: 300,
    resetsAt,
    observedAt
  };
}

test('projection uses only the continuous samples after an unexpected reset', () => {
  const originalNow = Date.now;
  Date.now = () => 10_000_000;
  try {
    const current = point(10_000, 10);
    const projection = calculateProjection(current, [
      point(7_000, 80),
      point(7_600, 90),
      point(8_200, 4),
      point(8_800, 8),
      current
    ]);

    assert.equal(projection.resetEventsDetected, 1);
    assert.equal(projection.samplesUsed, 3);
    assert.ok((projection.percentPerHour ?? 0) > 0);
    assert.ok((projection.percentPerHour ?? 100) < 20);
  } finally {
    Date.now = originalNow;
  }
});

test('projection holds an over-limit value steady and marks exhaustion as current', () => {
  const originalNow = Date.now;
  Date.now = () => 10_000_000;
  try {
    const current = point(10_000, 105, 12_000);
    const projection = calculateProjection(current, [point(9_400, 95, 12_000), current]);

    assert.equal(projection.projectedPercentAtReset, 105);
    assert.equal(projection.projectedExhaustionAt, 10_000);
    assert.equal(projection.paceRatio, null);
  } finally {
    Date.now = originalNow;
  }
});

test('chart points retain projections beyond 130 percent and flag reset boundaries', () => {
  const projection: LimitProjection = {
    projectedPercentAtReset: 164,
    projectedExhaustionAt: 9_800,
    percentPerHour: 12,
    paceRatio: 2,
    confidence: 'medium',
    samplesUsed: 4,
    resetEventsDetected: 1
  };
  const current = point(10_000, 108, 12_000);
  const points = buildChartPoints(current, [
    point(8_000, 97, 12_000),
    point(8_500, 3, 12_000),
    current
  ], projection);

  assert.equal(points[1].reset, true);
  assert.equal(points.at(-1)?.usedPercent, 164);
});

test('chart points ignore out-of-sync samples from an alias source', () => {
  const current = point(120, 22);
  const alias = { ...point(90, 18), key: 'codex:primary' };
  const points = buildChartPoints(current, [point(0, 20), alias, current], {
    projectedPercentAtReset: null,
    projectedExhaustionAt: null,
    percentPerHour: null,
    paceRatio: null,
    confidence: 'unavailable',
    samplesUsed: 2,
    resetEventsDetected: 0
  });

  assert.deepEqual(points.map((row) => row.usedPercent), [20, 22]);
  assert.equal(points.some((row) => row.reset), false);
});

test('model efficiency attributes quota by weighted token events and counts active minutes', () => {
  const rows = estimateModelEfficiencyForHistory(
    [point(0, 10, 1_800), point(600, 15, 1_800), point(1200, 19, 1_800)],
    30,
    [
      {
        observedAt: 300,
        threadId: 'thread-a',
        model: 'model-a',
        partKind: 'main',
        totalTokens: 1_000,
        estimatedApiCostUsd: 1
      },
      {
        observedAt: 900,
        threadId: 'thread-b',
        model: 'model-b',
        partKind: 'main',
        totalTokens: 2_000,
        estimatedApiCostUsd: 2
      }
    ],
    [
      { threadId: 'thread-a', startedAt: 60, completedAt: 540, primaryModel: 'model-a' },
      { threadId: 'thread-b', startedAt: 660, completedAt: 1140, primaryModel: 'model-b' }
    ],
    1_300
  );

  const modelA = rows.find((row) => row.model === 'model-a');
  const modelB = rows.find((row) => row.model === 'model-b');
  assert.equal(modelA?.estimatedUsagePercent, 5);
  assert.equal(modelA?.activeMinutes, 8);
  assert.equal(modelA?.minutesPerPercent, 1.6);
  assert.equal(modelA?.tokensPerPercent, 200);
  assert.equal(modelB?.estimatedUsagePercent, 4);
  assert.equal(modelB?.activeMinutes, 8);
  assert.equal(modelB?.minutesPerPercent, 2);
  assert.equal(modelB?.costPerPercent, 0.5);
});

test('bank histories cluster reset times that differ by a few seconds', () => {
  const banks = mergedBankHistories([
    point(0, 0, 10_000),
    point(60, 0, 10_060),
    point(120, 1, 10_075),
    point(180, 2, 10_075),
    point(240, 3, 10_070),
    point(20_000, 0, 30_000)
  ]);
  assert.deepEqual([...banks.keys()], [10_075, 30_000]);
  assert.equal(banks.get(10_075)?.length, 5);
  assert.ok(banks.get(10_075)?.every((sample) => sample.resetsAt === 10_075));
});
