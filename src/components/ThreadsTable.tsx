import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import {
  SOURCE_LABELS,
  compact,
  dateTime,
  duration,
  modelLabel,
  percent,
  readableProject,
  relativeTime,
  usd
} from '../format';
import type { ProviderCopy } from '../providers';
import type { PromptMetric, ThreadSummary, ThreadWindowUsage } from '../types';

const PAGE_SIZE = 25;

type ThreadFilter = 'all' | 'interactive' | 'scripts';
type ThreadSort = 'recent' | 'five' | 'seven' | 'tokens' | 'cost';

const INTERACTIVE_SOURCES = new Set(['desktop', 'cli', 'ide', 'voice', 'unknown']);

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length > 0 ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function usageValue(usage: ThreadWindowUsage | null): number {
  return usage ? usage.percent : -1;
}

function UsageCell({ usage }: { usage: ThreadWindowUsage | null }) {
  if (!usage) return <span className="usage-cell muted">-</span>;
  const stale = !usage.current;
  const unmeasured = usage.percent === 0 && usage.coverage < 0.05;
  const pending = unmeasured && !stale;
  const partial = !unmeasured && usage.coverage < 0.9;
  const label = pending
    ? 'pending'
    : unmeasured
      ? '<1%'
      : usage.percent > 0 && usage.percent < 0.05
        ? '<0.1%'
        : percent(usage.percent);
  const title = [
    stale ? `From the window that ended ${dateTime(usage.windowResetsAt)}` : 'Current window',
    unmeasured
      ? 'The limit did not move by a full percent while this chat was the only activity'
      : `${Math.round(usage.coverage * 100)}% of this chat's tokens were bracketed by quota samples`,
    usage.sharedPercent > 0 ? `${percent(usage.sharedPercent)} earned while other chats were running` : null
  ].filter(Boolean).join('. ');
  return (
    <span className={`usage-cell ${stale ? 'is-stale' : ''} ${unmeasured ? 'muted' : ''}`} title={title}>
      <strong>{label}</strong>
      {partial ? <small>{Math.round(usage.coverage * 100)}% covered</small> : null}
      {!partial && stale ? <small>prior window</small> : null}
    </span>
  );
}

function PromptRow({ prompt }: { prompt: PromptMetric }) {
  return (
    <li className="prompt-row">
      <span className="prompt-index">{prompt.sequence}</span>
      <div className="prompt-copy">
        <p title={prompt.prompt}>{prompt.prompt}</p>
        <span>{dateTime(prompt.startedAt)} · {modelLabel(prompt.primaryModel)}</span>
      </div>
      <dl className="prompt-metrics">
        <div><dt>Active</dt><dd>{duration(prompt.durationMs)}{prompt.timingEstimated && prompt.durationMs !== null ? '*' : ''}</dd></div>
        <div><dt>First token</dt><dd>{duration(prompt.timeToFirstTokenMs)}</dd></div>
        <div><dt>Tokens</dt><dd>{compact(prompt.totalTokens)}</dd></div>
        <div><dt>API eq.</dt><dd>{prompt.estimatedApiCostUsd === null ? '-' : usd(prompt.estimatedApiCostUsd, 3)}</dd></div>
      </dl>
    </li>
  );
}

