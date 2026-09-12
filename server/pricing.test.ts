import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateUsageCost } from './pricing.js';
import type { TokenUsage } from './types.js';

const sampleUsage: TokenUsage = {
  inputTokens: 100_000,
  cachedInputTokens: 50_000,
  outputTokens: 100_000,
  reasoningOutputTokens: 0,
  totalTokens: 200_000
};

function unixTimestamp(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

function assertCost(model: string, observedAt: string, expected: number): void {
  const actual = estimateUsageCost(model, sampleUsage, unixTimestamp(observedAt));
  if (actual === null) throw new Error(`No pricing found for ${model}`);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${model} cost was ${actual}, expected ${expected}`);
}

test('keeps the original Terra and Luna rates through July 30, 2026', () => {
  assertCost('gpt-5.6-terra', '2026-07-30T23:59:59Z', 1.6375);
  assertCost('gpt-5.6-luna', '2026-07-30T23:59:59Z', 0.655);
});

test('uses the reduced Terra and Luna rates after July 30, 2026', () => {
  assertCost('gpt-5.6-terra', '2026-07-31T00:00:00Z', 1.31);
  assertCost('gpt-5.6-luna', '2026-07-31T00:00:00Z', 0.131);
});

test('does not change Sol pricing when other model rates change', () => {
  assertCost('gpt-5.6-sol', '2026-07-30T23:59:59Z', 3.275);
  assertCost('gpt-5.6-sol', '2026-07-31T00:00:00Z', 3.275);
});

test('prices Claude cache writes and reads separately from fresh input', () => {
  const usage: TokenUsage = {
    inputTokens: 11_100,
    cachedInputTokens: 10_000,
    cacheWriteInputTokens: 1_000,
    cacheWrite1hInputTokens: 1_000,
    outputTokens: 100,
    reasoningOutputTokens: 20,
    totalTokens: 11_200
  };
  // 100 fresh at $10, 10k cache reads at $0.25, 1k one-hour writes at $20, 100 output at $50.
  const expected = (100 * 10 + 10_000 * 0.25 + 1_000 * 20 + 100 * 50) / 1_000_000;
  const actual = estimateUsageCost('claude-fable-5-1', usage);
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `cost was ${actual}`);

  // Five-minute writes bill at 1.25x, and the [1m] marker Claude Code appends is ignored.
  const fiveMinute = estimateUsageCost('claude-opus-5[1m]', { ...usage, cacheWrite1hInputTokens: 0 });
  const expectedOpus = (100 * 5 + 10_000 * 0.5 + 1_000 * 6.25 + 100 * 25) / 1_000_000;
  assert.ok(fiveMinute !== null && Math.abs(fiveMinute - expectedOpus) < 1e-12, `cost was ${fiveMinute}`);

  // Dated snapshot ids resolve through the alias prefix rule.
  assert.ok(estimateUsageCost('claude-haiku-4-5-20251001', usage) !== null);
});

test('charges cache writes at the input rate for models without a cache-write price', () => {
  const usage: TokenUsage = {
    inputTokens: 100_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 20_000,
    outputTokens: 100_000,
    reasoningOutputTokens: 0,
    totalTokens: 200_000
  };
  assertCost('gpt-5.6-sol', '2026-07-31T00:00:00Z', 3.275);
  assert.equal(estimateUsageCost('gpt-5.6-sol', usage, unixTimestamp('2026-07-31T00:00:00Z')), 3.275);
});

test('preserves long-context multipliers with a post-cut rate', () => {
  const usage: TokenUsage = {
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
    reasoningOutputTokens: 0,
    totalTokens: 1_300_000
  };

  assert.equal(
    estimateUsageCost('gpt-5.6-terra', usage, unixTimestamp('2026-07-31T00:00:00Z')),
    19.2
  );
});
