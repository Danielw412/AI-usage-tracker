import type { DashboardOverview, ProjectionPoint, PromptMetric, ThreadSummary } from './types.js';

const now = Math.floor(Date.now() / 1000);

function points(start: number, count: number, step: number, startValue: number, rise: number): ProjectionPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * step,
    usedPercent: Math.min(100, startValue + index * rise + Math.sin(index / 2) * 0.8)
  }));
}

function demoPrompt(
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
    estimatedApiCostUsd: cost,
    pricingStatus: 'exact-model-match'
  };
}

const threadOnePrompts = [
  demoPrompt('demo-p1', 'demo-1', 1, 'Fix schedule import authentication and verify the worker flow.', 'gpt-5.6-sol', now - 7200, 1_160_000, 910_000, 760_000, 29_000, 2.3),
  demoPrompt('demo-p2', 'demo-1', 2, 'Run the tests and fix the remaining mobile regression.', 'gpt-5.6-sol', now - 5100, 640_000, 550_000, 450_000, 13_000, 1.48)
];
const threadTwoPrompts = [
  demoPrompt('demo-p3', 'demo-2', 1, 'Improve the mobile schedule grid and reduce horizontal overflow.', 'gpt-5.6-terra', now - 86_400, 780_000, 760_000, 640_000, 24_000, 1.02)
];

const threads: ThreadSummary[] = [
  {
    threadId: 'demo-1',
    title: 'Schedule import authentication',
    titleSource: 'codex-name',
    preview: null,
    projectPath: 'C:\\Projects\\ScheduleShare',
    projectName: 'ScheduleShare',
    source: 'desktop',
    sourceLabel: null,
    reasoningEffort: 'high',
    gitBranch: 'main',
    archived: false,
    startedAt: now - 7200,
    updatedAt: now - 1800,
    primaryModel: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'codex-auto-review'],
    inputTokens: 1_460_000,
    cachedInputTokens: 1_210_000,
    outputTokens: 42_000,
    reasoningOutputTokens: 17_000,
    totalTokens: 1_502_000,
    estimatedApiCostUsd: 3.78,
    pricingStatus: 'exact-model-match',
    sourceFile: 'demo',
    userMessageCount: 2,
    reviewerTokens: 148_000,
    subagentTokens: 0,
    partCount: 3,
    prompts: threadOnePrompts,
    usage: {
      fiveHour: { percent: 9.8, coverage: 0.94, sharedPercent: 2.1, spans: 12, windowResetsAt: now + 5400, current: true },
      sevenDay: { percent: 3.4, coverage: 0.94, sharedPercent: 0.6, spans: 4, windowResetsAt: now + 86400, current: true }
    }
  },
  {
    threadId: 'demo-2',
    title: 'Cleaner mobile schedule grid',
    titleSource: 'codex-name',
    preview: null,
    projectPath: 'C:\\Projects\\ScheduleShare',
    projectName: 'ScheduleShare',
    source: 'cli',
    sourceLabel: null,
    reasoningEffort: 'medium',
    gitBranch: 'mobile-grid',
    archived: false,
    startedAt: now - 86_400,
    updatedAt: now - 82_500,
    primaryModel: 'gpt-5.6-terra',
    models: ['gpt-5.6-terra'],
    inputTokens: 760_000,
    cachedInputTokens: 640_000,
    outputTokens: 24_000,
    reasoningOutputTokens: 8_000,
    totalTokens: 784_000,
    estimatedApiCostUsd: 1.02,
    pricingStatus: 'exact-model-match',
    sourceFile: 'demo',
    userMessageCount: 1,
    reviewerTokens: 0,
    subagentTokens: 0,
    partCount: 1,
    prompts: threadTwoPrompts,
    usage: {
      fiveHour: { percent: 6.2, coverage: 1, sharedPercent: 0, spans: 6, windowResetsAt: now - 80_000, current: false },
      sevenDay: { percent: 1.7, coverage: 1, sharedPercent: 0, spans: 6, windowResetsAt: now + 86400, current: true }
    }
  }
];

