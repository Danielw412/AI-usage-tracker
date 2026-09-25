import crypto from 'node:crypto';
import {
  fallbackCostPerToken,
  groupWindowHistory,
  thinChartPoints,
  mergedBankHistories,
  sameBank,
  toQuotaEvents,
  type HistoryKeys
} from './analytics.js';
import type { TokenEventRow, UsageStore } from './db.js';
import { RESET_DROP_THRESHOLD, attributeQuotaUsage, coverageOf } from './threadUsage.js';
import type {
  ProjectionPoint,
  RateLimitWindow,
  ThreadWindowUsage,
  WindowActivityRun,
  WindowBreakdown,
  WindowDetail,
  WindowDeviceShare,
  WindowSession,
  WindowSummary
} from './types.js';

/**
 * Per-window quota attribution across every device.
 *
 * A "bank" is one quota window as the provider reported it: every sample that
 * shares (roughly) one reset time. Its attribution is derived data: the samples
 * plus every token event logged inside the window, from any device, fed to
 * `attributeQuotaUsage()`. Results are cached per bank; a cached result is used
 * only while its sample set is unchanged, and any write that adds, changes, or
 * removes an event inside a bank deletes that bank's cached result in the same
 * transaction. A late upload therefore recomputes exactly the windows it
 * touches, and nothing else.
 */

/** Bump when the attribution algorithm or the cached result shape changes. */
export const ATTRIBUTION_VERSION = '1';

const THREAD_USAGE_LOOKBACK_DAYS = 30;
/** How far back the window picker lists 5-hour and 7-day windows. */
export const WINDOW_LIST_LOOKBACK_DAYS: Record<number, number> = { 300: 35, 10_080: 190 };

export interface QuotaBank {
  durationMins: number;
  /** Canonical reset time of the bank. */
  resetsAt: number;
  startsAt: number;
  samples: RateLimitWindow[];
  /**
   * Samples that reported exactly the canonical reset time. A window that has
   * started reports the same reset time on every poll; an idle one reports
   * "now + duration", a new value each time, so it never gets past 1.
   */
  support: number;
  /** Memoized `bankSignature`. */
  signature?: string;
}

export interface BankThreadRow {
  threadId: string;
  percent: number;
  sharedPercent: number;
  coveredWeight: number;
  totalWeight: number;
  spans: number;
  segments: number;
  tokens: number;
  costUsd: number;
  events: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  /** Attribution weight, tokens, and cost per device, to split the chat's share. */
  devices: Record<string, { weight: number; tokens: number; costUsd: number }>;
}

export interface BankAttribution {
  resetsAt: number;
  startsAt: number;
  observedDeltaPercent: number;
  attributedPercent: number;
  unattributedPercent: number;
  spans: number;
  resetSegments: number;
  tokens: number;
  costUsd: number;
  events: number;
  threads: BankThreadRow[];
}

export interface AttributionContext {
  /** Attribution for windows ending before this has every device's events. */
  settledThrough: number | null;
  now?: number;
}

function nowSeconds(context?: AttributionContext): number {
  return context?.now ?? Math.floor(Date.now() / 1000);
}

/** A started window, as opposed to an idle reset time sliding forward. */
export function isRealBank(bank: QuotaBank): boolean {
  return bank.support >= 2;
}

/**
 * Bank lists are rebuilt only when samples were added (about once a minute
 * while quota is polled), and at least every few minutes as the lookback
 * boundary moves. Clustering tens of thousands of samples is the expensive part
 * of an overview, and several calls share each list.
 */
const BANK_LIST_TTL_MS = 5 * 60_000;
const bankListMemo = new WeakMap<UsageStore, Map<string, { version: number; builtAt: number; banks: QuotaBank[] }>>();

