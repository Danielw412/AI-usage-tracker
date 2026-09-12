import type { DashboardOverview, ProviderId, ProviderInfo } from './types.js';

/**
 * A provider owns one usage store plus the polling that fills it. The Express
 * layer only ever talks to this interface, so Codex and Claude Code stay
 * interchangeable from the API's point of view.
 */
export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly enabled: boolean;
  /** Begin polling. Safe to call once; ignored when the provider is disabled. */
  start(): void;
  stop(): void;
  /** Force a full refresh of every data source, as the refresh button does. */
  refresh(): Promise<void>;
  overview(): DashboardOverview;
  health(): { connected: boolean; error: string | null };
}

export function providerInfo(provider: Provider): ProviderInfo {
  return { id: provider.id, label: provider.label, enabled: provider.enabled };
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'claude';
}

export function debugEnabled(): boolean {
  return process.env.DEBUG_CODEX_DASHBOARD === 'true' || process.env.DEBUG_USAGE_DASHBOARD === 'true';
}
