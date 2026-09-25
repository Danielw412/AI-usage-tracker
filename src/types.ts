// Mirror of server/types.ts. Keep in sync when the overview payload changes.

/** Which local coding agent a dashboard payload describes. */
export type ProviderId = 'codex' | 'claude';

export interface ProviderInfo {
  id: ProviderId;
  /** Product name, e.g. "Codex" or "Claude Code". */
  label: string;
  /** False when the provider is turned off in configuration. */
  enabled: boolean;
}

export interface TokenUsage {
  /** Every prompt token sent upstream, including cache reads and cache writes. */
  inputTokens: number;
  /** Prompt tokens served from the provider's prompt cache (a subset of inputTokens). */
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens written to the cache at a premium rate (a subset of inputTokens,
   * disjoint from cachedInputTokens). Only providers that bill cache writes
   * separately report it; absent or zero otherwise.
   */
  cacheWriteInputTokens?: number;
  /** Portion of cacheWriteInputTokens written with a one-hour lifetime. */
  cacheWrite1hInputTokens?: number;
}

export interface RateLimitWindow {
  key: string;
  label: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  observedAt: number;
}

export interface ProjectionPoint {
  timestamp: number;
  usedPercent: number;
  projected?: boolean;
  reset?: boolean;
}

export interface LimitProjection {
  projectedPercentAtReset: number | null;
  projectedExhaustionAt: number | null;
  percentPerHour: number | null;
  paceRatio: number | null;
  confidence: 'low' | 'medium' | 'high' | 'unavailable';
  samplesUsed: number;
  resetEventsDetected: number;
}

export interface DailyUsage {
  date: string;
  tokens: number;
  source: 'account' | 'local';
}

export type SessionPartKind = 'main' | 'reviewer' | 'subagent';
export type PricingStatus = 'exact-model-match' | 'partial' | 'unknown';
/**
 * Where a chat's title came from: a name generated or set inside the provider's
 * own app, the provider's prompt preview, the first local prompt, or a label.
 */
export type TitleSource = 'generated' | 'preview' | 'prompt' | 'fallback';
export type ThreadSource =
  | 'desktop'
  | 'cli'
  | 'ide'
  | 'exec'
  | 'cloud'
  | 'voice'
  | 'review'
  | 'subagent'
  | 'unknown';

export interface PromptMetric extends TokenUsage {
  promptId: string;
  sourceFile: string;
  threadId: string;
  turnId: string | null;
  sequence: number;
  prompt: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  timingEstimated: boolean;
  primaryModel: string;
  models: string[];
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
}

export interface ThreadPartSummary extends TokenUsage {
  threadId: string;
  partId?: string;
  title: string | null;
  projectPath: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  primaryModel: string;
  models: string[];
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
  sourceFile: string;
  partKind: SessionPartKind;
  userMessageCount: number;
  source: ThreadSource;
  sourceLabel: string | null;
  /** The provider's own cost figure for this part, when it records one locally. */
  reportedCostUsd?: number | null;
}

/** Quota attributed to one thread inside a single reset bank. */
export interface ThreadWindowUsage {
  percent: number;
  /** Share of the thread's weighted tokens that were bracketed by quota samples, 0..1. */
  coverage: number;
  /** Portion of `percent` earned while other chats were also running. */
  sharedPercent: number;
  spans: number;
  windowResetsAt: number;
  /** True when the bank is the window the provider is reporting right now. */
  current: boolean;
}

export interface ThreadSummary extends TokenUsage {
  threadId: string;
  title: string;
  titleSource: TitleSource;
  /** Cleaned first prompt, shown under label-based titles. */
  preview: string | null;
  projectPath: string | null;
  projectName: string | null;
  source: ThreadSource;
  sourceLabel: string | null;
  reasoningEffort: string | null;
  gitBranch: string | null;
  archived: boolean;
  startedAt: number | null;
  updatedAt: number | null;
  primaryModel: string;
  models: string[];
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
  sourceFile: string;
  userMessageCount: number;
  reviewerTokens: number;
  subagentTokens: number;
  partCount: number;
  /** Cost the provider itself recorded for the chat, when available (Claude Code writes one). */
  reportedCostUsd: number | null;
  /** Devices whose logs contributed to this chat, normally exactly one. */
  deviceIds: string[];
  prompts: PromptMetric[];
  usage: {
    fiveHour: ThreadWindowUsage | null;
    sevenDay: ThreadWindowUsage | null;
  };
}

export interface ModelEfficiency {
  model: string;
  estimatedUsagePercent: number;
  activeMinutes: number;
  minutesPerPercent: number | null;
  tokens: number;
  tokensPerPercent: number | null;
  estimatedApiCostUsd: number;
  costPerPercent: number | null;
  spans: number;
}

export interface ModelUsageSummary extends TokenUsage {
  model: string;
  threads: number;
  estimatedApiCostUsd: number;
  pricingStatus: PricingStatus;
}

export interface WindowActivityRun {
  threadId: string;
  startedAt: number;
  completedAt: number;
}

