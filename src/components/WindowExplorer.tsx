import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getWindowDetail, getWindows } from '../api';
import { SOURCE_LABELS, clock, compact, modelLabel, percent, usd } from '../format';
import { seriesColorsFor } from '../palette';
import type { DashboardOverview, ProviderId, WindowBreakdown, WindowDetail, WindowSession, WindowSummary } from '../types';
import { UsageChart, type UsageRange } from './UsageChart';

const DURATION: Record<UsageRange, number> = { five: 300, seven: 10_080 };
const SESSION_PAGE = 10;

interface WindowExplorerProps {
  provider: ProviderId;
  overview: DashboardOverview;
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
  colors: Map<string, string>;
  titles: Map<string, string>;
  /** Device id to label, when more than one device reports usage. */
  deviceLabels: Map<string, string> | null;
  /** Set while a device is behind; windows it has not reached are provisional. */
  provisionalNote: string | null;
  now: number;
  onSelectThread: (threadId: string) => void;
}

function WindowToggle({ value, onChange }: { value: UsageRange; onChange: (value: UsageRange) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Usage window">
      {([['five', '5 hours'], ['seven', '7 days']] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={value === key ? 'active' : ''}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function shortDay(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function windowLabel(window: WindowSummary, range: UsageRange): string {
  if (range === 'five') return `${shortDay(window.windowStartsAt)}, ${clock(window.windowStartsAt)} to ${clock(window.resetsAt)}`;
  const day = (timestamp: number) => new Date(timestamp * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day(window.windowStartsAt)} to ${day(window.resetsAt)}`;
}

function shareLabel(value: number): string {
  if (value <= 0) return '-';
  return value < 0.05 ? '<0.1%' : percent(value);
}

/** The shape the usage chart's activity lanes expect, built from a window detail. */
function breakdownFrom(detail: WindowDetail): WindowBreakdown {
  return {
    resetsAt: detail.resetsAt,
    windowStartsAt: detail.windowStartsAt,
    observedDeltaPercent: detail.observedDeltaPercent,
    attributedPercent: detail.attributedPercent,
    unattributedPercent: detail.unattributedPercent,
    samples: detail.samples,
    threads: detail.sessions
      .filter((session) => session.percent > 0)
      .slice(0, 8)
      .map((session) => ({
        threadId: session.threadId,
        title: session.title,
        model: session.model,
        percent: session.percent,
        coverage: session.coverage,
        sharedPercent: session.sharedPercent,
        deviceIds: session.deviceIds
      })),
    activity: detail.activity,
    cloudTasksInWindow: 0,
    provisional: detail.provisional
  };
}

function SessionRow({
  session,
  color,
  deviceLabels,
  selectable,
  onSelect
}: {
  session: WindowSession;
  color: string | undefined;
  deviceLabels: Map<string, string> | null;
  selectable: boolean;
  onSelect: () => void;
}) {
  const title = (
    <span className="window-session-title">
      {color ? <i className="thread-swatch" style={{ background: color }} aria-hidden="true" /> : null}
      <span title={session.title}>{session.title}</span>
    </span>
  );
  return (
    <li className="window-session" role="row">
      <span className="window-session-main" role="cell">
        {selectable ? (
          <button type="button" onClick={onSelect} title="Show this chat">{title}</button>
        ) : title}
        <span className="thread-meta">
          {deviceLabels
            ? session.deviceIds.map((deviceId) => (
                <span key={deviceId} className="device-tag">{deviceLabels.get(deviceId) ?? deviceId}</span>
              ))
            : null}
          <span className={`source-tag ${session.source}`}>{SOURCE_LABELS[session.source] ?? 'Local'}</span>
          {session.projectName ? <span>{session.projectName}</span> : null}
        </span>
      </span>
      <span className="window-session-model" role="cell">{modelLabel(session.model)}</span>
      <span className="num" role="cell" title={`${Math.round(session.coverage * 100)}% of this chat's weighted tokens were bracketed by quota samples`}>
        <strong>{shareLabel(session.percent)}</strong>
        {session.sharedPercent > 0.05 ? <small>{percent(session.sharedPercent)} shared</small> : null}
      </span>
      <span className="num" role="cell">{compact(session.tokens)}</span>
      <span className="num" role="cell">{session.costUsd > 0 ? usd(session.costUsd) : '-'}</span>
    </li>
  );
}

/**
 * The usage chart plus a picker for past 5-hour and 7-day windows. The current
 * window keeps its projection; a past window shows its recorded samples, and
 * both list the chats (from every device) that used it.
 */
export function WindowExplorer({
  provider,
  overview,
  range,
  onRangeChange,
  colors,
  titles,
  deviceLabels,
  provisionalNote,
  now,
  onSelectThread
}: WindowExplorerProps) {
  const duration = DURATION[range];
  const [windows, setWindows] = useState<WindowSummary[]>([]);
  /** Reset time of the chosen past window; null follows the current one. */
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<WindowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const currentLimit = range === 'five' ? overview.limits.fiveHour : overview.limits.sevenDay;
  const currentEntry = windows.find((window) => window.current) ?? null;
  // With no live window (provider not reporting), open the latest recorded one.
  const effectiveSelected = selected ?? (currentLimit ? null : windows[0]?.resetsAt ?? null);
  const activeResetsAt = effectiveSelected ?? currentEntry?.resetsAt ?? currentLimit?.resetsAt ?? null;

  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setWindows([]);
  }, [provider, range]);

  useEffect(() => {
    setShowAll(false);
  }, [selected, range]);

  useEffect(() => {
    let cancelled = false;
    getWindows(provider, duration)
      .then((list) => {
        if (!cancelled) setWindows(list);
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, duration, overview.generatedAt]);

  useEffect(() => {
    if (activeResetsAt === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    getWindowDetail(provider, duration, activeResetsAt)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setError(null);
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, duration, activeResetsAt, overview.generatedAt]);

  const isCurrent = effectiveSelected === null;
  const index = windows.findIndex((window) => (isCurrent ? window.current : window.resetsAt === effectiveSelected));
  const older = index >= 0 ? windows[index + 1] ?? null : windows[0] ?? null;
  const newer = index > 0 ? windows[index - 1] : null;
  const shown = detail && Math.abs(detail.resetsAt - (activeResetsAt ?? 0)) <= 180 ? detail : null;

  const choose = (window: WindowSummary | null) => {
    if (!window) return;
    setSelected(window.current ? null : window.resetsAt);
  };

  const sessions = shown?.sessions ?? [];
  const pastColors = useMemo(
    () => seriesColorsFor(sessions.filter((session) => session.percent > 0).map((session) => session.threadId), colors),
    [sessions, colors]
  );
  const sessionColors = isCurrent ? colors : pastColors;
  const chartTitles = useMemo(() => {
    const map = new Map(titles);
    for (const session of sessions) if (!map.has(session.threadId)) map.set(session.threadId, session.title);
    return map;
  }, [titles, sessions]);
  const knownThreads = useMemo(() => new Set(overview.threads.map((thread) => thread.threadId)), [overview.threads]);

  const chart = isCurrent
    ? {
        points: range === 'five' ? overview.histories.fiveHour : overview.histories.sevenDay,
        resetAt: currentLimit?.resetsAt ?? null,
        breakdown: range === 'five' ? overview.breakdown.fiveHour : overview.breakdown.sevenDay,
        now
      }
    : shown
      ? { points: shown.points, resetAt: shown.resetsAt, breakdown: breakdownFrom(shown), now: shown.endsAt }
      : null;

  const summary = shown ?? (index >= 0 ? windows[index] : null);
  const subtitle = isCurrent
    ? currentLimit
      ? `Current window, resets ${shortDay(currentLimit.resetsAt)} at ${clock(currentLimit.resetsAt)}`
      : 'Reported percentage, the projected path to reset, and when each chat was running.'
    : summary
      ? `${windowLabel(summary, range)}, ${summary.resetsAt > now ? 'still open' : 'ended'}`
      : 'Loading window';
  const visibleSessions = showAll ? sessions : sessions.slice(0, SESSION_PAGE);

  return (
    <div className="panel usage-panel">
      <header className="panel-head window-explorer-head">
        <div>
          <h3>Usage over the window</h3>
          <p>{subtitle}</p>
        </div>
        <div className="window-controls">
          <WindowToggle value={range} onChange={onRangeChange} />
          <div className="window-nav" role="group" aria-label="Choose a window">
            <button
              type="button"
              className="icon-button"
              onClick={() => choose(older)}
              disabled={!older}
              aria-label="Previous window"
              title="Previous window"
            >
              <ChevronLeft size={15} strokeWidth={1.75} />
            </button>
            <label className="select-field">
              <span className="sr-only">Window</span>
              <select
                value={isCurrent ? 'current' : String(effectiveSelected)}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelected(value === 'current' ? null : Number(value));
                }}
              >
                {currentEntry || currentLimit ? <option value="current">Current window</option> : null}
                {windows.filter((window) => !window.current).map((window) => (
                  <option key={window.resetsAt} value={window.resetsAt}>
                    {windowLabel(window, range)}, {percent(window.finalPercent, 0)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="icon-button"
              onClick={() => (newer ? choose(newer) : setSelected(null))}
              disabled={isCurrent || (!newer && !currentLimit)}
              aria-label="Next window"
              title="Next window"
            >
              <ChevronRight size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </header>

      {chart ? (
        <UsageChart
          points={chart.points}
          range={range}
          resetAt={chart.resetAt}
          breakdown={chart.breakdown}
          colors={sessionColors}
          titles={chartTitles}
          now={chart.now}
        />
      ) : (
        <div className="chart-empty">{error ?? 'Loading this window.'}</div>
      )}

      {summary ? (
        <dl className="window-summary">
          <div>
            <dt>{isCurrent || summary.resetsAt > now ? 'Used so far' : 'Final usage'}</dt>
            <dd>{percent(summary.finalPercent, 0)}</dd>
          </div>
          <div>
            <dt>Attributed</dt>
            <dd>
              {percent(summary.attributedPercent)}
              {shown ? <small>{Math.round(shown.coverage * 100)}% of the rise</small> : null}
            </dd>
          </div>
          <div>
            <dt>Unattributed</dt>
            <dd>{percent(summary.unattributedPercent)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{compact(summary.tokens)}</dd>
          </div>
          <div>
            <dt>API equivalent</dt>
            <dd>{usd(summary.costUsd)}</dd>
          </div>
          {deviceLabels && shown && shown.devices.length > 0 ? (
            <div className="window-summary-devices">
              <dt>By device</dt>
              <dd>
                {shown.devices.map((device) => (
                  <span key={device.deviceId}>
                    {deviceLabels.get(device.deviceId) ?? device.deviceId} <b>{percent(device.percent)}</b>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {summary.provisional && provisionalNote ? (
            <div>
              <dt>Chat shares</dt>
              <dd>
                <span className="provisional-tag" title={`${provisionalNote}; shares update when its events arrive.`}>
                  Provisional
                </span>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {shown && sessions.length > 0 ? (
        <div className="window-sessions" role="table" aria-label="Chats in this window">
          <div className="window-session window-session-header" role="row">
            <span role="columnheader">Chat</span>
            <span role="columnheader" className="window-session-model">Model</span>
            <span role="columnheader" className="num">Share</span>
            <span role="columnheader" className="num">Tokens</span>
            <span role="columnheader" className="num">API eq.</span>
          </div>
          <ul>
            {visibleSessions.map((session) => (
              <SessionRow
                key={session.threadId}
                session={session}
                color={sessionColors.get(session.threadId)}
                deviceLabels={deviceLabels}
                selectable={knownThreads.has(session.threadId)}
                onSelect={() => onSelectThread(session.threadId)}
              />
            ))}
          </ul>
          {sessions.length > SESSION_PAGE ? (
            <button type="button" className="window-sessions-more" onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Show fewer' : `Show all ${sessions.length} chats`}
            </button>
          ) : null}
        </div>
      ) : shown ? (
        <p className="panel-foot">No chat logged tokens in this window.</p>
      ) : null}
    </div>
  );
}
