import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOverview, refreshOverview } from './api';
import { ActivityHeatmap, DailyTokenChart } from './components/Charts';
import { CloudTasks } from './components/CloudTasks';
import { ModelLedger } from './components/ModelLedger';
import { StatStrip } from './components/StatStrip';
import { ThreadsTable } from './components/ThreadsTable';
import { Topbar, type Section } from './components/Topbar';
import { UsageChart, type UsageRange } from './components/UsageChart';
import { WindowCard } from './components/WindowCard';
import { percent } from './format';
import { assignSeriesColors } from './palette';
import type { DashboardOverview } from './types';

const SECTIONS: Section[] = ['overview', 'chats', 'models', 'cloud'];

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-busy="true">
      <div className="loading-card">
        <span className="wordmark-mark large" aria-hidden="true" />
        <h1>Reading your Codex activity</h1>
        <p>Indexing local session logs and asking Codex for the current limits.</p>
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

export default function App() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<UsageRange>('five');
  const [activeSection, setActiveSection] = useState<Section>('overview');
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async (force = false) => {
    try {
      if (force) setRefreshing(true);
      const next = force ? await refreshOverview() : await getOverview();
      setOverview(next);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const poll = window.setInterval(() => void load(false), 60_000);
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

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
    if (!overview) return;
    const five = overview.limits.fiveHour;
    const seven = overview.limits.sevenDay;
    const parts = [
      five ? `5h ${percent(five.usedPercent, 0)}` : null,
      seven ? `7d ${percent(seven.usedPercent, 0)}` : null
    ].filter(Boolean);
    document.title = parts.length > 0 ? `${parts.join(' / ')} | Codex usage` : 'Codex usage';
  }, [overview]);

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

  const dailyData = useMemo(() => {
    if (!overview) return [];
    return overview.accountDailyUsage.length > 0 ? overview.accountDailyUsage : overview.localDailyUsage;
  }, [overview]);

  if (!overview && !error) return <LoadingScreen />;

  if (!overview) {
    return (
      <main className="loading-screen">
        <div className="loading-card">
          <h1>The dashboard server is not answering</h1>
          <p>{error}</p>
          <button className="button" type="button" onClick={() => void load(false)}>Try again</button>
        </div>
      </main>
    );
  }

  const selectedLimit = range === 'five' ? overview.limits.fiveHour : overview.limits.sevenDay;
  const selectedPoints = range === 'five' ? overview.histories.fiveHour : overview.histories.sevenDay;
  const selectedBreakdown = range === 'five' ? overview.breakdown.fiveHour : overview.breakdown.sevenDay;

  return (
    <div className="app">
      <a className="skip-link" href="#overview">Skip to content</a>
      <Topbar
        active={activeSection}
        onNavigate={navigate}
        connected={overview.connection.codexConnected}
        planType={overview.account.planType ?? overview.connection.planType}
        updatedAt={overview.generatedAt}
        refreshing={refreshing}
        onRefresh={() => void load(true)}
      />

      <main className="page">
        {error ? <div className="inline-alert" role="alert">{error}</div> : null}
        {overview.connection.error ? (
          <div className="inline-alert" role="status">
            Codex connection: {overview.connection.error}
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
              now={now}
              onSelectThread={selectThread}
            />
          </div>

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

          <StatStrip overview={overview} />
        </section>

        <ThreadsTable
          threads={overview.threads}
          colors={colors}
          selectedThreadId={selectedThread}
          now={now}
        />

        <section className="section" id="models" aria-labelledby="models-title">
          <header className="section-head">
            <h2 id="models-title">Models and rhythm</h2>
            <p>What each model costs against the limit, and when the work happens.</p>
          </header>
          <div className="models-grid">
            <DailyTokenChart data={dailyData} />
            <ActivityHeatmap grid={overview.hourlyActivity} />
          </div>
          <ModelLedger usage={overview.modelUsage} efficiency={overview.modelEfficiency} />
        </section>

        <CloudTasks cloud={overview.cloudTasks} breakdown={overview.breakdown} now={now} />

        <footer className="page-foot">
          <span>Percentages and reset times come from Codex. Chat shares and API-equivalent prices are local estimates.</span>
        </footer>
      </main>
    </div>
  );
}
