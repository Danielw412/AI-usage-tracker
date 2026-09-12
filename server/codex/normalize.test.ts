import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRateLimitExtras, normalizeRateLimits, normalizeUsageSummary } from './normalize.js';

test('normalizes rate-limit overages without clamping them to 100 percent', () => {
  const limits = normalizeRateLimits({
    rateLimits: {
      primary: {
        usedPercent: 127.4,
        windowDurationMins: 300,
        resetsAt: 20_000
      }
    }
  });

  assert.equal(limits[0]?.usedPercent, 127.4);
});

test('still clamps invalid negative usage at zero', () => {
  const limits = normalizeRateLimits({
    rateLimits: {
      primary: {
        used_percent: -8,
        window_duration_mins: 300,
        resets_at: 20_000
      }
    }
  });

  assert.equal(limits[0]?.usedPercent, 0);
});

test('reads plan type and reset credits from the rate limit payload', () => {
  const extras = normalizeRateLimitExtras({
    rateLimits: { planType: 'plus', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 } },
    rateLimitResetCredits: { availableCount: 3, credits: [] }
  });
  assert.deepEqual(extras, { planType: 'plus', resetCreditsAvailable: 3 });
});

test('reads lifetime usage summary fields', () => {
  const summary = normalizeUsageSummary({
    summary: {
      lifetimeTokens: 3948484564,
      peakDailyTokens: 278178665,
      longestRunningTurnSec: 9264,
      currentStreakDays: 15,
      longestStreakDays: 15
    },
    dailyUsageBuckets: []
  });
  assert.equal(summary.lifetimeTokens, 3948484564);
  assert.equal(summary.longestRunningTurnSec, 9264);
  assert.equal(summary.currentStreakDays, 15);
});
