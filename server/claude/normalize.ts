import type { AccountSummary, RateLimitWindow } from '../types.js';

type JsonRecord = Record<string, unknown>;

export const CLAUDE_FIVE_HOUR_KEY = 'claude:five-hour';
export const CLAUDE_SEVEN_DAY_KEY = 'claude:seven-day';
const SCOPED_KEY_PREFIX = 'claude:seven-day-scoped:';

export interface ClaudeUsageSnapshot {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  /** Model- or surface-specific weekly caps, such as a separate Opus allowance. */
  other: RateLimitWindow[];
  extraUsage: AccountSummary['extraUsage'];
}

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

function timestampSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
  }
  return null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scoped';
}

function window(
  key: string,
  label: string,
  durationMins: number,
  usedPercent: number | null,
  resetsAt: number | null,
  observedAt: number
): RateLimitWindow | null {
  if (usedPercent === null || resetsAt === null) return null;
  return {
    key,
    label,
    // Claude reports utilization as 0..100; keep anything above 100 intact.
    usedPercent: Math.max(0, usedPercent),
    windowDurationMins: durationMins,
    resetsAt,
    observedAt
  };
}

/** `{utilization, resets_at}` blocks such as `five_hour` and `seven_day_opus`. */
function windowFromBlock(
  block: unknown,
  key: string,
  label: string,
  durationMins: number,
  observedAt: number
): RateLimitWindow | null {
  if (!isRecord(block)) return null;
  return window(
    key,
    label,
    durationMins,
    numberValue(block.utilization ?? block.used_percentage ?? block.percent),
    timestampSeconds(block.resets_at ?? block.resetsAt),
    observedAt
  );
}

function scopeName(scope: unknown): string | null {
  if (!isRecord(scope)) return null;
  const model = isRecord(scope.model) ? scope.model : null;
  const surface = typeof scope.surface === 'string' ? scope.surface : null;
  const modelName =
    (model && typeof model.display_name === 'string' && model.display_name) ||
    (model && typeof model.id === 'string' && model.id) ||
    null;
  return modelName ?? surface;
}

const LEGACY_SCOPED_BLOCKS: Array<{ field: string; name: string }> = [
  { field: 'seven_day_opus', name: 'Opus' },
  { field: 'seven_day_sonnet', name: 'Sonnet' },
  { field: 'seven_day_oauth_apps', name: 'connected apps' },
  { field: 'seven_day_cowork', name: 'Cowork' }
];

function normalizeExtraUsage(payload: JsonRecord): AccountSummary['extraUsage'] {
  const extra = isRecord(payload.extra_usage) ? payload.extra_usage : null;
  const spend = isRecord(payload.spend) ? payload.spend : null;
  if (!extra && !spend) return null;
  const enabled = extra?.is_enabled === true || spend?.enabled === true;
  const money = (value: unknown): number | null => {
    if (isRecord(value)) {
      const minor = numberValue(value.amount_minor);
      const exponent = numberValue(value.exponent) ?? 2;
      const currency = typeof value.currency === 'string' ? value.currency : 'USD';
      if (minor === null || currency !== 'USD') return null;
      return minor / 10 ** exponent;
    }
    return numberValue(value);
  };
  return {
    enabled,
    usedPercent: numberValue(extra?.utilization) ?? numberValue(spend?.percent),
    usedUsd: money(spend?.used) ?? money(extra?.used_credits),
    limitUsd: money(spend?.limit) ?? money(extra?.monthly_limit)
  };
}

/**
 * Turn the `/api/oauth/usage` payload (or Claude Code's cached copy of it) into
 * dashboard windows. The 5-hour and 7-day windows come from the `five_hour` and
 * `seven_day` blocks, falling back to the `limits` array (`session`,
 * `weekly_all`). Every `weekly_scoped` entry and legacy per-model block becomes
 * an extra window keyed by its scope.
 */