export interface WindowThreadShare {
  threadId: string;
  title: string;
  model: string;
  percent: number;
  coverage: number;
  /** Portion of `percent` earned in quota rises shared with other chats. */
  sharedPercent: number;
  deviceIds: string[];
}

/** Where the current reset bank's usage came from. */
export interface WindowBreakdown {
  resetsAt: number;
  windowStartsAt: number;
  observedDeltaPercent: number;
  attributedPercent: number;
  unattributedPercent: number;
  samples: number;
  threads: WindowThreadShare[];
  activity: WindowActivityRun[];
  cloudTasksInWindow: number;
  /** True while a collector has not yet synchronized past the end of this bank. */
  provisional: boolean;
}

/** One chat's contribution to a single quota window (current or past). */
export interface WindowSession {
  threadId: string;
  title: string;
  model: string;
  source: ThreadSource;
  sourceLabel: string | null;
  projectName: string | null;
  deviceIds: string[];
  percent: number;
  sharedPercent: number;
  coverage: number;
  spans: number;
  /** Tokens and API-equivalent cost logged inside this window only. */
  tokens: number;
  costUsd: number;
  events: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

/** One entry in the list of past and current quota windows. */
export interface WindowSummary {
  durationMins: number;
  resetsAt: number;
  windowStartsAt: number;
  endsAt: number;
  current: boolean;
  provisional: boolean;
  peakPercent: number;
  finalPercent: number;
  samples: number;
  observedDeltaPercent: number;
  attributedPercent: number;
  unattributedPercent: number;
  sessionCount: number;
  tokens: number;
  costUsd: number;
}

export interface WindowDeviceShare {
  deviceId: string;
  percent: number;
  tokens: number;
  costUsd: number;
}

export interface WindowDetail extends WindowSummary {
  /** Attributed share of the observed rise, 0..1. */
  coverage: number;
  points: ProjectionPoint[];
  sessions: WindowSession[];
  activity: WindowActivityRun[];
  devices: WindowDeviceShare[];
}

export type TrackerRole = 'standalone' | 'server' | 'collector';

export interface DeviceStatus {
  deviceId: string;
  label: string;
  role: TrackerRole;
  self: boolean;
  online: boolean;
  lastSeenAt: number | null;
  lastSyncAt: number | null;
  pendingRecords: number | null;
  syncedThrough: number | null;
  clockOffsetSeconds: number | null;
  warning: string | null;
}

export interface SyncOverview {
  role: TrackerRole;
  deviceId: string;
  devices: DeviceStatus[];
  settledThrough: number | null;
  multiDevice: boolean;
}

export interface CloudTask {
  id: string;
  title: string;
  status: string;
  updatedAt: number | null;
  environmentLabel: string | null;
  url: string | null;
  isReview: boolean;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  firstSeenAt: number;
}

export interface AccountSummary {
  planType: string | null;
  resetCreditsAvailable: number | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  /**
   * Whether the lifetime figures above came from the provider's account API or
   * were computed from local logs. Local figures only cover what this machine saw.
   */
  statsSource: 'account' | 'local' | 'none';
  /** Pay-as-you-go overage on top of the plan, when the provider exposes it. */
  extraUsage: {
    enabled: boolean;
    usedPercent: number | null;
    usedUsd: number | null;
    limitUsd: number | null;
  } | null;
}

export type CloudTaskStatus = 'available' | 'unavailable' | 'disabled' | 'unsupported';

export interface DashboardOverview {
  provider: ProviderId;
  generatedAt: number;
  connection: {
    connected: boolean;
    authType: string | null;
    planType: string | null;
    error: string | null;
  };
  account: AccountSummary;
  limits: {
    fiveHour: RateLimitWindow | null;
    sevenDay: RateLimitWindow | null;
    /** Additional windows the provider reports, such as model-specific weekly caps. */
    other: RateLimitWindow[];
    fiveHourStatus: 'available' | 'not-reported';
  };
  projections: {
    fiveHour: LimitProjection;
    sevenDay: LimitProjection;
  };
  histories: {
    fiveHour: ProjectionPoint[];
    sevenDay: ProjectionPoint[];
  };
  breakdown: {
    fiveHour: WindowBreakdown | null;
    sevenDay: WindowBreakdown | null;
  };
  accountDailyUsage: DailyUsage[];
  localDailyUsage: DailyUsage[];
  /** Tokens by local weekday (0 = Sunday) and hour, last 30 days. */
  hourlyActivity: number[][];
  totals: TokenUsage & {
    threads: number;
    estimatedApiCostUsd: number;
    pricedThreads: number;
    unknownPriceThreads: number;
  };
  threads: ThreadSummary[];
  modelEfficiency: ModelEfficiency[];
  modelUsage: ModelUsageSummary[];
  cloudTasks: {
    status: CloudTaskStatus;
    checkedAt: number | null;
    tasks: CloudTask[];
  };
  sync: SyncOverview;
  notices: string[];
}
