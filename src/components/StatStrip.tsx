import { compact, duration, percent, usd } from '../format';
import type { ProviderCopy } from '../providers';
import type { DashboardOverview } from '../types';

interface Stat {
  label: string;
  value: string;
  note?: string;
}

export function StatStrip({ overview, copy }: { overview: DashboardOverview; copy: ProviderCopy }) {
  const { account, totals } = overview;
  const cacheHit = totals.inputTokens > 0
    ? (totals.cachedInputTokens / totals.inputTokens) * 100
    : null;
  const statsNote = account.statsSource === 'account' ? copy.statsReportedBy : 'from local logs';

  const stats: Stat[] = [];
  if (account.lifetimeTokens !== null) {
    stats.push({ label: 'Lifetime tokens', value: compact(account.lifetimeTokens), note: statsNote });
  }
  if (account.peakDailyTokens !== null) {
    stats.push({ label: 'Busiest day', value: compact(account.peakDailyTokens), note: 'tokens in one day' });
  }
  if (account.currentStreakDays !== null) {
    stats.push({
      label: 'Streak',
      value: `${account.currentStreakDays}d`,
      note: account.longestStreakDays !== null ? `longest ${account.longestStreakDays}d` : undefined
    });
  }
  if (account.longestRunningTurnSec !== null) {
    stats.push({ label: 'Longest turn', value: duration(account.longestRunningTurnSec * 1000), note: 'single task' });
  }
  if (account.resetCreditsAvailable !== null) {
    stats.push({
      label: 'Reset credits',
      value: String(account.resetCreditsAvailable),
      note: account.resetCreditsAvailable === 1 ? 'full reset available' : 'full resets available'
    });
  }
  if (account.extraUsage?.enabled) {
    const extra = account.extraUsage;
    stats.push({
      label: 'Extra usage',
      value: extra.usedPercent !== null ? percent(extra.usedPercent) : extra.usedUsd !== null ? usd(extra.usedUsd) : 'on',
      note: extra.limitUsd !== null ? `of ${usd(extra.limitUsd)} this month` : 'usage credits enabled'
    });
  }
  stats.push({
    label: 'API equivalent',
    value: usd(totals.estimatedApiCostUsd),
    note: `${compact(totals.totalTokens)} indexed tokens`
  });
  if (cacheHit !== null) {
    stats.push({ label: 'Cache hit', value: `${cacheHit.toFixed(0)}%`, note: `${compact(totals.cachedInputTokens)} cached` });
  }
  stats.push({ label: 'Chats indexed', value: String(totals.threads), note: 'from local logs' });

  return (
    <section className="stat-strip" aria-label="Account statistics">
      {stats.map((stat) => (
        <div className="stat" key={stat.label}>
          <span className="stat-label">{stat.label}</span>
          <span className="stat-value">{stat.value}</span>
          {stat.note ? <span className="stat-note">{stat.note}</span> : null}
        </div>
      ))}
    </section>
  );
}
