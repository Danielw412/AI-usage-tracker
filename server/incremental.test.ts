import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { claudeSessionSource } from './claude/sessionLogs.js';
import { createUsageStore, type UsageStore } from './db.js';
import { indexSessionFile, scanAllSessions, type SessionSource } from './sessionScan.js';
import { codexSessionSource } from './sessionLogs.js';
import { baseTime, removeDir, tempDir } from './testSupport.js';
import type { ProviderId } from './types.js';

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function lines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function codexRecords(start: number, from: number, to: number): unknown[] {
  const records: unknown[] = [];
  for (let index = from; index < to; index += 1) {
    const at = start + 10 + index * 20;
    if (index % 4 === 0) {
      records.push({ timestamp: iso(at - 5), type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${index}`, started_at: at - 5 } });
      records.push({
        timestamp: iso(at - 4),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Prompt number ${index}` }] }
      });
    }
    records.push({
      timestamp: iso(at),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 800 + index, cached_input_tokens: 300, output_tokens: 50 + index, total_tokens: 850 + 2 * index } },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 10 + Math.floor(index / 3), window_minutes: 300, resets_at: start + 5 * 3600 }
        }
      }
    });
    if (index % 4 === 3) {
      records.push({ timestamp: iso(at + 2), type: 'event_msg', payload: { type: 'task_complete', duration_ms: 20_000 } });
    }
  }
  return records;
}

function codexHeader(start: number, threadId: string): unknown[] {
  return [
    { timestamp: iso(start), type: 'session_meta', payload: { id: threadId, cwd: '/repo', thread_source: 'main', source: 'cli' } },
    { timestamp: iso(start + 1), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }
  ];
}

function store(directory: string, name: string, provider: ProviderId = 'codex'): UsageStore {
  return createUsageStore({ file: `${name}.sqlite`, provider, dataDir: directory, deviceId: 'device' });
}

/** Everything the dashboard reads for a store, normalized for comparison. */
function snapshot(target: UsageStore) {
  const threads = target.getThreadSummaries().map((thread) => ({
    threadId: thread.threadId,
    title: thread.title,
    totalTokens: thread.totalTokens,
    inputTokens: thread.inputTokens,
    outputTokens: thread.outputTokens,
    cachedInputTokens: thread.cachedInputTokens,
    cost: thread.estimatedApiCostUsd === null ? null : Number(thread.estimatedApiCostUsd.toFixed(9)),
    userMessageCount: thread.userMessageCount,
    prompts: thread.prompts.map((prompt) => ({
      id: prompt.promptId,
      sequence: prompt.sequence,
      prompt: prompt.prompt,
      tokens: prompt.totalTokens,
      completedAt: prompt.completedAt,
      durationMs: prompt.durationMs
    }))
  }));
  const events = target.getTokenEventsBetween(0, Number.MAX_SAFE_INTEGER);
  const samples = target.getRateLimitHistory(300, undefined, 3650).map((sample) => `${sample.observedAt}:${sample.usedPercent}`);
  return { threads, events, samples };
}

