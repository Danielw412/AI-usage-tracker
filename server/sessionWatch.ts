import fs from 'node:fs';
import path from 'node:path';
import { debugEnabled } from './providers.js';

export interface DirectoryWatcher {
  readonly roots: string[];
  /** False once every watcher failed; the periodic scan then does all the work. */
  readonly active: boolean;
  close(): void;
}

export interface WatchOptions {
  /** Changed files, collected over a short quiet period. */
  onPaths: (paths: string[]) => void;
  /** The platform reported a change without a file name; rescan everything. */
  onOverflow: () => void;
  /** Quiet period before reporting. Defaults to 750 ms. */
  debounceMs?: number;
  /** Report at least this often while changes keep arriving. Defaults to 4 s. */
  maxWaitMs?: number;
}

/**
 * Recursive file-system notifications for session folders. Notifications are
 * only a hint: they can be dropped, coalesced, or unsupported on a platform, so
 * callers keep a periodic full scan as the source of truth.
 */
export function watchDirectories(roots: string[], options: WatchOptions): DirectoryWatcher {
  const debounceMs = options.debounceMs ?? 750;
  const maxWaitMs = options.maxWaitMs ?? 4_000;
  const watchers: fs.FSWatcher[] = [];
  const pending = new Set<string>();
  let overflow = false;
  let timer: NodeJS.Timeout | null = null;
  let firstPendingAt = 0;
  let closed = false;

  function flush(): void {
    timer = null;
    if (closed) return;
    const paths = [...pending];
    pending.clear();
    if (overflow) {
      overflow = false;
      options.onOverflow();
    } else if (paths.length > 0) {
      options.onPaths(paths);
    }
  }

  function schedule(): void {
    const now = Date.now();
    if (!timer) firstPendingAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - now));
    timer = setTimeout(flush, wait);
    timer.unref();
  }

  for (const root of roots) {
    try {
      const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) overflow = true;
        else pending.add(path.join(root, filename.toString()));
        schedule();
      });
      watcher.on('error', (error) => {
        if (debugEnabled()) console.warn(`Stopped watching ${root}:`, error.message);
        watcher.close();
        const index = watchers.indexOf(watcher);
        if (index >= 0) watchers.splice(index, 1);
      });
      watchers.push(watcher);
    } catch (error) {
      // Recursive watching is unavailable on some platforms and file systems.
      if (debugEnabled()) console.warn(`Cannot watch ${root}:`, (error as Error).message);
    }
  }

  return {
    roots,
    get active() {
      return !closed && watchers.length > 0;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    }
  };
}
