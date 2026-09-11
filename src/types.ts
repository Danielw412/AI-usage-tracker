// Mirror of server/types.ts. Keep in sync when the overview payload changes.

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
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
export type TitleSource = 'codex-name' | 'codex-preview' | 'prompt' | 'fallback';
export type ThreadSource =
  | 'desktop'
  | 'cli'
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
  /** True when the bank is the window Codex is reporting right now. */
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
}

export interface DashboardOverview {
  generatedAt: number;
  connection: {
    codexConnected: boolean;
    authType: string | null;
    planType: string | null;
    error: string | null;
  };
  account: AccountSummary;
  limits: {
    fiveHour: RateLimitWindow | null;
    sevenDay: RateLimitWindow | null;
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
    status: 'available' | 'unavailable' | 'disabled';
    checkedAt: number | null;
    tasks: CloudTask[];
  };
  notices: string[];
}
