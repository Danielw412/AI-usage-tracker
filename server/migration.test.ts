import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { claudeLegacyPartId } from './claude/sessionLogs.js';
import { createUsageStore } from './db.js';
import { codexPartId } from './sessionLogs.js';
import { removeDir, tempDir } from './testSupport.js';

/** The tables as the single-device build created them. */
const LEGACY_SCHEMA = `
  CREATE TABLE rate_limit_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, limit_key TEXT NOT NULL,
    label TEXT NOT NULL, used_percent REAL NOT NULL, duration_mins INTEGER NOT NULL, resets_at INTEGER NOT NULL,
    UNIQUE(observed_at, limit_key, resets_at)
  );
  CREATE TABLE account_daily_usage (usage_date TEXT PRIMARY KEY, tokens INTEGER NOT NULL, observed_at INTEGER NOT NULL);
  CREATE TABLE session_parts (
    source_file TEXT PRIMARY KEY, modified_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, thread_id TEXT NOT NULL,
    part_kind TEXT NOT NULL, title TEXT, project_path TEXT, started_at INTEGER, updated_at INTEGER,
    primary_model TEXT NOT NULL, models_json TEXT NOT NULL, input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL, estimated_cost_usd REAL, pricing_status TEXT NOT NULL,
    user_message_count INTEGER NOT NULL DEFAULT 0, source TEXT, source_label TEXT
  );
  CREATE INDEX idx_session_parts_thread ON session_parts(thread_id, part_kind, updated_at);
  CREATE TABLE session_part_token_events (
    event_key TEXT PRIMARY KEY, source_file TEXT NOT NULL, thread_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    FOREIGN KEY(source_file) REFERENCES session_parts(source_file) ON DELETE CASCADE
  );
  CREATE INDEX idx_session_part_events_time ON session_part_token_events(observed_at);
  CREATE INDEX idx_session_part_events_thread ON session_part_token_events(thread_id, observed_at);
  CREATE TABLE prompt_metrics (
    prompt_id TEXT PRIMARY KEY, source_file TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT,
    sequence_number INTEGER NOT NULL, prompt_text TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
    duration_ms INTEGER, time_to_first_token_ms INTEGER, timing_estimated INTEGER NOT NULL,
    primary_model TEXT NOT NULL, models_json TEXT NOT NULL, input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL, estimated_cost_usd REAL, pricing_status TEXT NOT NULL,
    FOREIGN KEY(source_file) REFERENCES session_parts(source_file) ON DELETE CASCADE
  );
  CREATE INDEX idx_prompt_metrics_thread ON prompt_metrics(thread_id, started_at);
  CREATE INDEX idx_prompt_metrics_completed ON prompt_metrics(completed_at);
  CREATE TABLE thread_metadata (
    thread_id TEXT PRIMARY KEY, display_name TEXT, preview TEXT, updated_at INTEGER NOT NULL, source TEXT,
    source_label TEXT, model TEXT, reasoning_effort TEXT, git_branch TEXT, project_name TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE cloud_tasks (
    task_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER, environment_label TEXT,
    url TEXT, is_review INTEGER NOT NULL DEFAULT 0, files_changed INTEGER, lines_added INTEGER, lines_removed INTEGER,
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE dashboard_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO dashboard_meta (key, value) VALUES ('metadata_version', '3'), ('provider', 'codex');
`;

const ACTIVE = 'C:\\Users\\me\\.codex\\sessions\\2026\\07\\27\\rollout-2026-07-27T18-54-42-aaaa.jsonl';
const ARCHIVED = 'C:\\Users\\me\\.codex\\archived_sessions\\rollout-2026-07-27T18-54-42-aaaa.jsonl';
const OTHER = 'C:\\Users\\me\\.codex\\sessions\\2026\\07\\28\\rollout-2026-07-28T09-00-00-bbbb.jsonl';

