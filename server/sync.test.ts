import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { claudeSessionSource } from './claude/sessionLogs.js';
import { createUsageStore, type UsageStore } from './db.js';
import { indexSessionFile } from './sessionScan.js';
import { codexSessionSource } from './sessionLogs.js';
import { createSyncClient, type SyncSource } from './sync/client.js';
import { createDeviceRegistry, deviceStatuses, type DeviceRegistry } from './sync/registry.js';
import { createSyncRouter } from './sync/server.js';
import { baseTime, localEvent, partSummary, removeDir, tempDir } from './testSupport.js';
import type { ProviderId } from './types.js';

const SECRET = 'test-secret-with-enough-length';
const CENTRAL = 'http://central.test';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

interface CentralServer {
  url: string;
  stores: Record<ProviderId, UsageStore>;
  registry: DeviceRegistry;
  close(): Promise<void>;
}

async function startCentral(dataDir: string): Promise<CentralServer> {
  const stores = {
    codex: createUsageStore({ file: 'codex-usage.sqlite', provider: 'codex', dataDir, deviceId: 'server' }),
    claude: createUsageStore({ file: 'claude-usage.sqlite', provider: 'claude', dataDir, deviceId: 'server' })
  };
  const registry = createDeviceRegistry(dataDir);
  const app = express();
  app.use('/api/sync', createSyncRouter({ secret: SECRET, registry, stores, selfDeviceId: 'server' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stores,
    registry,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stores.codex.close();
      stores.claude.close();
      registry.close();
    }
  };
}

/** Routes the client's fixed URL to whichever server is running, or fails like a dead host. */
function routedFetch(target: { url: string | null }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!target.url) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    return fetch(String(input).replace(CENTRAL, target.url), init);
  }) as typeof fetch;
}

function collectorStore(dataDir: string, provider: ProviderId): UsageStore {
  return createUsageStore({ file: `${provider}-usage.sqlite`, provider, dataDir, deviceId: 'laptop', outbox: true });
}

function client(sources: SyncSource[], target: { url: string | null }, overrides: Partial<Parameters<typeof createSyncClient>[0]> = {}) {
  return createSyncClient({
    centralUrl: CENTRAL,
    secret: SECRET,
    deviceId: 'laptop',
    deviceLabel: 'Laptop',
    installId: 'install-1',
    version: 'test',
    sources,
    batchSize: 3,
    debounceMs: 10,
    heartbeatMs: 60_000,
    maxBackoffMs: 200,
    initialBackoffMs: 50,
    fetch: routedFetch(target),
    log: () => {},
    ...overrides
  });
}

