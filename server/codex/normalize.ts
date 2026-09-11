import type { DailyUsage, RateLimitWindow } from '../types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function validWindow(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  return (
    numberValue(value.usedPercent ?? value.used_percent) !== null &&
    numberValue(value.windowDurationMins ?? value.window_duration_mins) !== null &&
    numberValue(value.resetsAt ?? value.resets_at) !== null
  );
}

function classifyDuration(duration: number): string {
  if (Math.abs(duration - 300) <= 5) return 'five-hour';
  if (Math.abs(duration - 10_080) <= 60) return 'seven-day';
  return `window-${Math.round(duration)}`;
}

function labelFor(duration: number, sourceLabel?: string): string {
  if (Math.abs(duration - 300) <= 5) return '5-hour window';
  if (Math.abs(duration - 10_080) <= 60) return '7-day window';
  if (sourceLabel) return sourceLabel;
  if (duration < 60) return `${Math.round(duration)}-minute window`;
  if (duration < 1440) return `${Math.round(duration / 60)}-hour window`;
  return `${Math.round(duration / 1440)}-day window`;
}

export function normalizeRateLimits(payload: unknown): RateLimitWindow[] {
  const observedAt = Math.floor(Date.now() / 1000);
  const candidates: Array<{ value: JsonRecord; label?: string; sourceKey: string }> = [];

  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 5 || !isRecord(value)) return;
    if (validWindow(value)) {
      const label =
        (typeof value.limitName === 'string' && value.limitName) ||
        (typeof value.name === 'string' && value.name) ||
        undefined;
      candidates.push({ value, label, sourceKey: path });
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase().includes('credit')) continue;
      if (isRecord(child)) visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  visit(payload, 'root', 0);

  const deduped = new Map<string, RateLimitWindow>();
  for (const candidate of candidates) {
    const duration = numberValue(
      candidate.value.windowDurationMins ?? candidate.value.window_duration_mins
    );
    const used = numberValue(candidate.value.usedPercent ?? candidate.value.used_percent);
    const reset = numberValue(candidate.value.resetsAt ?? candidate.value.resets_at);
    if (duration === null || used === null || reset === null) continue;

    const classification = classifyDuration(duration);
    const key = `${classification}:${Math.round(reset)}`;
    deduped.set(key, {
      key: classification,
      label: labelFor(duration, candidate.label),
      // Codex may report usage beyond the nominal limit. Preserve that value so
      // the UI and estimators can distinguish 100% from an actual overage.
      usedPercent: Math.max(0, used),
      windowDurationMins: duration,
      resetsAt: Math.round(reset),
      observedAt
    });
  }
  return [...deduped.values()].sort((a, b) => a.windowDurationMins - b.windowDurationMins);
}

function findArrays(value: unknown, depth = 0): unknown[][] {
  if (depth > 6) return [];
  if (Array.isArray(value)) return [value];
  if (!isRecord(value)) return [];
  const arrays: unknown[][] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (Array.isArray(child) && (normalized.includes('daily') || normalized.includes('bucket'))) {
      arrays.push(child);
    } else if (isRecord(child)) {
      arrays.push(...findArrays(child, depth + 1));
    }
  }
  return arrays;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const direct = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
    if (direct) return direct;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString().slice(0, 10);
  }
  return null;
}

export function normalizeDailyUsage(payload: unknown): DailyUsage[] {
  const arrays = findArrays(payload);
  const rows = new Map<string, DailyUsage>();

  for (const array of arrays) {
    for (const item of array) {
      if (!isRecord(item)) continue;
      const date = normalizeDate(
        item.startDate ?? item.date ?? item.day ?? item.bucketStart ?? item.start_at
      );
      const tokens = numberValue(
        item.tokens ?? item.tokenCount ?? item.totalTokens ?? item.total_tokens ?? item.value
      );
      if (!date || tokens === null) continue;
      rows.set(date, { date, tokens: Math.max(0, Math.round(tokens)), source: 'account' });
    }
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeAccount(payload: unknown): {
  authType: string | null;
  planType: string | null;
} {
  if (!isRecord(payload)) return { authType: null, planType: null };
  const account = isRecord(payload.account) ? payload.account : payload;
  return {
    authType:
      (typeof account.type === 'string' && account.type) ||
      (typeof account.authMode === 'string' && account.authMode) ||
      null,
    planType: typeof account.planType === 'string' ? account.planType : null
  };
}

function integerValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.round(parsed);
}

/** Plan and reset-credit details that ride along with `account/rateLimits/read`. */
export function normalizeRateLimitExtras(payload: unknown): {
  planType: string | null;
  resetCreditsAvailable: number | null;
} {
  if (!isRecord(payload)) return { planType: null, resetCreditsAvailable: null };
  const snapshot = isRecord(payload.rateLimits) ? payload.rateLimits : payload;
  const planType =
    (typeof snapshot.planType === 'string' && snapshot.planType) ||
    (typeof snapshot.plan_type === 'string' && snapshot.plan_type) ||
    null;
  const credits = isRecord(payload.rateLimitResetCredits)
    ? payload.rateLimitResetCredits
    : isRecord(payload.rate_limit_reset_credits)
      ? payload.rate_limit_reset_credits
      : null;
  const resetCreditsAvailable = credits
    ? integerValue(credits.availableCount ?? credits.available_count)
    : null;
  return { planType, resetCreditsAvailable };
}

export interface UsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

/** Account-wide lifetime statistics from `account/usage/read`. */
export function normalizeUsageSummary(payload: unknown): UsageSummary {
  const empty: UsageSummary = {
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null
  };
  if (!isRecord(payload)) return empty;
  const summary = isRecord(payload.summary) ? payload.summary : payload;
  return {
    lifetimeTokens: integerValue(summary.lifetimeTokens ?? summary.lifetime_tokens),
    peakDailyTokens: integerValue(summary.peakDailyTokens ?? summary.peak_daily_tokens),
    longestRunningTurnSec: integerValue(
      summary.longestRunningTurnSec ?? summary.longest_running_turn_sec
    ),
    currentStreakDays: integerValue(summary.currentStreakDays ?? summary.current_streak_days),
    longestStreakDays: integerValue(summary.longestStreakDays ?? summary.longest_streak_days)
  };
}
