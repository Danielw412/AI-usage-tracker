import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { StoredThreadEvent, UsageStore } from '../db.js';
import { estimateUsageCost, findPricing, normalizeModelName } from '../pricing.js';
import { listFilesRecursive, scanSessionFiles, type ParsedSessionPart, type ScanResult } from '../sessionScan.js';
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
export const CLAUDE_PARSER_VERSION = '3';

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

interface PromptAccumulator extends PromptMetric {
  firstTokenAt: number | null;
  modelTokens: Map<string, number>;
  totalCost: number;
  pricedEvents: number;
  hasUnpriced: boolean;
}

/** Everything gathered for one session part (main conversation or subagent work). */
class PartAccumulator {
  readonly events: StoredThreadEvent[] = [];
  readonly prompts: PromptMetric[] = [];
  readonly totals = defaultUsage();
  readonly modelTokens = new Map<string, number>();
  readonly models = new Set<string>();
  readonly seenMessageIds = new Set<string>();
  totalCost = 0;
  pricedEvents = 0;
  startedAt: number | null = null;
  updatedAt: number | null = null;
  firstPrompt: string | null = null;
  userMessageCount = 0;
  private promptSequence = 0;
  private promptsInTurn = 0;
  private activePrompt: PromptAccumulator | null = null;
  private lastEventAt: number | null = null;

  constructor(readonly sourceFile: string, readonly partKind: SessionPartKind) {}

  touch(timestamp: number): void {
    this.startedAt = this.startedAt === null ? timestamp : Math.min(this.startedAt, timestamp);
    this.updatedAt = this.updatedAt === null ? timestamp : Math.max(this.updatedAt, timestamp);
  }

  get isEmpty(): boolean {
    return this.events.length === 0 && this.prompts.length === 0;
  }