function seedLegacy(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(LEGACY_SCHEMA);
  const part = db.prepare(`
    INSERT INTO session_parts VALUES (?, 1, 1, ?, 'main', ?, 'C:\\repo', 1000, ?, 'gpt-5.6-sol', '["gpt-5.6-sol"]',
      ?, 0, 0, 0, ?, ?, 'exact-model-match', 1, 'desktop', NULL)
  `);
  // The same rollout indexed twice, before and after Codex archived it.
  part.run(ACTIVE, 'thread-a', 'Archived chat', 2000, 3_000, 3_000, 0.3);
  part.run(ARCHIVED, 'thread-a', 'Archived chat', 2100, 3_000, 3_000, 0.3);
  part.run(OTHER, 'thread-b', 'Other chat', 5000, 500, 500, 0.05);
  const event = db.prepare(`INSERT INTO session_part_token_events VALUES (?, ?, ?, ?, 'gpt-5.6-sol', ?, 0, 0, 0, ?, ?)`);
  event.run('old-a1', ACTIVE, 'thread-a', 1_500, 1_000, 1_000, 0.1);
  event.run('old-a2', ACTIVE, 'thread-a', 1_600, 2_000, 2_000, 0.2);
  event.run('arch-a1', ARCHIVED, 'thread-a', 1_500, 1_000, 1_000, 0.1);
  event.run('arch-a2', ARCHIVED, 'thread-a', 1_600, 2_000, 2_000, 0.2);
  event.run('old-b1', OTHER, 'thread-b', 4_500, 500, 500, 0.05);
  db.prepare(`
    INSERT INTO prompt_metrics VALUES ('p-a', ?, 'thread-a', 't1', 1, 'Fix it', 1_400, 1_700, 300000, 1000, 0,
      'gpt-5.6-sol', '["gpt-5.6-sol"]', 3000, 0, 0, 0, 3000, 0.3, 'exact-model-match')
  `).run(ARCHIVED);
  db.prepare(`INSERT INTO thread_metadata (thread_id, display_name, preview, updated_at) VALUES ('thread-a', 'Named chat', NULL, 2000)`).run();
  db.prepare(`INSERT INTO rate_limit_snapshots (observed_at, limit_key, label, used_percent, duration_mins, resets_at) VALUES (1500, 'five-hour', '5-hour window', 12, 300, 9000)`).run();
  db.close();
}

test('an existing single-device database is migrated in place without losing history', () => {
  const directory = tempDir('migration');
  const file = path.join(directory, 'codex-usage.sqlite');
  seedLegacy(file);
  try {
    let store = createUsageStore({
      file,
      provider: 'codex',
      deviceId: 'home-server',
      legacyPartId: (row) => codexPartId(row.sourceFile)
    });
    const totals = store.getTokenTotals();
    // The archived duplicate collapses onto one part; nothing else is dropped.
    assert.equal(totals.threads, 2);
    assert.equal(totals.totalTokens, 3_500);
    const [threadB, threadA] = store.getThreadSummaries();
    assert.equal(threadA.threadId, 'thread-a');
    assert.equal(threadA.title, 'Named chat');
    assert.equal(threadA.partCount, 1);
    assert.equal(threadA.prompts.length, 1);
    assert.deepEqual(threadA.deviceIds, ['home-server']);
    assert.equal(threadB.threadId, 'thread-b');
    assert.equal(store.getRateLimitHistory(300, 9_000).length, 1);
    assert.equal(store.getTokenEventsBetween(0, 10_000).every((event) => event.deviceId === 'home-server'), true);
    assert.equal(store.getMeta('schema_version'), '2');
    assert.equal(store.outboxStats().pending, 0, 'standalone and server stores never queue anything');
    store.close();

    // Opening again is a no-op, and renaming the device relabels its own rows.
    store = createUsageStore({ file, provider: 'codex', deviceId: 'latitude' });
    assert.equal(store.getTokenTotals().totalTokens, 3_500);
    assert.deepEqual(store.getThreadSummaries().map((thread) => thread.deviceIds), [['latitude'], ['latitude']]);
    store.close();
  } finally {
    removeDir(directory);
  }
});

test('legacy Claude rows map onto path-independent part ids', () => {
  assert.equal(
    claudeLegacyPartId('C:\\Users\\me\\.claude\\projects\\C--repo\\11111111-2222-4333-8444-555555555555.jsonl'),
    'C--repo/11111111-2222-4333-8444-555555555555.jsonl'
  );
  assert.equal(
    claudeLegacyPartId('/home/me/.claude/projects/-home-me-repo/11111111-2222-4333-8444-555555555555.jsonl#sidechain'),
    '-home-me-repo/11111111-2222-4333-8444-555555555555.jsonl#sidechain'
  );
  assert.equal(codexPartId('C:\\Users\\me\\.codex\\archived_sessions\\rollout-x.jsonl'), 'rollout-x.jsonl');
  assert.equal(codexPartId('/home/me/.codex/sessions/2026/07/27/rollout-x.jsonl'), 'rollout-x.jsonl');
});
