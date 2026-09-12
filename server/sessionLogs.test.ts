import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanDisplayText, cleanUserMessage, extractRawUserMessage } from './messageText.js';
import { parseSessionFile } from './sessionLogs.js';

test('extracts user messages from the current response item format', () => {
  const record = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Fix the dashboard' },
        { type: 'input_image', image_url: 'data:image/png;base64,ignored' }
      ]
    }
  };
  assert.equal(extractRawUserMessage(record), 'Fix the dashboard');
});

test('cleans request wrappers, escaped markdown, and HTML entities', () => {
  assert.equal(
    cleanUserMessage(
      '# Files mentioned by the user:\nfile.png\n## My request: Build the \\*\\*usage view\\*\\*.&#x20;'
    ),
    'Build the **usage view**.'
  );
  assert.equal(cleanDisplayText('Use the \\`Codex SDK\\`'), 'Use the `Codex SDK`');
  assert.equal(cleanUserMessage('<environment_context>private runtime state</environment_context>'), null);
});

test('parses prompt metrics from current Codex session records', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-session-'));
  const sourceFile = path.join(temporaryDirectory, 'rollout.jsonl');
  const records = [
    {
      timestamp: '2026-08-29T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'thread-current-format', cwd: 'C:/repo', thread_source: 'main' }
    },
    {
      timestamp: '2026-08-29T00:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', turn_id: 'turn-1' }
    },
    {
      timestamp: '2026-08-29T00:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_787_961_602 }
    },
    {
      timestamp: '2026-08-29T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>ignored</environment_context>' }]
      }
    },
    {
      timestamp: '2026-08-29T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '## My request: Fix search and filters' }]
      }
    },
    {
      timestamp: '2026-08-29T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 20,
            total_tokens: 120
          }
        }
      }
    },
    {
      timestamp: '2026-08-29T00:00:06.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        completed_at: 1_787_961_606,
        duration_ms: 4_000,
        time_to_first_token_ms: 2_000
      }
    }
  ];

  fs.writeFileSync(sourceFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  try {
    const parsed = await parseSessionFile(sourceFile);
    assert.ok(parsed);
    assert.equal(parsed.summary.title, 'Fix search and filters');
    assert.equal(parsed.summary.userMessageCount, 1);
    assert.equal(parsed.prompts.length, 1);
    assert.equal(parsed.prompts[0].totalTokens, 120);
    assert.equal(parsed.prompts[0].durationMs, 4_000);
    assert.equal(parsed.prompts[0].timeToFirstTokenMs, 2_000);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('keeps plugin mentions readable in cleaned prompts', () => {
  assert.equal(
    cleanUserMessage('[@Chrome](plugin://browser@openai-bundled?browserFamily=chrome)&#x20;\n\nGo through my Gmail'),
    '@Chrome Go through my Gmail'
  );
});
