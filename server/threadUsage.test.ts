import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeQuotaUsage, coverageOf } from './threadUsage.js';
import type { RateLimitWindow } from './types.js';

function point(observedAt: number, usedPercent: number, resetsAt = 20_000): RateLimitWindow {
  return {
    key: 'five-hour',
    label: '5-hour window',
    usedPercent,
    windowDurationMins: 300,
    resetsAt,
    observedAt
  };
}

function event(key: string, observedAt: number, weight = 1) {
  return { key, observedAt, weight };
}

function close(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);
}

test('attributes a quota increase to the events logged since the previous high', () => {
  const result = attributeQuotaUsage(
    [point(0, 20), point(60, 20), point(120, 24)],
    [event('thread-a', 30), event('thread-a', 90)]
  );
  close(result.byKey.get('thread-a')?.percent, 4);
  assert.equal(result.unattributedPercent, 0);
  assert.equal(result.spans, 1);
});

test('splits a shared increase between concurrent threads by weight', () => {
  const result = attributeQuotaUsage(
    [point(0, 10), point(120, 16)],
    [event('thread-a', 30, 3), event('thread-b', 40, 1), event('thread-a', 100, 2)]
  );
  close(result.byKey.get('thread-a')?.percent, 5);
  close(result.byKey.get('thread-b')?.percent, 1);
  close(result.byKey.get('thread-a')?.sharedPercent, 5);
  close(result.byKey.get('thread-b')?.sharedPercent, 1);
});

test('keeps sequential threads separate when a sample divides them', () => {
  const result = attributeQuotaUsage(
    [point(0, 10), point(60, 12), point(120, 15)],
    [event('thread-a', 20), event('thread-b', 70)]
  );
  close(result.byKey.get('thread-a')?.percent, 2);
  close(result.byKey.get('thread-b')?.percent, 3);
  assert.equal(result.byKey.get('thread-a')?.sharedPercent, 0);
});

test('reports increases with no local events as unattributed usage', () => {
  const result = attributeQuotaUsage(
    [point(0, 10), point(60, 13), point(120, 13), point(180, 20)],
    [event('thread-a', 150)]
  );
  close(result.unattributedPercent, 3);
  close(result.byKey.get('thread-a')?.percent, 7);
  close(result.observedDeltaPercent, 10);
});

test('does not attribute across a reset boundary', () => {
  const result = attributeQuotaUsage(
    [point(0, 20), point(60, 24), point(120, 3, 30_000), point(180, 8, 30_000)],
    [event('thread-a', 30), event('thread-a', 150)]
  );
  close(result.byKey.get('thread-a')?.percent, 9);
  assert.equal(result.byKey.get('thread-a')?.segments, 2);
  assert.equal(result.resetSegments, 1);
});

test('treats a downward jump without a new reset time as a reset', () => {
  const result = attributeQuotaUsage(
    [point(0, 90), point(60, 95), point(120, 2), point(180, 5)],
    [event('thread-a', 30), event('thread-b', 150)]
  );
  close(result.byKey.get('thread-a')?.percent, 5);
  close(result.byKey.get('thread-b')?.percent, 3);
  assert.equal(result.resetSegments, 1);
});

test('ignores small disagreements between sample sources', () => {
  const result = attributeQuotaUsage(
    [point(0, 78), point(30, 79), point(60, 78), point(90, 79), point(120, 80)],
    [event('thread-a', 10), event('thread-a', 100)]
  );
  close(result.byKey.get('thread-a')?.percent, 2);
  assert.equal(result.resetSegments, 0);
});

test('tracks coverage for events that were never bracketed by a new high', () => {
  const result = attributeQuotaUsage(
    [point(0, 10), point(60, 12), point(120, 12)],
    [event('thread-a', 30, 2), event('thread-a', 90, 2)]
  );
  const row = result.byKey.get('thread-a');
  close(row?.percent, 2);
  close(row?.coveredWeight, 2);
  close(row?.totalWeight, 4);
  close(coverageOf(row!), 0.5);
});

test('preserves usage above 100 percent', () => {
  const result = attributeQuotaUsage(
    [point(0, 96), point(60, 104), point(120, 111)],
    [event('thread-a', 10), event('thread-a', 70)]
  );
  close(result.byKey.get('thread-a')?.percent, 15);
});

test('returns totals only when fewer than two samples exist', () => {
  const result = attributeQuotaUsage([point(0, 10)], [event('thread-a', 5)]);
  assert.equal(result.spans, 0);
  close(result.byKey.get('thread-a')?.totalWeight, 1);
  assert.equal(result.byKey.get('thread-a')?.percent, 0);
});
