import { countdown, percent } from '../format';
import { OTHER_COLOR, UNATTRIBUTED_COLOR, UNTRACKED_COLOR } from '../palette';
import type { ProviderCopy } from '../providers';
import type { LimitProjection, RateLimitWindow, WindowBreakdown } from '../types';

interface WindowCardProps {
  title: string;
  shortLabel: string;
  limit: RateLimitWindow | null;
  projection: LimitProjection;
  breakdown: WindowBreakdown | null;
  colors: Map<string, string>;
  copy: ProviderCopy;
  primary?: boolean;
  now: number;
  onSelectThread: (threadId: string) => void;
}

interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  kind: 'thread' | 'other' | 'unattributed' | 'untracked';
  threadId?: string;
}

export function buildSegments(
  usedPercent: number,
  breakdown: WindowBreakdown | null,
  colors: Map<string, string>,
  unattributedLabel = 'Cloud tasks or other devices'
): Segment[] {
  if (!breakdown) {
    return usedPercent > 0
      ? [{ key: 'untracked', label: 'Not yet attributed', value: usedPercent, color: UNTRACKED_COLOR, kind: 'untracked' }]
      : [];
  }
  const segments: Segment[] = [];
  let colored = 0;
  for (const thread of breakdown.threads) {
    const color = colors.get(thread.threadId);
    if (!color || thread.percent < 0.05) continue;
    colored += thread.percent;
    segments.push({
      key: thread.threadId,
      label: thread.title,
      value: thread.percent,
      color,
      kind: 'thread',
      threadId: thread.threadId
    });
  }
  const other = Math.max(0, breakdown.attributedPercent - colored);
  if (other > 0.05) segments.push({ key: 'other', label: 'Other chats', value: other, color: OTHER_COLOR, kind: 'other' });
  if (breakdown.unattributedPercent > 0.05) {
    segments.push({
      key: 'unattributed',
      label: unattributedLabel,
      value: breakdown.unattributedPercent,
      color: UNATTRIBUTED_COLOR,
      kind: 'unattributed'
    });
  }
  const accounted = segments.reduce((sum, segment) => sum + segment.value, 0);
  const untracked = usedPercent - accounted;
  if (untracked > 0.5) {
    segments.push({ key: 'untracked', label: 'Before tracking began', value: untracked, color: UNTRACKED_COLOR, kind: 'untracked' });
  } else if (untracked < -0.5 && accounted > 0) {
    // Attribution drifted past the reported total; scale it back to what the provider reports.
    const scale = usedPercent / accounted;
    for (const segment of segments) segment.value *= scale;
  }
  return segments;
}

export function WindowCard({
  title,
  shortLabel,
  limit,
  projection,
  breakdown,
  colors,
  copy,
  primary = false,
  now,
  onSelectThread
}: WindowCardProps) {
  if (!limit) {
    return (
      <section className={`window-card ${primary ? 'is-primary' : ''} is-missing`} aria-label={title}>
        <header className="window-head">
          <h2>{title}</h2>
        </header>
        <p className="window-missing">{copy.windowMissing}</p>
      </section>
    );
  }

  const used = limit.usedPercent;
  const over = used > 100;
  const secondsToReset = limit.resetsAt - now;
  const scale = Math.max(100, used);
  const segments = buildSegments(used, breakdown, colors, copy.unattributedLabel);
  const remaining = Math.max(0, 100 - used);
  const resetDate = new Date(limit.resetsAt * 1000);
  const resetLabel = resetDate.toLocaleString([], {
    weekday: secondsToReset > 86_400 ? 'short' : undefined,
    hour: 'numeric',
    minute: '2-digit'
  });
  const burn = projection.percentPerHour;
  const projectedAtReset = projection.projectedPercentAtReset;
  const exhaustionIn = projection.projectedExhaustionAt && used < 100
    ? projection.projectedExhaustionAt - now
    : null;

  return (
    <section className={`window-card ${primary ? 'is-primary' : ''} ${over ? 'is-over' : ''}`} aria-label={title}>
      <header className="window-head">
        <h2>{title}</h2>
        <p className="window-reset">
          {secondsToReset > 0 ? (
            <>Resets in <strong>{countdown(secondsToReset)}</strong> <span>{resetLabel}</span></>
          ) : (
            <>Reset pending</>
          )}
        </p>
      </header>

      <div className="window-hero">
        <span className="hero-figure">
          {used.toFixed(used < 10 && used !== Math.round(used) ? 1 : 0)}
          <small>%</small>
        </span>
        <span className="hero-note">
          {over ? `${percent(used - 100)} over the limit` : used >= 100 ? 'At the limit' : `${percent(remaining)} left`}
        </span>
      </div>

      <div
        className="window-meter"
        role="meter"
        aria-label={`${title} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, used)}
        aria-valuetext={`${used}% used`}
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={`meter-segment ${segment.kind}`}
            style={{ width: `${(segment.value / scale) * 100}%`, background: segment.color }}
            title={`${segment.label}: ${percent(segment.value)}`}
          />
        ))}
        {over ? <span className="meter-limit" style={{ left: `${(100 / scale) * 100}%` }} aria-hidden="true" /> : null}
      </div>

      {segments.length > 0 ? (
        <ul className="share-legend">
          {segments.map((segment) => (
            <li key={segment.key}>
              {segment.kind === 'thread' && segment.threadId ? (
                <button type="button" onClick={() => onSelectThread(segment.threadId!)} title="Show this chat">
                  <i style={{ background: segment.color }} aria-hidden="true" />
                  <span>{segment.label}</span>
                </button>
              ) : (
                <span className="legend-static">
                  <i className={segment.kind} style={{ background: segment.color }} aria-hidden="true" />
                  <span>{segment.label}</span>
                </span>
              )}
              <b>{percent(segment.value)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="share-empty">No usage recorded in this {shortLabel} window yet.</p>
      )}

      <dl className="window-facts">
        <div>
          <dt>Burn rate</dt>
          <dd>{burn === null ? 'Collecting' : `${burn.toFixed(burn < 10 ? 1 : 0)}% / hr`}</dd>
        </div>
        <div>
          <dt>{used >= 100 ? 'Limit reached' : exhaustionIn ? 'Limit in' : 'Projected at reset'}</dt>
          <dd>
            {used >= 100
              ? `until ${resetLabel}`
              : exhaustionIn
                ? countdown(exhaustionIn)
                : projectedAtReset === null
                  ? 'Collecting'
                  : percent(projectedAtReset)}
          </dd>
        </div>
        {breakdown && breakdown.cloudTasksInWindow > 0 ? (
          <div>
            <dt>Cloud tasks</dt>
            <dd>{breakdown.cloudTasksInWindow} in window</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
