import type { PromptRunRow, TokenEventRow, UsageStore } from './db.js';
import {
  RESET_DROP_THRESHOLD,
  attributeQuotaUsage,
  type QuotaEvent
} from './threadUsage.js';
import type {
  LimitProjection,
  ModelEfficiency,
  ProjectionPoint,
  RateLimitWindow
} from './types.js';

/**
 * Which stored sample keys belong to each primary window. Providers that store
 * several windows of the same duration (Claude's model-scoped weekly caps) use
 * this to keep them apart; Codex leaves it empty and merges every source.
 */
export interface HistoryKeys {
  fiveHour?: string[];
  sevenDay?: string[];
}

const EMPTY_PROJECTION: LimitProjection = {
  projectedPercentAtReset: null,
  projectedExhaustionAt: null,
  percentPerHour: null,
  paceRatio: null,
  confidence: 'unavailable',
  samplesUsed: 0,
  resetEventsDetected: 0
};

/** Used to weight tokens from models without a public price (auto-review). */
const DEFAULT_COST_PER_TOKEN = 2.5 / 1_000_000;
const MODEL_EFFICIENCY_LOOKBACK_DAYS = 15;
/**
 * Sources disagree on a reset time by a few seconds, and an idle window reports
 * a reset time that slides forward with every poll. Reset times closer together
 * than this belong to the same bank.
 */
export const BANK_TOLERANCE_SECONDS = 180;

function regression(points: RateLimitWindow[]): { slopePerSecond: number; spanSeconds: number } | null {
  if (points.length < 2) return null;
  const origin = points[0].observedAt;
  const xs = points.map((point) => point.observedAt - origin);
  const ys = points.map((point) => point.usedPercent);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const numerator = xs.reduce((sum, x, index) => sum + (x - meanX) * (ys[index] - meanY), 0);
  const denominator = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  if (denominator === 0) return null;
  return {
    slopePerSecond: Math.max(0, numerator / denominator),
    spanSeconds: xs[xs.length - 1] - xs[0]
  };
}

function splitContinuousHistory(history: RateLimitWindow[]): RateLimitWindow[][] {
  const ordered = [...history].sort((a, b) => a.observedAt - b.observedAt);
  const deduped: RateLimitWindow[] = [];
  for (const point of ordered) {
    const previous = deduped.at(-1);
    if (previous?.observedAt === point.observedAt) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }

  const segments: RateLimitWindow[][] = [];
  for (const point of deduped) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    const resetBoundary = previous && (
      point.resetsAt !== previous.resetsAt ||
      point.usedPercent < previous.usedPercent - RESET_DROP_THRESHOLD
    );
    if (!current || resetBoundary) segments.push([point]);
    else current.push(point);
  }
  return segments;
}

function activeProjectionHistory(
  current: RateLimitWindow,
  history: RateLimitWindow[]
): { points: RateLimitWindow[]; resetEventsDetected: number } {
  const matching = history.filter(
    (point) =>
      point.key === current.key &&
      point.resetsAt === current.resetsAt &&
      point.observedAt <= current.observedAt
  );
  if (!matching.some((point) => point.observedAt === current.observedAt)) matching.push(current);
  const segments = splitContinuousHistory(matching);
  return {
    points: segments.at(-1) ?? [],
    resetEventsDetected: Math.max(0, segments.length - 1)
  };
}

export function calculateProjection(
  current: RateLimitWindow | null,
  history: RateLimitWindow[]
): LimitProjection {
  if (!current) return EMPTY_PROJECTION;
  const now = Math.floor(Date.now() / 1000);
  const recentWindow = current.windowDurationMins <= 360 ? 90 * 60 : 24 * 60 * 60;
  const active = activeProjectionHistory(current, history);
  const recent = active.points.filter((point) => point.observedAt >= now - recentWindow);
  const fitPoints = recent.length >= 2 ? recent : active.points;
  const fit = regression(fitPoints);
  if (!fit || fit.spanSeconds < 5 * 60) {
    return {
      ...EMPTY_PROJECTION,
      samplesUsed: fitPoints.length,
      resetEventsDetected: active.resetEventsDetected
    };
  }

  const remainingSeconds = Math.max(0, current.resetsAt - now);
  // Providers stop serving requests at the limit, so the reported value cannot
  // keep climbing once it is there. Hold the projection at the current level.
  const projected = current.usedPercent >= 100
    ? current.usedPercent
    : current.usedPercent + fit.slopePerSecond * remainingSeconds;
  const projectedExhaustionAt = current.usedPercent >= 100
    ? now
    : fit.slopePerSecond > 0
      ? now + Math.round((100 - current.usedPercent) / fit.slopePerSecond)
      : null;
  const sustainableSlope = remainingSeconds > 0
    ? Math.max(0, 100 - current.usedPercent) / remainingSeconds
    : 0;
  const paceRatio = sustainableSlope > 0 ? fit.slopePerSecond / sustainableSlope : null;
  const confidence: LimitProjection['confidence'] =
    fit.spanSeconds >= recentWindow * 0.65 && recent.length >= 8
      ? 'high'
      : fit.spanSeconds >= 30 * 60 && recent.length >= 4
        ? 'medium'
        : 'low';

  return {
    projectedPercentAtReset: Math.max(0, projected),
    projectedExhaustionAt:
      projectedExhaustionAt && projectedExhaustionAt <= current.resetsAt
        ? projectedExhaustionAt
        : null,
    percentPerHour: fit.slopePerSecond * 3600,
    paceRatio,
    confidence,
    samplesUsed: fitPoints.length,
    resetEventsDetected: active.resetEventsDetected
  };
}

