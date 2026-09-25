import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IndexedPart, LocalFileRecord, ThreadMetadataInput, UsageStore } from './db.js';
import { watchDirectories, type DirectoryWatcher } from './sessionWatch.js';

/** One session part recovered from a local log file. */
export type ParsedSessionPart = IndexedPart;

export interface ScanResult {
  scanned: number;
  updated: number;
  errors: number;
  /** Files resumed from their saved position. */
  incremental: number;
  /** Files parsed from the start. */
  full: number;
}

/** What a parser produced once it has consumed every line it was given. */
export interface ParseOutput {
  /**
   * `null`: nothing indexable yet, leave stored rows alone. `[]`: the file is
   * superseded (a Claude session copied into its continuation) and whatever it
   * produced must be removed.
   */
  parts: ParsedSessionPart[] | null;
  metadata?: ThreadMetadataInput[];
  /** Another file whose later changes mean this one must be evaluated again. */
  dependsOn?: string | null;
}

/**
 * A log parser that can stop after any complete line and later continue from a
 * saved state. `finish()` reports the part summaries for the whole file so far,
 * but only the events and prompts produced since the parser was created or
 * restored, so appended lines never re-send what is already stored.
 */
export interface ResumableParser {
  /** One line, without its trailing newline. */
  feed(line: string): void;
  /** JSON-serializable state covering every line fed so far. */
  snapshot(): unknown;
  /**
   * The thread and part kinds stored rows were produced under. If appended lines
   * change it (a Codex rollout turning out to be an auto-review), the file is
   * parsed again from the start.
   */
  identity(): string;
  finish(): Promise<ParseOutput>;
}

export interface SessionSource {
  /** Human-readable provider name for warnings. */
  label: string;
  /** Bump when the parser's output changes so every file is read again. */
  parserVersion: string;
  /** Every file a full reconciliation scan should consider. */
  listFiles(): Promise<string[]>;
  /** Directories to watch for changes. */
  watchRoots(): string[];
  /** Whether a path reported by the watcher is a log this source parses. */
  accepts(filePath: string): boolean;
  /** A new parser, or one restored from `state`. Throws if the state is unusable. */
  createParser(filePath: string, state?: unknown): ResumableParser;
  /** Part ids a file may have produced before it was tracked (rows migrated from older builds). */
  candidatePartIds(filePath: string): string[];
}

const HEAD_BYTES = 4096;
const ANCHOR_BYTES = 256;
const READ_CHUNK_BYTES = 1 << 20;

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

async function hashRange(filePath: string, start: number, end: number): Promise<string> {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (read < length) return 'short';
    } finally {
      await handle.close();
    }
  }
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function statSignature(filePath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * Feed every line from `start` to the end of the file. Returns the offset just
 * past the last newline and the parser state at that point. A final line with
 * no newline yet (being written right now) is still fed, so its data shows up
 * immediately, but it is not part of the saved state: the next pass starts
 * before it and reads it again once it is complete. Stored rows are keyed by
 * stable ids, so reading a line twice changes nothing.
 */
export async function feedFile(
  filePath: string,
  start: number,
  parser: ResumableParser
): Promise<{ offset: number; state: unknown }> {
  const stream = fs.createReadStream(filePath, { start, highWaterMark: READ_CHUNK_BYTES });
  let pending: Buffer = Buffer.alloc(0);
  let offset = start;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let lineStart = 0;
    let newline = data.indexOf(0x0a, lineStart);
    while (newline !== -1) {
      let lineEnd = newline;
      if (lineEnd > lineStart && data[lineEnd - 1] === 0x0d) lineEnd -= 1;
      parser.feed(data.toString('utf8', lineStart, lineEnd));
      offset += newline + 1 - lineStart;
      lineStart = newline + 1;
      newline = data.indexOf(0x0a, lineStart);
    }
    pending = Buffer.from(data.subarray(lineStart));
  }
  const state = parser.snapshot();
  if (pending.length > 0) parser.feed(pending.toString('utf8'));
  return { offset, state };
}

async function fileFingerprint(filePath: string, offset: number): Promise<{
  headLength: number;
  headHash: string;
  anchorHash: string;
}> {
  const headLength = Math.min(offset, HEAD_BYTES);
  return {
    headLength,
    headHash: await hashRange(filePath, 0, headLength),
    anchorHash: await hashRange(filePath, Math.max(0, offset - ANCHOR_BYTES), offset)
  };
}

