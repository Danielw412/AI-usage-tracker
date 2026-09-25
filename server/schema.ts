import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionPartKind } from './types.js';

/**
 * Schema versions:
 *   1  single-device layout: parts, events, and prompts keyed by absolute file
 *      path, with foreign keys from events and prompts to parts.
 *   2  multi-device layout: parts keyed by a stable, path-independent part id,
 *      every row stamped with the device that produced it, events stored without
 *      a foreign key so they can arrive before (or without) their part, plus the
 *      local file index, sync outbox, and per-window attribution cache.
 */
export const SCHEMA_VERSION = '2';

export interface LegacyPartRow {
  sourceFile: string;
  threadId: string;
  partKind: SessionPartKind;
}

export interface SchemaOptions {
  deviceId: string;
  /** Stable part id for a row written by a schema-1 build. */
  legacyPartId: (row: LegacyPartRow) => string;
}

const SHARED_TABLES = `
  CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at INTEGER NOT NULL,
    limit_key TEXT NOT NULL,
    label TEXT NOT NULL,
    used_percent REAL NOT NULL,
    duration_mins INTEGER NOT NULL,
    resets_at INTEGER NOT NULL,
    UNIQUE(observed_at, limit_key, resets_at)
  );
  CREATE INDEX IF NOT EXISTS idx_rate_history
    ON rate_limit_snapshots(limit_key, resets_at, observed_at);
  CREATE INDEX IF NOT EXISTS idx_rate_history_duration
    ON rate_limit_snapshots(duration_mins, observed_at);

  CREATE TABLE IF NOT EXISTS account_daily_usage (
    usage_date TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL,
    observed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS thread_metadata (
    thread_id TEXT PRIMARY KEY,
    display_name TEXT,
    preview TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cloud_tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at INTEGER,
    environment_label TEXT,
    url TEXT,
    is_review INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER,
    lines_added INTEGER,
    lines_removed INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dashboard_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const PART_TABLES = `
  CREATE TABLE IF NOT EXISTS session_parts (
    part_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    source_file TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    part_kind TEXT NOT NULL,
    title TEXT,
    project_path TEXT,
    started_at INTEGER,
    updated_at INTEGER,
    primary_model TEXT NOT NULL,
    models_json TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL,
    pricing_status TEXT NOT NULL,
    user_message_count INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    source_label TEXT,
    reported_cost_usd REAL,
    written_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_parts_thread
    ON session_parts(thread_id, part_kind, updated_at);

  CREATE TABLE IF NOT EXISTS session_part_token_events (
    event_key TEXT PRIMARY KEY,
    part_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    part_kind TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL,
    reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    written_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_part_events_time
    ON session_part_token_events(observed_at);
  CREATE INDEX IF NOT EXISTS idx_session_part_events_thread
    ON session_part_token_events(thread_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_session_part_events_part
    ON session_part_token_events(part_id);

  CREATE TABLE IF NOT EXISTS prompt_metrics (
    prompt_id TEXT PRIMARY KEY,
    part_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    source_file TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    sequence_number INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER,
    time_to_first_token_ms INTEGER,
    timing_estimated INTEGER NOT NULL,
    primary_model TEXT NOT NULL,
    models_json TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL,
    reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    pricing_status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_metrics_thread
    ON prompt_metrics(thread_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_prompt_metrics_completed
    ON prompt_metrics(completed_at);
  CREATE INDEX IF NOT EXISTS idx_prompt_metrics_part
    ON prompt_metrics(part_id);
`;

const SYNC_TABLES = `
  -- Where each local log file was indexed up to. Device-local; never synced.
  CREATE TABLE IF NOT EXISTS local_files (
    path TEXT PRIMARY KEY,
    part_ids TEXT NOT NULL,
    modified_ms REAL NOT NULL,
    size_bytes INTEGER NOT NULL,
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL,
    tail_offset INTEGER,
    tail_state TEXT,
    head_length INTEGER,
    head_hash TEXT,
    anchor_hash TEXT,
    depends_on TEXT,
    depends_stat TEXT,
    indexed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_local_files_depends ON local_files(depends_on);

  -- Collector outbox: every local change waiting for the central server to
  -- acknowledge it. Rows are deleted only after an acknowledgement.
  CREATE TABLE IF NOT EXISTS sync_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    record_key TEXT NOT NULL,
    part_id TEXT,
    observed_at INTEGER,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(kind, record_key)
  );
  CREATE INDEX IF NOT EXISTS idx_sync_outbox_part ON sync_outbox(part_id);

  -- Derived, recomputable per-bank quota attribution. Any write that touches
  -- events inside [bank_start, bank_end] deletes the affected rows.
  CREATE TABLE IF NOT EXISTS window_attribution (
    scope TEXT NOT NULL,
    duration_mins INTEGER NOT NULL,
    resets_at INTEGER NOT NULL,
    bank_start INTEGER NOT NULL,
    bank_end INTEGER NOT NULL,
    signature TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (scope, duration_mins, resets_at)
  );
  CREATE INDEX IF NOT EXISTS idx_window_attribution_range
    ON window_attribution(bank_start, bank_end);
`;

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
  );
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

export function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM dashboard_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO dashboard_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

type Row = Record<string, unknown>;

/** Bring schema-1 columns that arrived over time up to date before migrating. */
function upgradeLegacyColumns(db: DatabaseSync): void {
  ensureColumn(db, 'session_parts', 'source', 'TEXT');
  ensureColumn(db, 'session_parts', 'source_label', 'TEXT');
  ensureColumn(db, 'session_parts', 'cache_write_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'session_parts', 'cache_write_1h_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'session_parts', 'reported_cost_usd', 'REAL');
  ensureColumn(db, 'session_part_token_events', 'cache_write_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'session_part_token_events', 'cache_write_1h_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'prompt_metrics', 'cache_write_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'prompt_metrics', 'cache_write_1h_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
}

/**
 * Rebuild schema-1 part, event, and prompt tables in the multi-device layout.
 * Every row is kept and stamped with this device. Rows for the same file seen
 * under two paths (a Codex rollout moved into `archived_sessions`) collapse onto
 * one part, keeping the copy whose file still exists.
 */
function migrateFromV1(db: DatabaseSync, options: SchemaOptions): void {
  upgradeLegacyColumns(db);
  const now = Math.floor(Date.now() / 1000);

  db.exec('ALTER TABLE session_parts RENAME TO legacy_session_parts;');
  db.exec('ALTER TABLE session_part_token_events RENAME TO legacy_session_part_token_events;');
  db.exec('ALTER TABLE prompt_metrics RENAME TO legacy_prompt_metrics;');
  // Index names are global; drop the old ones so the new tables can reuse them.
  for (const index of [
    'idx_session_parts_thread',
    'idx_session_part_events_time',
    'idx_session_part_events_thread',
    'idx_prompt_metrics_thread',
    'idx_prompt_metrics_completed'
  ]) {
    db.exec(`DROP INDEX IF EXISTS ${index};`);
  }
  db.exec(PART_TABLES);

  const legacyParts = db.prepare('SELECT * FROM legacy_session_parts').all() as Row[];
  const partIdByFile = new Map<string, string>();
  const winners = new Map<string, Row>();
  const score = (row: Row): [number, number, number] => [
    fs.existsSync(String(row.source_file).replace(/#sidechain$/, '')) ? 1 : 0,
    Number(row.total_tokens ?? 0),
    Number(row.updated_at ?? 0)
  ];
  for (const row of legacyParts) {
    const partId = options.legacyPartId({
      sourceFile: String(row.source_file),
      threadId: String(row.thread_id),
      partKind: String(row.part_kind) as SessionPartKind
    });
    partIdByFile.set(String(row.source_file), partId);
    const current = winners.get(partId);
    if (!current) {
      winners.set(partId, row);
      continue;
    }
    const [a, b] = [score(row), score(current)];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) winners.set(partId, row);
  }
  const winningFiles = new Set([...winners.values()].map((row) => String(row.source_file)));

  const insertPart = db.prepare(`
    INSERT INTO session_parts (
      part_id, device_id, source_file, thread_id, part_kind, title, project_path, started_at, updated_at,
      primary_model, models_json, input_tokens, cached_input_tokens, cache_write_input_tokens,
      cache_write_1h_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      estimated_cost_usd, pricing_status, user_message_count, source, source_label, reported_cost_usd, written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [partId, row] of winners) {
    insertPart.run(
      partId, options.deviceId, row.source_file as string, row.thread_id as string, row.part_kind as string,
      (row.title ?? null) as string | null, (row.project_path ?? null) as string | null,
      (row.started_at ?? null) as number | null, (row.updated_at ?? null) as number | null,
      row.primary_model as string, row.models_json as string, row.input_tokens as number,
      row.cached_input_tokens as number, (row.cache_write_input_tokens ?? 0) as number,
      (row.cache_write_1h_input_tokens ?? 0) as number, row.output_tokens as number,
      row.reasoning_output_tokens as number, row.total_tokens as number,
      (row.estimated_cost_usd ?? null) as number | null, row.pricing_status as string,
      (row.user_message_count ?? 0) as number, (row.source ?? null) as string | null,
      (row.source_label ?? null) as string | null, (row.reported_cost_usd ?? null) as number | null, now
    );
  }

  const partKindByFile = new Map(legacyParts.map((row) => [String(row.source_file), String(row.part_kind)]));
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO session_part_token_events (
      event_key, part_id, device_id, thread_id, part_kind, observed_at, model, input_tokens,
      cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens, output_tokens,
      reasoning_output_tokens, total_tokens, estimated_cost_usd, written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of db.prepare('SELECT * FROM legacy_session_part_token_events').all() as Row[]) {
    const sourceFile = String(row.source_file);
    // Events from a duplicate copy of a file would be counted twice.
    if (!winningFiles.has(sourceFile)) continue;
    const partId = partIdByFile.get(sourceFile);
    if (!partId) continue;
    insertEvent.run(
      row.event_key as string, partId, options.deviceId, row.thread_id as string,
      partKindByFile.get(sourceFile) ?? 'main', row.observed_at as number, row.model as string,
      row.input_tokens as number, row.cached_input_tokens as number,
      (row.cache_write_input_tokens ?? 0) as number, (row.cache_write_1h_input_tokens ?? 0) as number,
      row.output_tokens as number, row.reasoning_output_tokens as number, row.total_tokens as number,
      (row.estimated_cost_usd ?? null) as number | null, now
    );
  }

  const insertPrompt = db.prepare(`
    INSERT OR IGNORE INTO prompt_metrics (
      prompt_id, part_id, device_id, source_file, thread_id, turn_id, sequence_number, prompt_text,
      started_at, completed_at, duration_ms, time_to_first_token_ms, timing_estimated, primary_model,
      models_json, input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_1h_input_tokens,
      output_tokens, reasoning_output_tokens, total_tokens, estimated_cost_usd, pricing_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of db.prepare('SELECT * FROM legacy_prompt_metrics').all() as Row[]) {
    const sourceFile = String(row.source_file);
    if (!winningFiles.has(sourceFile)) continue;
    const partId = partIdByFile.get(sourceFile);
    if (!partId) continue;
    insertPrompt.run(
      row.prompt_id as string, partId, options.deviceId, sourceFile, row.thread_id as string,
      (row.turn_id ?? null) as string | null, row.sequence_number as number, row.prompt_text as string,
      row.started_at as number, (row.completed_at ?? null) as number | null,
      (row.duration_ms ?? null) as number | null, (row.time_to_first_token_ms ?? null) as number | null,
      row.timing_estimated as number, row.primary_model as string, row.models_json as string,
      row.input_tokens as number, row.cached_input_tokens as number,
      (row.cache_write_input_tokens ?? 0) as number, (row.cache_write_1h_input_tokens ?? 0) as number,
      row.output_tokens as number, row.reasoning_output_tokens as number, row.total_tokens as number,
      (row.estimated_cost_usd ?? null) as number | null, row.pricing_status as string
    );
  }

  db.exec('DROP TABLE legacy_prompt_metrics;');
  db.exec('DROP TABLE legacy_session_part_token_events;');
  db.exec('DROP TABLE legacy_session_parts;');
}

/**
 * Create or upgrade a provider store. Runs inside one transaction, so an
 * interrupted migration leaves the schema-1 tables untouched.
 */
export function ensureSchema(db: DatabaseSync, options: SchemaOptions): { migrated: boolean } {
  db.exec(SHARED_TABLES);
  ensureColumn(db, 'thread_metadata', 'source', 'TEXT');
  ensureColumn(db, 'thread_metadata', 'source_label', 'TEXT');
  ensureColumn(db, 'thread_metadata', 'model', 'TEXT');
  ensureColumn(db, 'thread_metadata', 'reasoning_effort', 'TEXT');
  ensureColumn(db, 'thread_metadata', 'git_branch', 'TEXT');
  ensureColumn(db, 'thread_metadata', 'project_name', 'TEXT');
  ensureColumn(db, 'thread_metadata', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rate_limit_snapshots', 'device_id', 'TEXT');

  if (getMeta(db, 'schema_version') === SCHEMA_VERSION) {
    db.exec(SYNC_TABLES);
    return { migrated: false };
  }

  const legacy = tableExists(db, 'session_parts') && !tableColumns(db, 'session_parts').has('part_id');
  // Foreign keys cannot be toggled inside a transaction, and the schema-1
  // tables reference each other while they are being renamed.
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (legacy) migrateFromV1(db, options);
    else db.exec(PART_TABLES);
    db.exec(SYNC_TABLES);
    // Anything cached by a previous build was computed from the old layout.
    db.exec('DELETE FROM window_attribution;');
    setMeta(db, 'schema_version', SCHEMA_VERSION);
    setMeta(db, 'local_device_id', options.deviceId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { migrated: legacy };
}