/** A usage chart cannot show more points than this anyway, and far more stall the browser. */
export const MAX_CHART_POINTS = 720;

/**
 * Keep every point where the value moves or a reset happens, then thin the
 * flat stretches evenly. The shape of the curve survives either way.
 */
export function thinChartPoints(points: ProjectionPoint[], max = MAX_CHART_POINTS): ProjectionPoint[] {
  if (points.length <= max) return points;
  const changes = points.filter((point, index) =>
    index === 0 || index === points.length - 1 || point.reset || point.usedPercent !== points[index - 1].usedPercent
  );
  if (changes.length <= max) return changes;
  const step = changes.length / max;
  const thinned: ProjectionPoint[] = [];
  for (let index = 0; index < max; index += 1) thinned.push(changes[Math.floor(index * step)]);
  const last = changes.at(-1)!;
  if (thinned.at(-1) !== last) thinned.push(last);
  return thinned;
}

export function buildChartPoints(
  current: RateLimitWindow | null,
  history: RateLimitWindow[],
  projection: LimitProjection
): ProjectionPoint[] {
  const selectedHistory = current
    ? groupWindowHistory(
        history.filter((point) => point.resetsAt === current.resetsAt),
        current.key
      )[0] ?? []
    : groupWindowHistory(history, history.at(-1)?.key ?? '').flat();
  const ordered = [...selectedHistory].sort((a, b) => a.observedAt - b.observedAt);
  const points: ProjectionPoint[] = thinChartPoints(ordered.map((point, index) => ({
    timestamp: point.observedAt,
    usedPercent: point.usedPercent,
    reset: index > 0 && (
      point.resetsAt !== ordered[index - 1].resetsAt ||
      point.usedPercent < ordered[index - 1].usedPercent - RESET_DROP_THRESHOLD
    )
  })));
  if (!current || projection.projectedPercentAtReset === null) return points;

  const nowPoint = points.at(-1);
  if (!nowPoint || nowPoint.timestamp !== current.observedAt) {
    points.push({ timestamp: current.observedAt, usedPercent: current.usedPercent });
  }
  if (
    current.usedPercent < 100 &&
    projection.projectedExhaustionAt &&
    projection.projectedExhaustionAt < current.resetsAt
  ) {
    points.push({
      timestamp: projection.projectedExhaustionAt,
      usedPercent: 100,
      projected: true
    });
  }
  points.push({
    timestamp: current.resetsAt,
    usedPercent: projection.projectedPercentAtReset,
    projected: true
  });
  return points;
}

function groupHistory(history: RateLimitWindow[]): RateLimitWindow[][] {
  const groups = new Map<string, RateLimitWindow[]>();
  for (const point of history) {
    const key = `${point.key}:${point.resetsAt}`;
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    group
      .sort((a, b) => a.observedAt - b.observedAt)
      .filter((point, index, all) =>
        index === 0 ||
        point.observedAt !== all[index - 1].observedAt ||
        point.usedPercent !== all[index - 1].usedPercent
      )
  );
}

