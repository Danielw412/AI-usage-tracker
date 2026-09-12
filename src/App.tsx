import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getOverview, getProviders, refreshOverview } from './api';
import { ActivityHeatmap, DailyTokenChart } from './components/Charts';
import { CloudTasks } from './components/CloudTasks';
import { ExtraLimits } from './components/ExtraLimits';
import { ModelLedger } from './components/ModelLedger';
import { StatStrip } from './components/StatStrip';
import { ThreadsTable } from './components/ThreadsTable';
import { Topbar, type Section } from './components/Topbar';
import { UsageChart, type UsageRange } from './components/UsageChart';
import { WindowCard } from './components/WindowCard';
import { percent } from './format';
import { assignSeriesColors } from './palette';
import { DEFAULT_PROVIDER, PROVIDERS, isProviderId, type ProviderCopy } from './providers';
import type { DashboardOverview, ProviderId, ProviderInfo } from './types';

const SECTIONS: Section[] = ['overview', 'chats', 'models', 'cloud'];
const PROVIDER_STORAGE_KEY = 'usage-dashboard.provider';

function initialProvider(): ProviderId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('provider');
    if (isProviderId(fromUrl)) return fromUrl;
    const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (isProviderId(stored)) return stored;
  } catch {
    // Private windows can refuse storage access; fall back to the default.
  }
  return DEFAULT_PROVIDER;
}

function rememberProvider(provider: ProviderId): void {
  try {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  } catch {
    // Storage is a convenience only.
  }
  const url = new URL(window.location.href);
  url.searchParams.set('provider', provider);
  window.history.replaceState(null, '', url);
}

