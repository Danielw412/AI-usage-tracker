import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  getSessionFileState,
  insertRateLimitSnapshot,
  replaceThreadData,
  type StoredThreadEvent
} from './db.js';
import { classifyThreadSource } from './codex/localThreadMetadata.js';
import { cleanUserMessage, extractRawUserMessage } from './messageText.js';
import { estimateUsageCost, findPricing } from './pricing.js';
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

async function listJsonlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  if (!fs.existsSync(root)) return result;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
    }
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

interface ParsedSession {
  summary: ThreadPartSummary;
  events: StoredThreadEvent[];
  prompts: PromptMetric[];
}

export async function parseSessionFile(sourceFile: string): Promise<ParsedSession | null> {
  const stream = fs.createReadStream(sourceFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let threadId: string | null = null;
  let title: string | null = null;
  let projectPath: string | null = null;
  let currentModel = 'unknown';
  let partKind: SessionPartKind = 'main';
  let source: ThreadSource = 'unknown';
  let sourceLabel: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  let lineNumber = 0;
  let userMessageCount = 0;
  let promptSequence = 0;
  let currentTurnId: string | null = null;
  let currentTaskStartedAt: number | null = null;
  let promptsInCurrentTurn = 0;
  let activePrompt: PromptAccumulator | null = null;
  const seenUserMessages = new Set<string>();
  const events: StoredThreadEvent[] = [];
  const prompts: PromptMetric[] = [];
  const totals = defaultUsage();
  const modelTokens = new Map<string, number>();
  const models = new Set<string>();
  let totalCost = 0;
  let pricedEvents = 0;

  const finalizePrompt = (
    completedAt: number | null,
    reportedDurationMs: number | null = null,
    reportedTimeToFirstTokenMs: number | null = null
  ): void => {
    if (!activePrompt) return;
    const prompt = activePrompt;
    const derivedDuration = completedAt === null ? null : Math.max(0, (completedAt - prompt.startedAt) * 1000);
    const canUseReportedTiming = promptsInCurrentTurn === 1 && currentTaskStartedAt !== null;
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
    prompts.push(stored);
    activePrompt = null;
  };

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

    const timestamp = recordTimestamp(record);
    if (timestamp !== null) {
      startedAt = startedAt === null ? timestamp : Math.min(startedAt, timestamp);
      updatedAt = updatedAt === null ? timestamp : Math.max(updatedAt, timestamp);
    }

    threadId ??= extractThreadId(record);
    projectPath ??= extractProjectPath(record);
    partKind = detectPartKind(record) ?? partKind;
    const detectedSource = detectSource(record);
    if (detectedSource) {
      source = detectedSource.source;
      sourceLabel = detectedSource.sourceLabel;
    }

    const payload = isRecord(record.payload) ? record.payload : null;
    const type = eventType(record);
    if (type === 'task_started' && payload) {
      finalizePrompt(timestamp);
      currentTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : currentTurnId;
      currentTaskStartedAt = parseTimestamp(payload.started_at) ?? timestamp;
      promptsInCurrentTurn = 0;
    }

    const rawUserMessage = extractRawUserMessage(record);
    if (rawUserMessage) {
      const cleaned = cleanUserMessage(rawUserMessage);
      if (cleaned) {
        const dedupeKey = cleaned.toLowerCase();
        if (!seenUserMessages.has(dedupeKey) && partKind === 'main') {
          seenUserMessages.add(dedupeKey);
          finalizePrompt(timestamp);
          userMessageCount += 1;
          promptSequence += 1;
          promptsInCurrentTurn += 1;
          title ??= cleaned.slice(0, 120);
          const promptStartedAt = timestamp ?? currentTaskStartedAt ?? Math.floor(Date.now() / 1000);
          activePrompt = {
            promptId: crypto.createHash('sha1').update(`${sourceFile}:${lineNumber}:${cleaned}`).digest('hex'),
            sourceFile,
            threadId: '',
            turnId: currentTurnId,
            sequence: promptSequence,
            prompt: cleaned,
            startedAt: promptStartedAt,
            completedAt: null,
            durationMs: null,
            timeToFirstTokenMs: null,
            timingEstimated: true,
            primaryModel: currentModel,
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
      currentModel = model;
      if (model.toLowerCase() === AUTO_REVIEW_MODEL) partKind = 'reviewer';
    }

    const usage = findIncrementalUsage(record);
    if (usage) {
      const observedAt = timestamp ?? updatedAt ?? Math.floor(Date.now() / 1000);
      for (const limit of extractRateLimitWindows(record, observedAt)) insertRateLimitSnapshot(limit);
      const cost = estimateUsageCost(currentModel, usage, observedAt);
      const eventKey = crypto
        .createHash('sha1')
        .update(`${sourceFile}:${lineNumber}:${observedAt}`)
        .digest('hex');
      events.push({
        eventKey,
        threadId: '',
        sourceFile,
        observedAt,
        model: currentModel,
        ...usage,
        estimatedApiCostUsd: cost
      });
      addUsage(totals, usage);
      models.add(currentModel);
      modelTokens.set(currentModel, (modelTokens.get(currentModel) ?? 0) + usage.totalTokens);
      if (cost !== null) {
        totalCost += cost;
        pricedEvents += 1;
      }

      if (activePrompt) {
        addUsage(activePrompt, usage);
        activePrompt.firstTokenAt ??= observedAt;
        activePrompt.modelTokens.set(
          currentModel,
          (activePrompt.modelTokens.get(currentModel) ?? 0) + usage.totalTokens
        );
        if (cost === null) activePrompt.hasUnpriced = true;
        else {
          activePrompt.totalCost += cost;
          activePrompt.pricedEvents += 1;
        }
      }
    }

    if (type === 'task_complete' && payload) {
      const completedAt = parseTimestamp(payload.completed_at) ?? timestamp;
      const durationMs = toFiniteNumber(payload.duration_ms);
      const ttftMs = toFiniteNumber(payload.time_to_first_token_ms);
      finalizePrompt(completedAt, durationMs, ttftMs);
      currentTurnId = null;
      currentTaskStartedAt = null;
      promptsInCurrentTurn = 0;
    }
  }

  finalizePrompt(updatedAt);
  if (events.length === 0 && prompts.length === 0) return null;
  const fallbackId = crypto.createHash('sha1').update(sourceFile).digest('hex');
  const finalThreadId = threadId ?? fallbackId;
  for (const event of events) event.threadId = finalThreadId;
  for (const prompt of prompts) prompt.threadId = finalThreadId;

  const primaryModel =
    [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? currentModel;
  // Auto-review has no public API price, so it never makes a chat's estimate "partial".
  const unknownModels = [...models].filter(
    (model) => model.toLowerCase() !== AUTO_REVIEW_MODEL && findPricing(model) === null
  );
  const pricingStatus: PricingStatus =
    pricedEvents === 0 ? 'unknown' : unknownModels.length > 0 ? 'partial' : 'exact-model-match';

  return {
    summary: {
      threadId: finalThreadId,
      title: partKind === 'main' ? title : null,
      projectPath,
      startedAt,
      updatedAt,
      primaryModel,
      models: [...models],
      ...totals,
      estimatedApiCostUsd: pricedEvents > 0 ? totalCost : null,
      pricingStatus,
      sourceFile,
      partKind,
      userMessageCount: partKind === 'main' ? userMessageCount : 0,
      source,
      sourceLabel
    },
    events,
    prompts
  };
}

export async function scanCodexSessions(): Promise<{
  scanned: number;
  updated: number;
  errors: number;
}> {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const roots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  const files = (await Promise.all(roots.map(listJsonlFiles))).flat();
  const parserVersion = '6';
  const markerPath = path.resolve(process.cwd(), 'data', '.session-parser-version');
  const installedVersion = fs.existsSync(markerPath)
    ? (await fs.promises.readFile(markerPath, 'utf8')).trim()
    : '';
  const forceRescan = installedVersion !== parserVersion;
  let updated = 0;
  let errors = 0;

  for (const sourceFile of files) {
    try {
      const stat = await fs.promises.stat(sourceFile);
      const previous = getSessionFileState(sourceFile);
      if (
        !forceRescan &&
        previous &&
        previous.modifiedMs === stat.mtimeMs &&
        previous.sizeBytes === stat.size
      ) {
        continue;
      }
      const parsed = await parseSessionFile(sourceFile);
      if (!parsed) continue;
      replaceThreadData(parsed.summary, parsed.events, parsed.prompts, {
        modifiedMs: stat.mtimeMs,
        sizeBytes: stat.size
      });
      updated += 1;
    } catch (error) {
      errors += 1;
      console.warn(`Failed to parse Codex session ${sourceFile}:`, error);
    }
  }

  if (forceRescan && errors === 0) {
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.promises.writeFile(markerPath, `${parserVersion}\n`, 'utf8');
  }

  return { scanned: files.length, updated, errors };
}
