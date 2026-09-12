import path from 'node:path';
import { credentialsExpired, readClaudeCredentials } from './credentials.js';
import { readClaudeConfigJson, readLiveClaudeSessions, readStatuslineSamples } from './localState.js';
import {
  CLAUDE_FIVE_HOUR_KEY,
  CLAUDE_SEVEN_DAY_KEY,
  normalizeCachedUtilization,
  normalizeClaudeAccount,
  normalizeClaudeUsage,
  type ClaudeAccountInfo,
  type ClaudeUsageSnapshot
} from './normalize.js';
import { scanClaudeSessions } from './sessionLogs.js';
import { ClaudeUsageError, fetchClaudeUsage } from './usageApi.js';
import { createUsageStore, type UsageStore } from '../db.js';
import { buildProviderOverview } from '../overview.js';
import { debugEnabled, type Provider } from '../providers.js';
import type { AccountSummary, DashboardOverview, RateLimitWindow } from '../types.js';

export interface ClaudeProviderConfig {
  enabled: boolean;
  usagePollMs: number;
  sessionScanMs: number;
  /** JSONL file the optional status-line hook appends samples to. */
  statuslineSampleFile?: string;
  store?: UsageStore;
}

const HISTORY_KEYS = { fiveHour: [CLAUDE_FIVE_HOUR_KEY], sevenDay: [CLAUDE_SEVEN_DAY_KEY] };
const STATUSLINE_OFFSET_META = 'claude_statusline_offset';
const CACHED_UTILIZATION_META = 'claude_cached_utilization_at';
const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** A stale current window is still shown, but its age is called out. */
const STALE_AFTER_SECONDS = 15 * 60;

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * Claude Code: quota windows from the OAuth usage endpoint behind `/usage`
 * (plus Claude Code's own cached copy and the optional status-line hook),
 * tokens and prompts from local transcripts, account details from the CLI's
 * state file. There is no account-side daily token API, so every history figure
 * is computed from what this machine logged.
 */
export function createClaudeProvider(config: ClaudeProviderConfig): Provider {
  const store = config.store ?? createUsageStore({ file: 'claude-usage.sqlite', provider: 'claude' });
  const statuslineFile =
    config.statuslineSampleFile ?? path.resolve(process.cwd(), 'data', 'claude-rate-limit-samples.jsonl');
  let snapshot: ClaudeUsageSnapshot | null = null;
  let otherKeys: string[] = [];
  let account: ClaudeAccountInfo = { planType: null, organizationType: null, rateLimitTier: null, email: null };
  let authType: string | null = null;
  let connectionError: string | null = null;
  let connected = false;
  let backoffUntil = 0;
  let backoffMs = MIN_BACKOFF_MS;
  let usageRefreshInProgress: Promise<void> | null = null;
  let sessionRefreshInProgress: Promise<void> | null = null;
  const timers: NodeJS.Timeout[] = [];
  let started = false;

  function storeSnapshot(value: ClaudeUsageSnapshot): void {
    const windows: RateLimitWindow[] = [];
    if (value.fiveHour) windows.push(value.fiveHour);
    if (value.sevenDay) windows.push(value.sevenDay);
    windows.push(...value.other);
    store.insertRateLimitSnapshots(windows);
  }

  /** Free samples Claude Code itself wrote: the `/usage` cache and status-line hook lines. */
  async function ingestLocalSamples(configJson: Record<string, unknown> | null): Promise<void> {
    const cached = normalizeCachedUtilization(configJson);
    if (cached) {
      const previous = Number(store.getMeta(CACHED_UTILIZATION_META) ?? 0);
      if (cached.observedAt > previous) {
        storeSnapshot(cached.snapshot);
        store.setMeta(CACHED_UTILIZATION_META, String(cached.observedAt));
        if (!snapshot || (snapshot.fiveHour?.observedAt ?? 0) < cached.observedAt) {
          snapshot = cached.snapshot;
          otherKeys = cached.snapshot.other.map((window) => window.key);
        }
      }
    }
    try {
      const offset = Number(store.getMeta(STATUSLINE_OFFSET_META) ?? 0);
      const samples = await readStatuslineSamples(statuslineFile, Number.isFinite(offset) ? offset : 0);
      if (samples.windows.length > 0) store.insertRateLimitSnapshots(samples.windows);
      store.setMeta(STATUSLINE_OFFSET_META, String(samples.nextOffset));
    } catch (error) {
      if (debugEnabled()) console.warn('Claude status-line samples unreadable:', (error as Error).message);
    }
  }

  async function refreshUsage(force = false): Promise<void> {
    if (usageRefreshInProgress) return usageRefreshInProgress;
    usageRefreshInProgress = (async () => {
      const configJson = await readClaudeConfigJson();
      await ingestLocalSamples(configJson);

      const credentials = await readClaudeCredentials();
      account = normalizeClaudeAccount(configJson, credentials?.subscriptionType ?? null);
      if (!credentials) {
        connected = false;
        connectionError = 'Claude Code sign-in not found. Run `claude` and sign in, then refresh.';
        return;
      }
      authType = credentials.source === 'env' ? 'token' : 'claude.ai';
      if (credentialsExpired(credentials)) {
        connected = false;
        connectionError = 'Claude Code sign-in token has expired. Open Claude Code to refresh it.';
        return;
      }
      const now = Date.now();
      if (!force && now < backoffUntil) return;

      try {
        const payload = await fetchClaudeUsage(credentials.accessToken);
        const observedAt = Math.floor(Date.now() / 1000);
        const normalized = normalizeClaudeUsage(payload, observedAt);
        if (!normalized.fiveHour && !normalized.sevenDay) {
          throw new ClaudeUsageError('Claude usage endpoint returned no windows', 0, null);
        }
        storeSnapshot(normalized);
        snapshot = normalized;
        otherKeys = normalized.other.map((window) => window.key);
        connected = true;
        connectionError = null;
        backoffMs = MIN_BACKOFF_MS;
        backoffUntil = 0;
      } catch (error) {
        connected = false;
        if (error instanceof ClaudeUsageError && error.status === 429) {
          const wait = Math.min(MAX_BACKOFF_MS, Math.max(error.retryAfterMs ?? 0, backoffMs));
          backoffUntil = Date.now() + wait;
          backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
          connectionError = `${error.message}; retrying in ${minutes(wait)}.`;
        } else {
          connectionError = (error as Error).message;
        }
        if (debugEnabled()) console.warn('Claude usage refresh failed:', connectionError);
      }
    })().finally(() => {
      usageRefreshInProgress = null;
    });
    return usageRefreshInProgress;
  }

  async function refreshSessions(): Promise<void> {
    if (sessionRefreshInProgress) return sessionRefreshInProgress;
    sessionRefreshInProgress = (async () => {
      try {
        const result = await scanClaudeSessions(store);
        // Running sessions may carry a name that never made it into the transcript.
        const live = await readLiveClaudeSessions();
        const named = new Set(
          store.getThreadSummaries(1000)
            .filter((thread) => thread.titleSource === 'generated')
            .map((thread) => thread.threadId)
        );
        const inputs = live
          .filter((session) => session.name && !named.has(session.sessionId))
          .map((session) => ({
            threadId: session.sessionId,
            displayName: session.name,
            preview: null,
            updatedAt: Math.floor(Date.now() / 1000)
          }));
        if (inputs.length > 0) store.upsertThreadMetadata(inputs);
        if (debugEnabled()) {
          console.log(`Claude session scan: ${result.scanned} found, ${result.updated} updated, ${result.errors} errors`);
        }
      } catch (error) {
        console.warn('Claude session scan failed:', (error as Error).message);
      }
    })().finally(() => {
      sessionRefreshInProgress = null;
    });
    return sessionRefreshInProgress;
  }

  function currentWindow(key: string): RateLimitWindow | null {
    return store.getLatestRateLimitSnapshot(key);
  }

  function overview(): DashboardOverview {
    const now = Math.floor(Date.now() / 1000);
    const fiveHour = currentWindow(CLAUDE_FIVE_HOUR_KEY);
    const sevenDay = currentWindow(CLAUDE_SEVEN_DAY_KEY);
    const other = otherKeys
      .map((key) => currentWindow(key))
      .filter((window): window is RateLimitWindow => window !== null);
    const notices: string[] = [];
    if (connectionError) notices.push(`Claude usage: ${connectionError}`);
    const newest = Math.max(fiveHour?.observedAt ?? 0, sevenDay?.observedAt ?? 0);
    if (newest > 0 && now - newest > STALE_AFTER_SECONDS && !connected) {
      notices.push(
        `Showing the last usage sample from ${new Date(newest * 1000).toLocaleString()}; live polling is unavailable.`
      );
    }

    const stats = store.getLocalAccountStats();
    const accountSummary: AccountSummary = {
      planType: account.planType,
      resetCreditsAvailable: null,
      ...stats,
      statsSource: stats.lifetimeTokens === null ? 'none' : 'local',
      extraUsage: snapshot?.extraUsage ?? null
    };

    return buildProviderOverview({
      provider: 'claude',
      store,
      limits: { fiveHour, sevenDay, other },
      historyKeys: HISTORY_KEYS,
      connection: {
        connected,
        authType,
        planType: account.planType,
        error: connectionError
      },
      account: accountSummary,
      cloudTasks: { status: 'unsupported', checkedAt: null, tasks: [] },
      notices,
      emptyThreadsNotice:
        'No Claude Code transcripts were found. Check CLAUDE_CONFIG_DIR or start a Claude Code session, then refresh.'
    });
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    enabled: config.enabled,
    start() {
      if (started || !config.enabled) return;
      started = true;
      void refreshUsage(true);
      void refreshSessions();
      timers.push(
        setInterval(() => void refreshUsage(false), config.usagePollMs),
        setInterval(() => void refreshSessions(), config.sessionScanMs)
      );
      for (const timer of timers) timer.unref();
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
    async refresh() {
      if (!config.enabled) return;
      await Promise.all([refreshUsage(true), refreshSessions()]);
    },
    overview,
    health() {
      return { connected, error: connectionError };
    }
  };
}