/** Every bank with samples observed in the lookback period, oldest first. */
export function listBanks(
  store: UsageStore,
  durationMins: number,
  keys: string[] | undefined,
  lookbackDays: number
): QuotaBank[] {
  const memoKey = `${durationMins}|${scopeOf(keys)}|${lookbackDays}`;
  let memo = bankListMemo.get(store);
  if (!memo) {
    memo = new Map();
    bankListMemo.set(store, memo);
  }
  const cached = memo.get(memoKey);
  if (cached && cached.version === store.sampleVersion() && Date.now() - cached.builtAt < BANK_LIST_TTL_MS) {
    return cached.banks;
  }
  const history = store.getRateLimitHistory(durationMins, undefined, lookbackDays, keys);
  const rawCounts = new Map<number, number>();
  for (const sample of history) rawCounts.set(sample.resetsAt, (rawCounts.get(sample.resetsAt) ?? 0) + 1);
  const banks = [...mergedBankHistories(history)]
    .map(([resetsAt, samples]) => ({
      durationMins,
      resetsAt,
      startsAt: resetsAt - durationMins * 60,
      samples,
      support: rawCounts.get(resetsAt) ?? 0
    }))
    .sort((a, b) => a.resetsAt - b.resetsAt);
  memo.set(memoKey, { version: store.sampleVersion(), builtAt: Date.now(), banks });
  return banks;
}

function bankSignature(bank: QuotaBank): string {
  if (bank.signature) return bank.signature;
  const hash = crypto.createHash('sha1');
  hash.update(`${ATTRIBUTION_VERSION}|${bank.resetsAt}|${bank.startsAt}|`);
  for (const sample of bank.samples) hash.update(`${sample.observedAt}:${sample.usedPercent};`);
  bank.signature = `${bank.samples.length}:${hash.digest('hex')}`;
  return bank.signature;
}

/**
 * Attribute one bank's quota rises to the chats whose events fall between the
 * samples, weighting by API-equivalent cost (tokens times the bank's average
 * price for unpriced models). Pure; exported for tests.
 */
export function computeBankAttribution(bank: QuotaBank, events: TokenEventRow[]): BankAttribution {
  const costPerToken = fallbackCostPerToken(events);
  const attribution = attributeQuotaUsage(
    bank.samples,
    toQuotaEvents(events, (event) => event.threadId, costPerToken)
  );

  const threads = new Map<string, BankThreadRow>();
  const rowFor = (threadId: string): BankThreadRow => {
    let row = threads.get(threadId);
    if (!row) {
      row = {
        threadId,
        percent: 0,
        sharedPercent: 0,
        coveredWeight: 0,
        totalWeight: 0,
        spans: 0,
        segments: 0,
        tokens: 0,
        costUsd: 0,
        events: 0,
        firstEventAt: null,
        lastEventAt: null,
        devices: {}
      };
      threads.set(threadId, row);
    }
    return row;
  };

  let tokens = 0;
  let costUsd = 0;
  for (const event of events) {
    const row = rowFor(event.threadId);
    const deviceId = event.deviceId ?? 'local';
    const device = row.devices[deviceId] ?? { weight: 0, tokens: 0, costUsd: 0 };
    const weight = event.estimatedApiCostUsd ?? event.totalTokens * costPerToken;
    device.weight += Math.max(0, weight);
    device.tokens += event.totalTokens;
    device.costUsd += event.estimatedApiCostUsd ?? 0;
    row.devices[deviceId] = device;
    row.tokens += event.totalTokens;
    row.costUsd += event.estimatedApiCostUsd ?? 0;
    row.events += 1;
    row.firstEventAt = row.firstEventAt === null ? event.observedAt : Math.min(row.firstEventAt, event.observedAt);
    row.lastEventAt = row.lastEventAt === null ? event.observedAt : Math.max(row.lastEventAt, event.observedAt);
    tokens += event.totalTokens;
    costUsd += event.estimatedApiCostUsd ?? 0;
  }
  for (const [threadId, result] of attribution.byKey) {
    const row = rowFor(threadId);
    row.percent = result.percent;
    row.sharedPercent = result.sharedPercent;
    row.coveredWeight = result.coveredWeight;
    row.totalWeight = result.totalWeight;
    row.spans = result.spans;
    row.segments = result.segments;
  }

  return {
    resetsAt: bank.resetsAt,
    startsAt: bank.startsAt,
    observedDeltaPercent: attribution.observedDeltaPercent,
    attributedPercent: attribution.attributedPercent,
    unattributedPercent: attribution.unattributedPercent,
    spans: attribution.spans,
    resetSegments: attribution.resetSegments,
    tokens,
    costUsd,
    events: events.length,
    threads: [...threads.values()].sort((a, b) => b.percent - a.percent || b.tokens - a.tokens)
  };
}

function scopeOf(keys: string[] | undefined): string {
  return keys && keys.length > 0 ? [...keys].sort().join(',') : '*';
}

