import { useEffect, useId, useRef, useState } from 'react';
import { dateTime, integer, relativeTime } from '../format';
import type { DeviceStatus, SyncOverview } from '../types';

/** How far behind "now" attribution can be settled before it is worth mentioning. */
const SETTLED_LAG_SECONDS = 10 * 60;

function describe(device: DeviceStatus, now: number): string {
  if (device.self) return 'Hosts the dashboard and polls quota';
  if (device.online) {
    const synced = device.lastSyncAt ?? device.lastSeenAt;
    return synced ? `Online, synced ${relativeTime(synced, now * 1000)}` : 'Online';
  }
  return device.lastSeenAt ? `Offline, last seen ${relativeTime(device.lastSeenAt, now * 1000)}` : 'Offline';
}

function settledNote(sync: SyncOverview, now: number): string {
  if (sync.settledThrough === null) {
    return 'Attribution stays provisional until every device has finished its first sync.';
  }
  if (now - sync.settledThrough <= SETTLED_LAG_SECONDS) return 'Every device is up to date.';
  const behind = sync.devices
    .filter((device) => !device.self && (device.syncedThrough === null || device.syncedThrough <= sync.settledThrough!))
    .map((device) => device.label);
  const who = behind.length > 0 ? behind.join(', ') : 'a device';
  return `Windows after ${dateTime(sync.settledThrough)} stay provisional until ${who} syncs.`;
}

/**
 * A small topbar pill listing the machines that report usage, shown once more
 * than one device is involved. Details open in a popover so device state never
 * crowds the dashboard itself.
 */
export function DeviceStatusMenu({ sync, now }: { sync: SyncOverview; now: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!sync.multiDevice && sync.role !== 'server') return null;
  const offline = sync.devices.filter((device) => !device.self && !device.online).length;
  const warnings = sync.devices.some((device) => device.warning);
  const tone = offline > 0 || warnings ? 'attention' : 'online';
  const label = `${sync.devices.length} ${sync.devices.length === 1 ? 'device' : 'devices'}${offline > 0 ? `, ${offline} offline` : ''}`;

  return (
    <div className="device-menu" ref={rootRef}>
      <button
        type="button"
        className={`status-pill device-pill ${tone}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <i aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <div className="device-popover" id={panelId} role="dialog" aria-label="Devices">
          <header>
            <strong>Devices</strong>
            <span>Usage from every device is combined on this server.</span>
          </header>
          <ul>
            {sync.devices.map((device) => (
              <li key={device.deviceId}>
                <span className={`device-dot ${device.online ? 'online' : 'offline'}`} aria-hidden="true" />
                <div className="device-main">
                  <strong>
                    {device.label}
                    {device.self ? <em>this server</em> : null}
                  </strong>
                  <span>{describe(device, now)}</span>
                  {device.warning ? <span className="device-warning">{device.warning}</span> : null}
                </div>
                <dl>
                  <div>
                    <dt>Queued</dt>
                    <dd>{device.self ? '-' : device.pendingRecords === null ? '-' : integer(device.pendingRecords)}</dd>
                  </div>
                  <div>
                    <dt>Synced through</dt>
                    <dd>{device.syncedThrough ? dateTime(device.syncedThrough) : 'Not yet'}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="device-foot">{settledNote(sync, now)}</p>
        </div>
      ) : null}
    </div>
  );
}
