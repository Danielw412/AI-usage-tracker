import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { classifyThreadSource, readLocalThreadMetadata } from './localThreadMetadata.js';

test('prefers the generated chat name and keeps the raw prompt as a preview', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-title-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  const database = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', 'School Dashboard');
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      name TEXT,
      preview TEXT,
      source TEXT,
      thread_source TEXT,
      model TEXT,
      reasoning_effort TEXT,
      git_branch TEXT,
      cwd TEXT,
      archived INTEGER,
      project_id TEXT,
      updated_at_ms INTEGER
    );
    INSERT INTO threads VALUES (
      'thread-1', '# Files mentioned by the user: clipboard.png', 'Fix mobile UX and auth flows',
      'make these changes to the UI/UX', 'vscode', 'user', 'gpt-5.6-sol', 'high', 'main',
      'C:/repo', 0, 'project-1', 1784600000000
    );
    INSERT INTO threads VALUES (
      'thread-2', 'You are operating inside one temporary assignment workspace.', NULL,
      'You are operating inside one temporary assignment workspace.', 'exec', 'school-dashboard',
      'gpt-5.6-luna', 'medium', NULL, 'C:/tmp/workspace', 0, NULL, 1784600001000
    );
  `);
  database.close();

  try {
    const rows = readLocalThreadMetadata().sort((a, b) => a.threadId.localeCompare(b.threadId));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].displayName, 'Fix mobile UX and auth flows');
    assert.equal(rows[0].preview, 'make these changes to the UI/UX');
    assert.equal(rows[0].source, 'desktop');
    assert.equal(rows[0].sourceLabel, null);
    assert.equal(rows[0].projectName, 'School Dashboard');
    assert.equal(rows[0].reasoningEffort, 'high');
    assert.equal(rows[0].gitBranch, 'main');
    assert.equal(rows[0].updatedAt, 1784600000);

    assert.equal(rows[1].displayName, null);
    assert.equal(rows[1].source, 'exec');
    assert.equal(rows[1].sourceLabel, 'school-dashboard');
    assert.equal(rows[1].preview, 'You are operating inside one temporary assignment workspace.');
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('classifies guardian reviews, subagents, and voice threads', () => {
  assert.equal(classifyThreadSource('{"subagent":{"other":"guardian"}}', 'guardian_review').source, 'review');
  assert.equal(classifyThreadSource('{"subagent":{"thread_spawn":{}}}', 'subagent').source, 'subagent');
  assert.equal(classifyThreadSource('vscode', 'realtime_voice').source, 'voice');
  assert.equal(classifyThreadSource('cli', null).source, 'cli');
  assert.deepEqual(classifyThreadSource('vscode', null), { source: 'desktop', sourceLabel: null });
});
