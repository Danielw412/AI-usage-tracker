import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { StoredThreadEvent, ThreadMetadataInput, UsageStore } from '../db.js';
import { estimateUsageCost, findPricing, normalizeModelName } from '../pricing.js';
import {
  feedFile,
  listFilesRecursive,
  scanAllSessions,
  type ParseOutput,
  type ParsedSessionPart,
  type ResumableParser,
  type ScanResult,
  type SessionSource
} from '../sessionScan.js';
import type {
  PricingStatus,
  PromptMetric,
  SessionPartKind,
  ThreadPartSummary,
  ThreadSource,
  TokenUsage
} from '../types.js';
import { cleanClaudePrompt, extractClaudePromptText } from './messageText.js';
import { claudeProjectsDir } from './paths.js';

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bump when parsing changes so every transcript is indexed again. */
export const CLAUDE_PARSER_VERSION = '4';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return 0;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return null;
}

function text(value: unknown, maxLength = 300): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function defaultUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite1hInputTokens: 0
  };
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
  target.cacheWriteInputTokens = (target.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
  target.cacheWrite1hInputTokens = (target.cacheWrite1hInputTokens ?? 0) + (usage.cacheWrite1hInputTokens ?? 0);
}

/**
 * Map an assistant message's `usage` block onto the dashboard's token model.
 * Claude reports uncached input, cache writes, and cache reads separately;
 * `inputTokens` is their sum so it stays comparable with other providers.
 */
export function usageFromClaudeMessage(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) return null;
  const input = toNumber(usage.input_tokens);
  const cacheWrite = toNumber(usage.cache_creation_input_tokens);
  const cacheRead = toNumber(usage.cache_read_input_tokens);
  const output = toNumber(usage.output_tokens);
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  const thinking = toNumber(details?.thinking_tokens);
  const creation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  const oneHour = toNumber(creation?.ephemeral_1h_input_tokens);
  const inputTokens = input + cacheWrite + cacheRead;
  if (inputTokens + output === 0) return null;
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    cacheWrite1hInputTokens: Math.min(oneHour, cacheWrite),
    outputTokens: output,
    reasoningOutputTokens: Math.min(thinking, output),
    totalTokens: inputTokens + output
  };
}

/** Where a Claude Code session was started from. */
export function classifyClaudeEntrypoint(
  entrypoint: string | null,
  sessionKind: string | null,
  bridged = false
): { source: ThreadSource; sourceLabel: string | null } {
  const raw = (entrypoint ?? '').toLowerCase();
  let source: ThreadSource = 'unknown';
  let sourceLabel: string | null = null;
  if (raw === 'cli') source = 'cli';
  else if (raw.includes('desktop') || raw.includes('cowork')) source = 'desktop';
  else if (raw.includes('sdk')) {
    source = 'exec';
    sourceLabel = 'SDK';
  } else if (raw.includes('vscode') || raw.includes('jetbrains') || raw.includes('ide') || raw.includes('cursor')) {
    source = 'ide';
  } else if (raw.includes('mcp')) {
    source = 'exec';
    sourceLabel = 'MCP';
  } else if (raw) {
    source = 'cli';
    sourceLabel = entrypoint;
  }
  if (sessionKind === 'bg' && !sourceLabel) sourceLabel = 'Background';
  if (bridged && !sourceLabel) sourceLabel = 'Remote Control';
  return { source, sourceLabel };
}

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter(Boolean);
}

/**
 * A transcript's path under Claude's `projects` folder (`<project>/<session>.jsonl`,
 * or deeper for subagent files). It does not depend on where the config folder
 * lives, so it identifies the part on every device and across migrations.
 */
export function claudePartId(sourceFile: string): string {
  const segments = pathSegments(sourceFile);
  const index = segments.lastIndexOf('projects');
  const relative = index >= 0 && index < segments.length - 1 ? segments.slice(index + 1) : segments.slice(-1);
  return relative.join('/');
}

/** Part id for a row written before multi-device tracking (keyed by path). */
export function claudeLegacyPartId(sourceFile: string): string {
  return sourceFile.endsWith('#sidechain')
    ? `${claudePartId(sourceFile.slice(0, -'#sidechain'.length))}#sidechain`
    : claudePartId(sourceFile);
}

