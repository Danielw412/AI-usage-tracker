import fs from 'node:fs';
import path from 'node:path';
import type { StoredThreadEvent, UsageStore } from './db.js';
import type { PromptMetric, RateLimitWindow, ThreadPartSummary } from './types.js';

/** One session part recovered from a local log file. */
export interface ParsedSessionPart {
  summary: ThreadPartSummary;
  events: StoredThreadEvent[];
  prompts: PromptMetric[];
  /** Quota samples embedded in the log, if the provider writes any. */
  limits?: RateLimitWindow[];
}

export interface ScanResult {
  scanned: number;
  updated: number;
  errors: number;
}

export interface ScanOptions {
  store: UsageStore;
  files: string[];
  /** Bump when the parser's output changes so every file is read again. */
  parserVersion: string;
  /** File that remembers which parser version indexed the store last. */
  markerPath: string;
  /**
   * Parse one file. `null` means "nothing to index, leave stored rows alone";
   * an empty array means the file is superseded and its rows must be removed.
   */
  parse: (sourceFile: string) => Promise<ParsedSessionPart[] | null>;
  /** Human-readable provider name for warnings. */
  label: string;
}

/** Files known to be superseded, so they are not re-read every scan. */
const supersededFiles = new Map<string, { modifiedMs: number; sizeBytes: number }>();

export async function listFilesRecursive(
  root: string,
  accept: (fullPath: string, name: string) => boolean,
  skipDirectory?: (fullPath: string, name: string) => boolean
): Promise<string[]> {
  const result: string[] = [];
  if (!fs.existsSync(root)) return result;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectory || !skipDirectory(full, entry.name)) stack.push(full);
      } else if (entry.isFile() && accept(full, entry.name)) {
        result.push(full);
      }
    }
  }
  return result;
}

/**
 * Shared incremental scan loop: files whose size and mtime are unchanged since
 * the last index are skipped unless the parser version moved.
 */
export async function scanSessionFiles(options: ScanOptions): Promise<ScanResult> {
  const { store, files, parserVersion, markerPath, parse, label } = options;
  const installedVersion = fs.existsSync(markerPath)
    ? (await fs.promises.readFile(markerPath, 'utf8')).trim()
    : '';
  const forceRescan = installedVersion !== parserVersion;
  let updated = 0;
  let errors = 0;

  for (const sourceFile of files) {
    try {
      const stat = await fs.promises.stat(sourceFile);
      const previous = store.getSessionFileState(sourceFile) ?? supersededFiles.get(sourceFile) ?? null;
      if (
        !forceRescan &&
        previous &&
        previous.modifiedMs === stat.mtimeMs &&
        previous.sizeBytes === stat.size
      ) {
        continue;
      }
      const parts = await parse(sourceFile);
      if (parts === null) continue;
      if (parts.length === 0) {
        const stale = store.listSessionFiles().filter(
          (stored) => stored === sourceFile || stored.startsWith(`${sourceFile}#`)
        );
        if (stale.length > 0) {
          store.removeSessionParts(stale);
          updated += 1;
        }
        supersededFiles.set(sourceFile, { modifiedMs: stat.mtimeMs, sizeBytes: stat.size });
        continue;
      }
      supersededFiles.delete(sourceFile);
      for (const part of parts) {
        if (part.limits && part.limits.length > 0) store.insertRateLimitSnapshots(part.limits);
        store.replaceThreadData(part.summary, part.events, part.prompts, {
          modifiedMs: stat.mtimeMs,
          sizeBytes: stat.size
        });
      }
      updated += 1;
    } catch (error) {
      errors += 1;
      console.warn(`Failed to parse ${label} session ${sourceFile}:`, error);
    }
  }

  if (forceRescan && errors === 0) {
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.promises.writeFile(markerPath, `${parserVersion}\n`, 'utf8');
  }

  return { scanned: files.length, updated, errors };
}
