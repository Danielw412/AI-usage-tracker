import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { clock, percent } from '../format';
import type { ProjectionPoint, WindowBreakdown } from '../types';

export type UsageRange = 'five' | 'seven';

const MARGIN = { top: 16, right: 16, bottom: 0, left: 0 };
const Y_AXIS_WIDTH = 40;

function timeLabel(timestamp: number, range: UsageRange): string {
  const date = new Date(timestamp * 1000);
  return range === 'five'
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { weekday: 'short', hour: 'numeric' });
}

type TrendRow = ProjectionPoint & {
  actual: number | null;
  projection: number | null;
  overLimit: number | null;
};

function buildRows(points: ProjectionPoint[]): TrendRow[] {
  const rows: TrendRow[] = points.map((point) => ({
    ...point,
    actual: point.projected ? null : point.usedPercent,
    projection: point.projected ? point.usedPercent : null,
    overLimit: !point.projected && point.usedPercent > 100 ? point.usedPercent : null
  }));
  const firstProjected = rows.findIndex((row) => row.projected);
  if (firstProjected > 0) rows[firstProjected - 1] = { ...rows[firstProjected - 1], projection: rows[firstProjected - 1].usedPercent };
  return rows;
}

function ChartTooltip({
  active,
  payload,
  label
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number | string }>;
  label?: number | string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const projected = payload.find((row) => row.dataKey === 'projection');
  const actual = payload.find((row) => row.dataKey === 'actual') ?? payload.find((row) => row.dataKey === 'overLimit');
  const value = actual?.value ?? projected?.value;
  if (value === undefined) return null;
  return (
    <div className="chart-tooltip">
      <span>{new Date(Number(label) * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
      <strong>{percent(Number(value))}</strong>
      <em>{actual?.value !== undefined ? 'reported' : 'projected'}</em>
    </div>
  );
}

interface UsageChartProps {
  points: ProjectionPoint[];
  range: UsageRange;
  resetAt: number | null;
  breakdown: WindowBreakdown | null;
  colors: Map<string, string>;
  titles: Map<string, string>;
  now: number;
}

export function UsageChart({ points, range, resetAt, breakdown, colors, titles, now }: UsageChartProps) {
  const rows = useMemo(() => buildRows(points), [points]);
  const actualPoints = points.filter((point) => !point.projected);
  const lastActual = actualPoints.at(-1) ?? null;
  const maxValue = Math.max(100, ...points.map((point) => point.usedPercent));
  const domainStart = breakdown?.windowStartsAt ?? Math.min(...points.map((point) => point.timestamp));
  const domainEnd = Math.max(resetAt ?? 0, now, ...points.map((point) => point.timestamp));
  const resetMarkers = actualPoints.filter((point) => point.reset);

  const lanes = useMemo(() => {
    if (!breakdown) return [];
    return [...colors.entries()]
      .filter(([threadId]) => breakdown.threads.some((thread) => thread.threadId === threadId))
      .map(([threadId, color]) => ({
        threadId,
        color,
        title: titles.get(threadId) ?? 'Chat',
        runs: breakdown.activity.filter((run) => run.threadId === threadId)
      }))
      .filter((lane) => lane.runs.length > 0);
  }, [breakdown, colors, titles]);

  if (points.length < 2) {
    return <div className="chart-empty">Two or more quota samples are needed before a trend can be drawn.</div>;
  }

  const span = Math.max(1, domainEnd - domainStart);

  return (
    <div className="usage-chart">
      <div className="chart-frame usage-chart-frame">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={MARGIN}>
            <defs>
              <linearGradient id={`usage-fill-${range}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.16} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={[domainStart, domainEnd]}
              tickFormatter={(value) => timeLabel(Number(value), range)}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={[0, Math.ceil(maxValue / 25) * 25]}
              tickFormatter={(value) => `${value}%`}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={Y_AXIS_WIDTH}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--line)', strokeWidth: 1 }} />
            <ReferenceLine y={100} stroke="var(--danger)" strokeOpacity={0.55} strokeWidth={1} />
            {resetMarkers.map((point) => (
              <ReferenceLine
                key={`reset-${point.timestamp}`}
                x={point.timestamp}
                stroke="var(--ink-3)"
                strokeWidth={1}
                label={{ value: 'reset', fill: 'var(--ink-3)', fontSize: 10, position: 'insideTopRight' }}
              />
            ))}
            {resetAt ? (
              <ReferenceLine
                x={resetAt}
                stroke="var(--ink-3)"
                strokeWidth={1}
                label={{ value: `resets ${clock(resetAt)}`, fill: 'var(--ink-2)', fontSize: 10, position: 'insideTopRight' }}
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="actual"
              stroke="var(--accent)"
              strokeWidth={2}
              fill={`url(#usage-fill-${range})`}
              connectNulls={false}
              isAnimationActive={false}
              activeDot={{ r: 4, fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 2 }}
            />
            <Line
              type="monotone"
              dataKey="overLimit"
              stroke="var(--danger)"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="projection"
              stroke="var(--accent)"
              strokeOpacity={0.55}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
              activeDot={false}
            />
            {lastActual ? (
              <ReferenceDot
                x={lastActual.timestamp}
                y={lastActual.usedPercent}
                r={4.5}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {lanes.length > 0 ? (
        <div className="activity-lanes" style={{ paddingLeft: Y_AXIS_WIDTH + MARGIN.left, paddingRight: MARGIN.right }}>
          <span className="lanes-caption">When each chat was running</span>
          {lanes.map((lane) => (
            <div className="activity-lane" key={lane.threadId} title={lane.title}>
              {lane.runs.map((run, index) => (
                <span
                  key={`${lane.threadId}-${index}`}
                  style={{
                    left: `${((run.startedAt - domainStart) / span) * 100}%`,
                    width: `${Math.max(0.4, ((run.completedAt - run.startedAt) / span) * 100)}%`,
                    background: lane.color
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