test('a growing Codex rollout indexed incrementally matches a full parse, including a half-written line', async () => {
  const directory = tempDir('incremental-codex');
  const incremental = store(directory, 'incremental');
  const fresh = store(directory, 'fresh');
  try {
    const home = path.join(directory, 'codex');
    const source = codexSessionSource(home);
    const file = path.join(home, 'sessions', '2026', '09', '20', 'rollout-2026-09-20T10-00-00-abcd.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const start = baseTime(1);
    const first = `${lines([...codexHeader(start, 'thread-grow'), ...codexRecords(start, 0, 6)])}\n`;
    const second = `${lines(codexRecords(start, 6, 13))}\n`;
    const third = `${lines(codexRecords(start, 13, 22))}\n`;
    // The file ends in the middle of a line, as it does while Codex is writing it.
    const cut = Math.floor(second.length / 2);
    fs.writeFileSync(file, first + second.slice(0, cut));
    assert.equal(await indexSessionFile(incremental, source, file), 'full');
    assert.equal(await indexSessionFile(incremental, source, file), 'skipped');

    fs.appendFileSync(file, second.slice(cut));
    assert.equal(await indexSessionFile(incremental, source, file), 'incremental');
    fs.appendFileSync(file, third);
    assert.equal(await indexSessionFile(incremental, source, file), 'incremental');

    assert.equal(await indexSessionFile(fresh, source, file), 'full');
    assert.deepEqual(snapshot(incremental), snapshot(fresh));
    assert.equal(snapshot(fresh).events.length, 22);
    assert.equal(snapshot(fresh).threads[0].prompts.length, 6);
  } finally {
    incremental.close();
    fresh.close();
    removeDir(directory);
  }
});

test('a truncated or replaced rollout, or a new parser version, is parsed again from the start', async () => {
  const directory = tempDir('incremental-replaced');
  const target = store(directory, 'store');
  try {
    const home = path.join(directory, 'codex');
    const source = codexSessionSource(home);
    const file = path.join(home, 'sessions', 'rollout-2026-09-20T11-00-00-efgh.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const start = baseTime(1);
    fs.writeFileSync(file, `${lines([...codexHeader(start, 'thread-replaced'), ...codexRecords(start, 0, 10)])}\n`);
    await indexSessionFile(target, source, file);
    assert.equal(snapshot(target).events.length, 10);

    // Same thread, rewritten shorter: incremental parsing would keep stale rows.
    fs.writeFileSync(file, `${lines([...codexHeader(start, 'thread-replaced'), ...codexRecords(start, 0, 4)])}\n`);
    assert.equal(await indexSessionFile(target, source, file), 'full');
    assert.equal(snapshot(target).events.length, 4);

    // Rewritten with different leading bytes but a larger size.
    fs.writeFileSync(file, `${lines([...codexHeader(start + 1, 'thread-replaced'), ...codexRecords(start, 0, 12)])}\n`);
    assert.equal(await indexSessionFile(target, source, file), 'full');
    assert.equal(snapshot(target).events.length, 12);

    const upgraded: SessionSource = { ...source, parserVersion: `${source.parserVersion}-next` };
    fs.appendFileSync(file, `${lines(codexRecords(start, 12, 14))}\n`);
    assert.equal(await indexSessionFile(target, upgraded, file), 'full');
    assert.equal(snapshot(target).events.length, 14);
  } finally {
    target.close();
    removeDir(directory);
  }
});

test('a rollout moved into archived_sessions is not counted twice', async () => {
  const directory = tempDir('incremental-archive');
  const target = store(directory, 'store');
  try {
    const home = path.join(directory, 'codex');
    const source = codexSessionSource(home);
    const name = 'rollout-2026-09-20T12-00-00-ijkl.jsonl';
    const active = path.join(home, 'sessions', '2026', '09', '20', name);
    fs.mkdirSync(path.dirname(active), { recursive: true });
    const start = baseTime(1);
    fs.writeFileSync(active, `${lines([...codexHeader(start, 'thread-archived'), ...codexRecords(start, 0, 5)])}\n`);
    await scanAllSessions(target, source);
    const before = target.getTokenTotals();

    const archived = path.join(home, 'archived_sessions', name);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(active, archived);
    await scanAllSessions(target, source);
    const after = target.getTokenTotals();
    assert.equal(after.totalTokens, before.totalTokens);
    assert.equal(after.threads, 1);
    assert.equal(target.getThreadSummaries()[0].partCount, 1);
  } finally {
    target.close();
    removeDir(directory);
  }
});

const SESSION = '11111111-2222-4333-8444-555555555555';

function claudeAssistant(uuid: string, timestamp: number, messageId: string, block: number) {
  return {
    type: 'assistant',
    uuid,
    timestamp: iso(timestamp),
    sessionId: SESSION,
    cwd: '/repo',
    entrypoint: 'cli',
    message: {
      id: messageId,
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [{ type: block === 0 ? 'text' : 'tool_use' }],
      usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 9_000, output_tokens: 120 + block }
    }
  };
}

function claudeUser(uuid: string, timestamp: number, text: string, promptId: string) {
  return { type: 'user', uuid, timestamp: iso(timestamp), sessionId: SESSION, cwd: '/repo', entrypoint: 'cli', promptId, message: { role: 'user', content: text } };
}

test('Claude streaming records split across two scans are still counted once', async () => {
  const directory = tempDir('incremental-claude');
  const incremental = store(directory, 'incremental', 'claude');
  const fresh = store(directory, 'fresh', 'claude');
  try {
    const projects = path.join(directory, 'projects');
    const source = claudeSessionSource(projects);
    const file = path.join(projects, '-repo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const start = baseTime(1);
    // The scan runs after the first content block of msg_1 was written...
    fs.writeFileSync(file, `${lines([
      claudeUser('u1', start, 'First request', 'turn-1'),
      claudeAssistant('a1', start + 2, 'msg_1', 0)
    ])}\n`);
    await indexSessionFile(incremental, source, file);
    // ...and the second block (same message, same usage) arrives with the next reply.
    fs.appendFileSync(file, `${lines([
      claudeAssistant('a2', start + 3, 'msg_1', 1),
      { type: 'system', subtype: 'turn_duration', durationMs: 9_000, timestamp: iso(start + 9), sessionId: SESSION, uuid: 's1' },
      claudeUser('u2', start + 30, 'Second request', 'turn-2'),
      claudeAssistant('a3', start + 33, 'msg_2', 0),
      { type: 'ai-title', aiTitle: 'Split transcript', sessionId: SESSION }
    ])}\n`);
    assert.equal(await indexSessionFile(incremental, source, file), 'incremental');
    await indexSessionFile(fresh, source, file);

    assert.deepEqual(snapshot(incremental), snapshot(fresh));
    const events = incremental.getTokenEventsBetween(0, Number.MAX_SAFE_INTEGER);
    assert.equal(events.length, 2);
    const [thread] = incremental.getThreadSummaries();
    assert.equal(thread.title, 'Split transcript');
    assert.equal(thread.prompts.length, 2);
    assert.equal(thread.prompts[0].durationMs, 9_000);
    assert.equal(thread.totalTokens, 2 * (9_503 + 120));
  } finally {
    incremental.close();
    fresh.close();
    removeDir(directory);
  }
});
