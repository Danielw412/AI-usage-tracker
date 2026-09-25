import path from 'node:path';
import type { UsageStore } from './db.js';
import type {
  DashboardOverview,
  ProviderId,
  ProviderInfo,
  SyncOverview,
  TrackerRole,
  WindowDetail,
  WindowSummary
} from './types.js';

/**
 * A provider owns one usage store plus the polling that fills it. The Express
 * layer only ever talks to this interface, so Codex and Claude Code stay
 * interchangeable from the API's point of view.
 */
export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly enabled: boolean;
  readonly store: UsageStore;
  /** Begin polling. Safe to call once; ignored when the provider is disabled. */
  start(): void;
  stop(): void;
  /** Force a full refresh of every data source, as the refresh button does. */
  refresh(): Promise<void>;
  overview(): DashboardOverview;
  health(): { connected: boolean; error: string | null };
  /** Current and past quota windows of one duration, newest first. */
  windows(durationMins: number): WindowSummary[];
  windowDetail(durationMins: number, resetsAt: number): WindowDetail | null;
  /** Everything this machine logged before this time is indexed. */
  scannedThrough(): number | null;
  /** True while file-system notifications drive session indexing. */
  watching(): boolean;
}

/** How a provider runs on this machine; shared by both providers. */
export interface ProviderRuntime {
  role: TrackerRole;
  deviceId: string;
  dataDir: string;
  /** Poll account-level quota, account details, and cloud tasks. */
  pollAccount: boolean;
  /** Index transcripts as soon as they change, on top of the periodic scan. */
  watchSessions: boolean;
  /** Record local changes in the outbox for the central server (collectors). */
  outbox: boolean;
  /** Device list and the settled-through time for a provider's overview. */
  sync(provider: ProviderId): SyncOverview;
}

/**
 * A full scan is complete up to the moment it started; the margin covers log
 * timestamps written slightly before the line reaches the disk.
 */
export const SCAN_MARGIN_SECONDS = 60;

/** Single-machine defaults, as every build before multi-device tracking behaved. */
export function standaloneRuntime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  const runtime: ProviderRuntime = {
    role: 'standalone',
    deviceId: 'local',
    dataDir: path.resolve(process.cwd(), 'data'),
    pollAccount: true,
    watchSessions: false,
    outbox: false,
    sync: () => ({
      role: runtime.role,
      deviceId: runtime.deviceId,
      devices: [],
      settledThrough: null,
      multiDevice: false
    }),
    ...overrides
  };
  return runtime;
}

export function providerInfo(provider: Provider): ProviderInfo {
  return { id: provider.id, label: provider.label, enabled: provider.enabled };
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'claude';
}

export function debugEnabled(): boolean {
  return process.env.DEBUG_AI_USAGE_TRACKER === 'true'
    || process.env.DEBUG_CODEX_DASHBOARD === 'true'
    || process.env.DEBUG_USAGE_DASHBOARD === 'true';
}
