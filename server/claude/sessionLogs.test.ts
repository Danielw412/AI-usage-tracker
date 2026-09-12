import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyClaudeEntrypoint, parseClaudeTranscript, usageFromClaudeMessage } from './sessionLogs.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

function record(type: string, extra: Record<string, unknown>, timestamp: string, uuid: string): Record<string, unknown> {
  return {
    type,
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp,
    sessionId: SESSION,
    cwd: 'C:\\repo\\dashboard',
    gitBranch: 'main',
    version: '2.1.268',
    entrypoint: 'cli',
    userType: 'external',
    ...extra
  };
}

function assistant(
  uuid: string,
  timestamp: string,
  messageId: string,
  blockIndex: number,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return record('assistant', {
    apiBlockIndex: blockIndex,
    requestId: `req_${messageId}`,
    effort: 'xhigh',
    message: {
      id: messageId,
      model: 'claude-fable-5-1',
      role: 'assistant',
      type: 'message',
      content: [{ type: blockIndex === 0 ? 'text' : 'tool_use', text: 'hi' }],
      usage
    },
    ...extra
  }, timestamp, uuid);
}

const usageA = {
  input_tokens: 2,
  cache_creation_input_tokens: 12_000,
  cache_read_input_tokens: 30_000,
  output_tokens: 250,
  output_tokens_details: { thinking_tokens: 40 },
  cache_creation: { ephemeral_1h_input_tokens: 12_000, ephemeral_5m_input_tokens: 0 }
};
const usageB = {
  input_tokens: 4,
  cache_creation_input_tokens: 800,
  cache_read_input_tokens: 42_000,
  output_tokens: 600,
  output_tokens_details: { thinking_tokens: 0 },
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 800 }
};

function writeTranscript(directory: string, name: string, records: Array<Record<string, unknown>>): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  return file;
}

function sampleRecords(): Array<Record<string, unknown>> {
  return [
    { type: 'mode', mode: 'normal', sessionId: SESSION },
    record('user', {
      promptId: 'turn-0',
      message: { role: 'user', content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>' }
    }, '2026-09-11T04:15:34.000Z', 'u0'),
    record('user', {
      promptId: 'turn-0',
      message: { role: 'user', content: '<local-command-stdout>Set effort level to xhigh</local-command-stdout>' }
    }, '2026-09-11T04:15:34.100Z', 'u0b'),
    record('user', {
      promptId: 'turn-1',
      message: { role: 'user', content: [{ type: 'text', text: 'Integrate Claude Code into the dashboard' }, { type: 'image' }] }
    }, '2026-09-11T04:16:00.000Z', 'u1'),
    record('user', { isMeta: true, promptId: 'turn-1', message: { role: 'user', content: 'meta context' } }, '2026-09-11T04:16:00.100Z', 'u1m'),
    assistant('a1', '2026-09-11T04:16:03.000Z', 'msg_1', 0, usageA),
    assistant('a2', '2026-09-11T04:16:04.000Z', 'msg_1', 1, usageA),
    record('user', {
      promptId: 'turn-1',
      toolUseResult: {},
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] }
    }, '2026-09-11T04:16:05.000Z', 'u1t'),
    assistant('a3', '2026-09-11T04:16:20.000Z', 'msg_2', 0, usageB),
    // A subagent answering inline (older transcripts keep sidechains in the same file).
    assistant('s1', '2026-09-11T04:16:25.000Z', 'msg_side', 0, usageB, { isSidechain: true, agentId: 'agent-1' }),
    record('system', { subtype: 'turn_duration', durationMs: 32_000, messageCount: 6 }, '2026-09-11T04:16:32.000Z', 'sys1'),
    { type: 'ai-title', aiTitle: 'Integrate Claude Code into Codex dashboard', sessionId: SESSION },
    { type: 'custom-title', customTitle: 'Dashboard integration', sessionId: SESSION },
    {
      type: 'cost-state',
      sessionId: SESSION,
      totalCostUSD: 0.42,
      totalDuration: 1000,
      modelUsage: { 'claude-fable-5-1': { inputTokens: 6, outputTokens: 850 } },
      hasUnknownModelCost: false
    }
  ];
}

test('maps Claude usage blocks onto the shared token model', () => {
  const usage = usageFromClaudeMessage(usageA);
  assert.deepEqual(usage, {
    inputTokens: 42_002,
    cachedInputTokens: 30_000,
    cacheWriteInputTokens: 12_000,
    cacheWrite1hInputTokens: 12_000,
    outputTokens: 250,
    reasoningOutputTokens: 40,
    totalTokens: 42_252
  });
  assert.equal(usageFromClaudeMessage({ input_tokens: 0, output_tokens: 0 }), null);
});

