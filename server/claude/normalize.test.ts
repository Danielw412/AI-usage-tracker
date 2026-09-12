import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_FIVE_HOUR_KEY,
  CLAUDE_SEVEN_DAY_KEY,
  normalizeCachedUtilization,
  normalizeClaudeAccount,
  normalizeClaudeUsage,
  normalizeStatuslineSample,
  planLabelFromTier
} from './normalize.js';

const usagePayload = {
  five_hour: { utilization: 68.0, resets_at: '2026-09-11T05:40:00.155317+00:00', limit_dollars: null },
  seven_day: { utilization: 42.0, resets_at: '2026-09-11T08:00:00.155338+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 68, resets_at: '2026-09-11T05:40:00.155317+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 42, resets_at: '2026-09-11T08:00:00.155338+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 74,
      resets_at: '2026-09-11T08:00:00.155556+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }
    }
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false }
};

test('normalizes the 5-hour and 7-day windows from the usage endpoint', () => {
  const snapshot = normalizeClaudeUsage(usagePayload, 1_000);
  assert.equal(snapshot.fiveHour?.key, CLAUDE_FIVE_HOUR_KEY);
  assert.equal(snapshot.fiveHour?.usedPercent, 68);
  assert.equal(snapshot.fiveHour?.windowDurationMins, 300);
  assert.equal(snapshot.fiveHour?.resetsAt, Math.round(Date.parse('2026-09-11T05:40:00.155317+00:00') / 1000));
  assert.equal(snapshot.fiveHour?.observedAt, 1_000);
  assert.equal(snapshot.sevenDay?.key, CLAUDE_SEVEN_DAY_KEY);
  assert.equal(snapshot.sevenDay?.usedPercent, 42);
  assert.equal(snapshot.sevenDay?.windowDurationMins, 10_080);
});

test('keeps model-scoped weekly caps apart from the shared 7-day window', () => {
  const snapshot = normalizeClaudeUsage(usagePayload, 1_000);
  assert.equal(snapshot.other.length, 1);
  assert.equal(snapshot.other[0].key, 'claude:seven-day-scoped:fable');
  assert.equal(snapshot.other[0].label, '7-day Fable window');
  assert.equal(snapshot.other[0].usedPercent, 74);
  assert.equal(snapshot.extraUsage?.enabled, false);
  assert.equal(snapshot.extraUsage?.usedUsd, 0);
});

test('falls back to the limits array when the top-level blocks are missing', () => {
  const snapshot = normalizeClaudeUsage({ limits: usagePayload.limits }, 5);
  assert.equal(snapshot.fiveHour?.usedPercent, 68);
  assert.equal(snapshot.sevenDay?.usedPercent, 42);
});

test('reads legacy per-model blocks and ignores blocks without a reset time', () => {
  const snapshot = normalizeClaudeUsage({
    five_hour: { utilization: 10, resets_at: 2_000 },
    seven_day_opus: { utilization: 55, resets_at: 9_000 },
    nimbus_quill: { utilization: 0, resets_at: null }
  }, 1_000);
  assert.equal(snapshot.other.length, 1);
  assert.equal(snapshot.other[0].label, '7-day Opus window');
  assert.equal(snapshot.sevenDay, null);
});

test('reads the cached /usage snapshot from the Claude Code state file', () => {
  const cached = normalizeCachedUtilization({
    cachedUsageUtilization: { fetchedAtMs: 1_789_099_829_647, utilization: usagePayload }
  });
  assert.equal(cached?.observedAt, 1_789_099_830);
  assert.equal(cached?.snapshot.fiveHour?.usedPercent, 68);
  assert.equal(normalizeCachedUtilization({}), null);
});

test('parses status-line samples written by the optional hook', () => {
  const windows = normalizeStatuslineSample(
    JSON.stringify({ observedAt: 1_700, five_hour: { used_percentage: 31, resets_at: 5_000 }, seven_day: { used_percentage: 12, resets_at: 9_000 } })
  );
  assert.deepEqual(windows.map((window) => [window.key, window.usedPercent, window.resetsAt, window.observedAt]), [
    [CLAUDE_FIVE_HOUR_KEY, 31, 5_000, 1_700],
    [CLAUDE_SEVEN_DAY_KEY, 12, 9_000, 1_700]
  ]);
  assert.deepEqual(normalizeStatuslineSample('not json'), []);
});

test('labels the plan from the rate-limit tier', () => {
  assert.equal(planLabelFromTier('default_claude_max_5x', 'max', 'claude_max'), 'max 5x');
  assert.equal(planLabelFromTier(null, 'pro', null), 'pro');
  assert.equal(planLabelFromTier(null, null, 'claude_team'), 'team');
  const account = normalizeClaudeAccount({
    oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x', emailAddress: 'a@b.c' }
  });
  assert.equal(account.planType, 'max 5x');
  assert.equal(account.email, 'a@b.c');
});