function ThreadDetail({ thread, copy, now }: { thread: ThreadSummary; copy: ProviderCopy; now: number }) {
  const cacheWrites = Math.max(0, thread.cacheWriteInputTokens ?? 0);
  const cacheWrites1h = Math.max(0, Math.min(thread.cacheWrite1hInputTokens ?? 0, cacheWrites));
  const uncached = Math.max(0, thread.inputTokens - thread.cachedInputTokens - cacheWrites);
  const stackTotal = Math.max(1, thread.cachedInputTokens + cacheWrites + uncached + thread.outputTokens);
  const totalPromptMs = thread.prompts.reduce((sum, prompt) => sum + (prompt.durationMs ?? 0), 0);
  const averageTtft = average(thread.prompts.map((prompt) => prompt.timeToFirstTokenMs));
  const tokensPerMinute = totalPromptMs > 0 ? thread.totalTokens / (totalPromptMs / 60_000) : null;
  const anyEstimated = thread.prompts.some((prompt) => prompt.timingEstimated && prompt.durationMs !== null);
  const stack = [
    { label: 'Cached input', value: thread.cachedInputTokens, color: 'var(--ramp-1)', hint: null as string | null },
    ...(cacheWrites > 0
      ? [{
          label: 'Cache writes',
          value: cacheWrites,
          color: 'var(--ramp-4)',
          hint: cacheWrites1h > 0 ? `${compact(cacheWrites1h)} at the 1-hour rate` : null
        }]
      : []),
    { label: 'Fresh input', value: uncached, color: 'var(--ramp-2)', hint: null },
    { label: 'Output', value: thread.outputTokens, color: 'var(--ramp-3)', hint: null }
  ];

  const usageRows = [
    { label: '5-hour share', usage: thread.usage.fiveHour },
    { label: '7-day share', usage: thread.usage.sevenDay }
  ];

  return (
    <div className="thread-detail">
      <div className="detail-grid">
        <div className="detail-block">
          <h4>Tokens</h4>
          <div className="stack-bar detail-stack">
            {stack.map((item) => (
              <span key={item.label} style={{ flexGrow: item.value, background: item.color }} title={`${item.label}: ${compact(item.value)}`} />
            ))}
          </div>
          <ul className="detail-list">
            {stack.map((item) => (
              <li key={item.label}>
                <i style={{ background: item.color }} aria-hidden="true" />
                <span>{item.label}</span>
                <b>{compact(item.value)}</b>
                <small>
                  {((item.value / stackTotal) * 100).toFixed(0)}%
                  {item.hint ? <span className="detail-hint">, {item.hint}</span> : null}
                </small>
              </li>
            ))}
            {thread.reviewerTokens > 0 ? (
              <li><i className="hollow" aria-hidden="true" /><span>Auto-review overhead</span><b>{compact(thread.reviewerTokens)}</b><small>{((thread.reviewerTokens / Math.max(1, thread.totalTokens)) * 100).toFixed(0)}%</small></li>
            ) : null}
            {thread.subagentTokens > 0 ? (
              <li><i className="hollow" aria-hidden="true" /><span>Subagents</span><b>{compact(thread.subagentTokens)}</b><small>{((thread.subagentTokens / Math.max(1, thread.totalTokens)) * 100).toFixed(0)}%</small></li>
            ) : null}
          </ul>
        </div>

        <div className="detail-block">
          <h4>Share of the limit</h4>
          <ul className="detail-list">
            {usageRows.map((row) => (
              <li key={row.label}>
                <span>{row.label}</span>
                <b>{row.usage ? (row.usage.percent === 0 && row.usage.coverage < 0.05 ? 'pending' : percent(row.usage.percent)) : '-'}</b>
                <small>
                  {row.usage
                    ? row.usage.current
                      ? `${Math.round(row.usage.coverage * 100)}% covered`
                      : `window ended ${relativeTime(row.usage.windowResetsAt, now * 1000)}`
                    : 'no samples'}
                </small>
              </li>
            ))}
            {thread.usage.fiveHour && thread.usage.fiveHour.sharedPercent > 0 ? (
              <li>
                <span>Earned alongside other chats</span>
                <b>{percent(thread.usage.fiveHour.sharedPercent)}</b>
                <small>of the 5h share</small>
              </li>
            ) : null}
            <li>
              <span>Quota rises attributed</span>
              <b>{thread.usage.fiveHour?.spans ?? thread.usage.sevenDay?.spans ?? 0}</b>
              <small />
            </li>
          </ul>
        </div>

        <div className="detail-block">
          <h4>Timing</h4>
          <ul className="detail-list">
            <li><span>Prompts</span><b>{thread.prompts.length}</b><small>{thread.userMessageCount} messages</small></li>
            <li><span>Active time</span><b>{duration(totalPromptMs || null)}</b><small>{anyEstimated ? 'partly derived' : 'reported'}</small></li>
            <li><span>First token</span><b>{duration(averageTtft)}</b><small>average</small></li>
            <li><span>Tokens per minute</span><b>{tokensPerMinute === null ? '-' : compact(tokensPerMinute)}</b><small /></li>
            <li><span>Started</span><b>{dateTime(thread.startedAt)}</b><small>{thread.partCount} session {thread.partCount === 1 ? 'file' : 'files'}</small></li>
            {thread.reportedCostUsd !== null ? (
              <li>
                <span>{copy.label} estimate</span>
                <b>{usd(thread.reportedCostUsd)}</b>
                <small>from the session log</small>
              </li>
            ) : null}
          </ul>
        </div>
      </div>

      <div className="prompt-section">
        <h4>Prompts</h4>
        {thread.prompts.length === 0 ? (
          <p className="prompt-empty">Prompt-level events were not persisted for this chat.</p>
        ) : (
          <ol className="prompt-list">
            {thread.prompts.map((prompt) => <PromptRow key={prompt.promptId} prompt={prompt} />)}
          </ol>
        )}
        {anyEstimated ? <p className="prompt-note">{copy.derivedTimingNote}</p> : null}
      </div>
    </div>
  );
}

