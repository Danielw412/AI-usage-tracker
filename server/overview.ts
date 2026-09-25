import {
  buildChartPoints,
  calculateModelEfficiency,
  calculateProjection,
  type HistoryKeys
} from './analytics.js';
import type { UsageStore } from './db.js';
import type {
  AccountSummary,
  DashboardOverview,
  ProviderId,
  RateLimitWindow,
  SyncOverview
} from './types.js';
import { calculateThreadUsageEstimates, calculateWindowBreakdown } from './windows.js';

export interface CurrentLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  other: RateLimitWindow[];
}

export interface OverviewInputs {
  provider: ProviderId;
  store: UsageStore;
  limits: CurrentLimits;
  /** Restrict history queries to these sample keys (see HistoryKeys). */
  historyKeys?: HistoryKeys;
  connection: DashboardOverview['connection'];
  account: AccountSummary;
  cloudTasks: DashboardOverview['cloudTasks'];
  sync: SyncOverview;
  notices: string[];
  /** Notice shown when the store holds no session data at all. */
  emptyThreadsNotice: string;
}

/**
 * Assemble the dashboard payload from a provider's store and live state. Every
 * provider shares this so the projections, attribution, and charts behave the
 * same way regardless of where the samples and logs came from. On the central
 * server the store holds every device's events, so every figure below is the
 * combined picture.
 */
export function buildProviderOverview(inputs: OverviewInputs): DashboardOverview {
  const { store, limits, historyKeys = {} } = inputs;
  const { fiveHour, sevenDay } = limits;
  const context = { settledThrough: inputs.sync.settledThrough };
  const fiveHistory = fiveHour
    ? store.getRateLimitHistory(300, fiveHour.resetsAt, 2, historyKeys.fiveHour)
    : store.getRateLimitHistory(300, undefined, 8, historyKeys.fiveHour);
  const sevenHistory = sevenDay
    ? store.getRateLimitHistory(10_080, sevenDay.resetsAt, 8, historyKeys.sevenDay)
    : store.getRateLimitHistory(10_080, undefined, 15, historyKeys.sevenDay);
  const fiveProjection = calculateProjection(fiveHour, fiveHistory);
  const sevenProjection = calculateProjection(sevenDay, sevenHistory);
  const usageEstimates = calculateThreadUsageEstimates(store, fiveHour, sevenDay, historyKeys);
  const threads = store.getThreadSummaries(120).map((thread) => ({
    ...thread,
    usage: usageEstimates.get(thread.threadId) ?? { fiveHour: null, sevenDay: null }
  }));
  const totals = store.getTokenTotals();
  const notices = [...inputs.notices];
  if (threads.length === 0) notices.push(inputs.emptyThreadsNotice);

  return {
    provider: inputs.provider,
    generatedAt: Math.floor(Date.now() / 1000),
    connection: inputs.connection,
    account: inputs.account,
    limits: {
      fiveHour,
      sevenDay,
      other: limits.other,
      fiveHourStatus: fiveHour ? 'available' : 'not-reported'
    },
    projections: {
      fiveHour: fiveProjection,
      sevenDay: sevenProjection
    },
    histories: {
      fiveHour: buildChartPoints(fiveHour, fiveHistory, fiveProjection),
      sevenDay: buildChartPoints(sevenDay, sevenHistory, sevenProjection)
    },
    breakdown: {
      fiveHour: calculateWindowBreakdown(store, fiveHour, 2, historyKeys.fiveHour, context),
      sevenDay: calculateWindowBreakdown(store, sevenDay, 9, historyKeys.sevenDay, context)
    },
    accountDailyUsage: store.getAccountDailyUsage(14),
    localDailyUsage: store.getLocalDailyUsage(14),
    hourlyActivity: store.getHourlyActivity(30),
    totals,
    threads,
    modelEfficiency: calculateModelEfficiency(store, historyKeys),
    modelUsage: store.getModelUsageSummaries(),
    cloudTasks: inputs.cloudTasks,
    sync: inputs.sync,
    notices
  };
}
