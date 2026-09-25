import { RefreshCw } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { DeviceStatusMenu } from './DeviceStatus';
import { clock, sentence } from '../format';
import type { ProviderCopy } from '../providers';
import type { ProviderId, ProviderInfo, SyncOverview } from '../types';

export type Section = 'overview' | 'chats' | 'models' | 'cloud';

const NAV: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'chats', label: 'Chats' },
  { id: 'models', label: 'Models' },
  { id: 'cloud', label: 'Cloud' }
];

interface TopbarProps {
  active: Section;
  onNavigate: (section: Section) => void;
  provider: ProviderId;
  providers: ProviderInfo[];
  onProviderChange: (provider: ProviderId) => void;
  copy: ProviderCopy;
  connected: boolean;
  planType: string | null;
  updatedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
  sync: SyncOverview | undefined;
  now: number;
}

export function Topbar({
  active,
  onNavigate,
  provider,
  providers,
  onProviderChange,
  copy,
  connected,
  planType,
  updatedAt,
  refreshing,
  onRefresh,
  sync,
  now
}: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-brand">
          <a className="wordmark" href="#overview" onClick={(event) => { event.preventDefault(); onNavigate('overview'); }}>
            <BrandLogo />
            <span>{copy.appName}</span>
          </a>
          <div className="segmented provider-switch" role="group" aria-label="Provider">
            {providers.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === provider ? 'active' : ''}
                aria-pressed={item.id === provider}
                disabled={!item.enabled}
                title={item.enabled ? `Show ${item.label} usage` : 'Turned off in .env'}
                onClick={() => onProviderChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <nav className="topnav" aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === active ? 'active' : ''}
              aria-current={item.id === active ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="topbar-status">
          {sync ? <DeviceStatusMenu sync={sync} now={now} /> : null}
          <span className={`status-pill ${connected ? 'online' : 'offline'}`}>
            <i aria-hidden="true" />
            {connected ? (planType ? `${sentence(planType)} plan` : 'Connected') : copy.offline}
          </span>
          <span className="updated-at">Updated {clock(updatedAt)}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh usage data"
            title="Refresh"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={15} strokeWidth={1.75} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </div>
    </header>
  );
}