/**
 * Parsed results, dropped whenever any event changes. The persistent cache in
 * the store is the precise one (it only loses the banks a write touched); this
 * layer only saves re-reading and re-parsing between writes.
 */
const MAX_MEMOIZED_RESULTS = 1_000;
const resultMemo = new WeakMap<UsageStore, { eventVersion: number; results: Map<string, BankAttribution> }>();

/** Attribution for one bank: memoized, then persisted, then computed. */
export function getBankAttribution(store: UsageStore, keys: string[] | undefined, bank: QuotaBank): BankAttribution {
  const scope = scopeOf(keys);
  const signature = bankSignature(bank);
  let memo = resultMemo.get(store);
  if (!memo || memo.eventVersion !== store.eventVersion() || memo.results.size > MAX_MEMOIZED_RESULTS) {
    memo = { eventVersion: store.eventVersion(), results: new Map() };
    resultMemo.set(store, memo);
  }
  const memoKey = `${scope}|${bank.durationMins}|${bank.resetsAt}|${signature}`;
  const memoized = memo.results.get(memoKey);
  if (memoized) return memoized;

  let result: BankAttribution | null = null;
  const cached = store.getWindowAttribution(scope, bank.durationMins, bank.resetsAt);
  if (cached && cached.signature === signature) {
    try {
      result = JSON.parse(cached.resultJson) as BankAttribution;
    } catch {
      result = null;
    }
  }
  if (!result) {
    result = computeBankAttribution(bank, store.getTokenEventsBetween(bank.startsAt, bank.resetsAt));
    store.putWindowAttribution({
      scope,
      durationMins: bank.durationMins,
      resetsAt: bank.resetsAt,
      bankStart: bank.startsAt,
      bankEnd: bank.resetsAt,
      signature,
      resultJson: JSON.stringify(result)
    });
  }
  memo.results.set(memoKey, result);
  return result;
}

function isProvisional(bank: QuotaBank, context: AttributionContext): boolean {
  const end = Math.min(bank.resetsAt, nowSeconds(context));
  return context.settledThrough === null || end > context.settledThrough;
}

/** The bank the provider is reporting right now, with the live sample included. */
function bankForCurrent(banks: QuotaBank[], current: RateLimitWindow): QuotaBank {
  const found = banks.find((bank) => sameBank(bank.resetsAt, current.resetsAt));
  if (!found) {
    return {
      durationMins: current.windowDurationMins,
      resetsAt: current.resetsAt,
      startsAt: current.resetsAt - current.windowDurationMins * 60,
      samples: [current],
      support: 1
    };
  }
  if (found.samples.some((sample) => sample.observedAt === current.observedAt)) return found;
  return {
    ...found,
    samples: [...found.samples, { ...current, resetsAt: found.resetsAt }].sort((a, b) => a.observedAt - b.observedAt),
    signature: undefined
  };
}

/**
 * Each chat's share of the most recent 5-hour and 7-day bank it was active in.
 */
export function calculateThreadUsageEstimates(
  store: UsageStore,
  fiveHourWindow: RateLimitWindow | null,
  sevenDayWindow: RateLimitWindow | null,
  keys: HistoryKeys = {}
): Map<string, { fiveHour: ThreadWindowUsage | null; sevenDay: ThreadWindowUsage | null }> {
  const estimate = (
    current: RateLimitWindow | null,
    durationMins: number,
    scopeKeys: string[] | undefined
  ): Map<string, ThreadWindowUsage> => {
    const result = new Map<string, ThreadWindowUsage>();
    // An idle reset time sliding forward is not a window anyone used; letting it
    // through would replace a chat's real share with a 0% one.
    const banks = listBanks(store, durationMins, scopeKeys, THREAD_USAGE_LOOKBACK_DAYS)
      .filter((bank) => bank.samples.length >= 2)
      .filter((bank) => isRealBank(bank) || (current !== null && sameBank(current.resetsAt, bank.resetsAt)));
    for (const bank of banks) {
      const attribution = getBankAttribution(store, scopeKeys, bank);
      for (const row of attribution.threads) {
        if (row.totalWeight <= 0) continue;
        // Banks are oldest first, so the most recent one a chat was active in wins.
        result.set(row.threadId, {
          percent: row.percent,
          coverage: coverageOf(row),
          sharedPercent: row.sharedPercent,
          spans: row.spans,
          windowResetsAt: bank.resetsAt,
          current: current !== null && sameBank(current.resetsAt, bank.resetsAt)
        });
      }
    }
    return result;
  };
  const fiveHour = estimate(fiveHourWindow, 300, keys.fiveHour);
  const sevenDay = estimate(sevenDayWindow, 10_080, keys.sevenDay);
  const ids = new Set([...fiveHour.keys(), ...sevenDay.keys()]);
  return new Map(
    [...ids].map((threadId) => [threadId, {
      fiveHour: fiveHour.get(threadId) ?? null,
      sevenDay: sevenDay.get(threadId) ?? null
    }])
  );
}

