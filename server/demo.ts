import type {
  DashboardOverview,
  ProjectionPoint,
  PromptMetric,
  ProviderId,
  ThreadSummary
} from './types.js';

const now = Math.floor(Date.now() / 1000);

/** Provider-flavoured names so the demo reads like real data for either CLI. */
interface DemoFlavour {
  primaryModel: string;
  secondaryModel: string;
  helperModel: string;
  reasoning: [string, string];
  sources: [ThreadSummary['source'], ThreadSummary['source']];
  planType: string;
  authType: string;
  /** Codex bills cache writes as plain input; Claude bills them separately. */
  cacheWrites: boolean;
  reportedCost: boolean;
  notice: string;
}

const FLAVOURS: Record<ProviderId, DemoFlavour> = {
  codex: {
    primaryModel: 'gpt-5.6-sol',
    secondaryModel: 'gpt-5.6-terra',
    helperModel: 'codex-auto-review',
    reasoning: ['high', 'medium'],
    sources: ['desktop', 'cli'],
    planType: 'plus',
    authType: 'chatgpt',
    cacheWrites: false,
    reportedCost: false,
    notice: 'Demo mode is enabled. Set DEMO_MODE=false to read your local Codex data.'
  },
  claude: {
    primaryModel: 'claude-fable-5-1',
    secondaryModel: 'claude-opus-5',
    helperModel: 'claude-haiku-4-5-20251001',
    reasoning: ['xhigh', 'high'],
    sources: ['cli', 'desktop'],
    planType: 'max 5x',
    authType: 'claude.ai',
    cacheWrites: true,
    reportedCost: true,
    notice: 'Demo mode is enabled. Set DEMO_MODE=false to read your local Claude Code data.'
  }
};

function points(start: number, count: number, step: number, startValue: number, rise: number): ProjectionPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * step,
    usedPercent: Math.min(100, startValue + index * rise + Math.sin(index / 2) * 0.8)
  }));
}

function demoPrompt(
  flavour: DemoFlavour,
  promptId: string,
  threadId: string,
  sequence: number,
  prompt: string,
  model: string,
  startedAt: number,
  durationMs: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  cost: number
): PromptMetric {
  const cacheWrites = flavour.cacheWrites ? Math.round((inputTokens - cachedInputTokens) * 0.6) : 0;
  return {
    promptId,
    sourceFile: 'demo',
    threadId,
    turnId: `turn-${promptId}`,
    sequence,
    prompt,
    startedAt,
    completedAt: startedAt + Math.round(durationMs / 1000),
    durationMs,
    timeToFirstTokenMs: 3_200,
    timingEstimated: false,
    primaryModel: model,
    models: [model],
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: Math.round(outputTokens * 0.35),
    totalTokens: inputTokens + outputTokens,
    cacheWriteInputTokens: cacheWrites,
    cacheWrite1hInputTokens: cacheWrites,
    estimatedApiCostUsd: cost,
    pricingStatus: 'exact-model-match'
  };
}

