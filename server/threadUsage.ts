import type { RateLimitWindow } from './types.js';

/**
 * Quota attribution.
 *
 * Codex only reports an account-wide "used percent" for each window. To work out
 * which chats consumed it, the dashboard walks the quota samples for one reset
 * bank in time order. Every time the reported percent climbs to a new high, the
 * increase is split between the token events that were logged since the previous
 * high, in proportion to their cost-like weight. Two chats running at the same
 * time therefore share an increase by how much work each actually did, instead
 * of by wall-clock time. An increase with no local events behind it is reported
 * as unattributed usage: cloud tasks, other devices, or logs that were not
 * persisted locally.
 */

export interface QuotaEvent {
  /** Attribution key: a thread id, or a model name for model efficiency. */
  key: string;
  observedAt: number;
  /** Cost-like weight. Events with a non-positive weight are ignored. */
  weight: number;
}

export interface KeyAttribution {
  percent: number;
  /** Portion of `percent` that came from spans shared with other keys. */
  sharedPercent: number;
  /** Weight of this key's events that fell inside an attributed span. */
  coveredWeight: number;
  /** Weight of every event for this key that was passed in. */
  totalWeight: number;
  /** Number of quota increases this key received a share of. */
  spans: number;
  /** Number of reset-separated segments that contributed. */
  segments: number;
}

export interface AttributionResult {
  byKey: Map<string, KeyAttribution>;
  /** Total of every quota increase seen across the continuous segments. */
  observedDeltaPercent: number;
  attributedPercent: number;
  unattributedPercent: number;
  spans: number;
  resetSegments: number;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
}

const EPSILON = 1e-9;
/**
 * Drops smaller than this are treated as sampling noise, not a reset. Samples
 * embedded in session logs can sit a full percent below the App Server value
 * for the same moment, so only a clearly larger fall counts as a reset.
 */
export const RESET_DROP_THRESHOLD = 2.5;

export function coverageOf(row: Pick<KeyAttribution, 'coveredWeight' | 'totalWeight'>): number {
  if (row.totalWeight <= 0) return 0;
  return Math.max(0, Math.min(1, row.coveredWeight / row.totalWeight));
}

function normalizeHistory(rawHistory: RateLimitWindow[]): RateLimitWindow[] {
  const ordered = rawHistory
    .filter((point) => Number.isFinite(point.observedAt) && Number.isFinite(point.usedPercent))
    .sort((a, b) => a.observedAt - b.observedAt);
  const deduped: RateLimitWindow[] = [];
  for (const point of ordered) {
    const previous = deduped.at(-1);
    if (previous?.observedAt === point.observedAt) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return deduped;
}

export function splitAtResets(history: RateLimitWindow[]): RateLimitWindow[][] {
  const segments: RateLimitWindow[][] = [];
  for (const point of history) {
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

function emptyResult(): AttributionResult {
  return {
    byKey: new Map(),
    observedDeltaPercent: 0,
    attributedPercent: 0,
    unattributedPercent: 0,
    spans: 0,
    resetSegments: 0,
    firstObservedAt: null,
    lastObservedAt: null
  };
}

function ensureKey(map: Map<string, KeyAttribution>, key: string): KeyAttribution {
  let row = map.get(key);
  if (!row) {
    row = {
      percent: 0,
      sharedPercent: 0,
      coveredWeight: 0,
      totalWeight: 0,
      spans: 0,
      segments: 0
    };
    map.set(key, row);
  }
  return row;
}

export function attributeQuotaUsage(
  rawHistory: RateLimitWindow[],
  rawEvents: QuotaEvent[]
): AttributionResult {
  const history = normalizeHistory(rawHistory);
  const events = rawEvents
    .filter((event) => Number.isFinite(event.observedAt) && event.weight > 0)
    .sort((a, b) => a.observedAt - b.observedAt);
  const result = emptyResult();
  if (history.length === 0) return result;

  result.firstObservedAt = history[0].observedAt;
  result.lastObservedAt = history.at(-1)!.observedAt;
  for (const event of events) ensureKey(result.byKey, event.key).totalWeight += event.weight;
  if (history.length < 2) return result;

  const segments = splitAtResets(history);
  result.resetSegments = Math.max(0, segments.length - 1);
  let cursor = 0;

  for (const segment of segments) {
    if (segment.length < 2) continue;
    const keysInSegment = new Set<string>();
    // Events before the first sample of the segment cannot be bracketed.
    while (cursor < events.length && events[cursor].observedAt <= segment[0].observedAt) cursor += 1;

    let level = segment[0].usedPercent;
    let pendingStart = cursor;
    for (let index = 1; index < segment.length; index += 1) {
      const sample = segment[index];
      const delta = sample.usedPercent - level;
      if (delta <= EPSILON) continue;

      // Collect the events since the previous high, inclusive of this sample time.
      let end = pendingStart;
      while (end < events.length && events[end].observedAt <= sample.observedAt) end += 1;
      const span = events.slice(pendingStart, end);
      const weights = new Map<string, number>();
      let totalWeight = 0;
      for (const event of span) {
        weights.set(event.key, (weights.get(event.key) ?? 0) + event.weight);
        totalWeight += event.weight;
      }

      result.observedDeltaPercent += delta;
      result.spans += 1;
      if (totalWeight <= 0) {
        result.unattributedPercent += delta;
      } else {
        const shared = weights.size > 1;
        for (const [key, weight] of weights) {
          const share = delta * (weight / totalWeight);
          const row = ensureKey(result.byKey, key);
          row.percent += share;
          row.coveredWeight += weight;
          row.spans += 1;
          if (shared) row.sharedPercent += share;
          keysInSegment.add(key);
        }
        result.attributedPercent += delta;
      }

      level = sample.usedPercent;
      pendingStart = end;
    }

    for (const key of keysInSegment) ensureKey(result.byKey, key).segments += 1;
    // Anything logged after the last high in this segment stays uncovered until a
    // later sample shows the quota moving again.
    const segmentEnd = segment.at(-1)!.observedAt;
    while (cursor < events.length && events[cursor].observedAt <= segmentEnd) cursor += 1;
  }

  return result;
}
