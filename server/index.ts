import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AppServerClient } from './codex/AppServerClient.js';
import { classifyThreadSource, readLocalThreadMetadata } from './codex/localThreadMetadata.js';
import {
  normalizeAccount,
  normalizeDailyUsage,
  normalizeRateLimitExtras,
  normalizeRateLimits,
  normalizeUsageSummary,
  type UsageSummary
} from './codex/normalize.js';
import {
  getAccountDailyUsage,
  getCloudTasks,
  getHourlyActivity,
  getLocalDailyUsage,
  getModelUsageSummaries,
  getRateLimitHistory,
  getThreadSummaries,
  getTokenTotals,
  insertRateLimitSnapshot,
  upsertAccountDailyUsage,
  upsertCloudTasks,
  upsertThreadMetadata,
  type ThreadMetadataInput
} from './db.js';
import {
  buildChartPoints,
  calculateModelEfficiency,
  calculateProjection,
  calculateThreadUsageEstimates,
  calculateWindowBreakdown
} from './analytics.js';
import { listCloudTasks } from './cloudTasks.js';
import { demoOverview } from './demo.js';
import { loadPricingConfig } from './pricing.js';
import { scanCodexSessions } from './sessionLogs.js';
import type { DashboardOverview, RateLimitWindow } from './types.js';

const app = express();
app.use(express.json());

const port = Number(process.env.PORT || 8787);
const demoMode = process.env.DEMO_MODE === 'true';
const rateLimitPollMs = Number(process.env.RATE_LIMIT_POLL_MS || 60_000);
const accountUsagePollMs = Number(process.env.ACCOUNT_USAGE_POLL_MS || 900_000);
const sessionScanMs = Number(process.env.SESSION_SCAN_MS || 120_000);
const threadMetadataPollMs = Number(process.env.THREAD_METADATA_POLL_MS || 900_000);
const cloudTaskPollMs = Number(process.env.CLOUD_TASK_POLL_MS || 600_000);
const cloudTasksEnabled = process.env.CLOUD_TASKS !== 'false';

const codex = new AppServerClient();
let limits: RateLimitWindow[] = [];
let accountState: { authType: string | null; planType: string | null } = {
  authType: null,
  planType: null
};
let accountExtras: { planType: string | null; resetCreditsAvailable: number | null } = {
  planType: null,
  resetCreditsAvailable: null
};
let usageSummary: UsageSummary = {
  lifetimeTokens: null,
  peakDailyTokens: null,
  longestRunningTurnSec: null,
  currentStreakDays: null,
  longestStreakDays: null
};
let connectionError: string | null = null;
let refreshInProgress: Promise<void> | null = null;
let sessionRefreshInProgress: Promise<void> | null = null;
let cloudRefreshInProgress: Promise<void> | null = null;
let lastAccountUsageRefresh = 0;
let lastThreadMetadataRefresh = 0;
let cloudTasksStatus: DashboardOverview['cloudTasks']['status'] = cloudTasksEnabled
  ? 'unavailable'
  : 'disabled';
let cloudTasksCheckedAt: number | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

codex.on('diagnostic', (message: string) => {
  if (process.env.DEBUG_CODEX_DASHBOARD === 'true') console.log(`[codex] ${message}`);
});
codex.on('account/rateLimits/updated', () => {
  setTimeout(() => void refreshCodexData(false), 500);
});
codex.on('thread/name/updated', () => {
  lastThreadMetadataRefresh = 0;
  setTimeout(() => void refreshCodexData(false), 500);
});

function pickWindow(duration: number): RateLimitWindow | null {
  return (
    limits.find((limit) => Math.abs(limit.windowDurationMins - duration) <= (duration < 1000 ? 5 : 60)) ??
    null
  );
}

function localMetadataInputs(): ThreadMetadataInput[] {
  return readLocalThreadMetadata().map((item) => ({
    threadId: item.threadId,
    displayName: item.displayName,
    preview: item.preview,
    updatedAt: item.updatedAt,
    source: item.source,
    sourceLabel: item.sourceLabel,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    gitBranch: item.gitBranch,
    projectName: item.projectName,
    archived: item.archived
  }));
}