function buildThreads(flavour: DemoFlavour): ThreadSummary[] {
  const threadOnePrompts = [
    demoPrompt(flavour, 'demo-p1', 'demo-1', 1, 'Fix schedule import authentication and verify the worker flow.', flavour.primaryModel, now - 7200, 1_160_000, 910_000, 760_000, 29_000, 2.3),
    demoPrompt(flavour, 'demo-p2', 'demo-1', 2, 'Run the tests and fix the remaining mobile regression.', flavour.primaryModel, now - 5100, 640_000, 550_000, 450_000, 13_000, 1.48)
  ];
  const threadTwoPrompts = [
    demoPrompt(flavour, 'demo-p3', 'demo-2', 1, 'Improve the mobile schedule grid and reduce horizontal overflow.', flavour.secondaryModel, now - 86_400, 780_000, 760_000, 640_000, 24_000, 1.02)
  ];
  const cacheWritesOne = flavour.cacheWrites ? 150_000 : 0;
  const cacheWritesTwo = flavour.cacheWrites ? 72_000 : 0;

  return [
    {
      threadId: 'demo-1',
      title: 'Schedule import authentication',
      titleSource: 'generated',
      preview: null,
      projectPath: 'C:\\Projects\\ScheduleShare',
      projectName: 'ScheduleShare',
      source: flavour.sources[0],
      sourceLabel: null,
      reasoningEffort: flavour.reasoning[0],
      gitBranch: 'main',
      archived: false,
      startedAt: now - 7200,
      updatedAt: now - 1800,
      primaryModel: flavour.primaryModel,
      models: [flavour.primaryModel, flavour.helperModel],
      inputTokens: 1_460_000,
      cachedInputTokens: 1_210_000,
      outputTokens: 42_000,
      reasoningOutputTokens: 17_000,
      totalTokens: 1_502_000,
      cacheWriteInputTokens: cacheWritesOne,
      cacheWrite1hInputTokens: cacheWritesOne,
      estimatedApiCostUsd: 3.78,
      pricingStatus: 'exact-model-match',
      sourceFile: 'demo',
      userMessageCount: 2,
      reviewerTokens: flavour.cacheWrites ? 0 : 148_000,
      subagentTokens: flavour.cacheWrites ? 148_000 : 0,
      partCount: 3,
      reportedCostUsd: flavour.reportedCost ? 3.91 : null,
      prompts: threadOnePrompts,
      usage: {
        fiveHour: { percent: 9.8, coverage: 0.94, sharedPercent: 2.1, spans: 12, windowResetsAt: now + 5400, current: true },
        sevenDay: { percent: 3.4, coverage: 0.94, sharedPercent: 0.6, spans: 4, windowResetsAt: now + 86400, current: true }
      }
    },
    {
      threadId: 'demo-2',
      title: 'Cleaner mobile schedule grid',
      titleSource: 'generated',
      preview: null,
      projectPath: 'C:\\Projects\\ScheduleShare',
      projectName: 'ScheduleShare',
      source: flavour.sources[1],
      sourceLabel: null,
      reasoningEffort: flavour.reasoning[1],
      gitBranch: 'mobile-grid',
      archived: false,
      startedAt: now - 86_400,
      updatedAt: now - 82_500,
      primaryModel: flavour.secondaryModel,
      models: [flavour.secondaryModel],
      inputTokens: 760_000,
      cachedInputTokens: 640_000,
      outputTokens: 24_000,
      reasoningOutputTokens: 8_000,
      totalTokens: 784_000,
      cacheWriteInputTokens: cacheWritesTwo,
      cacheWrite1hInputTokens: cacheWritesTwo,
      estimatedApiCostUsd: 1.02,
      pricingStatus: 'exact-model-match',
      sourceFile: 'demo',
      userMessageCount: 1,
      reviewerTokens: 0,
      subagentTokens: 0,
      partCount: 1,
      reportedCostUsd: flavour.reportedCost ? 1.05 : null,
      prompts: threadTwoPrompts,
      usage: {
        fiveHour: { percent: 6.2, coverage: 1, sharedPercent: 0, spans: 6, windowResetsAt: now - 80_000, current: false },
        sevenDay: { percent: 1.7, coverage: 1, sharedPercent: 0, spans: 6, windowResetsAt: now + 86400, current: true }
      }
    }
  ];
}