function writeCodexRollout(codexHome: string, name: string, threadId: string, start: number, responses: number): string {
  const directory = path.join(codexHome, 'sessions', '2026', '09', '20');
  fs.mkdirSync(directory, { recursive: true });
  const lines: unknown[] = [
    { timestamp: iso(start), type: 'session_meta', payload: { id: threadId, cwd: '/home/daniel/project', thread_source: 'main', source: 'cli' } },
    { timestamp: iso(start + 1), type: 'turn_context', payload: { model: 'gpt-5.6-sol', turn_id: 'turn-1' } },
    { timestamp: iso(start + 2), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1', started_at: start + 2 } },
    {
      timestamp: iso(start + 3),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Work on ${threadId}` }] }
    }
  ];
  for (let index = 0; index < responses; index += 1) {
    lines.push({
      timestamp: iso(start + 10 + index * 30),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1_100 } }
      }
    });
  }
  lines.push({ timestamp: iso(start + 20 + responses * 30), type: 'event_msg', payload: { type: 'task_complete' } });
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

const SESSION = '11111111-2222-4333-8444-555555555555';
const CONTINUATION = '99999999-8888-4777-8666-555555555555';

function claudeRecord(type: string, extra: Record<string, unknown>, timestamp: number, uuid: string, sessionId = SESSION) {
  return { type, uuid, isSidechain: false, timestamp: iso(timestamp), sessionId, cwd: '/home/daniel/project', entrypoint: 'cli', ...extra };
}

function claudeAssistant(uuid: string, timestamp: number, messageId: string, block: number, sessionId = SESSION) {
  return claudeRecord('assistant', {
    requestId: `req_${messageId}`,
    message: {
      id: messageId,
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [{ type: block === 0 ? 'text' : 'tool_use' }],
      usage: { input_tokens: 5, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 300 }
    }
  }, timestamp, uuid, sessionId);
}

function claudeTranscript(start: number, sessionId = SESSION): Array<Record<string, unknown>> {
  return [
    claudeRecord('user', { promptId: 'turn-1', message: { role: 'user', content: 'Sync the laptop' } }, start, 'u1', sessionId),
    // Streaming: two records for one API message, each repeating the full usage.
    claudeAssistant('a1', start + 3, 'msg_1', 0, sessionId),
    claudeAssistant('a2', start + 4, 'msg_1', 1, sessionId),
    claudeAssistant('a3', start + 20, 'msg_2', 0, sessionId),
    claudeRecord('system', { subtype: 'turn_duration', durationMs: 25_000 }, start + 25, 's1', sessionId)
  ];
}

function writeJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('Codex events from a collector arrive once, with their device and log timestamps', async () => {
  const root = tempDir('sync-codex');
  const central = await startCentral(path.join(root, 'server'));
  const collector = collectorStore(path.join(root, 'laptop'), 'codex');
  const target = { url: central.url as string | null };
  const sync = client([{ provider: 'codex', store: collector, enabled: true, scannedThrough: () => baseTime(0) }], target);
  try {
    const start = baseTime(1);
    const codexHome = path.join(root, 'codex-home');
    const file = writeCodexRollout(codexHome, 'rollout-2026-09-20T10-00-00-aaaa.jsonl', 'thread-laptop', start, 7);
    assert.equal(await indexSessionFile(collector, codexSessionSource(codexHome), file), 'full');
    assert.ok(collector.outboxStats().pending > 7);

    assert.equal(await sync.flush(), true);
    assert.equal(collector.outboxStats().pending, 0);
    const [thread] = central.stores.codex.getThreadSummaries();
    assert.equal(thread.threadId, 'thread-laptop');
    assert.deepEqual(thread.deviceIds, ['laptop']);
    assert.equal(thread.totalTokens, 7 * 1_100);
    assert.equal(thread.prompts.length, 1);
    assert.equal(thread.title, 'Work on thread-laptop');
    const events = central.stores.codex.getTokenEventsBetween(start, start + 1_000);
    assert.deepEqual(events.map((event) => event.observedAt), Array.from({ length: 7 }, (_, index) => start + 10 + index * 30));
    assert.ok(events.every((event) => event.deviceId === 'laptop'));
    const serverCost = central.stores.codex.getTokenTotals().estimatedApiCostUsd;
    assert.ok(Math.abs(serverCost - collector.getTokenTotals().estimatedApiCostUsd) < 1e-9);

    // A full re-send (as after a server reset) changes nothing.
    collector.exportAllToOutbox('another-server');
    assert.equal(await sync.flush(), true);
    assert.equal(central.stores.codex.getTokenTotals().totalTokens, 7 * 1_100);
    assert.equal(central.stores.codex.getThreadSummaries().length, 1);

    const [device] = central.registry.list();
    assert.equal(device.deviceId, 'laptop');
    assert.equal(device.label, 'Laptop');
    assert.equal(device.status?.providers.codex?.pending, 0);
  } finally {
    sync.stop();
    collector.close();
    await central.close();
    removeDir(root);
  }
});

test('Claude Code events keep streaming deduplication across the sync', async () => {
  const root = tempDir('sync-claude');
  const central = await startCentral(path.join(root, 'server'));
  const collector = collectorStore(path.join(root, 'laptop'), 'claude');
  const target = { url: central.url as string | null };
  const sync = client([{ provider: 'claude', store: collector, enabled: true, scannedThrough: () => baseTime(0) }], target);
  try {
    const projects = path.join(root, 'claude', 'projects');
    const file = path.join(projects, '-home-daniel-project', `${SESSION}.jsonl`);
    writeJsonl(file, claudeTranscript(baseTime(1)));
    await indexSessionFile(collector, claudeSessionSource(projects), file);
    assert.equal(await sync.flush(), true);

    const [thread] = central.stores.claude.getThreadSummaries();
    assert.equal(thread.threadId, SESSION);
    assert.deepEqual(thread.deviceIds, ['laptop']);
    // Three assistant records, two API messages.
    assert.equal(central.stores.claude.getTokenEventsBetween(0, Number.MAX_SAFE_INTEGER).length, 2);
    assert.equal(thread.totalTokens, 2 * (21_005 + 300));
    assert.equal(thread.cacheWriteInputTokens, 2_000);
    assert.equal(thread.prompts[0].durationMs, 25_000);
  } finally {
    sync.stop();
    collector.close();
    await central.close();
    removeDir(root);
  }
});

test('Codex and Claude Code activity from one collector sync together into separate stores', async () => {
  const root = tempDir('sync-both');
  const central = await startCentral(path.join(root, 'server'));
  const laptopDir = path.join(root, 'laptop');
  const codex = collectorStore(laptopDir, 'codex');
  const claude = collectorStore(laptopDir, 'claude');
  const target = { url: central.url as string | null };
  const sync = client([
    { provider: 'codex', store: codex, enabled: true, scannedThrough: () => baseTime(0) },
    { provider: 'claude', store: claude, enabled: true, scannedThrough: () => baseTime(0) }
  ], target);
  try {
    const start = baseTime(1);
    const codexHome = path.join(root, 'codex-home');
    const rollout = writeCodexRollout(codexHome, 'rollout-2026-09-20T10-00-00-both.jsonl', 'codex-at-the-same-time', start, 4);
    const projects = path.join(root, 'claude', 'projects');
    const transcript = path.join(projects, '-home-daniel-project', `${SESSION}.jsonl`);
    writeJsonl(transcript, claudeTranscript(start));
    await indexSessionFile(codex, codexSessionSource(codexHome), rollout);
    await indexSessionFile(claude, claudeSessionSource(projects), transcript);

    assert.equal(await sync.flush(), true);
    assert.deepEqual(central.stores.codex.getThreadSummaries().map((thread) => thread.threadId), ['codex-at-the-same-time']);
    assert.deepEqual(central.stores.claude.getThreadSummaries().map((thread) => thread.threadId), [SESSION]);
    const [device] = central.registry.list();
    assert.equal(device.status?.providers.codex?.pending, 0);
    assert.equal(device.status?.providers.claude?.pending, 0);
  } finally {
    sync.stop();
    codex.close();
    claude.close();
    await central.close();
    removeDir(root);
  }
});

test('the outbox survives a collector restart and a server outage, then uploads the backlog', async () => {
  const root = tempDir('sync-offline');
  const serverDir = path.join(root, 'server');
  const laptopDir = path.join(root, 'laptop');
  const target: { url: string | null } = { url: null };
  const start = baseTime(4);

  // Server unreachable: several days of work queue up locally.
  let collector = collectorStore(laptopDir, 'codex');
  let sync = client([{ provider: 'codex', store: collector, enabled: true, scannedThrough: () => baseTime(0) }], target);
  const events = Array.from({ length: 40 }, (_, index) =>
    localEvent(`backlog-${index}`, 'offline-chat', start + index * 7_200, 0.05, 500));
  collector.replaceThreadData(partSummary('offline-chat', 'offline-chat.jsonl'), events, []);
  const queued = collector.outboxStats().pending;
  assert.ok(queued >= 41);
  assert.equal(collector.outboxStats().oldestPendingAt, start);
  assert.equal(await sync.flush(), false);
  const status = sync.status();
  assert.equal(status.state, 'offline');
  assert.equal(status.online, false);
  assert.ok(status.nextRetryAt !== null, 'a retry is scheduled');
  assert.equal(collector.outboxStats().pending, queued, 'nothing is dropped while offline');
  sync.stop();
  collector.close();

  // The laptop restarts; the queue is still there.
  collector = collectorStore(laptopDir, 'codex');
  assert.equal(collector.outboxStats().pending, queued);

  // The server comes back and receives the backlog in batches.
  let central = await startCentral(serverDir);
  target.url = central.url;
  sync = client([{ provider: 'codex', store: collector, enabled: true, scannedThrough: () => baseTime(0) }], target, { batchSize: 7 });
  try {
    assert.equal(await sync.flush(), true);
    assert.equal(collector.outboxStats().pending, 0);
    assert.equal(central.stores.codex.getTokenTotals().totalTokens, 40 * 500);
    assert.equal(sync.status().state, 'synced');

    // The server restarts too: its data and identity persist, nothing is re-sent twice.
    const instance = central.registry.instanceId;
    await central.close();
    target.url = null;
    collector.replaceThreadData(partSummary('offline-chat', 'offline-chat.jsonl'), [
      ...events,
      localEvent('after-restart', 'offline-chat', start + 90 * 3_600, 0.05, 500)
    ], []);
    assert.equal(await sync.flush(), false);
    central = await startCentral(serverDir);
    target.url = central.url;
    assert.equal(central.registry.instanceId, instance);
    assert.equal(await sync.flush(), true);
    assert.equal(central.stores.codex.getTokenTotals().totalTokens, 41 * 500);
    assert.equal(collector.outboxStats().pending, 0);
  } finally {
    sync.stop();
    collector.close();
    await central.close();
    removeDir(root);
  }
});

test('a wrong secret or the server\'s own device id is refused and nothing is dequeued', async () => {
  const root = tempDir('sync-auth');
  const central = await startCentral(path.join(root, 'server'));
  const collector = collectorStore(path.join(root, 'laptop'), 'codex');
  const target = { url: central.url as string | null };
  const sources: SyncSource[] = [{ provider: 'codex', store: collector, enabled: true, scannedThrough: () => null }];
  const wrongSecret = client(sources, target, { secret: 'not-the-secret' });
  const impostor = client(sources, target, { deviceId: 'server' });
  try {
    collector.replaceThreadData(partSummary('chat', 'chat.jsonl'), [localEvent('e1', 'chat', baseTime(), 0.1)], []);
    const pending = collector.outboxStats().pending;
    assert.equal(await wrongSecret.flush(), false);
    assert.equal(wrongSecret.status().state, 'unauthorized');
    assert.equal(await impostor.flush(), false);
    assert.equal(impostor.status().state, 'rejected');
    assert.match(impostor.status().lastError ?? '', /DEVICE_ID/);
    assert.equal(collector.outboxStats().pending, pending);
    assert.equal(central.stores.codex.getTokenTotals().totalTokens, 0);
  } finally {
    wrongSecret.stop();
    impostor.stop();
    collector.close();
    await central.close();
    removeDir(root);
  }
});

test('a Claude session superseded by its continuation is removed on the server too', async () => {
  const root = tempDir('sync-superseded');
  const central = await startCentral(path.join(root, 'server'));
  const collector = collectorStore(path.join(root, 'laptop'), 'claude');
  const target = { url: central.url as string | null };
  const sync = client([{ provider: 'claude', store: collector, enabled: true, scannedThrough: () => null }], target);
  try {
    const projects = path.join(root, 'claude', 'projects');
    const source = claudeSessionSource(projects);
    const start = baseTime(1);
    const original = path.join(projects, '-home-daniel-project', `${SESSION}.jsonl`);
    const records = claudeTranscript(start);
    writeJsonl(original, [
      ...records,
      { type: 'continued-in', timestamp: iso(start + 60), sessionId: SESSION, continuedInSessionId: CONTINUATION }
    ]);
    // The continuation has not been written yet, so the original counts.
    await indexSessionFile(collector, source, original);
    assert.equal(await sync.flush(), true);
    assert.equal(central.stores.claude.getThreadSummaries()[0].threadId, SESSION);

    // Claude Code copies the transcript into the continuation and keeps going.
    const continuation = path.join(projects, '-home-daniel-project', `${CONTINUATION}.jsonl`);
    writeJsonl(continuation, [
      ...claudeTranscript(start, CONTINUATION),
      claudeAssistant('b1', start + 120, 'msg_3', 0, CONTINUATION)
    ]);
    await indexSessionFile(collector, source, continuation);
    for (const dependent of collector.filesDependingOn([continuation])) await indexSessionFile(collector, source, dependent);
    assert.equal(await sync.flush(), true);

    const threads = central.stores.claude.getThreadSummaries();
    assert.deepEqual(threads.map((thread) => thread.threadId), [CONTINUATION]);
    assert.equal(central.stores.claude.getTokenEventsBetween(0, Number.MAX_SAFE_INTEGER).length, 3);
  } finally {
    sync.stop();
    collector.close();
    await central.close();
    removeDir(root);
  }
});

test('attribution stays provisional until every active device has synced past it', () => {
  const now = 1_800_000_000;
  const self = {
    deviceId: 'server',
    label: 'Server',
    role: 'server' as const,
    scannedThrough: () => now - 60,
    providerEnabled: () => true
  };
  const status = (codexThrough: number | null, claudeEnabled = true) => ({
    role: 'collector' as const,
    version: 'test',
    now: now - 5,
    watching: true,
    lastError: null,
    providers: {
      codex: { enabled: true, pending: 3, oldestPendingAt: null, scannedThrough: codexThrough, syncedThrough: codexThrough },
      claude: { enabled: claudeEnabled, pending: 0, oldestPendingAt: null, scannedThrough: null, syncedThrough: null }
    }
  });
  const row = (deviceId: string, lastSeenAt: number, report: ReturnType<typeof status>, clockOffsetSeconds = 1) => ({
    deviceId,
    label: deviceId,
    role: 'collector' as const,
    installId: 'x',
    firstSeenAt: now - 90 * 86_400,
    lastSeenAt,
    lastUploadAt: lastSeenAt,
    uploadedRecords: 10,
    status: report,
    clockOffsetSeconds,
    installChangedAt: null
  });
  const rows = [
    row('laptop', now - 30, status(now - 3_600, false), 400),
    row('old-desktop', now - 45 * 86_400, status(now - 50 * 86_400))
  ];

  const codex = deviceStatuses('codex', self, rows, { heartbeatMs: 90_000, retireAfterDays: 30, now });
  assert.equal(codex.settledThrough, now - 3_600, 'the laptop holds recent windows provisional');
  const laptop = codex.devices.find((device) => device.deviceId === 'laptop');
  assert.equal(laptop?.online, true);
  assert.equal(laptop?.pendingRecords, 3);
  assert.match(laptop?.warning ?? '', /Clock is 7 min behind/);
  assert.equal(codex.devices.find((device) => device.deviceId === 'old-desktop')?.online, false);

  // The laptop does not run Claude Code, and the retired desktop no longer counts.
  const claude = deviceStatuses('claude', self, rows, { heartbeatMs: 90_000, retireAfterDays: 30, now });
  assert.equal(claude.settledThrough, now - 60);

  const withNewDevice = deviceStatuses('codex', self, [...rows, row('new', now - 10, status(null))], {
    heartbeatMs: 90_000,
    retireAfterDays: 30,
    now
  });
  assert.equal(withNewDevice.settledThrough, null, 'a device that has not finished its first scan holds everything open');
});
