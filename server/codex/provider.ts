import { AppServerClient } from './AppServerClient.js';
import { classifyThreadSource, readLocalThreadMetadata } from './localThreadMetadata.js';
import {
  normalizeAccount,
  normalizeDailyUsage,
  normalizeRateLimitExtras,
  normalizeRateLimits,
  normalizeUsageSummary,
  type UsageSummary
} from './normalize.js';
import { listCloudTasks } from '../cloudTasks.js';
import { createUsageStore, type ThreadMetadataInput, type UsageStore } from '../db.js';
import { buildProviderOverview } from '../overview.js';
import { debugEnabled, type Provider } from '../providers.js';
import { scanCodexSessions } from '../sessionLogs.js';
import type { CloudTaskStatus, DashboardOverview, RateLimitWindow } from '../types.js';

export interface CodexProviderConfig {
  enabled: boolean;
  rateLimitPollMs: number;
  accountUsagePollMs: number;
  sessionScanMs: number;
  threadMetadataPollMs: number;
  cloudTaskPollMs: number;
  cloudTasksEnabled: boolean;
  /** Override the store, mainly for tests. */
  store?: UsageStore;
}

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

/**
 * Codex: quota and account data from `codex app-server`, chat metadata from the
 * desktop state database and App Server, tokens from local rollout logs, and
 * cloud tasks from the CLI.
 */
export function createCodexProvider(config: CodexProviderConfig): Provider {
  const store = config.store ?? createUsageStore({ file: 'codex-usage.sqlite', provider: 'codex' });
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
  let cloudTasksStatus: CloudTaskStatus = config.cloudTasksEnabled ? 'unavailable' : 'disabled';
  let cloudTasksCheckedAt: number | null = null;
  const timers: NodeJS.Timeout[] = [];
  let started = false;

  codex.on('diagnostic', (message: string) => {
    if (debugEnabled()) console.log(`[codex] ${message}`);
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

    if (collected.length > 0) store.upsertThreadMetadata(collected);
    const local = localMetadataInputs();
    if (local.length > 0) store.upsertThreadMetadata(local);
    lastThreadMetadataRefresh = Date.now();
  }

  async function refreshCodexData(forceAccountUsage = false): Promise<void> {
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
          store.insertRateLimitSnapshots(normalized);
        }
        accountExtras = normalizeRateLimitExtras(rateResult);
        connectionError = null;

        const now = Date.now();
        if (forceAccountUsage || now - lastAccountUsageRefresh >= config.accountUsagePollMs) {
          try {
            const usageResult = await codex.request('account/usage/read');
            const daily = normalizeDailyUsage(usageResult);
            if (daily.length > 0) store.upsertAccountDailyUsage(daily);
            usageSummary = normalizeUsageSummary(usageResult);
            lastAccountUsageRefresh = now;
          } catch (error) {
            console.warn('Account usage summary unavailable:', (error as Error).message);
          }
        }

        if (forceAccountUsage || now - lastThreadMetadataRefresh >= config.threadMetadataPollMs) {
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
    if (sessionRefreshInProgress) return sessionRefreshInProgress;

    sessionRefreshInProgress = (async () => {
      try {
        const result = await scanCodexSessions(store);
        const local = localMetadataInputs();
        if (local.length > 0) store.upsertThreadMetadata(local);
        if (debugEnabled()) {
          console.log(`Codex session scan: ${result.scanned} found, ${result.updated} updated, ${result.errors} errors`);
        }
      } catch (error) {
        console.warn('Codex session scan failed:', (error as Error).message);
      }
    })().finally(() => {
      sessionRefreshInProgress = null;
    });

    return sessionRefreshInProgress;
  }

  async function refreshCloudTasks(): Promise<void> {
    if (!config.cloudTasksEnabled) return;
    if (cloudRefreshInProgress) return cloudRefreshInProgress;

    cloudRefreshInProgress = (async () => {
      try {
        const tasks = await listCloudTasks(20);
        if (tasks.length > 0) store.upsertCloudTasks(tasks);
        cloudTasksStatus = 'available';
      } catch (error) {
        cloudTasksStatus = 'unavailable';
        if (debugEnabled()) {
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

  function overview(): DashboardOverview {
    const fiveHour = pickWindow(300);
    const sevenDay = pickWindow(10_080);
    const notices: string[] = [];
    if (connectionError) notices.push(`Codex account connection error: ${connectionError}`);

    return buildProviderOverview({
      provider: 'codex',
      store,
      limits: {
        fiveHour,
        sevenDay,
        other: limits.filter(
          (limit) =>
            Math.abs(limit.windowDurationMins - 300) > 5 &&
            Math.abs(limit.windowDurationMins - 10_080) > 60
        )
      },
      connection: {
        connected: codex.connected && !connectionError,
        ...accountState,
        error: connectionError
      },
      account: {
        planType: accountExtras.planType ?? accountState.planType,
        resetCreditsAvailable: accountExtras.resetCreditsAvailable,
        ...usageSummary,
        statsSource: usageSummary.lifetimeTokens !== null ? 'account' : 'none',
        extraUsage: null
      },
      cloudTasks: {
        status: cloudTasksStatus,
        checkedAt: cloudTasksCheckedAt,
        tasks: store.getCloudTasks(20)
      },
      notices,
      emptyThreadsNotice:
        'No local session token events were found. Check CODEX_HOME or create a new Codex thread, then refresh.'
    });
  }

  return {
    id: 'codex',
    label: 'Codex',
    enabled: config.enabled,
    start() {
      if (started || !config.enabled) return;
      started = true;
      void refreshCodexData(true);
      void refreshSessions();
      void refreshCloudTasks();
      timers.push(
        setInterval(() => void refreshCodexData(false), config.rateLimitPollMs),
        setInterval(() => void refreshSessions(), config.sessionScanMs),
        setInterval(() => void refreshCloudTasks(), config.cloudTaskPollMs)
      );
      for (const timer of timers) timer.unref();
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      codex.stop();
    },
    async refresh() {
      if (!config.enabled) return;
      lastThreadMetadataRefresh = 0;
      await Promise.all([refreshCodexData(true), refreshSessions(), refreshCloudTasks()]);
    },
    overview,
    health() {
      return { connected: codex.connected && !connectionError, error: connectionError };
    }
  };
}
