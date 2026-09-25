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
import {
  SCAN_MARGIN_SECONDS,
  debugEnabled,
  standaloneRuntime,
  type Provider,
  type ProviderRuntime
} from '../providers.js';
import { createSessionScanner } from '../sessionScan.js';
import { codexPartId, codexSessionSource } from '../sessionLogs.js';
import type { CloudTaskStatus, DashboardOverview, RateLimitWindow } from '../types.js';
import { listWindows, windowDetail } from '../windows.js';

export interface CodexProviderConfig {
  enabled: boolean;
  rateLimitPollMs: number;
  accountUsagePollMs: number;
  sessionScanMs: number;
  threadMetadataPollMs: number;
  cloudTaskPollMs: number;
  cloudTasksEnabled: boolean;
  /** Role, device, and polling switches; single-machine defaults when omitted. */
  runtime?: ProviderRuntime;
  /** Override the store, mainly for tests. */
  store?: UsageStore;
}

/** Local chat names are re-read at most this often after change-driven scans. */
const TARGETED_METADATA_INTERVAL_MS = 30_000;

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
  const runtime = config.runtime ?? standaloneRuntime();
  const store = config.store ?? createUsageStore({
    file: 'codex-usage.sqlite',
    provider: 'codex',
    dataDir: runtime.dataDir,
    deviceId: runtime.deviceId,
    outbox: runtime.outbox,
    legacyPartId: (row) => codexPartId(row.sourceFile)
  });
  const codex = new AppServerClient();
  let lastLocalMetadataRefresh = 0;
  const scanner = createSessionScanner({
    store,
    source: codexSessionSource(),
    watch: runtime.watchSessions,
    onScanned: (result, kind) => {
      // Chat names live in the desktop state database, which changes with the logs.
      if (kind === 'full' || Date.now() - lastLocalMetadataRefresh >= TARGETED_METADATA_INTERVAL_MS) {
        refreshLocalMetadata();
      }
      if (debugEnabled() && (kind === 'full' || result.updated > 0)) {
        console.log(
          `Codex ${kind} scan: ${result.scanned} files, ${result.incremental} resumed, ${result.full} parsed in full, ${result.errors} errors`
        );
      }
    }
  });
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

  function refreshLocalMetadata(): void {
    lastLocalMetadataRefresh = Date.now();
    try {
      const local = localMetadataInputs();
      if (local.length > 0) store.upsertThreadMetadata(local);
    } catch (error) {
      console.warn('Codex chat names unavailable:', (error as Error).message);
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      await scanner.fullScan();
    } catch (error) {
      console.warn('Codex session scan failed:', (error as Error).message);
    }
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
      sync: runtime.sync('codex'),
      notices,
      emptyThreadsNotice:
        'No local session token events were found. Check CODEX_HOME or create a new Codex thread, then refresh.'
    });
  }

  function windowContext() {
    return { settledThrough: runtime.sync('codex').settledThrough };
  }

  return {
    id: 'codex',
    label: 'Codex',
    enabled: config.enabled,
    store,
    start() {
      if (started || !config.enabled) return;
      started = true;
      void refreshSessions();
      timers.push(setInterval(() => void refreshSessions(), config.sessionScanMs));
      // Account quota and cloud tasks are account-wide: only the central
      // machine polls them, so devices do not all ask for the same numbers.
      if (runtime.pollAccount) {
        void refreshCodexData(true);
        void refreshCloudTasks();
        timers.push(
          setInterval(() => void refreshCodexData(false), config.rateLimitPollMs),
          setInterval(() => void refreshCloudTasks(), config.cloudTaskPollMs)
        );
      }
      for (const timer of timers) timer.unref();
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      scanner.stop();
      codex.stop();
    },
    async refresh() {
      if (!config.enabled) return;
      if (!runtime.pollAccount) {
        await refreshSessions();
        return;
      }
      lastThreadMetadataRefresh = 0;
      await Promise.all([refreshCodexData(true), refreshSessions(), refreshCloudTasks()]);
    },
    overview,
    health() {
      return { connected: codex.connected && !connectionError, error: connectionError };
    },
    windows(durationMins) {
      return listWindows(store, durationMins, undefined, pickWindow(durationMins), windowContext());
    },
    windowDetail(durationMins, resetsAt) {
      return windowDetail(store, durationMins, undefined, resetsAt, pickWindow(durationMins), windowContext());
    },
    scannedThrough() {
      const startedAt = scanner.lastFullScanStartedAt();
      return startedAt === null ? null : startedAt - SCAN_MARGIN_SECONDS;
    },
    watching: () => scanner.watching()
  };
}
