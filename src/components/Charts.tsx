import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { compact, integer, weekdayShort } from '../format';
import type { DailyUsage } from '../types';

function DailyTooltip({
  active,
  payload,
  label
}: {
  active?: boolean;
  payload?: Array<{ value?: number | string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <span>{new Date(`${label}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
      <strong>{integer(Number(payload[0]?.value ?? 0))}</strong>
      <em>tokens</em>
    </div>
  );
}

function fillDays(data: DailyUsage[], days: number): DailyUsage[] {
  const byDate = new Map(data.map((row) => [row.date, row]));
  const result: DailyUsage[] = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    result.push(byDate.get(key) ?? { date: key, tokens: 0, source: data[0]?.source ?? 'local' });
  }
  return result;
}

export function DailyTokenChart({ data, days = 14 }: { data: DailyUsage[]; days?: number }) {
  const rows = useMemo(() => fillDays(data, days), [data, days]);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const peak = rows.reduce((best, row) => (row.tokens > best.tokens ? row : best), rows[0]);

  return (
    <section className="panel chart-panel" aria-labelledby="daily-title">
      <header className="panel-head">
        <div>
          <h3 id="daily-title">Daily tokens</h3>
          <p>{`Last ${days} days${data[0]?.source === 'account' ? ', account totals' : ', local logs'}`}</p>
        </div>
        <div className="panel-figure">
          <strong>{compact(total)}</strong>
          <span>tokens</span>
        </div>
      </header>
      {total === 0 ? (
        <div className="chart-empty">No daily token history yet.</div>
      ) : (
        <div className="chart-frame chart-frame-sm">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={4}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(value) => new Date(`${value}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(value) => compact(Number(value), 0)}
                tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip content={<DailyTooltip />} cursor={{ fill: 'var(--accent-soft)' }} />
              <Bar
                dataKey="tokens"
                fill="var(--accent)"
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {total > 0 && peak ? (
        <p className="panel-foot">
          Peak {new Date(`${peak.date}T12:00:00`).toLocaleDateString([], { weekday: 'long' })} with {compact(peak.tokens)} tokens.
        </p>
      ) : null}
    </section>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function ActivityHeatmap({ grid, title }: { grid: number[][]; title: string }) {
  const max = Math.max(0, ...grid.flat());
  const total = grid.flat().reduce((sum, value) => sum + value, 0);
  const busiest = useMemo(() => {
    let best = { day: 0, hour: 0, tokens: 0 };
    grid.forEach((row, day) => row.forEach((tokens, hour) => {
      if (tokens > best.tokens) best = { day, hour, tokens };
    }));
    return best;
  }, [grid]);
  const hourTotals = HOURS.map((hour) => grid.reduce((sum, row) => sum + (row[hour] ?? 0), 0));
  const busiestHour = hourTotals.indexOf(Math.max(...hourTotals));

  return (
    <section className="panel chart-panel" aria-labelledby="heatmap-title">
      <header className="panel-head">
        <div>
          <h3 id="heatmap-title">{title}</h3>
          <p>Tokens by weekday and hour, last 30 days</p>
        </div>
        {total > 0 ? (
          <div className="panel-figure">
            <strong>{`${busiestHour % 12 || 12}${busiestHour < 12 ? 'am' : 'pm'}`}</strong>
            <span>busiest hour</span>
          </div>
        ) : null}
      </header>
      {total === 0 ? (
        <div className="chart-empty">No local token events in the last 30 days.</div>
      ) : (
        <div className="heatmap" role="img" aria-label="Token activity by weekday and hour">
          <div className="heatmap-hours" aria-hidden="true">
            <span />
            {HOURS.map((hour) => (
              <span key={hour}>{hour % 6 === 0 ? `${hour % 12 || 12}${hour < 12 ? 'a' : 'p'}` : ''}</span>
            ))}
          </div>
          {DAY_ORDER.map((day) => (
            <div className="heatmap-row" key={day}>
              <span className="heatmap-day">{weekdayShort(day)}</span>
              {HOURS.map((hour) => {
                const tokens = grid[day]?.[hour] ?? 0;
                const level = max > 0 ? Math.sqrt(tokens / max) : 0;
                return (
                  <span
                    key={hour}
                    className="heatmap-cell"
                    style={{ opacity: tokens > 0 ? 0.14 + level * 0.86 : 1, background: tokens > 0 ? 'var(--accent)' : 'var(--bg)' }}
                    title={`${weekdayShort(day)} ${hour}:00, ${integer(tokens)} tokens`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      {total > 0 ? (
        <p className="panel-foot">
          Busiest slot: {weekdayShort(busiest.day)} at {busiest.hour}:00 with {compact(busiest.tokens)} tokens.
        </p>
      ) : null}
    </section>
  );
}