function activityFor(
  store: UsageStore,
  startsAt: number,
  endsAt: number,
  threadIds: Set<string>,
  limit: number
): WindowActivityRun[] {
  return store.getPromptRunsBetween(startsAt, endsAt)
    .filter((run) => threadIds.has(run.threadId))
    .slice(0, limit)
    .map((run) => ({
      threadId: run.threadId,
      startedAt: Math.max(run.startedAt, startsAt),
      completedAt: Math.min(run.completedAt, endsAt)
    }));
}

/** Where the usage in the currently reported bank came from. */
export function calculateWindowBreakdown(
  store: UsageStore,
  current: RateLimitWindow | null,
  lookbackDays: number,
  keys: string[] | undefined,
  context: AttributionContext,
  topThreads = 8
): WindowBreakdown | null {
  if (!current) return null;
  const now = nowSeconds(context);
  const bank = bankForCurrent(listBanks(store, current.windowDurationMins, keys, lookbackDays), current);
  const attribution = getBankAttribution(store, keys, bank);
  const lookup = store.getThreadLookup();
  const threads = attribution.threads
    .filter((row) => row.percent > 0)
    .slice(0, topThreads)
    .map((row) => ({
      threadId: row.threadId,
      title: lookup.get(row.threadId)?.title ?? 'Untitled chat',
      model: lookup.get(row.threadId)?.model ?? 'unknown',
      percent: row.percent,
      coverage: coverageOf(row),
      sharedPercent: row.sharedPercent,
      deviceIds: Object.keys(row.devices)
    }));
  const windowStartsAt = bank.startsAt;

  return {
    resetsAt: current.resetsAt,
    windowStartsAt,
    observedDeltaPercent: attribution.observedDeltaPercent,
    attributedPercent: attribution.attributedPercent,
    unattributedPercent: attribution.unattributedPercent,
    samples: bank.samples.length,
    threads,
    activity: activityFor(store, windowStartsAt, now, new Set(threads.map((thread) => thread.threadId)), 400),
    cloudTasksInWindow: store.countCloudTasksBetween(windowStartsAt, now),
    provisional: isProvisional(bank, context)
  };
}

function summarize(
  bank: QuotaBank,
  attribution: BankAttribution,
  current: RateLimitWindow | null,
  context: AttributionContext
): WindowSummary {
  const now = nowSeconds(context);
  const values = bank.samples.map((sample) => sample.usedPercent);
  return {
    durationMins: bank.durationMins,
    resetsAt: bank.resetsAt,
    windowStartsAt: bank.startsAt,
    endsAt: Math.min(bank.resetsAt, now),
    current: current !== null && sameBank(current.resetsAt, bank.resetsAt),
    provisional: isProvisional(bank, context),
    peakPercent: values.length > 0 ? Math.max(...values) : 0,
    finalPercent: bank.samples.at(-1)?.usedPercent ?? 0,
    samples: bank.samples.length,
    observedDeltaPercent: attribution.observedDeltaPercent,
    attributedPercent: attribution.attributedPercent,
    unattributedPercent: attribution.unattributedPercent,
    sessionCount: attribution.threads.filter((row) => row.tokens > 0 || row.percent > 0).length,
    tokens: attribution.tokens,
    costUsd: attribution.costUsd
  };
}

/**
 * Past and current windows of one duration, newest first, straight from the
 * stored reset history. Idle reset times (which slide forward on every poll
 * until usage starts a window) and windows that were never used are left out.
 */
