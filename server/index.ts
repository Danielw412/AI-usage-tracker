import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClaudeProvider } from './claude/provider.js';
import { createCodexProvider } from './codex/provider.js';
import { ConfigError, flagEnv, loadTrackerConfig, type TrackerConfig } from './config.js';
import { demoDevices, demoOverview, demoWindowDetail, demoWindows } from './demo.js';
import { loadPricingConfig } from './pricing.js';
import { isProviderId, providerInfo, type Provider, type ProviderRuntime } from './providers.js';
import { createSyncClient } from './sync/client.js';
import { createDeviceRegistry, deviceStatuses } from './sync/registry.js';
import { createSyncRouter } from './sync/server.js';
import type { ProviderId, SyncOverview } from './types.js';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(currentDir, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

let config: TrackerConfig;
try {
  config = loadTrackerConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`AI Usage Tracker configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const version = readVersion();
const port = Number(process.env.PORT || 8893);
const host = process.env.HOST?.trim() || undefined;
const demoMode = process.env.DEMO_MODE === 'true';
const isCollector = config.role === 'collector';
const registry = config.role === 'server' ? createDeviceRegistry(config.dataDir) : null;

// Providers look up the device list and settled-through time through the
// runtime; `providers` is assigned right below, before anything asks.
let providers: Record<ProviderId, Provider>;

function syncOverview(provider: ProviderId): SyncOverview {
  const self = {
    deviceId: config.deviceId,
    label: config.deviceLabel,
    role: config.role,
    scannedThrough: (id: ProviderId) => providers[id].scannedThrough(),
    providerEnabled: (id: ProviderId) => providers[id].enabled
  };
  if (!registry) {
    return {
      role: config.role,
      deviceId: config.deviceId,
      devices: [],
      settledThrough: self.scannedThrough(provider),
      multiDevice: false
    };
  }
  const { devices, settledThrough } = deviceStatuses(provider, self, registry.list(), {
    heartbeatMs: config.sync.heartbeatMs,
    retireAfterDays: config.sync.retireAfterDays,
    knownDeviceIds: providers[provider].store.getDeviceUsage()
      .filter((row) => row.deviceId !== config.deviceId)
      .map((row) => ({ deviceId: row.deviceId, lastEventAt: row.lastEventAt }))
  });
  return {
    role: config.role,
    deviceId: config.deviceId,
    devices,
    settledThrough,
    multiDevice: devices.length > 1
  };
}

const runtime: ProviderRuntime = {
  role: config.role,
  deviceId: config.deviceId,
  dataDir: config.dataDir,
  pollAccount: config.quotaPolling,
  watchSessions: config.watchSessions,
  outbox: isCollector,
  sync: syncOverview
};

providers = {
  codex: createCodexProvider({
    enabled: flagEnv(process.env, 'CODEX', true),
    rateLimitPollMs: numberEnv('RATE_LIMIT_POLL_MS', 60_000),
    accountUsagePollMs: numberEnv('ACCOUNT_USAGE_POLL_MS', 900_000),
    sessionScanMs: numberEnv('SESSION_SCAN_MS', 120_000),
    threadMetadataPollMs: numberEnv('THREAD_METADATA_POLL_MS', 900_000),
    cloudTaskPollMs: numberEnv('CLOUD_TASK_POLL_MS', 600_000),
    cloudTasksEnabled: flagEnv(process.env, 'CLOUD_TASKS', true),
    runtime
  }),
  claude: createClaudeProvider({
    enabled: flagEnv(process.env, 'CLAUDE_CODE', true),
    usagePollMs: numberEnv('CLAUDE_USAGE_POLL_MS', 120_000),
    sessionScanMs: numberEnv('CLAUDE_SESSION_SCAN_MS', numberEnv('SESSION_SCAN_MS', 120_000)),
    runtime
  })
};

const syncClient = isCollector && !demoMode
  ? createSyncClient({
      centralUrl: config.sync.centralUrl!,
      secret: config.sync.secret!,
      deviceId: config.deviceId,
      deviceLabel: config.deviceLabel,
      installId: config.installId,
      role: config.role,
      version,
      sources: Object.values(providers).map((provider) => ({
        provider: provider.id,
        store: provider.store,
        enabled: provider.enabled,
        scannedThrough: () => provider.scannedThrough()
      })),
      batchSize: config.sync.batchSize,
      debounceMs: config.sync.debounceMs,
      heartbeatMs: config.sync.heartbeatMs,
      maxBackoffMs: config.sync.maxBackoffMs,
      watching: () => Object.values(providers).some((provider) => provider.enabled && provider.watching())
    })
  : null;

const app = express();

// The sync API parses its own (larger) request bodies, so it is mounted before
// the default JSON parser.
if (registry && config.sync.secret) {
  app.use('/api/sync', createSyncRouter({
    secret: config.sync.secret,
    registry,
    stores: { codex: providers.codex.store, claude: providers.claude.store },
    selfDeviceId: config.deviceId
  }));
}
app.use(express.json());

const configuredDefault = process.env.DEFAULT_PROVIDER;
const defaultProvider: ProviderId =
  isProviderId(configuredDefault) && providers[configuredDefault].enabled
    ? configuredDefault
    : (Object.values(providers).find((provider) => provider.enabled)?.id ?? 'codex');

const COLLECTOR_MESSAGE = `This machine runs as a collector (device "${config.deviceId}") and sends its usage to ${
  config.sync.centralUrl ?? 'the central server'
}. Open the dashboard there.`;

function resolveProvider(
  request: express.Request,
  response: express.Response
): Provider | null {
  const requested = typeof request.query.provider === 'string' ? request.query.provider : defaultProvider;
  if (!isProviderId(requested)) {
    response.status(400).json({ error: `Unknown provider "${requested}". Use "codex" or "claude".` });
    return null;
  }
  const provider = providers[requested];
  if (!provider.enabled && !demoMode) {
    response.status(404).json({ error: `${provider.label} is turned off in .env.` });
    return null;
  }
  return provider;
}

function resolveDuration(request: express.Request, response: express.Response): number | null {
  const value = Number(request.query.duration ?? 300);
  if (value !== 300 && value !== 10_080) {
    response.status(400).json({ error: 'duration must be 300 (5 hours) or 10080 (7 days).' });
    return null;
  }
  return value;
}

/** Dashboard data only exists on the central server (or a standalone machine). */
function dashboardAvailable(response: express.Response): boolean {
  if (!isCollector || demoMode) return true;
  response.status(409).json({ error: COLLECTOR_MESSAGE, role: config.role });
  return false;
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    demoMode,
    version,
    role: config.role,
    deviceId: config.deviceId,
    deviceLabel: config.deviceLabel,
    defaultProvider,
    providers: Object.fromEntries(
      Object.values(providers).map((provider) => [
        provider.id,
        {
          enabled: provider.enabled,
          ...provider.health(),
          watching: provider.watching(),
          scannedThrough: provider.scannedThrough()
        }
      ])
    ),
    sync: syncClient?.status() ?? null,
    // Kept for older clients that read the Codex fields directly.
    codexConnected: providers.codex.health().connected,
    error: providers.codex.health().error
  });
});

app.get('/api/sync/status', (_request, response) => {
  if (syncClient) {
    response.json({ role: config.role, deviceId: config.deviceId, ...syncClient.status() });
    return;
  }
  response.json({
    role: config.role,
    deviceId: config.deviceId,
    instanceId: registry?.instanceId ?? null,
    devices: registry?.list() ?? []
  });
});

app.get('/api/providers', (_request, response) => {
  response.json({
    providers: Object.values(providers).map(providerInfo),
    defaultProvider
  });
});

app.get('/api/overview', (request, response) => {
  if (!dashboardAvailable(response)) return;
  const provider = resolveProvider(request, response);
  if (!provider) return;
  response.json(demoMode ? demoOverview(provider.id) : provider.overview());
});

app.get('/api/windows', (request, response) => {
  if (!dashboardAvailable(response)) return;
  const provider = resolveProvider(request, response);
  const duration = provider ? resolveDuration(request, response) : null;
  if (!provider || duration === null) return;
  response.json({ windows: demoMode ? demoWindows(duration) : provider.windows(duration) });
});

app.get('/api/windows/detail', (request, response) => {
  if (!dashboardAvailable(response)) return;
  const provider = resolveProvider(request, response);
  const duration = provider ? resolveDuration(request, response) : null;
  if (!provider || duration === null) return;
  const resetsAt = Number(request.query.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) {
    response.status(400).json({ error: 'resetsAt must be a unix timestamp in seconds.' });
    return;
  }
  const detail = demoMode ? demoWindowDetail(duration, resetsAt) : provider.windowDetail(duration, resetsAt);
  if (!detail) {
    response.status(404).json({ error: 'No stored samples for that window.' });
    return;
  }
  response.json(detail);
});

app.get('/api/devices', (request, response) => {
  if (!dashboardAvailable(response)) return;
  const provider = resolveProvider(request, response);
  if (!provider) return;
  response.json(demoMode ? demoDevices() : syncOverview(provider.id));
});

app.get('/api/pricing', (_request, response) => {
  response.json(loadPricingConfig());
});

app.post('/api/refresh', async (request, response) => {
  const provider = resolveProvider(request, response);
  if (!provider) return;
  if (!demoMode) await provider.refresh();
  if (isCollector && !demoMode) {
    await syncClient?.flush();
    response.status(409).json({ error: COLLECTOR_MESSAGE, role: config.role, sync: syncClient?.status() ?? null });
    return;
  }
  response.json(demoMode ? demoOverview(provider.id) : provider.overview());
});

const clientDist = path.resolve(currentDir, '../dist');
app.use(express.static(clientDist));
app.use((request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(path.join(clientDist, 'index.html'));
});

const onListening = () => {
  const enabled = Object.values(providers).filter((provider) => provider.enabled).map((provider) => provider.label);
  const where = `http://${host ?? 'localhost'}:${port}`;
  console.log(
    `AI Usage Tracker ${version} (${config.role}, device "${config.deviceId}"): ${where} (${enabled.join(', ') || 'no providers enabled'})`
  );
  if (isCollector) console.log(`Sending usage to ${config.sync.centralUrl}; the outbox keeps it while the server is unreachable.`);
  if (config.role === 'server') console.log('Accepting usage from collectors at /api/sync.');
  if (demoMode) console.log('DEMO_MODE is enabled.');
};
if (host) app.listen(port, host, onListening);
else app.listen(port, onListening);

if (!demoMode) {
  for (const provider of Object.values(providers)) provider.start();
  syncClient?.start();
}

function shutdown(): void {
  syncClient?.stop();
  for (const provider of Object.values(providers)) provider.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