async function refreshThreadMetadata(): Promise<void> {
  const collected: ThreadMetadataInput[] = [];

  for (const archived of [false, true]) {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await codex.request('thread/list', {
        cursor,
        limit: 100,
        archived,
        sortKey: 'updated_at',
        sortDirection: 'desc'
      }, 30_000);
      if (!isRecord(result)) break;
      const data = Array.isArray(result.data) ? result.data : [];
      for (const value of data) {
        if (!isRecord(value)) continue;
        const threadId = firstText(value, ['id', 'threadId', 'thread_id']);
        if (!threadId) continue;
        const classified = classifyThreadSource(
          firstText(value, ['source']),
          firstText(value, ['threadSource', 'thread_source'])
        );
        const gitInfo = isRecord(value.gitInfo) ? value.gitInfo : null;
        collected.push({
          threadId,
          // Only generated names count as display names; previews are raw prompts.
          displayName: firstText(value, ['name', 'threadName', 'displayName']),
          preview: firstText(value, ['preview', 'promptPreview']),
          updatedAt: parseTime(value.updatedAt ?? value.updated_at ?? value.recencyAt ?? value.createdAt),
          source: classified.source,
          sourceLabel: classified.sourceLabel,
          model: firstText(value, ['model']),
          reasoningEffort: firstText(value, ['reasoningEffort', 'reasoning_effort']),
          gitBranch: gitInfo ? firstText(gitInfo, ['branch']) : null,
          archived
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
  }

  if (collected.length > 0) upsertThreadMetadata(collected);
  const local = localMetadataInputs();
  if (local.length > 0) upsertThreadMetadata(local);
  lastThreadMetadataRefresh = Date.now();
}

async function refreshCodexData(forceAccountUsage = false): Promise<void> {
  if (demoMode) return;
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    try {
      await codex.start();
      const accountResult = await codex.request('account/read', { refreshToken: false });
      accountState = normalizeAccount(accountResult);

      const rateResult = await codex.request('account/rateLimits/read');
      const normalized = normalizeRateLimits(rateResult);
      if (normalized.length > 0) {
        limits = normalized;
        for (const limit of normalized) insertRateLimitSnapshot(limit);
      }
      accountExtras = normalizeRateLimitExtras(rateResult);
      connectionError = null;

      const now = Date.now();
      if (forceAccountUsage || now - lastAccountUsageRefresh >= accountUsagePollMs) {
        try {
          const usageResult = await codex.request('account/usage/read');
          const daily = normalizeDailyUsage(usageResult);
          if (daily.length > 0) upsertAccountDailyUsage(daily);
          usageSummary = normalizeUsageSummary(usageResult);
          lastAccountUsageRefresh = now;
        } catch (error) {
          console.warn('Account usage summary unavailable:', (error as Error).message);
        }
      }

      if (forceAccountUsage || now - lastThreadMetadataRefresh >= threadMetadataPollMs) {
        try {
          await refreshThreadMetadata();
        } catch (error) {
          console.warn('Thread titles unavailable from App Server:', (error as Error).message);
          lastThreadMetadataRefresh = now;
        }
      }
    } catch (error) {
      connectionError = (error as Error).message;
      console.warn('Could not refresh Codex account data:', connectionError);
    }
  })().finally(() => {
    refreshInProgress = null;
  });

  return refreshInProgress;
}

async function refreshSessions(): Promise<void> {
  if (demoMode) return;
  if (sessionRefreshInProgress) return sessionRefreshInProgress;

  sessionRefreshInProgress = (async () => {
    const result = await scanCodexSessions();
    const local = localMetadataInputs();
    if (local.length > 0) upsertThreadMetadata(local);
    if (process.env.DEBUG_CODEX_DASHBOARD === 'true') {
      console.log(`Session scan: ${result.scanned} found, ${result.updated} updated, ${result.errors} errors`);
    }
  })().finally(() => {
    sessionRefreshInProgress = null;
  });

  return sessionRefreshInProgress;
}

async function refreshCloudTasks(): Promise<void> {
  if (demoMode || !cloudTasksEnabled) return;
  if (cloudRefreshInProgress) return cloudRefreshInProgress;

  cloudRefreshInProgress = (async () => {
    try {
      const tasks = await listCloudTasks(20);
      if (tasks.length > 0) upsertCloudTasks(tasks);
      cloudTasksStatus = 'available';
    } catch (error) {
      cloudTasksStatus = 'unavailable';
      if (process.env.DEBUG_CODEX_DASHBOARD === 'true') {
        console.warn('Codex Cloud task list unavailable:', (error as Error).message);
      }
    } finally {
      cloudTasksCheckedAt = Math.floor(Date.now() / 1000);
    }
  })().finally(() => {
    cloudRefreshInProgress = null;
  });

  return cloudRefreshInProgress;
}

function buildOverview(): DashboardOverview {
  if (demoMode) return demoOverview();

  const fiveHour = pickWindow(300);
  const sevenDay = pickWindow(10_080);
  const fiveHistory = fiveHour
    ? getRateLimitHistory(300, fiveHour.resetsAt, 2)
    : getRateLimitHistory(300, undefined, 8);
  const sevenHistory = sevenDay
    ? getRateLimitHistory(10_080, sevenDay.resetsAt, 8)
    : getRateLimitHistory(10_080, undefined, 15);
  const fiveProjection = calculateProjection(fiveHour, fiveHistory);
  const sevenProjection = calculateProjection(sevenDay, sevenHistory);
  const usageEstimates = calculateThreadUsageEstimates(fiveHour, sevenDay);
  const threads = getThreadSummaries(120).map((thread) => ({
    ...thread,
    usage: usageEstimates.get(thread.threadId) ?? { fiveHour: null, sevenDay: null }
  }));
  const totals = getTokenTotals();
  const notices: string[] = [];

  if (threads.length === 0) {
    notices.push(
      'No local session token events were found. Check CODEX_HOME or create a new Codex thread, then refresh.'
    );
  }
  if (connectionError) notices.push(`Codex account connection error: ${connectionError}`);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    connection: {
      codexConnected: codex.connected && !connectionError,
      ...accountState,
      error: connectionError
    },
    account: {
      planType: accountExtras.planType ?? accountState.planType,
      resetCreditsAvailable: accountExtras.resetCreditsAvailable,
      ...usageSummary
    },
    limits: {
      fiveHour,
      sevenDay,
      other: limits.filter(
        (limit) =>
          Math.abs(limit.windowDurationMins - 300) > 5 &&
          Math.abs(limit.windowDurationMins - 10_080) > 60
      ),
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
      fiveHour: calculateWindowBreakdown(fiveHour, getRateLimitHistory(300, undefined, 2)),
      sevenDay: calculateWindowBreakdown(sevenDay, getRateLimitHistory(10_080, undefined, 9))
    },
    accountDailyUsage: getAccountDailyUsage(14),
    localDailyUsage: getLocalDailyUsage(14),
    hourlyActivity: getHourlyActivity(30),
    totals,
    threads,
    modelEfficiency: calculateModelEfficiency(),
    modelUsage: getModelUsageSummaries(),
    cloudTasks: {
      status: cloudTasksStatus,
      checkedAt: cloudTasksCheckedAt,
      tasks: getCloudTasks(20)
    },
    notices
  };
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    demoMode,
    codexConnected: codex.connected,
    error: connectionError
  });
});

app.get('/api/overview', (_request, response) => {
  response.json(buildOverview());
});

app.get('/api/pricing', (_request, response) => {
  response.json(loadPricingConfig());
});

app.post('/api/refresh', async (_request, response) => {
  lastThreadMetadataRefresh = 0;
  await Promise.all([refreshCodexData(true), refreshSessions(), refreshCloudTasks()]);
  response.json(buildOverview());
});

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const clientDist = path.resolve(currentDir, '../dist');
app.use(express.static(clientDist));
app.use((request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(port, () => {
  console.log(`Codex Usage Dashboard server: http://localhost:${port}`);
  if (demoMode) console.log('DEMO_MODE is enabled.');
});

void refreshCodexData(true);
void refreshSessions();
void refreshCloudTasks();
setInterval(() => void refreshCodexData(false), rateLimitPollMs).unref();
setInterval(() => void refreshSessions(), sessionScanMs).unref();
setInterval(() => void refreshCloudTasks(), cloudTaskPollMs).unref();

process.on('SIGINT', () => {
  codex.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  codex.stop();
  process.exit(0);
});