function LoadingScreen({ copy }: { copy: ProviderCopy }) {
  return (
    <main className="loading-screen" aria-busy="true">
      <div className="loading-card">
        <span className="wordmark-mark large" aria-hidden="true" />
        <h1>{copy.loading.title}</h1>
        <p>{copy.loading.body}</p>
        <div className="loading-bars" aria-hidden="true"><span /><span /><span /></div>
      </div>
    </main>
  );
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

const FALLBACK_PROVIDERS: ProviderInfo[] = [
  { id: 'codex', label: PROVIDERS.codex.label, enabled: true },
  { id: 'claude', label: PROVIDERS.claude.label, enabled: true }
];

export default function App() {
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [providers, setProviders] = useState<ProviderInfo[]>(FALLBACK_PROVIDERS);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<UsageRange>('five');
  const [activeSection, setActiveSection] = useState<Section>('overview');
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // Responses for a provider that is no longer selected are dropped.
  const requestSequence = useRef(0);
  const copy = PROVIDERS[provider];

  const load = useCallback(async (force = false) => {
    const sequence = ++requestSequence.current;
    try {
      if (force) setRefreshing(true);
      const next = force ? await refreshOverview(provider) : await getOverview(provider);
      if (sequence !== requestSequence.current) return;
      setOverview(next);
      setError(null);
    } catch (caught) {
      if (sequence !== requestSequence.current) return;
      setError((caught as Error).message);
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false);
    }
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    getProviders()
      .then((result) => {
        if (cancelled) return;
        if (result.providers.length > 0) setProviders(result.providers);
        const current = result.providers.find((item) => item.id === provider);
        if (current && !current.enabled) {
          const fallback = result.providers.find((item) => item.enabled)?.id ?? result.defaultProvider;
          if (isProviderId(fallback) && fallback !== provider) setProvider(fallback);
        }
      })
      .catch(() => {
        // The overview request reports connectivity problems; the switch keeps its defaults.
      });
    return () => {
      cancelled = true;
    };
    // Only on mount: later provider changes come from the switch itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rememberProvider(provider);
    setOverview(null);
    setError(null);
    setSelectedThread(null);
    setActiveSection('overview');
    void load(false);
    const poll = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(poll);
  }, [provider, load]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!overview) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActiveSection(visible.target.id as Section);
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: [0, 0.1, 0.5] }
    );
    for (const id of SECTIONS) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [overview]);

  useEffect(() => {
    if (!overview) {
      document.title = copy.appName;
      return;
    }
    const five = overview.limits.fiveHour;
    const seven = overview.limits.sevenDay;
    const parts = [
      five ? `5h ${percent(five.usedPercent, 0)}` : null,
      seven ? `7d ${percent(seven.usedPercent, 0)}` : null
    ].filter(Boolean);
    document.title = parts.length > 0 ? `${parts.join(' / ')} | ${copy.appName}` : copy.appName;
  }, [overview, copy]);

  const colors = useMemo(() => {
    if (!overview) return new Map<string, string>();
    const ranked = new Map<string, number>();
    for (const breakdown of [overview.breakdown.fiveHour, overview.breakdown.sevenDay]) {
      for (const thread of breakdown?.threads ?? []) {
        ranked.set(thread.threadId, Math.max(ranked.get(thread.threadId) ?? 0, thread.percent));
      }
    }
    const ordered = [...ranked.entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([threadId]) => threadId);
    return assignSeriesColors(ordered);
  }, [overview]);

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const thread of overview?.threads ?? []) map.set(thread.threadId, thread.title);
    for (const breakdown of [overview?.breakdown.fiveHour, overview?.breakdown.sevenDay]) {
      for (const thread of breakdown?.threads ?? []) if (!map.has(thread.threadId)) map.set(thread.threadId, thread.title);
    }
    return map;
  }, [overview]);

  const navigate = useCallback((section: Section) => {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const selectThread = useCallback((threadId: string) => {
    setSelectedThread(threadId);
    setActiveSection('chats');
  }, []);

  const switchProvider = useCallback((next: ProviderId) => {
    if (next === provider) return;
    requestSequence.current += 1;
    setRefreshing(false);
    setProvider(next);
  }, [provider]);

  const dailyData = useMemo(() => {
    if (!overview) return [];
    return overview.accountDailyUsage.length > 0 ? overview.accountDailyUsage : overview.localDailyUsage;
  }, [overview]);

  if (!overview && !error) return <LoadingScreen copy={copy} />;

  if (!overview) {
    return (
      <main className="loading-screen">
        <div className="loading-card">
          <h1>The dashboard server is not answering</h1>
          <p>{error}</p>
          <div className="loading-actions">
            <button className="button" type="button" onClick={() => void load(false)}>Try again</button>
            {providers.filter((item) => item.id !== provider && item.enabled).map((item) => (
              <button key={item.id} className="button ghost" type="button" onClick={() => switchProvider(item.id)}>
                Show {item.label}
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  const selectedLimit = range === 'five' ? overview.limits.fiveHour : overview.limits.sevenDay;
  const selectedPoints = range === 'five' ? overview.histories.fiveHour : overview.histories.sevenDay;
  const selectedBreakdown = range === 'five' ? overview.breakdown.fiveHour : overview.breakdown.sevenDay;

  return (
    <div className="app" data-provider={provider}>
      <a className="skip-link" href="#overview">Skip to content</a>
      <Topbar
        active={activeSection}
        onNavigate={navigate}
        provider={provider}
        providers={providers}
        onProviderChange={switchProvider}
        copy={copy}
        connected={overview.connection.connected}
        planType={overview.account.planType ?? overview.connection.planType}
        updatedAt={overview.generatedAt}
        refreshing={refreshing}
        onRefresh={() => void load(true)}
      />

      <main className="page">
        {error ? <div className="inline-alert" role="alert">{error}</div> : null}
        {overview.connection.error ? (
          <div className="inline-alert" role="status">
            {copy.label} connection: {overview.connection.error}
          </div>
        ) : null}

        <section className="section overview" id="overview" aria-label="Overview">
          <div className="window-grid">
            <WindowCard
              title="5-hour window"
              shortLabel="5-hour"
              limit={overview.limits.fiveHour}
              projection={overview.projections.fiveHour}
              breakdown={overview.breakdown.fiveHour}
              colors={colors}
              copy={copy}
              primary
              now={now}
              onSelectThread={selectThread}
            />
            <WindowCard
              title="7-day window"
              shortLabel="7-day"
              limit={overview.limits.sevenDay}
              projection={overview.projections.sevenDay}
              breakdown={overview.breakdown.sevenDay}
              colors={colors}
              copy={copy}
              now={now}
              onSelectThread={selectThread}
            />
          </div>

          <ExtraLimits windows={overview.limits.other} now={now} />

          <div className="panel usage-panel">
            <header className="panel-head">
              <div>
                <h3>Usage over the window</h3>
                <p>Reported percentage, the projected path to reset, and when each chat was running.</p>
              </div>
              <WindowToggle value={range} onChange={setRange} />
            </header>
            <UsageChart
              points={selectedPoints}
              range={range}
              resetAt={selectedLimit?.resetsAt ?? null}
              breakdown={selectedBreakdown}
              colors={colors}
              titles={titles}
              now={now}
            />
          </div>

          <StatStrip overview={overview} copy={copy} />
        </section>

        <ThreadsTable
          threads={overview.threads}
          colors={colors}
          selectedThreadId={selectedThread}
          copy={copy}
          now={now}
        />

        <section className="section" id="models" aria-labelledby="models-title">
          <header className="section-head">
            <h2 id="models-title">Models and rhythm</h2>
            <p>What each model costs against the limit, and when the work happens.</p>
          </header>
          <div className="models-grid">
            <DailyTokenChart data={dailyData} />
            <ActivityHeatmap grid={overview.hourlyActivity} title={copy.heatmapTitle} />
          </div>
          <ModelLedger usage={overview.modelUsage} efficiency={overview.modelEfficiency} />
        </section>

        <CloudTasks cloud={overview.cloudTasks} breakdown={overview.breakdown} copy={copy} now={now} />

        <footer className="page-foot">
          <span>{copy.footer}</span>
        </footer>
      </main>
    </div>
  );
}