interface PromptAccumulator extends PromptMetric {
  /** Line the prompt started on; with the thread id it identifies the prompt. */
  line: number;
  firstTokenAt: number | null;
  modelTokens: Map<string, number>;
  totalCost: number;
  pricedEvents: number;
  hasUnpriced: boolean;
}

type SerializedPrompt = Omit<PromptAccumulator, 'modelTokens'> & { modelTokens: Array<[string, number]> };

interface PartState {
  totals: TokenUsage;
  modelTokens: Array<[string, number]>;
  models: string[];
  seenMessageIds: string[];
  totalCost: number;
  pricedEvents: number;
  eventCount: number;
  startedAt: number | null;
  updatedAt: number | null;
  firstPrompt: string | null;
  userMessageCount: number;
  promptSequence: number;
  promptsInTurn: number;
  activePrompt: SerializedPrompt | null;
  lastEventAt: number | null;
}

type PendingEvent = StoredThreadEvent & { messageId: string };

/** Everything gathered for one session part (main conversation or subagent work). */
class PartAccumulator {
  /** Produced since the parser was created or restored. */
  readonly events: PendingEvent[] = [];
  readonly prompts: Array<{ metric: PromptMetric; line: number }> = [];
  totals = defaultUsage();
  readonly modelTokens = new Map<string, number>();
  readonly models = new Set<string>();
  /** Streaming writes one record per content block; only the first counts. */
  readonly seenMessageIds = new Set<string>();
  totalCost = 0;
  pricedEvents = 0;
  eventCount = 0;
  startedAt: number | null = null;
  updatedAt: number | null = null;
  firstPrompt: string | null = null;
  userMessageCount = 0;
  private promptSequence = 0;
  private promptsInTurn = 0;
  private activePrompt: PromptAccumulator | null = null;
  private lastEventAt: number | null = null;

  constructor(readonly sourceFile: string, readonly partKind: SessionPartKind) {}

  toState(): PartState {
    return {
      totals: { ...this.totals },
      modelTokens: [...this.modelTokens.entries()],
      models: [...this.models],
      seenMessageIds: [...this.seenMessageIds],
      totalCost: this.totalCost,
      pricedEvents: this.pricedEvents,
      eventCount: this.eventCount,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      firstPrompt: this.firstPrompt,
      userMessageCount: this.userMessageCount,
      promptSequence: this.promptSequence,
      promptsInTurn: this.promptsInTurn,
      activePrompt: this.activePrompt
        ? { ...this.activePrompt, modelTokens: [...this.activePrompt.modelTokens.entries()] }
        : null,
      lastEventAt: this.lastEventAt
    };
  }

  restore(state: PartState): void {
    this.totals = { ...state.totals };
    for (const [model, tokens] of state.modelTokens) this.modelTokens.set(model, tokens);
    for (const model of state.models) this.models.add(model);
    for (const id of state.seenMessageIds) this.seenMessageIds.add(id);
    this.totalCost = state.totalCost;
    this.pricedEvents = state.pricedEvents;
    this.eventCount = state.eventCount;
    this.startedAt = state.startedAt;
    this.updatedAt = state.updatedAt;
    this.firstPrompt = state.firstPrompt;
    this.userMessageCount = state.userMessageCount;
    this.promptSequence = state.promptSequence;
    this.promptsInTurn = state.promptsInTurn;
    this.activePrompt = state.activePrompt
      ? { ...state.activePrompt, modelTokens: new Map(state.activePrompt.modelTokens) }
      : null;
    this.lastEventAt = state.lastEventAt;
  }

  touch(timestamp: number): void {
    this.startedAt = this.startedAt === null ? timestamp : Math.min(this.startedAt, timestamp);
    this.updatedAt = this.updatedAt === null ? timestamp : Math.max(this.updatedAt, timestamp);
  }

  /** Nothing ever indexed from this part (across every pass, not just this one). */
  get isEmpty(): boolean {
    return this.eventCount === 0 && this.promptSequence === 0;
  }

