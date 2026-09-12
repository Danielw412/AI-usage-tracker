import fs from 'node:fs';
import path from 'node:path';
import { normalizeStatuslineSample } from './normalize.js';
import { claudeConfigFile, claudeSessionsDir } from './paths.js';
import type { RateLimitWindow } from '../types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse `~/.claude.json`, tolerating a missing or half-written file. */
export async function readClaudeConfigJson(): Promise<JsonRecord | null> {
  const file = claudeConfigFile();
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface LiveClaudeSession {
  sessionId: string;
  /** Display name, when Claude Code generated or the user set one (not path-derived). */
  name: string | null;
  cwd: string | null;
  kind: string | null;
  entrypoint: string | null;
  status: string | null;
  startedAt: number | null;
}

/** Running Claude Code processes, from `<config>/sessions/*.json`. */
export async function readLiveClaudeSessions(): Promise<LiveClaudeSession[]> {
  const directory = claudeSessionsDir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    return [];
  }
  const sessions: LiveClaudeSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(directory, entry), 'utf8')) as unknown;
      if (!isRecord(parsed) || typeof parsed.sessionId !== 'string') continue;
      const nameSource = typeof parsed.nameSource === 'string' ? parsed.nameSource : null;
      const rawName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      sessions.push({
        sessionId: parsed.sessionId,
        name: rawName && nameSource !== 'derived' ? rawName : null,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
        kind: typeof parsed.kind === 'string' ? parsed.kind : null,
        entrypoint: typeof parsed.entrypoint === 'string' ? parsed.entrypoint : null,
        status: typeof parsed.status === 'string' ? parsed.status : null,
        startedAt: typeof parsed.startedAt === 'number' ? Math.round(parsed.startedAt / 1000) : null
      });
    } catch {
      // Session files are rewritten often; skip the ones caught mid-write.
    }
  }
  return sessions;
}

const MAX_SAMPLE_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_SAMPLE_LINES = 3000;

/**
 * Read new lines from the status-line sample file. `offset` is the byte position
 * already ingested; the file is compacted once it grows past a few megabytes.
 */
export async function readStatuslineSamples(
  file: string,
  offset: number
): Promise<{ windows: RateLimitWindow[]; nextOffset: number }> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return { windows: [], nextOffset: 0 };
  }
  const start = stat.size < offset ? 0 : offset;
  if (stat.size === start) return { windows: [], nextOffset: start };

  const handle = await fs.promises.open(file, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally {
    await handle.close();
  }
  // Only ingest complete lines; a partial trailing line waits for the next read.
  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  const windows = complete
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => normalizeStatuslineSample(line));
  let nextOffset = start + Buffer.byteLength(complete, 'utf8');

  if (stat.size > MAX_SAMPLE_FILE_BYTES) {
    try {
      const all = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
      const kept = all.slice(-KEEP_SAMPLE_LINES).join('\n') + '\n';
      await fs.promises.writeFile(file, kept, 'utf8');
      nextOffset = Buffer.byteLength(kept, 'utf8');
    } catch {
      // Compaction is best effort; the offset logic tolerates a shrinking file.
    }
  }
  return { windows, nextOffset };
}