test('parses a transcript into a main part and an inline subagent part', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dashboard-transcript-'));
  try {
    const file = writeTranscript(directory, `${SESSION}.jsonl`, sampleRecords());
    const parts = await parseClaudeTranscript(file);
    assert.equal(parts.length, 2);

    const [main, side] = parts;
    assert.equal(main.summary.threadId, SESSION);
    assert.equal(main.summary.partKind, 'main');
    assert.equal(main.summary.source, 'cli');
    assert.equal(main.summary.projectPath, 'C:\\repo\\dashboard');
    assert.equal(main.summary.title, 'Integrate Claude Code into the dashboard');
    assert.equal(main.summary.reportedCostUsd, 0.42);
    // Two distinct API messages despite three assistant records.
    assert.equal(main.events.length, 2);
    assert.equal(main.summary.inputTokens, 42_002 + 42_804);
    assert.equal(main.summary.cacheWriteInputTokens, 12_800);
    assert.equal(main.summary.cacheWrite1hInputTokens, 12_000);
    assert.equal(main.summary.outputTokens, 850);
    assert.equal(main.summary.primaryModel, 'claude-fable-5-1');
    assert.equal(main.summary.pricingStatus, 'exact-model-match');
    assert.ok((main.summary.estimatedApiCostUsd ?? 0) > 0);

    // The slash command produced no API call, so only the real prompt is kept.
    assert.equal(main.summary.userMessageCount, 1);
    assert.equal(main.prompts.length, 1);
    const prompt = main.prompts[0];
    assert.equal(prompt.prompt, 'Integrate Claude Code into the dashboard');
    assert.equal(prompt.turnId, 'turn-1');
    assert.equal(prompt.durationMs, 32_000);
    assert.equal(prompt.timingEstimated, false);
    assert.equal(prompt.timeToFirstTokenMs, 3_000);
    assert.equal(prompt.totalTokens, main.summary.totalTokens);

    assert.equal(main.metadata?.displayName, 'Dashboard integration');
    assert.equal(main.metadata?.reasoningEffort, 'xhigh');
    assert.equal(main.metadata?.gitBranch, 'main');
    assert.equal(main.metadata?.projectName, 'dashboard');

    assert.equal(side.summary.partKind, 'subagent');
    assert.equal(side.summary.sourceFile, `${file}#sidechain`);
    assert.equal(side.summary.threadId, SESSION);
    assert.equal(side.events.length, 1);
    assert.equal(side.summary.userMessageCount, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('treats a continued session as superseded once the continuation holds its records', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dashboard-continue-'));
  try {
    const original = sampleRecords();
    const continuedFile = writeTranscript(directory, `${SESSION}.jsonl`, [
      ...original,
      { type: 'continued-in', timestamp: '2026-09-11T04:20:00.000Z', sessionId: SESSION, continuedInSessionId: OTHER },
      // Housekeeping written after the marker never reaches the continuation.
      record('system', { subtype: 'away_summary', content: 'recap' }, '2026-09-11T04:20:05.000Z', 'after-marker')
    ]);
    // Continuations copy every record (same uuids) under the new session id.
    const copied = original.map((item) => ('sessionId' in item ? { ...item, sessionId: OTHER } : item));
    writeTranscript(directory, `${OTHER}.jsonl`, [
      ...copied,
      assistant('b1', '2026-09-11T04:21:00.000Z', 'msg_new', 0, usageB)
    ]);

    assert.deepEqual(await parseClaudeTranscript(continuedFile), []);
    const continuation = await parseClaudeTranscript(path.join(directory, `${OTHER}.jsonl`));
    assert.equal(continuation[0].summary.threadId, OTHER);
    assert.equal(continuation[0].events.length, 3);

    // A continuation that never copied anything leaves the original in place.
    const emptyTarget = `${'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}.jsonl`;
    const abandoned = writeTranscript(directory, 'abcdefab-1234-4567-8901-abcdefabcdef.jsonl', [
      ...original,
      { type: 'continued-in', timestamp: '2026-09-11T04:20:00.000Z', sessionId: SESSION, continuedInSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
    ]);
    fs.writeFileSync(path.join(directory, emptyTarget), '');
    const kept = await parseClaudeTranscript(abandoned);
    assert.equal(kept.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('files under subagents/ become subagent parts of the parent session', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dashboard-subagent-'));
  try {
    const nested = path.join(directory, SESSION, 'subagents');
    fs.mkdirSync(nested, { recursive: true });
    const file = writeTranscript(nested, 'agent-abc123.jsonl', [
      record('user', { agentId: 'abc123', message: { role: 'user', content: 'Explore the repo' } }, '2026-09-11T05:00:00.000Z', 'x1'),
      assistant('x2', '2026-09-11T05:00:05.000Z', 'msg_sub', 0, usageB, { agentId: 'abc123' })
    ]);
    const parts = await parseClaudeTranscript(file);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].summary.threadId, SESSION);
    assert.equal(parts[0].summary.partKind, 'subagent');
    assert.equal(parts[0].summary.source, 'subagent');
    assert.equal(parts[0].prompts.length, 0);
    assert.equal(parts[0].events.length, 1);
    assert.equal(parts[0].metadata, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('classifies session entry points', () => {
  assert.deepEqual(classifyClaudeEntrypoint('cli', null), { source: 'cli', sourceLabel: null });
  assert.deepEqual(classifyClaudeEntrypoint('cli', 'bg'), { source: 'cli', sourceLabel: 'Background' });
  assert.deepEqual(classifyClaudeEntrypoint('claude-desktop', null), { source: 'desktop', sourceLabel: null });
  assert.deepEqual(classifyClaudeEntrypoint('sdk-ts', null), { source: 'exec', sourceLabel: 'SDK' });
  assert.deepEqual(classifyClaudeEntrypoint('vscode', null), { source: 'ide', sourceLabel: null });
  assert.deepEqual(classifyClaudeEntrypoint('cli', null, true), { source: 'cli', sourceLabel: 'Remote Control' });
  assert.equal(classifyClaudeEntrypoint(null, null).source, 'unknown');
});