  startPrompt(prompt: string, timestamp: number | null, turnId: string | null, lineNumber: number): void {
    // A new prompt ends the previous turn; timing then comes from the last response.
    const previousTurn = this.activePrompt?.turnId ?? null;
    this.finalizePrompt(this.lastEventAt ?? timestamp, null);
    this.promptsInTurn = previousTurn !== null && previousTurn === turnId ? this.promptsInTurn + 1 : 1;
    const startedAt = timestamp ?? this.updatedAt ?? Math.floor(Date.now() / 1000);
    this.activePrompt = {
      promptId: '',
      line: lineNumber,
      sourceFile: this.sourceFile,
      threadId: '',
      turnId,
      sequence: 0,
      prompt,
      startedAt,
      completedAt: null,
      durationMs: null,
      timeToFirstTokenMs: null,
      timingEstimated: true,
      primaryModel: 'unknown',
      models: [],
      ...defaultUsage(),
      estimatedApiCostUsd: null,
      pricingStatus: 'unknown',
      firstTokenAt: null,
      modelTokens: new Map<string, number>(),
      totalCost: 0,
      pricedEvents: 0,
      hasUnpriced: false
    };
  }

  addEvent(observedAt: number, model: string, usage: TokenUsage, messageId: string): void {
    this.seenMessageIds.add(messageId);
    this.lastEventAt = observedAt;
    const cost = estimateUsageCost(model, usage, observedAt);
    this.events.push({
      eventKey: '',
      messageId,
      threadId: '',
      sourceFile: this.sourceFile,
      observedAt,
      model,
      ...usage,
      estimatedApiCostUsd: cost
    });
    this.eventCount += 1;
    addUsage(this.totals, usage);
    this.models.add(model);
    this.modelTokens.set(model, (this.modelTokens.get(model) ?? 0) + usage.totalTokens);
    if (cost !== null) {
      this.totalCost += cost;
      this.pricedEvents += 1;
    }
    const prompt = this.activePrompt;
    if (prompt) {
      addUsage(prompt, usage);
      prompt.firstTokenAt ??= observedAt;
      prompt.modelTokens.set(model, (prompt.modelTokens.get(model) ?? 0) + usage.totalTokens);
      if (cost === null) prompt.hasUnpriced = true;
      else {
        prompt.totalCost += cost;
        prompt.pricedEvents += 1;
      }
    }
  }