/** True when the bytes before the saved offset are exactly what was parsed. */
async function unchangedBeforeOffset(filePath: string, record: LocalFileRecord, size: number): Promise<boolean> {
  if (record.tailOffset === null || record.headLength === null || !record.headHash || !record.anchorHash) return false;
  // A file that shrank was truncated or replaced.
  if (size < record.tailOffset) return false;
  const head = await hashRange(filePath, 0, record.headLength);
  if (head !== record.headHash) return false;
  const anchor = await hashRange(filePath, Math.max(0, record.tailOffset - ANCHOR_BYTES), record.tailOffset);
  return anchor === record.anchorHash;
}

export type IndexOutcome = 'skipped' | 'incremental' | 'full' | 'missing';

/**
 * Index one file. Unchanged files are skipped; a file that only grew resumes
 * from its saved position; anything else (a new parser version, truncation,
 * replacement, a changed identity, a superseded Claude session, or unreadable
 * state) is parsed again from the start.
 */
export async function indexSessionFile(
  store: UsageStore,
  source: SessionSource,
  filePath: string
): Promise<IndexOutcome> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return 'missing';
  }
  if (!stat.isFile()) return 'missing';

  const record = store.getLocalFile(filePath);
  const dependencyNow = record?.dependsOn ? await statSignature(record.dependsOn) : null;
  const sameVersion = record?.parserVersion === source.parserVersion;
  const dependencyUnchanged = !record?.dependsOn || dependencyNow === record.dependsStat;
  if (
    record &&
    sameVersion &&
    dependencyUnchanged &&
    record.modifiedMs === stat.mtimeMs &&
    record.sizeBytes === stat.size
  ) {
    return 'skipped';
  }

  if (
    record &&
    sameVersion &&
    dependencyUnchanged &&
    (record.status === 'indexed' || record.status === 'empty') &&
    record.tailState !== null &&
    (await unchangedBeforeOffset(filePath, record, stat.size))
  ) {
    if (await indexIncrementally(store, source, filePath, stat, record)) return 'incremental';
  }

  await indexFully(store, source, filePath, stat);
  return 'full';
}

async function indexIncrementally(
  store: UsageStore,
  source: SessionSource,
  filePath: string,
  stat: fs.Stats,
  record: LocalFileRecord
): Promise<boolean> {
  let parser: ResumableParser;
  try {
    parser = source.createParser(filePath, JSON.parse(record.tailState!) as unknown);
  } catch {
    return false;
  }
  const identity = parser.identity();
  const { offset, state } = await feedFile(filePath, record.tailOffset!, parser);
  const output = await parser.finish();
  // Anything that rewrites rows produced earlier needs the full picture.
  if (parser.identity() !== identity) return false;
  if (output.parts !== null && output.parts.length === 0) return false;
  if (record.status === 'indexed' && output.parts === null) return false;
  const dependsOn = output.dependsOn ?? null;
  store.applyFileIndex(filePath, {
    mode: 'incremental',
    parts: output.parts,
    metadata: output.metadata,
    file: {
      modifiedMs: stat.mtimeMs,
      sizeBytes: stat.size,
      parserVersion: source.parserVersion,
      status: output.parts === null ? 'empty' : 'indexed',
      tailOffset: offset,
      tailState: JSON.stringify(state),
      ...(await fileFingerprint(filePath, offset)),
      dependsOn,
      dependsStat: dependsOn ? await statSignature(dependsOn) : null
    }
  });
  return true;
}

async function indexFully(store: UsageStore, source: SessionSource, filePath: string, stat: fs.Stats): Promise<void> {
  const parser = source.createParser(filePath);
  const { offset, state } = await feedFile(filePath, 0, parser);
  const output = await parser.finish();
  const superseded = output.parts !== null && output.parts.length === 0;
  const dependsOn = output.dependsOn ?? null;
  store.applyFileIndex(filePath, {
    mode: 'full',
    parts: output.parts,
    candidatePartIds: source.candidatePartIds(filePath),
    metadata: output.metadata,
    file: {
      modifiedMs: stat.mtimeMs,
      sizeBytes: stat.size,
      parserVersion: source.parserVersion,
      status: superseded ? 'superseded' : output.parts === null ? 'empty' : 'indexed',
      // A superseded file is always parsed in full if it changes again.
      tailOffset: superseded ? null : offset,
      tailState: superseded ? null : JSON.stringify(state),
      ...(superseded
        ? { headLength: null, headHash: null, anchorHash: null }
        : await fileFingerprint(filePath, offset)),
      dependsOn,
      dependsStat: dependsOn ? await statSignature(dependsOn) : null
    }
  });
}