/** One sample series per reset bank, preferring the polled source for charts. */
export function groupWindowHistory(
  history: RateLimitWindow[],
  preferredKey: string
): RateLimitWindow[][] {
  const banks = new Map<number, RateLimitWindow[]>();
  for (const point of history) {
    const bank = banks.get(point.resetsAt) ?? [];
    bank.push(point);
    banks.set(point.resetsAt, bank);
  }

  const selected: RateLimitWindow[] = [];
  for (const bank of banks.values()) {
    const sources = new Map<string, RateLimitWindow[]>();
    for (const point of bank) {
      const source = sources.get(point.key) ?? [];
      source.push(point);
      sources.set(point.key, source);
    }
    const preferred = sources.get(preferredKey);
    const source = preferred && preferred.length >= 2
      ? preferred
      : [...sources.values()].sort((a, b) =>
          b.length - a.length ||
          (b.at(-1)?.observedAt ?? 0) - (a.at(-1)?.observedAt ?? 0)
        )[0] ?? [];
    selected.push(...source);
  }

  return groupHistory(selected).sort(
    (a, b) => (a[0]?.observedAt ?? 0) - (b[0]?.observedAt ?? 0)
  );
}

/**
 * Every sample for each reset bank, regardless of which source logged it. The
 * attribution engine tolerates small disagreements between sources, and denser
 * samples bracket work more tightly.
 */
export function mergedBankHistories(
  history: RateLimitWindow[],
  tolerance = BANK_TOLERANCE_SECONDS
): Map<number, RateLimitWindow[]> {
  const byResetsAt = new Map<number, RateLimitWindow[]>();
  for (const point of history) {
    const bank = byResetsAt.get(point.resetsAt) ?? [];
    bank.push(point);
    byResetsAt.set(point.resetsAt, bank);
  }

  // Chain reset times that sit within the tolerance into one cluster.
  const clusters: number[][] = [];
  for (const resetsAt of [...byResetsAt.keys()].sort((a, b) => a - b)) {
    const current = clusters.at(-1);
    if (current && resetsAt - current[current.length - 1] <= tolerance) current.push(resetsAt);
    else clusters.push([resetsAt]);
  }

  const banks = new Map<number, RateLimitWindow[]>();
  for (const cluster of clusters) {
    // The locked reset time is the one most samples agree on.
    const canonical = cluster.reduce((best, resetsAt) =>
      (byResetsAt.get(resetsAt)?.length ?? 0) > (byResetsAt.get(best)?.length ?? 0) ? resetsAt : best
    );
    const samples = cluster
      .flatMap((resetsAt) => byResetsAt.get(resetsAt) ?? [])
      .map((point) => ({ ...point, resetsAt: canonical }))
      .sort((a, b) => a.observedAt - b.observedAt);
    banks.set(canonical, samples);
  }
  return banks;
}

export function sameBank(a: number, b: number, tolerance = BANK_TOLERANCE_SECONDS): boolean {
  return Math.abs(a - b) <= tolerance;
}

export function fallbackCostPerToken(events: TokenEventRow[]): number {
  let cost = 0;
  let tokens = 0;
  for (const event of events) {
    if (event.estimatedApiCostUsd === null) continue;
    cost += event.estimatedApiCostUsd;
    tokens += event.totalTokens;
  }
  return tokens > 0 && cost > 0 ? cost / tokens : DEFAULT_COST_PER_TOKEN;
}

export function toQuotaEvents(
  events: TokenEventRow[],
  keyOf: (event: TokenEventRow) => string | null,
  costPerToken = fallbackCostPerToken(events)
): QuotaEvent[] {
  const result: QuotaEvent[] = [];
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    const weight = event.estimatedApiCostUsd ?? event.totalTokens * costPerToken;
    if (weight > 0) result.push({ key, observedAt: event.observedAt, weight });
  }
  return result;
}

function sliceEvents(events: TokenEventRow[], start: number, end: number): TokenEventRow[] {
  // Events are sorted by observedAt; binary-search the bounds.
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle].observedAt < start) low = middle + 1;
    else high = middle;
  }
  const from = low;
  high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle].observedAt <= end) low = middle + 1;
    else high = middle;
  }
  return events.slice(from, low);
}

interface BankRange {
  resetsAt: number;
  start: number;
  end: number;
  samples: RateLimitWindow[];
}

function bankRanges(
  history: RateLimitWindow[],
  durationMins: number,
  now: number
): BankRange[] {
  const ranges: BankRange[] = [];
  for (const [resetsAt, samples] of mergedBankHistories(history)) {
    if (samples.length < 2) continue;
    const start = resetsAt - durationMins * 60;
    ranges.push({ resetsAt, start, end: Math.min(resetsAt, now), samples });
  }
  return ranges;
}

interface EfficiencyAccumulator {
  estimatedUsagePercent: number;
  activeMinutes: number;
  tokens: number;
  estimatedApiCostUsd: number;
  spans: number;
}