  startPrompt(prompt: string, timestamp: number | null, turnId: string | null, lineNumber: number): void {
    // A new prompt ends the previous turn; timing then comes from the last response.
    const previousTurn = this.activePrompt?.turnId ?? null;
    this.finalizePrompt(this.lastEventAt ?? timestamp, null);
    this.promptsInTurn = previousTurn !== null && previousTurn === turnId ? this.promptsInTurn + 1 : 1;
    const startedAt = timestamp ?? this.updatedAt ?? Math.floor(Date.now() / 1000);
    this.activePrompt = {
      promptId: crypto.createHash('sha1').update(`${this.sourceFile}:${lineNumber}:${prompt}`).digest('hex'),
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
      eventKey: crypto.createHash('sha1').update(`${this.sourceFile}:${messageId}`).digest('hex'),
      threadId: '',
      sourceFile: this.sourceFile,
      observedAt,
      model,
      ...usage,
      estimatedApiCostUsd: cost
    });
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
      firstTokenAt: _firstTokenAt,
      modelTokens: _modelTokens,
      totalCost: _totalCost,
      pricedEvents: _pricedEvents,
      hasUnpriced: _hasUnpriced,
      ...stored
    } = prompt;
    this.prompts.push(stored);
  }

  primaryModel(): string {
    return [...this.modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  }

  pricingStatus(): PricingStatus {
    if (this.pricedEvents === 0) return 'unknown';
    const unknown = [...this.models].some((model) => findPricing(model) === null);
    return unknown ? 'partial' : 'exact-model-match';
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

/**
 * Parse one Claude Code transcript into session parts. The main conversation
 * becomes a `main` part; sidechain records (subagents logged inline) become a
 * `subagent` part with the same thread id; files under `subagents/` are
 * subagent parts of their parent session.
 *
 * Returns `[]` when the file was continued into another session whose
 * transcript already contains every record of this one, so the copy is not
 * counted twice.
 */
export async function parseClaudeTranscript(sourceFile: string): Promise<ClaudeParsedPart[]> {
  const parentSession = parentSessionFromPath(sourceFile);
  const isSubagentFile = parentSession !== null || path.basename(sourceFile).startsWith('agent-');
  const main = new PartAccumulator(sourceFile, isSubagentFile ? 'subagent' : 'main');
  const side = new PartAccumulator(`${sourceFile}#sidechain`, 'subagent');

  const stream = fs.createReadStream(sourceFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let entrypoint: string | null = null;
  let sessionKind: string | null = null;
  let bridged = false;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let reportedCostUsd: number | null = null;
  let continuedInto: string | null = null;
  let lastUuid: string | null = null;
  let lastMessageId: string | null = null;
  let updatedAt: number | null = null;
  const effortCounts = new Map<string, number>();

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }

    const type = typeof record.type === 'string' ? record.type : '';
    const timestamp = parseTimestamp(record.timestamp);
    const sidechain = !isSubagentFile && (record.isSidechain === true || typeof record.agentId === 'string');
    const part = sidechain ? side : main;
    if (timestamp !== null) {
      part.touch(timestamp);
      updatedAt = updatedAt === null ? timestamp : Math.max(updatedAt, timestamp);
    }
    // Records written after the continuation marker were never copied, so the
    // last uuid before it is what the continuation file must contain.
    if (typeof record.uuid === 'string' && continuedInto === null) lastUuid = record.uuid;
    if (!sidechain) {
      sessionId ??= text(record.sessionId, 100);
      cwd ??= text(record.cwd, 500);
      const branch = text(record.gitBranch, 200);
      if (branch && branch !== 'HEAD') gitBranch = branch;
      entrypoint ??= text(record.entrypoint, 60);
      if (record.sessionKind === 'bg') sessionKind = 'bg';
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
        part.startPrompt(cleaned, timestamp, turnId, lineNumber);
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
        if (continuedInto === null && !sidechain && typeof message.id === 'string') lastMessageId = message.id;
        // Streaming writes one record per content block, all carrying the full usage.
        const usage = usageFromClaudeMessage(message.usage);
        if (!usage) {
          part.seenMessageIds.add(messageId);
          break;
        }
        part.addEvent(timestamp ?? part.updatedAt ?? Math.floor(Date.now() / 1000), model, usage, messageId);
        if (!sidechain && typeof record.effort === 'string') {
          effortCounts.set(record.effort, (effortCounts.get(record.effort) ?? 0) + 1);
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
        aiTitle = text(record.aiTitle, 200) ?? aiTitle;
        break;
      case 'custom-title':
        customTitle = text(record.customTitle, 200) ?? customTitle;
        break;
      case 'cost-state': {
        const cost = toFiniteNumber(record.totalCostUSD);
        if (cost !== null && cost > 0) reportedCostUsd = cost;
        break;
      }
      case 'continued-in':
        continuedInto = text(record.continuedInSessionId, 100);
        break;
      case 'bridge-session':
        bridged = true;
        break;
      default:
        break;
    }
  }

  main.finalizePrompt(main.updatedAt, null);
  side.finalizePrompt(side.updatedAt, null);

  if (continuedInto && (lastMessageId || lastUuid)) {
    const continuation = path.join(path.dirname(sourceFile), `${continuedInto}.jsonl`);
    if (continuation !== sourceFile && fs.existsSync(continuation)) {
      // The copy keeps API message ids even where it rewrites record uuids, so the
      // last assistant message is the reliable marker; the last uuid is a fallback.
      const needles = [
        ...(lastMessageId ? [`"id":"${lastMessageId}"`] : []),
        ...(lastUuid ? [`"uuid":"${lastUuid}"`] : [])
      ];
      try {
        if (await fileContainsAny(continuation, needles)) return [];
      } catch {
        // If the continuation cannot be read, keep this file's data.
      }
    }
  }

  if (main.isEmpty && side.isEmpty) return [];

  const baseName = path.basename(sourceFile, '.jsonl');
  const threadId =
    parentSession ??
    (UUID_PATTERN.test(baseName) ? baseName : null) ??
    sessionId ??
    crypto.createHash('sha1').update(sourceFile).digest('hex');
  const classified = classifyClaudeEntrypoint(entrypoint, sessionKind, bridged);
  const source: ThreadSource = isSubagentFile ? 'subagent' : classified.source;
  const sourceLabel = isSubagentFile ? null : classified.sourceLabel;
  const reasoningEffort = [...effortCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const parts: ClaudeParsedPart[] = [];
  const buildSummary = (part: PartAccumulator, kind: SessionPartKind): ThreadPartSummary => ({
    threadId,
    title: kind === 'main' ? part.firstPrompt : null,
    projectPath: cwd,
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
    reportedCostUsd: kind === 'main' ? reportedCostUsd : null
  });

  if (!main.isEmpty) {
    for (const event of main.events) event.threadId = threadId;
    for (const prompt of main.prompts) prompt.threadId = threadId;
    const summary = buildSummary(main, main.partKind);
    const metadata: ClaudeThreadMetadata | undefined = main.partKind === 'main'
      ? {
          threadId,
          displayName: customTitle ?? aiTitle,
          updatedAt: updatedAt ?? Math.floor(Date.now() / 1000),
          source,
          sourceLabel,
          model: summary.primaryModel === 'unknown' ? null : summary.primaryModel,
          reasoningEffort,
          gitBranch,
          projectName: projectNameFromPath(cwd)
        }
      : undefined;
    parts.push({ summary, events: main.events, prompts: main.prompts, metadata });
  }
  if (!side.isEmpty) {
    for (const event of side.events) event.threadId = threadId;
    parts.push({ summary: buildSummary(side, 'subagent'), events: side.events, prompts: [] });
  }
  return parts;
}

const SKIPPED_DIRECTORIES = new Set(['memory', 'tool-results', 'file-history']);

export async function listClaudeTranscripts(root = claudeProjectsDir()): Promise<string[]> {
  return listFilesRecursive(
    root,
    (_full, name) => name.endsWith('.jsonl'),
    (_full, name) => SKIPPED_DIRECTORIES.has(name)
  );
}

export async function scanClaudeSessions(store: UsageStore, root = claudeProjectsDir()): Promise<ScanResult> {
  const files = await listClaudeTranscripts(root);
  return scanSessionFiles({
    store,
    files,
    parserVersion: CLAUDE_PARSER_VERSION,
    markerPath: path.resolve(process.cwd(), 'data', '.claude-parser-version'),
    label: 'Claude Code',
    parse: async (sourceFile) => {
      const parts = await parseClaudeTranscript(sourceFile);
      const metadata = parts.flatMap((part) => (part.metadata ? [part.metadata] : []));
      if (metadata.length > 0) {
        store.upsertThreadMetadata(metadata.map((item) => ({
          threadId: item.threadId,
          displayName: item.displayName,
          preview: null,
          updatedAt: item.updatedAt,
          source: item.source,
          sourceLabel: item.sourceLabel,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          gitBranch: item.gitBranch,
          projectName: item.projectName
        })));
      }
      return parts;
    }
  });
}