  /**
   * Close the active prompt. A prompt that never produced an API response (a
   * local slash command, an interrupted turn) is dropped rather than counted.
   */
  finalizePrompt(completedAt: number | null, reportedDurationMs: number | null): void {
    const prompt = this.activePrompt;
    if (!prompt) return;
    this.activePrompt = null;
    if (prompt.modelTokens.size === 0) return;

    this.promptSequence += 1;
    this.userMessageCount += 1;
    this.firstPrompt ??= prompt.prompt.slice(0, 120);
    const derived = completedAt === null ? null : Math.max(0, (completedAt - prompt.startedAt) * 1000);
    const useReported = reportedDurationMs !== null && this.promptsInTurn === 1;
    prompt.sequence = this.promptSequence;
    prompt.completedAt = completedAt;
    prompt.durationMs = useReported ? reportedDurationMs : derived;
    prompt.timingEstimated = !useReported;
    prompt.timeToFirstTokenMs = prompt.firstTokenAt === null
      ? null
      : Math.max(0, (prompt.firstTokenAt - prompt.startedAt) * 1000);
    prompt.primaryModel = [...prompt.modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    prompt.models = [...prompt.modelTokens.keys()];
    prompt.estimatedApiCostUsd = prompt.pricedEvents > 0 ? prompt.totalCost : null;
    prompt.pricingStatus = prompt.pricedEvents === 0 ? 'unknown' : prompt.hasUnpriced ? 'partial' : 'exact-model-match';
    const {
      line,
      firstTokenAt: _firstTokenAt,
      modelTokens: _modelTokens,
      totalCost: _totalCost,
      pricedEvents: _pricedEvents,
      hasUnpriced: _hasUnpriced,
      ...stored
    } = prompt;
    this.prompts.push({ metric: stored, line });
  }

  primaryModel(): string {
    return [...this.modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  }

  pricingStatus(): PricingStatus {
    if (this.pricedEvents === 0) return 'unknown';
    const unknown = [...this.models].some((model) => findPricing(model) === null);
    return unknown ? 'partial' : 'exact-model-match';
  }

  /** Give this pass's events and prompts their final ids. */
  assignIds(threadId: string): { events: StoredThreadEvent[]; prompts: PromptMetric[] } {
    const events = this.events.map(({ messageId, ...event }) => ({
      ...event,
      threadId,
      // The API message id is unique, so the same response keeps one id on
      // every device and in every copy of the transcript.
      eventKey: crypto.createHash('sha1').update(`claude:${threadId}:${messageId}`).digest('hex')
    }));
    const prompts = this.prompts.map(({ metric, line }) => ({
      ...metric,
      threadId,
      promptId: crypto.createHash('sha1').update(`claude:${threadId}:${line}:${metric.prompt}`).digest('hex')
    }));
    return { events, prompts };
  }
}

export interface ClaudeThreadMetadata {
  threadId: string;
  /** `/rename` title, else the title Claude Code generated; never a raw prompt. */
  displayName: string | null;
  updatedAt: number;
  source: ThreadSource;
  sourceLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  gitBranch: string | null;
  projectName: string | null;
}

export interface ClaudeParsedPart extends ParsedSessionPart {
  metadata?: ClaudeThreadMetadata;
}

function projectNameFromPath(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const parts = projectPath.replace(/^\\\\\?\\/, '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

/** `<project>/<session>/subagents/agent-x.jsonl` belongs to `<session>`. */
function parentSessionFromPath(sourceFile: string): string | null {
  const segments = path.resolve(sourceFile).split(/[\\/]/);
  const subagentsIndex = segments.lastIndexOf('subagents');
  if (subagentsIndex > 0 && UUID_PATTERN.test(segments[subagentsIndex - 1])) return segments[subagentsIndex - 1];
  const parent = segments.at(-2);
  if (path.basename(sourceFile).startsWith('agent-') && parent && UUID_PATTERN.test(parent)) return parent;
  return null;
}

async function fileContainsAny(file: string, needles: string[]): Promise<boolean> {
  if (needles.length === 0) return false;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (needles.some((needle) => line.includes(needle))) return true;
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** File-level fields of the saved parser state. */
interface ClaudeParserState {
  version: string;
  lineNumber: number;
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  entrypoint: string | null;
  sessionKind: string | null;
  bridged: boolean;
  aiTitle: string | null;
  customTitle: string | null;
  reportedCostUsd: number | null;
  continuedInto: string | null;
  lastUuid: string | null;
  lastMessageId: string | null;
  updatedAt: number | null;
  effortCounts: Array<[string, number]>;
  main: PartState;
  side: PartState;
}

/**
 * Resumable parser for one Claude Code transcript. The main conversation
 * becomes a `main` part; sidechain records (subagents logged inline) become a
 * `subagent` part with the same thread id; files under `subagents/` are
 * subagent parts of their parent session.
 *
 * A file that was continued into another session whose transcript already
 * contains every record of this one is reported as superseded, so the copy is
 * not counted twice.
 */
export class ClaudeTranscriptParser implements ResumableParser {
  private readonly parentSession: string | null;
  private readonly isSubagentFile: boolean;
  private readonly partId: string;
  private readonly main: PartAccumulator;
  private readonly side: PartAccumulator;
  private lineNumber = 0;
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private gitBranch: string | null = null;
  private entrypoint: string | null = null;
  private sessionKind: string | null = null;
  private bridged = false;
  private aiTitle: string | null = null;
  private customTitle: string | null = null;
  private reportedCostUsd: number | null = null;
  private continuedInto: string | null = null;
  private lastUuid: string | null = null;
  private lastMessageId: string | null = null;
  private updatedAt: number | null = null;
  private readonly effortCounts = new Map<string, number>();

  constructor(readonly sourceFile: string, state?: unknown) {
    this.parentSession = parentSessionFromPath(sourceFile);
    this.isSubagentFile = this.parentSession !== null || path.basename(sourceFile).startsWith('agent-');
    this.partId = claudePartId(sourceFile);
    this.main = new PartAccumulator(sourceFile, this.isSubagentFile ? 'subagent' : 'main');
    this.side = new PartAccumulator(`${sourceFile}#sidechain`, 'subagent');
    if (state !== undefined) this.restore(state);
  }

  private restore(raw: unknown): void {
    const state = raw as ClaudeParserState;
    if (!state || typeof state !== 'object' || state.version !== CLAUDE_PARSER_VERSION) {
      throw new Error('Saved Claude parser state is from another parser version');
    }
    this.lineNumber = state.lineNumber;
    this.sessionId = state.sessionId;
    this.cwd = state.cwd;
    this.gitBranch = state.gitBranch;
    this.entrypoint = state.entrypoint;
    this.sessionKind = state.sessionKind;
    this.bridged = state.bridged;
    this.aiTitle = state.aiTitle;
    this.customTitle = state.customTitle;
    this.reportedCostUsd = state.reportedCostUsd;
    this.continuedInto = state.continuedInto;
    this.lastUuid = state.lastUuid;
    this.lastMessageId = state.lastMessageId;
    this.updatedAt = state.updatedAt;
    for (const [effort, count] of state.effortCounts) this.effortCounts.set(effort, count);
    this.main.restore(state.main);
    this.side.restore(state.side);
  }

  snapshot(): ClaudeParserState {
    return {
      version: CLAUDE_PARSER_VERSION,
      lineNumber: this.lineNumber,
      sessionId: this.sessionId,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      entrypoint: this.entrypoint,
      sessionKind: this.sessionKind,
      bridged: this.bridged,
      aiTitle: this.aiTitle,
      customTitle: this.customTitle,
      reportedCostUsd: this.reportedCostUsd,
      continuedInto: this.continuedInto,
      lastUuid: this.lastUuid,
      lastMessageId: this.lastMessageId,
      updatedAt: this.updatedAt,
      effortCounts: [...this.effortCounts.entries()],
      main: this.main.toState(),
      side: this.side.toState()
    };
  }

  private threadId(): string {
    const baseName = path.basename(this.sourceFile, '.jsonl');
    return (
      this.parentSession ??
      (UUID_PATTERN.test(baseName) ? baseName : null) ??
      this.sessionId ??
      crypto.createHash('sha1').update(this.partId).digest('hex')
    );
  }

  identity(): string {
    return `${this.threadId()}|${this.main.partKind}`;
  }

  feed(line: string): void {
    this.lineNumber += 1;
    if (!line.trim()) return;
    let record: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) return;
      record = parsed;
    } catch {
      return;
    }
    const { main, side } = this;

    const type = typeof record.type === 'string' ? record.type : '';
    const timestamp = parseTimestamp(record.timestamp);
    const sidechain = !this.isSubagentFile && (record.isSidechain === true || typeof record.agentId === 'string');
    const part = sidechain ? side : main;
    if (timestamp !== null) {
      part.touch(timestamp);
      this.updatedAt = this.updatedAt === null ? timestamp : Math.max(this.updatedAt, timestamp);
    }
    // Records written after the continuation marker were never copied, so the
    // last uuid before it is what the continuation file must contain.
    if (typeof record.uuid === 'string' && this.continuedInto === null) this.lastUuid = record.uuid;
    if (!sidechain) {
      this.sessionId ??= text(record.sessionId, 100);
      this.cwd ??= text(record.cwd, 500);
      const branch = text(record.gitBranch, 200);
      if (branch && branch !== 'HEAD') this.gitBranch = branch;
      this.entrypoint ??= text(record.entrypoint, 60);
      if (record.sessionKind === 'bg') this.sessionKind = 'bg';
    }

    switch (type) {
      case 'user': {
        if (part.partKind !== 'main' || record.isMeta === true || record.isCompactSummary === true) break;
        const message = isRecord(record.message) ? record.message : null;
        if (!message || (message.role !== undefined && message.role !== 'user')) break;
        const raw = extractClaudePromptText(message.content);
        if (!raw) break;
        const cleaned = cleanClaudePrompt(raw);
        if (!cleaned) break;
        const turnId = text(record.promptId, 100) ?? text(record.uuid, 100);
        part.startPrompt(cleaned, timestamp, turnId, this.lineNumber);
        break;
      }
      case 'assistant': {
        if (record.isApiErrorMessage === true) break;
        const message = isRecord(record.message) ? record.message : null;
        if (!message) break;
        const rawModel = text(message.model, 100);
        if (!rawModel || rawModel === '<synthetic>') break;
        const model = normalizeModelName(rawModel);
        const messageId = text(message.id, 120) ?? text(record.requestId, 120) ?? text(record.uuid, 120);
        if (!messageId || part.seenMessageIds.has(messageId)) break;
        if (this.continuedInto === null && !sidechain && typeof message.id === 'string') {
          this.lastMessageId = message.id;
        }
        // Streaming writes one record per content block, all carrying the full usage.
        const usage = usageFromClaudeMessage(message.usage);
        if (!usage) {
          part.seenMessageIds.add(messageId);
          break;
        }
        part.addEvent(timestamp ?? part.updatedAt ?? Math.floor(Date.now() / 1000), model, usage, messageId);
        if (!sidechain && typeof record.effort === 'string') {
          this.effortCounts.set(record.effort, (this.effortCounts.get(record.effort) ?? 0) + 1);
        }
        break;
      }
      case 'system': {
        if (record.subtype === 'turn_duration' && !sidechain) {
          main.finalizePrompt(timestamp ?? main.updatedAt, toFiniteNumber(record.durationMs));
        }
        break;
      }
      case 'ai-title':
        this.aiTitle = text(record.aiTitle, 200) ?? this.aiTitle;
        break;
      case 'custom-title':
        this.customTitle = text(record.customTitle, 200) ?? this.customTitle;
        break;
      case 'cost-state': {
        const cost = toFiniteNumber(record.totalCostUSD);
        if (cost !== null && cost > 0) this.reportedCostUsd = cost;
        break;
      }
      case 'continued-in':
        this.continuedInto = text(record.continuedInSessionId, 100);
        break;
      case 'bridge-session':
        this.bridged = true;
        break;
      default:
        break;
    }
  }

  private continuationPath(): string | null {
    if (!this.continuedInto) return null;
    const continuation = path.join(path.dirname(this.sourceFile), `${this.continuedInto}.jsonl`);
    return continuation === this.sourceFile ? null : continuation;
  }

  private async superseded(): Promise<boolean> {
    const continuation = this.continuationPath();
    if (!continuation || !(this.lastMessageId || this.lastUuid) || !fs.existsSync(continuation)) return false;
    // The copy keeps API message ids even where it rewrites record uuids, so the
    // last assistant message is the reliable marker; the last uuid is a fallback.
    const needles = [
      ...(this.lastMessageId ? [`"id":"${this.lastMessageId}"`] : []),
      ...(this.lastUuid ? [`"uuid":"${this.lastUuid}"`] : [])
    ];
    try {
      return await fileContainsAny(continuation, needles);
    } catch {
      // If the continuation cannot be read, keep this file's data.
      return false;
    }
  }

  /**
   * Parts as of the last line fed. `[]` when the file is superseded or has
   * nothing to index (see `finish()` for the distinction).
   */
  async parts(): Promise<{ parts: ClaudeParsedPart[]; superseded: boolean }> {
    const { main, side } = this;
    main.finalizePrompt(main.updatedAt, null);
    side.finalizePrompt(side.updatedAt, null);
    if (await this.superseded()) return { parts: [], superseded: true };
    if (main.isEmpty && side.isEmpty) return { parts: [], superseded: false };

    const threadId = this.threadId();
    const classified = classifyClaudeEntrypoint(this.entrypoint, this.sessionKind, this.bridged);
    const source: ThreadSource = this.isSubagentFile ? 'subagent' : classified.source;
    const sourceLabel = this.isSubagentFile ? null : classified.sourceLabel;
    const reasoningEffort = [...this.effortCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const parts: ClaudeParsedPart[] = [];
    const buildSummary = (part: PartAccumulator, kind: SessionPartKind, partId: string): ThreadPartSummary => ({
      threadId,
      partId,
      title: kind === 'main' ? part.firstPrompt : null,
      projectPath: this.cwd,
      startedAt: part.startedAt,
      updatedAt: part.updatedAt,
      primaryModel: part.primaryModel(),
      models: [...part.models],
      ...part.totals,
      estimatedApiCostUsd: part.pricedEvents > 0 ? part.totalCost : null,
      pricingStatus: part.pricingStatus(),
      sourceFile: part.sourceFile,
      partKind: kind,
      userMessageCount: kind === 'main' ? part.userMessageCount : 0,
      source: kind === 'main' ? source : 'subagent',
      sourceLabel: kind === 'main' ? sourceLabel : null,
      reportedCostUsd: kind === 'main' ? this.reportedCostUsd : null
    });

    if (!main.isEmpty) {
      const { events, prompts } = main.assignIds(threadId);
      const summary = buildSummary(main, main.partKind, this.partId);
      const metadata: ClaudeThreadMetadata | undefined = main.partKind === 'main'
        ? {
            threadId,
            displayName: this.customTitle ?? this.aiTitle,
            updatedAt: this.updatedAt ?? Math.floor(Date.now() / 1000),
            source,
            sourceLabel,
            model: summary.primaryModel === 'unknown' ? null : summary.primaryModel,
            reasoningEffort,
            gitBranch: this.gitBranch,
            projectName: projectNameFromPath(this.cwd)
          }
        : undefined;
      parts.push({ summary, events, prompts, metadata });
    }
    if (!side.isEmpty) {
      const { events } = side.assignIds(threadId);
      parts.push({ summary: buildSummary(side, 'subagent', `${this.partId}#sidechain`), events, prompts: [] });
    }
    return { parts, superseded: false };
  }

  async finish(): Promise<ParseOutput> {
    const { parts, superseded } = await this.parts();
    const metadata: ThreadMetadataInput[] = parts.flatMap((part) => (part.metadata
      ? [{
          threadId: part.metadata.threadId,
          displayName: part.metadata.displayName,
          preview: null,
          updatedAt: part.metadata.updatedAt,
          source: part.metadata.source,
          sourceLabel: part.metadata.sourceLabel,
          model: part.metadata.model,
          reasoningEffort: part.metadata.reasoningEffort,
          gitBranch: part.metadata.gitBranch,
          projectName: part.metadata.projectName
        }]
      : []));
    return {
      parts: superseded ? [] : parts.length === 0 ? null : parts,
      metadata,
      dependsOn: this.continuationPath()
    };
  }
}

/**
 * Parse a whole transcript. Returns `[]` when the file is superseded by its
 * continuation or has nothing to index.
 */
export async function parseClaudeTranscript(sourceFile: string): Promise<ClaudeParsedPart[]> {
  const parser = new ClaudeTranscriptParser(sourceFile);
  await feedFile(sourceFile, 0, parser);
  return (await parser.parts()).parts;
}

const SKIPPED_DIRECTORIES = new Set(['memory', 'tool-results', 'file-history']);

export async function listClaudeTranscripts(root = claudeProjectsDir()): Promise<string[]> {
  return listFilesRecursive(
    root,
    (_full, name) => name.endsWith('.jsonl'),
    (_full, name) => SKIPPED_DIRECTORIES.has(name)
  );
}

/** Transcripts under `<CLAUDE_CONFIG_DIR>/projects`. */
export function claudeSessionSource(root = claudeProjectsDir()): SessionSource {
  return {
    label: 'Claude Code',
    parserVersion: CLAUDE_PARSER_VERSION,
    listFiles: () => listClaudeTranscripts(root),
    watchRoots: () => [root],
    accepts: (file) => {
      if (!file.endsWith('.jsonl')) return false;
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
      return !pathSegments(relative).some((segment) => SKIPPED_DIRECTORIES.has(segment));
    },
    createParser: (file, state) => new ClaudeTranscriptParser(file, state),
    candidatePartIds: (file) => [claudePartId(file), `${claudePartId(file)}#sidechain`]
  };
}

export async function scanClaudeSessions(store: UsageStore, root = claudeProjectsDir()): Promise<ScanResult> {
  return scanAllSessions(store, claudeSessionSource(root));
}