export function normalizeClaudeUsage(payload: unknown, observedAt: number): ClaudeUsageSnapshot {
  const empty: ClaudeUsageSnapshot = { fiveHour: null, sevenDay: null, other: [], extraUsage: null };
  if (!isRecord(payload)) return empty;
  const utilization = isRecord(payload.utilization) ? payload.utilization : payload;

  let fiveHour = windowFromBlock(utilization.five_hour, CLAUDE_FIVE_HOUR_KEY, '5-hour window', 300, observedAt);
  let sevenDay = windowFromBlock(utilization.seven_day, CLAUDE_SEVEN_DAY_KEY, '7-day window', 10_080, observedAt);
  const other = new Map<string, RateLimitWindow>();

  const limits = Array.isArray(utilization.limits) ? utilization.limits : [];
  for (const entry of limits) {
    if (!isRecord(entry)) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    const percent = numberValue(entry.percent ?? entry.utilization);
    const resetsAt = timestampSeconds(entry.resets_at);
    if (kind === 'session') {
      fiveHour ??= window(CLAUDE_FIVE_HOUR_KEY, '5-hour window', 300, percent, resetsAt, observedAt);
    } else if (kind === 'weekly_all') {
      sevenDay ??= window(CLAUDE_SEVEN_DAY_KEY, '7-day window', 10_080, percent, resetsAt, observedAt);
    } else if (kind === 'weekly_scoped' || kind.startsWith('weekly')) {
      const name = scopeName(entry.scope) ?? (kind.replace(/^weekly_?/, '') || 'scoped');
      const scoped = window(
        `${SCOPED_KEY_PREFIX}${slug(name)}`,
        `7-day ${name} window`,
        10_080,
        percent,
        resetsAt,
        observedAt
      );
      if (scoped) other.set(scoped.key, scoped);
    } else if (kind && kind !== 'spend') {
      const name = scopeName(entry.scope) ?? kind.replace(/_/g, ' ');
      const generic = window(
        `claude:${slug(kind)}${entry.scope ? `:${slug(name)}` : ''}`,
        `${name} window`,
        10_080,
        percent,
        resetsAt,
        observedAt
      );
      if (generic) other.set(generic.key, generic);
    }
  }

  for (const legacy of LEGACY_SCOPED_BLOCKS) {
    const key = `${SCOPED_KEY_PREFIX}${slug(legacy.name)}`;
    if (other.has(key)) continue;
    const scoped = windowFromBlock(utilization[legacy.field], key, `7-day ${legacy.name} window`, 10_080, observedAt);
    if (scoped) other.set(key, scoped);
  }

  return {
    fiveHour,
    sevenDay,
    other: [...other.values()],
    extraUsage: normalizeExtraUsage(utilization)
  };
}

export interface ClaudeAccountInfo {
  /** Short plan label such as "max 5x", "max", "pro", "team", or null. */
  planType: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
  email: string | null;
}

/** "default_claude_max_5x" -> "max 5x", "default_claude_pro" -> "pro". */
export function planLabelFromTier(tier: string | null, subscriptionType: string | null, organizationType: string | null): string | null {
  const cleanedTier = tier?.replace(/^default_/, '').replace(/^claude_/, '').replace(/_/g, ' ').trim();
  if (cleanedTier) return cleanedTier;
  if (subscriptionType) return subscriptionType.replace(/_/g, ' ');
  if (organizationType) return organizationType.replace(/^claude_/, '').replace(/_/g, ' ');
  return null;
}

/** Account details from `~/.claude.json`'s `oauthAccount` block. */
export function normalizeClaudeAccount(configJson: unknown, subscriptionType: string | null = null): ClaudeAccountInfo {
  const account = isRecord(configJson) && isRecord(configJson.oauthAccount) ? configJson.oauthAccount : null;
  const tier =
    (account && typeof account.userRateLimitTier === 'string' && account.userRateLimitTier) ||
    (account && typeof account.organizationRateLimitTier === 'string' && account.organizationRateLimitTier) ||
    null;
  const organizationType = account && typeof account.organizationType === 'string' ? account.organizationType : null;
  return {
    planType: planLabelFromTier(tier, subscriptionType, organizationType),
    organizationType,
    rateLimitTier: tier,
    email: account && typeof account.emailAddress === 'string' ? account.emailAddress : null
  };
}

/**
 * Claude Code caches the last `/usage` response in `~/.claude.json` under
 * `cachedUsageUtilization`. It is a free extra sample whenever the user opens
 * `/usage`, and the only source while the endpoint is rate limiting us.
 */
export function normalizeCachedUtilization(configJson: unknown): { observedAt: number; snapshot: ClaudeUsageSnapshot } | null {
  if (!isRecord(configJson) || !isRecord(configJson.cachedUsageUtilization)) return null;
  const cached = configJson.cachedUsageUtilization;
  const observedAt = timestampSeconds(cached.fetchedAtMs ?? cached.fetchedAt);
  if (observedAt === null) return null;
  const snapshot = normalizeClaudeUsage(cached.utilization ?? cached, observedAt);
  if (!snapshot.fiveHour && !snapshot.sevenDay) return null;
  return { observedAt, snapshot };
}

/**
 * Samples appended by the optional status-line hook (`scripts/claude-statusline-sample.mjs`).
 * Each line: `{"observedAt": <seconds>, "five_hour": {"used_percentage", "resets_at"}, "seven_day": {...}}`.
 */
export function normalizeStatuslineSample(line: string): RateLimitWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const observedAt = timestampSeconds(parsed.observedAt ?? parsed.observed_at);
  if (observedAt === null) return [];
  const rateLimits = isRecord(parsed.rate_limits) ? parsed.rate_limits : parsed;
  const result: RateLimitWindow[] = [];
  const five = windowFromBlock(rateLimits.five_hour, CLAUDE_FIVE_HOUR_KEY, '5-hour window', 300, observedAt);
  const seven = windowFromBlock(rateLimits.seven_day, CLAUDE_SEVEN_DAY_KEY, '7-day window', 10_080, observedAt);
  if (five) result.push(five);
  if (seven) result.push(seven);
  return result;
}