export function demoOverview(provider: ProviderId = 'codex'): DashboardOverview {
  const flavour = FLAVOURS[provider];
  const threads = buildThreads(flavour);
  const fiveHistory = points(now - 3.5 * 3600, 15, 15 * 60, 5, 2.8);
  fiveHistory.push({ timestamp: now + 1.5 * 3600, usedPercent: 61, projected: true });
  const sevenHistory = points(now - 6 * 86400, 13, 12 * 3600, 10, 3.1);
  sevenHistory.push({ timestamp: now + 86400, usedPercent: 58, projected: true });
  const isClaude = provider === 'claude';

  return {
    provider,
    generatedAt: now,
    connection: { connected: true, authType: flavour.authType, planType: flavour.planType, error: null },
    account: {
      planType: flavour.planType,
      resetCreditsAvailable: isClaude ? null : 2,
      lifetimeTokens: 3_948_484_564,
      peakDailyTokens: 278_178_665,
      longestRunningTurnSec: 9_264,
      currentStreakDays: 15,
      longestStreakDays: 15,
      statsSource: isClaude ? 'local' : 'account',
      extraUsage: isClaude ? { enabled: false, usedPercent: null, usedUsd: null, limitUsd: null } : null
    },
    limits: {
      fiveHour: {
        key: isClaude ? 'claude:five-hour' : 'five-hour',
        label: '5-hour window',
        usedPercent: 47,
        windowDurationMins: 300,
        resetsAt: now + 5400,
        observedAt: now
      },
      sevenDay: {
        key: isClaude ? 'claude:seven-day' : 'seven-day',
        label: '7-day window',
        usedPercent: 42,
        windowDurationMins: 10_080,
        resetsAt: now + 86400,
        observedAt: now
      },
      other: isClaude
        ? [{
            key: 'claude:seven-day-scoped:fable',
            label: '7-day Fable window',
            usedPercent: 74,
            windowDurationMins: 10_080,
            resetsAt: now + 86400,
            observedAt: now
          }]
        : [],
      fiveHourStatus: 'available'
    },
    projections: {
      fiveHour: {
        projectedPercentAtReset: 61,
        projectedExhaustionAt: null,
        percentPerHour: 9.3,
        paceRatio: 0.53,
        confidence: 'high',
        samplesUsed: 15,
        resetEventsDetected: 0
      },
      sevenDay: {
        projectedPercentAtReset: 58,
        projectedExhaustionAt: null,
        percentPerHour: 0.16,
        paceRatio: 0.38,
        confidence: 'medium',
        samplesUsed: 13,
        resetEventsDetected: 0
      }
    },
    histories: { fiveHour: fiveHistory, sevenDay: sevenHistory },
    breakdown: {
      fiveHour: {
        resetsAt: now + 5400,
        windowStartsAt: now + 5400 - 5 * 3600,
        observedDeltaPercent: 47,
        attributedPercent: 41,
        unattributedPercent: 6,
        samples: 210,
        threads: [
          { threadId: 'demo-1', title: 'Schedule import authentication', model: flavour.primaryModel, percent: 32.4, coverage: 0.94 },
          { threadId: 'demo-2', title: 'Cleaner mobile schedule grid', model: flavour.secondaryModel, percent: 8.6, coverage: 1 }
        ],
        activity: [
          { threadId: 'demo-1', startedAt: now - 7200, completedAt: now - 6040 },
          { threadId: 'demo-1', startedAt: now - 5100, completedAt: now - 4460 },
          { threadId: 'demo-2', startedAt: now - 6500, completedAt: now - 5900 }
        ],
        cloudTasksInWindow: isClaude ? 0 : 1
      },
      sevenDay: {
        resetsAt: now + 86400,
        windowStartsAt: now + 86400 - 7 * 86400,
        observedDeltaPercent: 42,
        attributedPercent: 39,
        unattributedPercent: 3,
        samples: 900,
        threads: [
          { threadId: 'demo-1', title: 'Schedule import authentication', model: flavour.primaryModel, percent: 21.2, coverage: 0.94 },
          { threadId: 'demo-2', title: 'Cleaner mobile schedule grid', model: flavour.secondaryModel, percent: 17.8, coverage: 1 }
        ],
        activity: [],
        cloudTasksInWindow: isClaude ? 0 : 2
      }
    },
    accountDailyUsage: isClaude
      ? []
      : Array.from({ length: 14 }, (_, index) => ({
          date: new Date((now - (13 - index) * 86400) * 1000).toISOString().slice(0, 10),
          tokens: [410000, 230000, 0, 1250000, 470000, 910000, 720000, 310000, 840000, 620000, 1250000, 470000, 910000, 720000][index],
          source: 'account' as const
        })),
    localDailyUsage: Array.from({ length: 14 }, (_, index) => ({
      date: new Date((now - (13 - index) * 86400) * 1000).toISOString().slice(0, 10),
      tokens: [410000, 230000, 0, 1250000, 470000, 910000, 720000, 310000, 840000, 620000, 1250000, 470000, 910000, 720000][index],
      source: 'local' as const
    })),
    hourlyActivity: Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 24 }, (_, hour) =>
        hour >= 9 && hour <= 23 && day !== 0 ? Math.round(120_000 * Math.abs(Math.sin(hour / 3 + day))) : 0
      )
    ),
    totals: {
      threads: 2,
      inputTokens: 2_220_000,
      cachedInputTokens: 1_850_000,
      outputTokens: 66_000,
      reasoningOutputTokens: 25_000,
      totalTokens: 2_286_000,
      cacheWriteInputTokens: flavour.cacheWrites ? 222_000 : 0,
      cacheWrite1hInputTokens: flavour.cacheWrites ? 222_000 : 0,
      estimatedApiCostUsd: 4.8,
      pricedThreads: 2,
      unknownPriceThreads: isClaude ? 0 : 1
    },
    threads,
    modelEfficiency: [
      {
        model: flavour.primaryModel,
        estimatedUsagePercent: 19.4,
        activeMinutes: 76,
        minutesPerPercent: 3.92,
        tokens: 1_502_000,
        tokensPerPercent: 77_400,
        estimatedApiCostUsd: 3.78,
        costPerPercent: 0.19,
        spans: 18
      },
      {
        model: flavour.secondaryModel,
        estimatedUsagePercent: 8.6,
        activeMinutes: 51,
        minutesPerPercent: 5.93,
        tokens: 784_000,
        tokensPerPercent: 91_200,
        estimatedApiCostUsd: 1.02,
        costPerPercent: 0.12,
        spans: 11
      }
    ],
    modelUsage: [
      {
        model: flavour.primaryModel,
        threads: 1,
        inputTokens: 1_312_000,
        cachedInputTokens: 1_095_000,
        outputTokens: 42_000,
        reasoningOutputTokens: 17_000,
        totalTokens: 1_354_000,
        cacheWriteInputTokens: flavour.cacheWrites ? 150_000 : 0,
        cacheWrite1hInputTokens: flavour.cacheWrites ? 150_000 : 0,
        estimatedApiCostUsd: 3.78,
        pricingStatus: 'exact-model-match'
      },
      {
        model: flavour.helperModel,
        threads: 1,
        inputTokens: 145_000,
        cachedInputTokens: 115_000,
        outputTokens: 3_000,
        reasoningOutputTokens: 1_000,
        totalTokens: 148_000,
        cacheWriteInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        estimatedApiCostUsd: isClaude ? 0.04 : 0,
        pricingStatus: isClaude ? 'exact-model-match' : 'unknown'
      },
      {
        model: flavour.secondaryModel,
        threads: 1,
        inputTokens: 760_000,
        cachedInputTokens: 640_000,
        outputTokens: 24_000,
        reasoningOutputTokens: 8_000,
        totalTokens: 784_000,
        cacheWriteInputTokens: flavour.cacheWrites ? 72_000 : 0,
        cacheWrite1hInputTokens: flavour.cacheWrites ? 72_000 : 0,
        estimatedApiCostUsd: 1.02,
        pricingStatus: 'exact-model-match'
      }
    ],
    cloudTasks: isClaude
      ? { status: 'unsupported', checkedAt: null, tasks: [] }
      : {
          status: 'available',
          checkedAt: now - 120,
          tasks: [
            {
              id: 'demo-cloud-1',
              title: 'Add retry to the Canvas sync job',
              status: 'ready',
              updatedAt: now - 2400,
              environmentLabel: 'school-dashboard',
              url: null,
              isReview: false,
              filesChanged: 3,
              linesAdded: 42,
              linesRemoved: 11,
              firstSeenAt: now - 3000
            },
            {
              id: 'demo-cloud-2',
              title: 'Review PR 128',
              status: 'pending',
              updatedAt: now - 30_000,
              environmentLabel: 'scheduleshare',
              url: null,
              isReview: true,
              filesChanged: null,
              linesAdded: null,
              linesRemoved: null,
              firstSeenAt: now - 30_000
            }
          ]
        },
    notices: [flavour.notice]
  };
}