/** Per-model quota efficiency across the given banks. Exported for tests. */
export function estimateModelEfficiencyForHistory(
  history: RateLimitWindow[],
  durationMins: number,
  events: TokenEventRow[],
  runs: PromptRunRow[],
  now = Math.floor(Date.now() / 1000)
): ModelEfficiency[] {
  const totals = new Map<string, EfficiencyAccumulator>();
  const sortedEvents = [...events].sort((a, b) => a.observedAt - b.observedAt);
  const costPerToken = fallbackCostPerToken(sortedEvents);

  for (const bank of bankRanges(history, durationMins, now)) {
    const bankEvents = sliceEvents(sortedEvents, bank.start, bank.end);
    const quotaEvents = toQuotaEvents(
      bankEvents,
      (event) => (event.model === 'unknown' || event.model === AUTO_REVIEW_MODEL ? null : event.model),
      costPerToken
    );
    if (quotaEvents.length === 0) continue;
    const attribution = attributeQuotaUsage(bank.samples, quotaEvents);
    for (const [model, row] of attribution.byKey) {
      if (row.percent <= 0) continue;
      const accumulator = totals.get(model) ?? {
        estimatedUsagePercent: 0,
        activeMinutes: 0,
        tokens: 0,
        estimatedApiCostUsd: 0,
        spans: 0
      };
      accumulator.estimatedUsagePercent += row.percent;
      accumulator.spans += row.spans;
      for (const event of bankEvents) {
        if (event.model !== model) continue;
        accumulator.tokens += event.totalTokens;
        accumulator.estimatedApiCostUsd += event.estimatedApiCostUsd ?? 0;
      }
      for (const run of runs) {
        if (run.primaryModel !== model) continue;
        const start = Math.max(run.startedAt, bank.start);
        const end = Math.min(run.completedAt, bank.end);
        if (end > start) accumulator.activeMinutes += (end - start) / 60;
      }
      totals.set(model, accumulator);
    }
  }

  return [...totals.entries()]
    .map(([model, row]) => ({
      model,
      ...row,
      minutesPerPercent: row.estimatedUsagePercent > 0 && row.activeMinutes > 0
        ? row.activeMinutes / row.estimatedUsagePercent
        : null,
      tokensPerPercent: row.estimatedUsagePercent > 0 ? row.tokens / row.estimatedUsagePercent : null,
      costPerPercent: row.estimatedUsagePercent > 0 && row.estimatedApiCostUsd > 0
        ? row.estimatedApiCostUsd / row.estimatedUsagePercent
        : null
    }))
    .sort((a, b) => b.estimatedUsagePercent - a.estimatedUsagePercent);
}

const AUTO_REVIEW_MODEL = 'codex-auto-review';

/** Auto-review runs against the parent chat's model, so its tokens count toward that model. */
function foldReviewEvents(store: UsageStore, events: TokenEventRow[]): TokenEventRow[] {
  const primaryModels = store.getThreadTitleMap();
  return events.map((event) => {
    if (event.partKind !== 'reviewer' && event.model !== AUTO_REVIEW_MODEL) return event;
    const parentModel = primaryModels.get(event.threadId)?.model;
    return parentModel && parentModel !== 'unknown' ? { ...event, model: parentModel } : event;
  });
}

export function calculateModelEfficiency(store: UsageStore, keys: HistoryKeys = {}): ModelEfficiency[] {
  const now = Math.floor(Date.now() / 1000);
  const since = now - MODEL_EFFICIENCY_LOOKBACK_DAYS * 86400;
  const events = foldReviewEvents(store, store.getTokenEventsBetween(since, now));
  const runs = store.getPromptRunsBetween(since, now);
  const fiveHour = estimateModelEfficiencyForHistory(
    store.getRateLimitHistory(300, undefined, MODEL_EFFICIENCY_LOOKBACK_DAYS, keys.fiveHour),
    300,
    events,
    runs,
    now
  );
  if (fiveHour.length > 0) return fiveHour;
  const longer = now - MODEL_EFFICIENCY_LOOKBACK_DAYS * 2 * 86400;
  return estimateModelEfficiencyForHistory(
    store.getRateLimitHistory(10_080, undefined, MODEL_EFFICIENCY_LOOKBACK_DAYS * 2, keys.sevenDay),
    10_080,
    foldReviewEvents(store, store.getTokenEventsBetween(longer, now)),
    store.getPromptRunsBetween(longer, now),
    now
  );
}