async function indexFiles(store: UsageStore, source: SessionSource, files: string[]): Promise<ScanResult> {
  const result: ScanResult = { scanned: files.length, updated: 0, errors: 0, incremental: 0, full: 0 };
  for (const filePath of files) {
    try {
      const outcome = await indexSessionFile(store, source, filePath);
      if (outcome === 'incremental') result.incremental += 1;
      if (outcome === 'full') result.full += 1;
      if (outcome === 'incremental' || outcome === 'full') result.updated += 1;
    } catch (error) {
      result.errors += 1;
      console.warn(`Failed to index ${source.label} session ${filePath}:`, (error as Error).message);
    }
  }
  return result;
}

/** Scan every file the source lists. Unchanged files cost one stat call. */
export async function scanAllSessions(store: UsageStore, source: SessionSource): Promise<ScanResult> {
  return indexFiles(store, source, await source.listFiles());
}

export interface SessionScannerOptions {
  store: UsageStore;
  source: SessionSource;
  /** Watch the source's folders and index changed files right away. */
  watch: boolean;
  /** Called after every scan that ran. */
  onScanned?: (result: ScanResult, kind: 'full' | 'targeted') => void;
  watchDebounceMs?: number;
}

export interface SessionScanner {
  /** Scan every file (the periodic safety net). */
  fullScan(): Promise<void>;
  /** Index specific files now, plus any file whose indexing depends on them. */
  scanFiles(paths: string[]): Promise<void>;
  /** Start of the most recent completed full scan, unix seconds. */
  lastFullScanStartedAt(): number | null;
  watching(): boolean;
  stop(): void;
}

/**
 * Change-driven indexing with a periodic safety net: file-system events index
 * the changed transcripts within a second or two, and the caller's slower
 * `fullScan()` catches anything a notification missed. Scans never overlap.
 */
export function createSessionScanner(options: SessionScannerOptions): SessionScanner {
  const { store, source } = options;
  let running: Promise<void> | null = null;
  let fullRequested = false;
  const requestedFiles = new Set<string>();
  let lastFull: number | null = null;
  let watcher: DirectoryWatcher | null = null;
  let stopped = false;

  function ensureWatcher(): void {
    if (!options.watch || stopped) return;
    const roots = source.watchRoots().filter((root) => fs.existsSync(root));
    if (watcher && watcher.roots.length === roots.length && watcher.active) return;
    watcher?.close();
    watcher = watchDirectories(roots, {
      debounceMs: options.watchDebounceMs,
      onPaths: (paths) => void scanFiles(paths),
      onOverflow: () => void fullScan()
    });
  }

  async function drain(): Promise<void> {
    while (!stopped && (fullRequested || requestedFiles.size > 0)) {
      if (fullRequested) {
        fullRequested = false;
        requestedFiles.clear();
        const startedAt = Math.floor(Date.now() / 1000);
        const result = await scanAllSessions(store, source);
        lastFull = startedAt;
        ensureWatcher();
        options.onScanned?.(result, 'full');
      } else {
        const accepted = [...requestedFiles].filter((file) => source.accepts(file));
        requestedFiles.clear();
        const files = [...new Set([...accepted, ...store.filesDependingOn(accepted)])];
        if (files.length === 0) continue;
        const result = await indexFiles(store, source, files);
        options.onScanned?.(result, 'targeted');
      }
    }
  }

  function schedule(): Promise<void> {
    running ??= drain().finally(() => {
      running = null;
    });
    return running;
  }

  function fullScan(): Promise<void> {
    fullRequested = true;
    return schedule();
  }

  function scanFiles(paths: string[]): Promise<void> {
    for (const file of paths) requestedFiles.add(path.resolve(file));
    return schedule();
  }

  return {
    fullScan,
    scanFiles,
    lastFullScanStartedAt: () => lastFull,
    watching: () => watcher?.active ?? false,
    stop() {
      stopped = true;
      watcher?.close();
      watcher = null;
    }
  };
}
