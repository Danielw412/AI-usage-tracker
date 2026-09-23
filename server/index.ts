import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClaudeProvider } from './claude/provider.js';
import { createCodexProvider } from './codex/provider.js';
import { demoOverview } from './demo.js';
import { loadPricingConfig } from './pricing.js';
import { isProviderId, providerInfo, type Provider } from './providers.js';
import type { ProviderId } from './types.js';

const app = express();
app.use(express.json());

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flagEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return !/^(false|0|no|off)$/i.test(value.trim());
}

const port = Number(process.env.PORT || 8893);
const demoMode = process.env.DEMO_MODE === 'true';

const providers: Record<ProviderId, Provider> = {
  codex: createCodexProvider({
    enabled: flagEnv('CODEX', true),
    rateLimitPollMs: numberEnv('RATE_LIMIT_POLL_MS', 60_000),
    accountUsagePollMs: numberEnv('ACCOUNT_USAGE_POLL_MS', 900_000),
    sessionScanMs: numberEnv('SESSION_SCAN_MS', 120_000),
    threadMetadataPollMs: numberEnv('THREAD_METADATA_POLL_MS', 900_000),
    cloudTaskPollMs: numberEnv('CLOUD_TASK_POLL_MS', 600_000),
    cloudTasksEnabled: flagEnv('CLOUD_TASKS', true)
  }),
  claude: createClaudeProvider({
    enabled: flagEnv('CLAUDE_CODE', true),
    usagePollMs: numberEnv('CLAUDE_USAGE_POLL_MS', 120_000),
    sessionScanMs: numberEnv('CLAUDE_SESSION_SCAN_MS', numberEnv('SESSION_SCAN_MS', 120_000))
  })
};

const configuredDefault = process.env.DEFAULT_PROVIDER;
const defaultProvider: ProviderId =
  isProviderId(configuredDefault) && providers[configuredDefault].enabled
    ? configuredDefault
    : (Object.values(providers).find((provider) => provider.enabled)?.id ?? 'codex');

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

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    demoMode,
    defaultProvider,
    providers: Object.fromEntries(
      Object.values(providers).map((provider) => [
        provider.id,
        { enabled: provider.enabled, ...provider.health() }
      ])
    ),
    // Kept for older clients that read the Codex fields directly.
    codexConnected: providers.codex.health().connected,
    error: providers.codex.health().error
  });
});

app.get('/api/providers', (_request, response) => {
  response.json({
    providers: Object.values(providers).map(providerInfo),
    defaultProvider
  });
});

app.get('/api/overview', (request, response) => {
  const provider = resolveProvider(request, response);
  if (!provider) return;
  response.json(demoMode ? demoOverview(provider.id) : provider.overview());
});

app.get('/api/pricing', (_request, response) => {
  response.json(loadPricingConfig());
});

app.post('/api/refresh', async (request, response) => {
  const provider = resolveProvider(request, response);
  if (!provider) return;
  if (!demoMode) await provider.refresh();
  response.json(demoMode ? demoOverview(provider.id) : provider.overview());
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
  const enabled = Object.values(providers).filter((provider) => provider.enabled).map((provider) => provider.label);
  console.log(`AI Usage Tracker server: http://localhost:${port} (${enabled.join(', ') || 'no providers enabled'})`);
  if (demoMode) console.log('DEMO_MODE is enabled.');
});

if (!demoMode) {
  for (const provider of Object.values(providers)) provider.start();
}

function shutdown(): void {
  for (const provider of Object.values(providers)) provider.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
