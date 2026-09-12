import fs from 'node:fs';
import path from 'node:path';
import type { TokenUsage } from './types.js';

interface LongContextRule {
  thresholdTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

interface PricingRate {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  /** Price of writing a prompt prefix to the cache (5-minute lifetime). Defaults to the input price. */
  cacheWritePerMillion?: number;
  /** Price of a one-hour cache write. Defaults to the 5-minute write price. */
  cacheWrite1hPerMillion?: number;
}

interface PriceChange extends PricingRate {
  effectiveFrom: string;
}

export interface ModelPricing extends PricingRate {
  id: string;
  aliases: string[];
  /** Which provider bills this model; informational. */
  provider?: 'openai' | 'anthropic';
  longContext?: LongContextRule;
  priceChanges?: PriceChange[];
}

interface PricingConfig {
  updatedAt: string;
  currency: string;
  models: ModelPricing[];
}

let cachedConfig: PricingConfig | null = null;

export function loadPricingConfig(): PricingConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.resolve(
    process.cwd(),
    process.env.PRICING_CONFIG ?? 'config/pricing.json'
  );
  cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PricingConfig;
  return cachedConfig;
}

/** Lower-case, and drop context-size markers such as the `[1m]` Claude Code appends. */
export function normalizeModelName(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim();
}

function parseEffectiveTimestamp(effectiveFrom: string): number | null {
  const timestamp = Date.parse(effectiveFrom);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function selectPricingRate(pricing: ModelPricing, observedAt?: number): PricingRate {
  const timestamp = observedAt ?? Math.floor(Date.now() / 1000);
  const applicableChange = (pricing.priceChanges ?? [])
    .map((change) => ({ change, timestamp: parseEffectiveTimestamp(change.effectiveFrom) }))
    .filter(({ timestamp: effectiveAt }) => effectiveAt !== null && effectiveAt <= timestamp)
    .sort((a, b) => a.timestamp! - b.timestamp!)
    .at(-1)?.change;

  return applicableChange ?? pricing;
}

export function findPricing(model: string): ModelPricing | null {
  const normalized = normalizeModelName(model);
  const config = loadPricingConfig();

  const exact = config.models.find((entry) =>
    [entry.id, ...entry.aliases].some((alias) => normalizeModelName(alias) === normalized)
  );
  if (exact) return exact;

  // Snapshot model IDs usually append a date. Match the longest alias prefix.
  const candidates = config.models
    .flatMap((entry) => [entry.id, ...entry.aliases].map((alias) => ({ entry, alias })))
    .filter(({ alias }) => normalized.startsWith(`${normalizeModelName(alias)}-`))
    .sort((a, b) => b.alias.length - a.alias.length);
  return candidates[0]?.entry ?? null;
}

export function estimateUsageCost(
  model: string,
  usage: TokenUsage,
  observedAt?: number
): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;
  const rate = selectPricingRate(pricing, observedAt);

  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const cacheWrite = Math.max(
    0,
    Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached)
  );
  const cacheWrite1h = Math.max(0, Math.min(usage.cacheWrite1hInputTokens ?? 0, cacheWrite));
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);
  const write5mRate = rate.cacheWritePerMillion ?? rate.inputPerMillion;
  const write1hRate = rate.cacheWrite1hPerMillion ?? write5mRate;

  let inputCost =
    (uncached * rate.inputPerMillion +
      cached * rate.cachedInputPerMillion +
      cacheWrite5m * write5mRate +
      cacheWrite1h * write1hRate) /
    1_000_000;
  let outputCost = (usage.outputTokens * rate.outputPerMillion) / 1_000_000;

  // Long-context pricing is applied per upstream request. This function is used on
  // individual token events, not cumulative thread totals.
  if (pricing.longContext && usage.inputTokens > pricing.longContext.thresholdTokens) {
    inputCost *= pricing.longContext.inputMultiplier;
    outputCost *= pricing.longContext.outputMultiplier;
  }

  return inputCost + outputCost;
}