export function listWindows(
  store: UsageStore,
  durationMins: number,
  keys: string[] | undefined,
  current: RateLimitWindow | null,
  context: AttributionContext,
  lookbackDays = WINDOW_LIST_LOOKBACK_DAYS[durationMins] ?? 35
): WindowSummary[] {
  let banks = listBanks(store, durationMins, keys, lookbackDays);
  let live: QuotaBank | null = null;
  if (current) {
    live = bankForCurrent(banks, current);
    const liveResetsAt = live.resetsAt;
    banks = [...banks.filter((bank) => !sameBank(bank.resetsAt, liveResetsAt)), live];
  }
  return banks
    .filter((bank) => bank === live || isRealBank(bank))
    .map((bank) => summarize(bank, getBankAttribution(store, keys, bank), current, context))
    .filter((window) => window.current || window.peakPercent > 0 || window.tokens > 0)
    .sort((a, b) => b.resetsAt - a.resetsAt);
}

function chartPoints(samples: RateLimitWindow[]): ProjectionPoint[] {
  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample.key, (counts.get(sample.key) ?? 0) + 1);
  const preferred = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const series = groupWindowHistory(samples, preferred).flat().sort((a, b) => a.observedAt - b.observedAt);
  return thinChartPoints(series.map((point, index) => ({
    timestamp: point.observedAt,
    usedPercent: point.usedPercent,
    reset: index > 0 && point.usedPercent < series[index - 1].usedPercent - RESET_DROP_THRESHOLD
  })));
}

/** Everything shown for one window: chart, sessions, devices, and coverage. */
export function windowDetail(
  store: UsageStore,
  durationMins: number,
  keys: string[] | undefined,
  resetsAt: number,
  current: RateLimitWindow | null,
  context: AttributionContext
): WindowDetail | null {
  const now = nowSeconds(context);
  const lookbackDays = Math.max(2, Math.ceil((now - (resetsAt - durationMins * 60)) / 86_400) + 2);
  let banks = listBanks(store, durationMins, keys, lookbackDays);
  if (current && sameBank(current.resetsAt, resetsAt)) {
    const live = bankForCurrent(banks, current);
    banks = [...banks.filter((bank) => !sameBank(bank.resetsAt, live.resetsAt)), live];
  }
  const bank = banks.find((item) => sameBank(item.resetsAt, resetsAt));
  if (!bank) return null;

  const attribution = getBankAttribution(store, keys, bank);
  const summary = summarize(bank, attribution, current, context);
  const lookup = store.getThreadLookup();
  const sessions: WindowSession[] = attribution.threads
    .filter((row) => row.percent > 0 || row.tokens > 0)
    .map((row) => {
      const info = lookup.get(row.threadId);
      return {
        threadId: row.threadId,
        title: info?.title ?? 'Untitled chat',
        model: info?.model ?? 'unknown',
        source: info?.source ?? 'unknown',
        sourceLabel: info?.sourceLabel ?? null,
        projectName: info?.projectName ?? null,
        deviceIds: Object.keys(row.devices).length > 0 ? Object.keys(row.devices) : (info?.deviceIds ?? []),
        percent: row.percent,
        sharedPercent: row.sharedPercent,
        coverage: coverageOf(row),
        spans: row.spans,
        tokens: row.tokens,
        costUsd: row.costUsd,
        events: row.events,
        firstEventAt: row.firstEventAt,
        lastEventAt: row.lastEventAt
      };
    });

  const devices = new Map<string, WindowDeviceShare>();
  for (const row of attribution.threads) {
    const totalWeight = Object.values(row.devices).reduce((sum, device) => sum + device.weight, 0);
    for (const [deviceId, device] of Object.entries(row.devices)) {
      const share = devices.get(deviceId) ?? { deviceId, percent: 0, tokens: 0, costUsd: 0 };
      share.percent += totalWeight > 0 ? row.percent * (device.weight / totalWeight) : 0;
      share.tokens += device.tokens;
      share.costUsd += device.costUsd;
      devices.set(deviceId, share);
    }
  }

  return {
    ...summary,
    coverage: attribution.observedDeltaPercent > 0
      ? Math.min(1, attribution.attributedPercent / attribution.observedDeltaPercent)
      : 0,
    points: chartPoints(bank.samples),
    sessions,
    activity: activityFor(store, bank.startsAt, summary.endsAt, new Set(sessions.map((session) => session.threadId)), 600),
    devices: [...devices.values()].sort((a, b) => b.percent - a.percent || b.tokens - a.tokens)
  };
}