interface ThreadsTableProps {
  threads: ThreadSummary[];
  colors: Map<string, string>;
  selectedThreadId: string | null;
  copy: ProviderCopy;
  now: number;
}

export function ThreadsTable({ threads, colors, selectedThreadId, copy, now }: ThreadsTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [sort, setSort] = useState<ThreadSort>('recent');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!selectedThreadId) return;
    setExpanded((current) => new Set(current).add(selectedThreadId));
    setFilter('all');
    setQuery('');
    setSort('recent');
    setLimit((current) => {
      const index = threads.findIndex((thread) => thread.threadId === selectedThreadId);
      return index >= current ? Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE : current;
    });
    window.setTimeout(() => {
      rowRefs.current.get(selectedThreadId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }, [selectedThreadId, threads]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [filter, query, sort]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = threads.filter((thread) => {
      if (filter === 'interactive' && !INTERACTIVE_SOURCES.has(thread.source)) return false;
      if (filter === 'scripts' && thread.source !== 'exec') return false;
      if (!normalized) return true;
      return [
        thread.title,
        thread.preview ?? '',
        thread.projectName ?? '',
        thread.projectPath ?? '',
        thread.primaryModel,
        thread.sourceLabel ?? '',
        thread.reasoningEffort ?? '',
        thread.gitBranch ?? ''
      ].some((value) => value.toLowerCase().includes(normalized));
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'five') return usageValue(b.usage.fiveHour) - usageValue(a.usage.fiveHour);
      if (sort === 'seven') return usageValue(b.usage.sevenDay) - usageValue(a.usage.sevenDay);
      if (sort === 'tokens') return b.totalTokens - a.totalTokens;
      if (sort === 'cost') return (b.estimatedApiCostUsd ?? -1) - (a.estimatedApiCostUsd ?? -1);
      return (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0);
    });
  }, [filter, query, sort, threads]);

  const toggle = (threadId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  return (
    <section className="section" id="chats" aria-labelledby="chats-title">
      <header className="section-head with-tools">
        <div>
          <h2 id="chats-title">Chats</h2>
          <p>Every chat found in your local logs, with its share of each limit.</p>
        </div>
        <div className="toolbar">
          <label className="search-field">
            <Search size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">Search chats</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats, projects, models"
            />
          </label>
          <div className="segmented" role="group" aria-label="Filter chats">
            {([['all', 'All'], ['interactive', 'Interactive'], ['scripts', 'Scripts']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'active' : ''}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="select-field">
            <span className="sr-only">Sort chats</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as ThreadSort)}>
              <option value="recent">Most recent</option>
              <option value="five">5-hour share</option>
              <option value="seven">7-day share</option>
              <option value="tokens">Tokens</option>
              <option value="cost">API equivalent</option>
            </select>
          </label>
        </div>
      </header>

      {threads.length === 0 ? (
        <div className="panel chart-empty">{copy.noThreads}</div>
      ) : visible.length === 0 ? (
        <div className="panel chart-empty">No chats match this search.</div>
      ) : (
        <div className="thread-table" role="table" aria-label="Chats">
          <div className="thread-header" role="row">
            <span aria-hidden="true" />
            <span role="columnheader">Chat</span>
            <span role="columnheader">Model</span>
            <span role="columnheader" className="num">5h share</span>
            <span role="columnheader" className="num">7d share</span>
            <span role="columnheader" className="num">Tokens</span>
            <span role="columnheader" className="num">API eq.</span>
            <span role="columnheader" className="num">Active</span>
          </div>
          {visible.slice(0, limit).map((thread) => {
            const isExpanded = expanded.has(thread.threadId);
            const color = colors.get(thread.threadId);
            const project = readableProject(thread.projectName);
            return (
              <article
                key={thread.threadId}
                className={`thread-row ${isExpanded ? 'expanded' : ''}`}
                ref={(node) => {
                  if (node) rowRefs.current.set(thread.threadId, node);
                  else rowRefs.current.delete(thread.threadId);
                }}
              >
                <button
                  type="button"
                  className="thread-summary"
                  aria-expanded={isExpanded}
                  aria-controls={`detail-${thread.threadId}`}
                  onClick={() => toggle(thread.threadId)}
                >
                  <span className="thread-chevron"><ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" /></span>
                  <span className="thread-main">
                    <span className="thread-title">
                      {color ? <i className="thread-swatch" style={{ background: color }} aria-hidden="true" /> : null}
                      <span className="thread-title-text" title={thread.title}>{thread.title}</span>
                    </span>
                    <span className="thread-meta">
                      <span className={`source-tag ${thread.source}`}>{SOURCE_LABELS[thread.source] ?? 'Local'}</span>
                      {thread.sourceLabel && thread.source !== 'exec' ? <span>{thread.sourceLabel}</span> : null}
                      {project ? <span>{project}</span> : null}
                      {thread.gitBranch ? <span className="branch">{thread.gitBranch}</span> : null}
                      {thread.titleSource === 'fallback' && thread.preview ? <span className="preview">{thread.preview}</span> : null}
                    </span>
                  </span>
                  <span className="thread-model">
                    <strong>{modelLabel(thread.primaryModel)}</strong>
                    {thread.reasoningEffort ? <small>{thread.reasoningEffort}</small> : null}
                  </span>
                  <UsageCell usage={thread.usage.fiveHour} />
                  <UsageCell usage={thread.usage.sevenDay} />
                  <span className="thread-tokens">
                    <strong>{compact(thread.totalTokens)}</strong>
                    <small>{compact(thread.outputTokens)} out</small>
                  </span>
                  <span className="thread-cost">
                    <strong>{thread.estimatedApiCostUsd === null ? '-' : usd(thread.estimatedApiCostUsd)}</strong>
                    {thread.pricingStatus === 'partial' ? <small>partly priced</small> : null}
                  </span>
                  <span className="thread-time" title={dateTime(thread.updatedAt)}>{relativeTime(thread.updatedAt, now * 1000)}</span>
                </button>
                {isExpanded ? (
                  <div id={`detail-${thread.threadId}`}>
                    <ThreadDetail thread={thread} copy={copy} now={now} />
                  </div>
                ) : null}
              </article>
            );
          })}
          {visible.length > limit ? (
            <div className="thread-more">
              <button type="button" className="button ghost" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, visible.length - limit)} more of {visible.length - limit} remaining
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
