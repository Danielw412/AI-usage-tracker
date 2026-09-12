import { spawn } from 'node:child_process';
import type { CloudTask } from './types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, maxLength = 300): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function integerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
  }
  return null;
}

function statusText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/[_-]+/g, ' ').trim().toLowerCase() || 'unknown';
  if (isRecord(value)) {
    const inner = Object.keys(value)[0];
    return inner ? inner.replace(/[_-]+/g, ' ').toLowerCase() : 'unknown';
  }
  return 'unknown';
}

/** Parse the JSON printed by `codex cloud list --json`. Exported for tests. */
export function parseCloudTaskList(raw: string, now = Math.floor(Date.now() / 1000)): CloudTask[] {
  const start = raw.indexOf('{');
  if (start < 0) return [];
  const parsed = JSON.parse(raw.slice(start)) as unknown;
  const list = isRecord(parsed) && Array.isArray(parsed.tasks)
    ? parsed.tasks
    : Array.isArray(parsed)
      ? parsed
      : [];
  return list.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = textValue(item.id, 200);
    if (!id) return [];
    const summary = isRecord(item.summary) ? item.summary : {};
    return [{
      id,
      title: textValue(item.title) ?? 'Untitled cloud task',
      status: statusText(item.status),
      updatedAt: timestampValue(item.updated_at ?? item.updatedAt),
      environmentLabel: textValue(item.environment_label ?? item.environmentLabel, 120),
      url: textValue(item.url, 500),
      isReview: item.is_review === true || item.isReview === true,
      filesChanged: integerValue(summary.files_changed ?? summary.filesChanged),
      linesAdded: integerValue(summary.lines_added ?? summary.linesAdded),
      linesRemoved: integerValue(summary.lines_removed ?? summary.linesRemoved),
      firstSeenAt: now
    }];
  });
}

function runCodex(args: string[], timeoutMs: number): Promise<string> {
  const binary = process.env.CODEX_BIN || 'codex';
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex ${args[0]} ${args[1]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `codex exited with code ${code}`));
    });
  });
}

/** List recent Codex Cloud tasks through the CLI. Throws when the CLI cannot answer. */
export async function listCloudTasks(limit = 20, timeoutMs = 90_000): Promise<CloudTask[]> {
  const output = await runCodex(
    ['cloud', 'list', '--limit', String(Math.max(1, Math.min(20, limit))), '--json'],
    timeoutMs
  );
  return parseCloudTaskList(output);
}