export function demoOverview(): DashboardOverview {
  const fiveHistory = points(now - 3.5 * 3600, 15, 15 * 60, 5, 2.8);
  fiveHistory.push({ timestamp: now + 1.5 * 3600, usedPercent: 61, projected: true });
  const sevenHistory = points(now - 6 * 86400, 13, 12 * 3600, 10, 3.1);
  sevenHistory.push({ timestamp: now + 86400, usedPercent: 58, projected: true });

  return {
    generatedAt: now,
    connection: { codexConnected: true, authType: 'chatgpt', planType: 'plus', error: null },
    account: {
      planType: 'plus',
      resetCreditsAvailable: 2,
      lifetimeTokens: 3_948_484_564,
      peakDailyTokens: 278_178_665,
      longestRunningTurnSec: 9_264,
      currentStreakDays: 15,
      longestStreakDays: 15
    },
    limits: {
      fiveHour: {
        key: 'five-hour',
        label: '5-hour window',
        usedPercent: 47,
        windowDurationMins: 300,
        resetsAt: now + 5400,
        observedAt: now
      },
      sevenDay: {
        key: 'seven-day',
        label: '7-day window',
        usedPercent: 42,
        windowDurationMins: 10_080,
        resetsAt: now + 86400,
        observedAt: now
      },
      other: [],
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
          { threadId: 'demo-1', title: 'Schedule import authentication', model: 'gpt-5.6-sol', percent: 32.4, coverage: 0.94 },
          { threadId: 'demo-2', title: 'Cleaner mobile schedule grid', model: 'gpt-5.6-terra', percent: 8.6, coverage: 1 }
        ],
        activity: [
          { threadId: 'demo-1', startedAt: now - 7200, completedAt: now - 6040 },
          { threadId: 'demo-1', startedAt: now - 5100, completedAt: now - 4460 },
          { threadId: 'demo-2', startedAt: now - 6500, completedAt: now - 5900 }
        ],
        cloudTasksInWindow: 1
      },
      sevenDay: {
        resetsAt: now + 86400,
        windowStartsAt: now + 86400 - 7 * 86400,
        observedDeltaPercent: 42,
        attributedPercent: 39,
        unattributedPercent: 3,
        samples: 900,
        threads: [
          { threadId: 'demo-1', title: 'Schedule import authentication', model: 'gpt-5.6-sol', percent: 21.2, coverage: 0.94 },
          { threadId: 'demo-2', title: 'Cleaner mobile schedule grid', model: 'gpt-5.6-terra', percent: 17.8, coverage: 1 }
        ],
        activity: [],
        cloudTasksInWindow: 2
      }
    },
    accountDailyUsage: Array.from({ length: 14 }, (_, index) => ({
      date: new Date((now - (13 - index) * 86400) * 1000).toISOString().slice(0, 10),
      tokens: [410000, 230000, 0, 1250000, 470000, 910000, 720000, 310000, 840000, 620000, 1250000, 470000, 910000, 720000][index],
      source: 'account' as const
    })),
    localDailyUsage: [],
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
      estimatedApiCostUsd: 4.8,
      pricedThreads: 2,
      unknownPriceThreads: 1
    },
    threads,
    modelEfficiency: [
      {
        model: 'gpt-5.6-sol',
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
        model: 'gpt-5.6-terra',
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
        model: 'gpt-5.6-sol',
        threads: 1,
        inputTokens: 1_312_000,
        cachedInputTokens: 1_095_000,
        outputTokens: 42_000,
        reasoningOutputTokens: 17_000,
        totalTokens: 1_354_000,
        estimatedApiCostUsd: 3.78,
        pricingStatus: 'exact-model-match'
      },
      {
        model: 'codex-auto-review',
        threads: 1,
        inputTokens: 145_000,
        cachedInputTokens: 115_000,
        outputTokens: 3_000,
        reasoningOutputTokens: 1_000,
        totalTokens: 148_000,
        estimatedApiCostUsd: 0,
        pricingStatus: 'unknown'
      },
      {
        model: 'gpt-5.6-terra',
        threads: 1,
        inputTokens: 760_000,
        cachedInputTokens: 640_000,
        outputTokens: 24_000,
        reasoningOutputTokens: 8_000,
        totalTokens: 784_000,
        estimatedApiCostUsd: 1.02,
        pricingStatus: 'exact-model-match'
      }
    ],
    cloudTasks: {
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
    notices: ['Demo mode is enabled. Set DEMO_MODE=false to read your local Codex data.']
  };
}
