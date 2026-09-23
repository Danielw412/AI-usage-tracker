import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { readLocalThreadMetadata } from './localThreadMetadata.js';

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export class AppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private starting: Promise<void> | null = null;
  private lastError: string | null = null;
  private localTitleCache = new Map<string, string>();
  private localTitleCacheAt = 0;

  get connected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  get error(): string | null {
    return this.lastError;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;

    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const binary = process.env.CODEX_BIN || 'codex';
    const args = ['app-server', '--listen', 'stdio://'];
    this.lastError = null;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32'
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A bare "spawn EPERM" means this process may not launch programs at all,
      // which is what happens when an agent's sandboxed shell started the tracker.
      this.lastError = code === 'EPERM' || code === 'EACCES'
        ? `This tracker process is not allowed to launch ${binary} (${code}). It was probably started from a sandboxed agent shell; restart it with the "AI Usage Tracker" scheduled task or scripts/start-ai-usage-tracker.ps1.`
        : (error as Error).message;
      throw new Error(this.lastError);
    }
    this.process = child;

    const output = readline.createInterface({ input: child.stdout });
    output.on('line', (line) => this.handleLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) this.emit('diagnostic', message);
    });

    child.on('error', (error) => {
      if (this.process !== child) return;
      this.lastError = error.message;
      this.rejectAll(error);
      this.process = null;
      this.emit('disconnect', error);
    });

    child.on('exit', (code, signal) => {
      // A replaced app-server exiting late must not tear down its successor.
      if (this.process !== child) return;
      const error = new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})`);
      this.lastError = error.message;
      this.rejectAll(error);
      this.process = null;
      this.emit('disconnect', error);
    });

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'ai_usage_tracker',
          title: 'AI Usage Tracker',
          version: '0.1.0'
        },
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: [
            'thread/started',
            'item/agentMessage/delta',
            'item/reasoning/summaryTextDelta'
          ]
        }
      });
    } catch (error) {
      // Left running, an app-server that never initialized looks connected and
      // rejects every later request, so drop it and let the next poll start fresh.
      if (this.process === child) this.stop();
      throw error;
    }
    this.notify('initialized', {});
  }

  async request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.process) {
      throw new Error('Codex app-server is not running');
    }

    const id = this.nextId++;
    const message: RpcMessage = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.process) return;
    const message: RpcMessage = { method };
    if (params !== undefined) message.params = params;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.rejectAll(new Error('Codex app-server stopped'));
  }

  private getLocalThreadTitles(): Map<string, string> {
    const now = Date.now();
    if (now - this.localTitleCacheAt < 5_000) return this.localTitleCache;

    this.localTitleCache = new Map(
      readLocalThreadMetadata().flatMap((item) =>
        item.displayName ? [[item.threadId, item.displayName] as const] : []
      )
    );
    this.localTitleCacheAt = now;
    return this.localTitleCache;
  }

  private enrichThreadListResult(result: unknown): unknown {
    if (!isRecord(result) || !Array.isArray(result.data)) return result;
    const localTitles = this.getLocalThreadTitles();
    if (localTitles.size === 0) return result;

    return {
      ...result,
      data: result.data.map((value) => {
        if (!isRecord(value)) return value;
        const threadId = firstString(value, ['id', 'threadId', 'thread_id']);
        const localName = threadId ? localTitles.get(threadId) : null;
        if (!localName || firstString(value, ['name', 'threadName', 'displayName'])) return value;
        return { ...value, name: localName };
      })
    };
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit('diagnostic', `Ignored non-JSON app-server output: ${line}`);
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Unknown Codex RPC error'));
      } else {
        pending.resolve(
          pending.method === 'thread/list'
            ? this.enrichThreadListResult(message.result)
            : message.result
        );
      }
      return;
    }

    if (message.method) {
      this.emit('notification', message.method, message.params);
      this.emit(message.method, message.params);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
