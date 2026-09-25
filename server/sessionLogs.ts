import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { StoredThreadEvent, UsageStore } from './db.js';
import { classifyThreadSource } from './codex/localThreadMetadata.js';
import { cleanUserMessage, extractRawUserMessage } from './messageText.js';
import { estimateUsageCost, findPricing } from './pricing.js';
import {
  feedFile,
  listFilesRecursive,
  scanAllSessions,
  type ParseOutput,
  type ParsedSessionPart,
  type ResumableParser,
  type ScanResult,
  type SessionSource
} from './sessionScan.js';
import type {
  PricingStatus,
  PromptMetric,
  RateLimitWindow,
  SessionPartKind,
  ThreadPartSummary,
  ThreadSource,
  TokenUsage
} from './types.js';

const AUTO_REVIEW_MODEL = 'codex-auto-review';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return 0;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return null;
}

function usageFrom(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = toNumber(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = toNumber(value.cached_input_tokens ?? value.cachedInputTokens);
  const outputTokens = toNumber(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = toNumber(
    value.reasoning_output_tokens ?? value.reasoningOutputTokens
  );
  const totalTokens = toNumber(value.total_tokens ?? value.totalTokens) || inputTokens + outputTokens;
  if (inputTokens + outputTokens + totalTokens === 0) return null;
  return {
    inputTokens,
    cachedInputTokens: Math.min(cachedInputTokens, inputTokens),
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function findIncrementalUsage(record: JsonRecord): TokenUsage | null {
  const payload = isRecord(record.payload) ? record.payload : record;
  const info = isRecord(payload.info) ? payload.info : null;
  const direct = info?.last_token_usage ?? info?.lastTokenUsage ?? payload.last_token_usage;
  const parsed = usageFrom(direct);
  if (parsed) return parsed;

  if (payload.type === 'raw_response_completed' || payload.type === 'rawResponse/completed') {
    return usageFrom(payload.usage);
  }
  return null;
}

function eventType(record: JsonRecord): string {
  const payload = isRecord(record.payload) ? record.payload : null;
  const innerPayload = payload && isRecord(payload.payload) ? payload.payload : null;
  const values = [innerPayload?.type, payload?.type, record.type];
  return values.find((value): value is string => typeof value === 'string') ?? '';
}

function recordTimestamp(record: JsonRecord): number | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  return parseTimestamp(record.timestamp ?? payload?.timestamp ?? payload?.created_at);
}

function findString(record: JsonRecord, keys: string[]): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  const innerPayload = payload && isRecord(payload.payload) ? payload.payload : null;
  for (const container of [innerPayload, payload, record]) {
    if (!container) continue;
    for (const key of keys) {
      const value = container[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

function extractModel(record: JsonRecord): string | null {
  const type = eventType(record).toLowerCase();
  if (
    !type.includes('context') &&
    !type.includes('turn') &&
    !type.includes('session') &&
    !type.includes('model') &&
    !type.includes('response')
  ) {
    return null;
  }
  return findString(record, ['model', 'model_name', 'modelName', 'model_slug', 'modelSlug']);
}

function extractThreadId(record: JsonRecord): string | null {
  const type = eventType(record).toLowerCase();
  if (!type.includes('session') && !type.includes('metadata') && !type.includes('thread')) {
    return null;
  }
  return findString(record, ['thread_id', 'threadId', 'session_id', 'sessionId', 'id']);
}

function extractProjectPath(record: JsonRecord): string | null {
  const type = eventType(record).toLowerCase();
  if (!type.includes('session') && !type.includes('context') && !type.includes('turn')) {
    return null;
  }
  return findString(record, ['cwd', 'working_directory', 'workingDirectory', 'project_path']);
}

function detectPartKind(record: JsonRecord): SessionPartKind | null {
  if (String(record.type).toLowerCase() !== 'session_meta') return null;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;

  const threadSource = typeof payload.thread_source === 'string' ? payload.thread_source.toLowerCase() : '';
  const sourceText = JSON.stringify(payload.source ?? '').toLowerCase();
  if (sourceText.includes('guardian') || sourceText.includes('review')) return 'reviewer';
  if (threadSource === 'subagent' || (isRecord(payload.source) && isRecord(payload.source.subagent))) {
    return 'subagent';
  }
  return 'main';
}

function detectSource(record: JsonRecord): { source: ThreadSource; sourceLabel: string | null } | null {
  if (String(record.type).toLowerCase() !== 'session_meta') return null;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;
  const source = typeof payload.source === 'string'
    ? payload.source
    : payload.source === undefined || payload.source === null
      ? null
      : JSON.stringify(payload.source);
  const threadSource = typeof payload.thread_source === 'string' ? payload.thread_source : null;
  return classifyThreadSource(source, threadSource);
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
}

function defaultUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function labelForWindow(durationMins: number, fallback: string): string {
  if (Math.abs(durationMins - 300) <= 5) return '5-hour window';
  if (Math.abs(durationMins - 10_080) <= 60) return '7-day window';
  return fallback;
}

function extractRateLimitWindows(record: JsonRecord, observedAt: number): RateLimitWindow[] {
  const payload = isRecord(record.payload) ? record.payload : null;
  const limits = payload && isRecord(payload.rate_limits ?? payload.rateLimits)
    ? (payload.rate_limits ?? payload.rateLimits) as JsonRecord
    : null;
  if (!limits) return [];

  const limitId = typeof limits.limit_id === 'string'
    ? limits.limit_id
    : typeof limits.limitId === 'string'
      ? limits.limitId
      : 'codex';
  const limitName = typeof limits.limit_name === 'string'
    ? limits.limit_name
    : typeof limits.limitName === 'string'
      ? limits.limitName
      : 'Codex usage';
  const result: RateLimitWindow[] = [];
  for (const slot of ['primary', 'secondary', 'individual_limit', 'individualLimit']) {
    const raw = limits[slot];
    if (!isRecord(raw)) continue;
    const usedPercent = toFiniteNumber(raw.used_percent ?? raw.usedPercent);
    const windowDurationMins = toNumber(raw.window_minutes ?? raw.windowDurationMins);
    const resetsAt = parseTimestamp(raw.resets_at ?? raw.resetsAt);
    if (usedPercent === null || windowDurationMins <= 0 || resetsAt === null) continue;
    result.push({
      key: `${limitId}:${slot.replace('_', '-')}`,
      label: labelForWindow(windowDurationMins, limitName),
      usedPercent: Math.max(0, usedPercent),
      windowDurationMins,
      resetsAt,
      observedAt
    });
  }
  return result;
}


interface PromptAccumulator extends PromptMetric {
  firstTokenAt: number | null;
  modelTokens: Map<string, number>;
  totalCost: number;
  pricedEvents: number;
  hasUnpriced: boolean;
}

type SerializedPrompt = Omit<PromptAccumulator, 'modelTokens'> & { modelTokens: Array<[string, number]> };

/** Bump when parsing changes so every rollout is indexed again. */
export const CODEX_PARSER_VERSION = '7';

/** Everything needed to continue parsing a rollout after its last complete line. */
interface CodexParserState {
  version: string;
  lineNumber: number;
  threadId: string | null;
  title: string | null;
  projectPath: string | null;
  currentModel: string;
  partKind: SessionPartKind;
  source: ThreadSource;
  sourceLabel: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  userMessageCount: number;
  promptSequence: number;
  currentTurnId: string | null;
  currentTaskStartedAt: number | null;
  promptsInCurrentTurn: number;
  activePrompt: SerializedPrompt | null;
  seenUserMessages: string[];
  totals: TokenUsage;
  modelTokens: Array<[string, number]>;
  models: string[];
  totalCost: number;
  pricedEvents: number;
  eventCount: number;
  promptCount: number;
}

export interface ParsedSession extends ParsedSessionPart {
  limits: RateLimitWindow[];
}

/**
 * A rollout keeps its file name when Codex moves it into `archived_sessions`,
 * so the name (not the path) identifies the part on every device.
 */
export function codexPartId(sourceFile: string): string {
  // Split on both separators so rows migrated from another OS map the same way.
  return sourceFile.replace(/#sidechain$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? sourceFile;
}

function userMessageKey(cleaned: string): string {
  return crypto.createHash('sha1').update(cleaned.toLowerCase()).digest('hex').slice(0, 24);
}

/**
 * Resumable parser for one Codex rollout file. It never touches the database,
 * so the scanner (and tests) decide what to do with the result.
 */
export class CodexRolloutParser implements ResumableParser {
  private lineNumber = 0;
  private threadId: string | null = null;
  private title: string | null = null;
  private projectPath: string | null = null;
  private currentModel = 'unknown';
  private partKind: SessionPartKind = 'main';
  private source: ThreadSource = 'unknown';
  private sourceLabel: string | null = null;
  private startedAt: number | null = null;
  private updatedAt: number | null = null;
  private userMessageCount = 0;
  private promptSequence = 0;
  private currentTurnId: string | null = null;
  private currentTaskStartedAt: number | null = null;
  private promptsInCurrentTurn = 0;
  private activePrompt: PromptAccumulator | null = null;
  private readonly seenUserMessages = new Set<string>();
  private totals = defaultUsage();
  private readonly modelTokens = new Map<string, number>();
  private readonly models = new Set<string>();
  private totalCost = 0;
  private pricedEvents = 0;
  private eventCount = 0;
  private promptCount = 0;
  /** Produced since this parser was created or restored. */
  private readonly events: StoredThreadEvent[] = [];
  private readonly prompts: PromptMetric[] = [];
  private readonly limits: RateLimitWindow[] = [];

  constructor(
    readonly sourceFile: string,
    readonly partId = codexPartId(sourceFile),
    state?: unknown
  ) {
    if (state !== undefined) this.restore(state);
  }

  private restore(raw: unknown): void {
    const state = raw as CodexParserState;
    if (!state || typeof state !== 'object' || state.version !== CODEX_PARSER_VERSION) {
      throw new Error('Saved Codex parser state is from another parser version');
    }
    this.lineNumber = state.lineNumber;
    this.threadId = state.threadId;
    this.title = state.title;
    this.projectPath = state.projectPath;
    this.currentModel = state.currentModel;
    this.partKind = state.partKind;
    this.source = state.source;
    this.sourceLabel = state.sourceLabel;
    this.startedAt = state.startedAt;
    this.updatedAt = state.updatedAt;
    this.userMessageCount = state.userMessageCount;
    this.promptSequence = state.promptSequence;
    this.currentTurnId = state.currentTurnId;
    this.currentTaskStartedAt = state.currentTaskStartedAt;
    this.promptsInCurrentTurn = state.promptsInCurrentTurn;
    this.activePrompt = state.activePrompt
      ? { ...state.activePrompt, modelTokens: new Map(state.activePrompt.modelTokens) }
      : null;
    for (const key of state.seenUserMessages) this.seenUserMessages.add(key);
    this.totals = { ...state.totals };
    for (const [model, tokens] of state.modelTokens) this.modelTokens.set(model, tokens);
    for (const model of state.models) this.models.add(model);
    this.totalCost = state.totalCost;
    this.pricedEvents = state.pricedEvents;
    this.eventCount = state.eventCount;
    this.promptCount = state.promptCount;
  }

  snapshot(): CodexParserState {
    return {
      version: CODEX_PARSER_VERSION,
      lineNumber: this.lineNumber,
      threadId: this.threadId,
      title: this.title,
      projectPath: this.projectPath,
      currentModel: this.currentModel,
      partKind: this.partKind,
      source: this.source,
      sourceLabel: this.sourceLabel,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      userMessageCount: this.userMessageCount,
      promptSequence: this.promptSequence,
      currentTurnId: this.currentTurnId,
      currentTaskStartedAt: this.currentTaskStartedAt,
      promptsInCurrentTurn: this.promptsInCurrentTurn,
      activePrompt: this.activePrompt
        ? { ...this.activePrompt, modelTokens: [...this.activePrompt.modelTokens.entries()] }
        : null,
      seenUserMessages: [...this.seenUserMessages],
      totals: { ...this.totals },
      modelTokens: [...this.modelTokens.entries()],
      models: [...this.models],
      totalCost: this.totalCost,
      pricedEvents: this.pricedEvents,
      eventCount: this.eventCount,
      promptCount: this.promptCount
    };
  }

  identity(): string {
    return `${this.threadId ?? ''}|${this.partKind}`;
  }

  private finalizePrompt(
    completedAt: number | null,
    reportedDurationMs: number | null = null,
    reportedTimeToFirstTokenMs: number | null = null
  ): void {
    if (!this.activePrompt) return;
    const prompt = this.activePrompt;
    const derivedDuration = completedAt === null ? null : Math.max(0, (completedAt - prompt.startedAt) * 1000);
    const canUseReportedTiming = this.promptsInCurrentTurn === 1 && this.currentTaskStartedAt !== null;
    prompt.completedAt = completedAt;
    prompt.durationMs = canUseReportedTiming && reportedDurationMs !== null
      ? reportedDurationMs
      : derivedDuration;
    prompt.timeToFirstTokenMs = canUseReportedTiming && reportedTimeToFirstTokenMs !== null
      ? reportedTimeToFirstTokenMs
      : prompt.firstTokenAt === null
        ? null
        : Math.max(0, (prompt.firstTokenAt - prompt.startedAt) * 1000);
    prompt.timingEstimated = !(canUseReportedTiming && reportedDurationMs !== null);
    prompt.primaryModel = [...prompt.modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? prompt.primaryModel;
    prompt.models = [...prompt.modelTokens.keys()];
    prompt.estimatedApiCostUsd = prompt.pricedEvents > 0 ? prompt.totalCost : null;
    prompt.pricingStatus = prompt.pricedEvents === 0
      ? 'unknown'
      : prompt.hasUnpriced
        ? 'partial'
        : 'exact-model-match';
    const {
      firstTokenAt: _firstTokenAt,
      modelTokens: _modelTokens,
      totalCost: _totalCost,
      pricedEvents: _pricedEvents,
      hasUnpriced: _hasUnpriced,
      ...stored
    } = prompt;
    this.prompts.push(stored);
    this.promptCount += 1;
    this.activePrompt = null;
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

    const timestamp = recordTimestamp(record);
    if (timestamp !== null) {
      this.startedAt = this.startedAt === null ? timestamp : Math.min(this.startedAt, timestamp);
      this.updatedAt = this.updatedAt === null ? timestamp : Math.max(this.updatedAt, timestamp);
    }

    this.threadId ??= extractThreadId(record);
    this.projectPath ??= extractProjectPath(record);
    this.partKind = detectPartKind(record) ?? this.partKind;
    const detectedSource = detectSource(record);
    if (detectedSource) {
      this.source = detectedSource.source;
      this.sourceLabel = detectedSource.sourceLabel;
    }

    const payload = isRecord(record.payload) ? record.payload : null;
    const type = eventType(record);
    if (type === 'task_started' && payload) {
      this.finalizePrompt(timestamp);
      this.currentTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : this.currentTurnId;
      this.currentTaskStartedAt = parseTimestamp(payload.started_at) ?? timestamp;
      this.promptsInCurrentTurn = 0;
    }

    const rawUserMessage = extractRawUserMessage(record);
    if (rawUserMessage) {
      const cleaned = cleanUserMessage(rawUserMessage);
      if (cleaned) {
        const dedupeKey = userMessageKey(cleaned);
        if (!this.seenUserMessages.has(dedupeKey) && this.partKind === 'main') {
          this.seenUserMessages.add(dedupeKey);
          this.finalizePrompt(timestamp);
          this.userMessageCount += 1;
          this.promptSequence += 1;
          this.promptsInCurrentTurn += 1;
          this.title ??= cleaned.slice(0, 120);
          const promptStartedAt = timestamp ?? this.currentTaskStartedAt ?? Math.floor(Date.now() / 1000);
          this.activePrompt = {
            promptId: crypto.createHash('sha1').update(`${this.partId}:${this.lineNumber}:${cleaned}`).digest('hex'),
            sourceFile: this.sourceFile,
            threadId: '',
            turnId: this.currentTurnId,
            sequence: this.promptSequence,
            prompt: cleaned,
            startedAt: promptStartedAt,
            completedAt: null,
            durationMs: null,
            timeToFirstTokenMs: null,
            timingEstimated: true,
            primaryModel: this.currentModel,
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
      }
    }

    const model = extractModel(record);
    if (model) {
      this.currentModel = model;
      if (model.toLowerCase() === AUTO_REVIEW_MODEL) this.partKind = 'reviewer';
    }

    const usage = findIncrementalUsage(record);
    if (usage) {
      const observedAt = timestamp ?? this.updatedAt ?? Math.floor(Date.now() / 1000);
      this.limits.push(...extractRateLimitWindows(record, observedAt));
      const cost = estimateUsageCost(this.currentModel, usage, observedAt);
      // The rollout name, line, and time identify this response on any device.
      const eventKey = crypto
        .createHash('sha1')
        .update(`codex:${this.partId}:${this.lineNumber}:${observedAt}`)
        .digest('hex');
      this.events.push({
        eventKey,
        threadId: '',
        sourceFile: this.sourceFile,
        observedAt,
        model: this.currentModel,
        ...usage,
        estimatedApiCostUsd: cost
      });
      this.eventCount += 1;
      addUsage(this.totals, usage);
      this.models.add(this.currentModel);
      this.modelTokens.set(this.currentModel, (this.modelTokens.get(this.currentModel) ?? 0) + usage.totalTokens);
      if (cost !== null) {
        this.totalCost += cost;
        this.pricedEvents += 1;
      }

      const prompt = this.activePrompt;
      if (prompt) {
        addUsage(prompt, usage);
        prompt.firstTokenAt ??= observedAt;
        prompt.modelTokens.set(
          this.currentModel,
          (prompt.modelTokens.get(this.currentModel) ?? 0) + usage.totalTokens
        );
        if (cost === null) prompt.hasUnpriced = true;
        else {
          prompt.totalCost += cost;
          prompt.pricedEvents += 1;
        }
      }
    }

    if (type === 'task_complete' && payload) {
      const completedAt = parseTimestamp(payload.completed_at) ?? timestamp;
      const durationMs = toFiniteNumber(payload.duration_ms);
      const ttftMs = toFiniteNumber(payload.time_to_first_token_ms);
      this.finalizePrompt(completedAt, durationMs, ttftMs);
      this.currentTurnId = null;
      this.currentTaskStartedAt = null;
      this.promptsInCurrentTurn = 0;
    }
  }

  /**
   * The part as of the last line fed: whole-file totals, with the events and
   * prompts produced by this pass. A prompt still in progress is reported with
   * the latest timestamp as its end, and reported again once it completes.
   */
  result(): ParsedSession | null {
    this.finalizePrompt(this.updatedAt);
    if (this.eventCount === 0 && this.promptCount === 0) return null;
    const finalThreadId = this.threadId ?? crypto.createHash('sha1').update(this.partId).digest('hex');
    for (const event of this.events) event.threadId = finalThreadId;
    for (const prompt of this.prompts) prompt.threadId = finalThreadId;

    const primaryModel =
      [...this.modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.currentModel;
    // Auto-review has no public API price, so it never makes a chat's estimate "partial".
    const unknownModels = [...this.models].filter(
      (model) => model.toLowerCase() !== AUTO_REVIEW_MODEL && findPricing(model) === null
    );
    const pricingStatus: PricingStatus =
      this.pricedEvents === 0 ? 'unknown' : unknownModels.length > 0 ? 'partial' : 'exact-model-match';

    const summary: ThreadPartSummary = {
      threadId: finalThreadId,
      partId: this.partId,
      title: this.partKind === 'main' ? this.title : null,
      projectPath: this.projectPath,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      primaryModel,
      models: [...this.models],
      ...this.totals,
      estimatedApiCostUsd: this.pricedEvents > 0 ? this.totalCost : null,
      pricingStatus,
      sourceFile: this.sourceFile,
      partKind: this.partKind,
      userMessageCount: this.partKind === 'main' ? this.userMessageCount : 0,
      source: this.source,
      sourceLabel: this.sourceLabel
    };

    return { summary, events: this.events, prompts: this.prompts, limits: this.limits };
  }

  async finish(): Promise<ParseOutput> {
    const parsed = this.result();
    return { parts: parsed ? [parsed] : null };
  }
}

/** Parse a whole Codex rollout file. */
export async function parseSessionFile(sourceFile: string): Promise<ParsedSession | null> {
  const parser = new CodexRolloutParser(sourceFile);
  await feedFile(sourceFile, 0, parser);
  return parser.result();
}

export function codexHomeDirectory(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Rollouts under `sessions/` and `archived_sessions/` in CODEX_HOME. */
export function codexSessionSource(codexHome = codexHomeDirectory()): SessionSource {
  const roots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  return {
    label: 'Codex',
    parserVersion: CODEX_PARSER_VERSION,
    listFiles: async () => (
      await Promise.all(roots.map((root) => listFilesRecursive(root, (_full, name) => name.endsWith('.jsonl'))))
    ).flat(),
    watchRoots: () => roots,
    accepts: (file) => file.endsWith('.jsonl') && roots.some((root) => isInside(root, file)),
    createParser: (file, state) => new CodexRolloutParser(file, codexPartId(file), state),
    candidatePartIds: (file) => [codexPartId(file)]
  };
}

export async function scanCodexSessions(store: UsageStore, codexHome?: string): Promise<ScanResult> {
  return scanAllSessions(store, codexSessionSource(codexHome));
}
