import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TrackerRole } from './types.js';

export type { TrackerRole };

/**
 * How this installation takes part in multi-device tracking:
 *
 * - `standalone`: one machine, as before. Scans its own sessions, polls quota,
 *   serves the dashboard. No sync API.
 * - `server`: the central authority. Everything `standalone` does, plus it
 *   accepts usage events from collectors and attributes quota across devices.
 * - `collector`: scans local sessions and forwards events to the server through
 *   a durable outbox. It does not poll account quota or attribute anything.
 */
export const TRACKER_ROLES: TrackerRole[] = ['standalone', 'server', 'collector'];
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface SyncSettings {
  /** Base URL of the central server, for collectors. */
  centralUrl: string | null;
  /** Shared secret both sides send and check. */
  secret: string | null;
  /** Records per upload request. */
  batchSize: number;
  /** How long a burst of local changes is coalesced before uploading. */
  debounceMs: number;
  /** Heartbeat and reconciliation cadence, even when nothing changed. */
  heartbeatMs: number;
  /** Longest wait between retries while the server is unreachable. */
  maxBackoffMs: number;
  /** A collector silent for longer than this no longer holds history provisional. */
  retireAfterDays: number;
}

export interface TrackerConfig {
  role: TrackerRole;
  /** Stable identifier for this machine; every event it produces carries it. */
  deviceId: string;
  /** Human-readable name shown in the dashboard. */
  deviceLabel: string;
  /** Random per-installation id, used to notice two installs sharing a device id. */
  installId: string;
  dataDir: string;
  /** Watch session folders for changes instead of waiting for the periodic scan. */
  watchSessions: boolean;
  /** Poll account-level quota, account details, and cloud tasks. */
  quotaPolling: boolean;
  sync: SyncSettings;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function flagEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return !/^(false|0|no|off)$/i.test(value.trim());
}

/** A hostname turned into something usable as a device id. */
export function slugDeviceId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64);
  return slug || 'device';
}

interface DeviceIdentityFile {
  deviceId: string;
  installId: string;
  createdAt: number;
}

function readIdentity(file: string): DeviceIdentityFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeviceIdentityFile>;
    if (typeof parsed.deviceId !== 'string' || typeof parsed.installId !== 'string') return null;
    return {
      deviceId: parsed.deviceId,
      installId: parsed.installId,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Math.floor(Date.now() / 1000)
    };
  } catch {
    return null;
  }
}

function normalizeUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`CENTRAL_URL is not a valid URL: "${trimmed}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`CENTRAL_URL must start with http:// or https:// (got "${trimmed}").`);
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Read the role, device identity, and sync settings from the environment. The
 * device id defaults to the hostname and is remembered in `<data>/device.json`,
 * so renaming the machine later does not split its history.
 */
export function loadTrackerConfig(env: NodeJS.ProcessEnv = process.env): TrackerConfig {
  const rawRole = (env.TRACKER_ROLE ?? '').trim().toLowerCase() || 'standalone';
  if (!TRACKER_ROLES.includes(rawRole as TrackerRole)) {
    throw new ConfigError(`TRACKER_ROLE must be standalone, server, or collector (got "${env.TRACKER_ROLE}").`);
  }
  const role = rawRole as TrackerRole;

  const dataDir = path.resolve(env.DATA_DIR?.trim() || path.join(process.cwd(), 'data'));
  fs.mkdirSync(dataDir, { recursive: true });

  const configuredId = env.DEVICE_ID?.trim();
  if (configuredId && !DEVICE_ID_PATTERN.test(configuredId)) {
    throw new ConfigError(
      `DEVICE_ID may only contain letters, digits, ".", "_" and "-", up to 64 characters (got "${configuredId}").`
    );
  }
  const identityFile = path.join(dataDir, 'device.json');
  const stored = readIdentity(identityFile);
  const deviceId = configuredId || stored?.deviceId || slugDeviceId(os.hostname());
  const installId = stored?.installId ?? crypto.randomUUID();
  if (!stored || stored.deviceId !== deviceId) {
    const identity: DeviceIdentityFile = {
      deviceId,
      installId,
      createdAt: stored?.createdAt ?? Math.floor(Date.now() / 1000)
    };
    fs.writeFileSync(identityFile, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  }

  const secret = env.SYNC_SECRET?.trim() || null;
  const centralUrl = normalizeUrl(env.CENTRAL_URL);
  if (role === 'server' && !secret) {
    throw new ConfigError('TRACKER_ROLE=server needs SYNC_SECRET so collectors can authenticate.');
  }
  if (role === 'collector') {
    if (!centralUrl) throw new ConfigError('TRACKER_ROLE=collector needs CENTRAL_URL, the address of the central server.');
    if (!secret) throw new ConfigError('TRACKER_ROLE=collector needs SYNC_SECRET, the same value the server uses.');
  }

  return {
    role,
    deviceId,
    deviceLabel: env.DEVICE_LABEL?.trim() || deviceId,
    installId,
    dataDir,
    watchSessions: flagEnv(env, 'WATCH_SESSIONS', true),
    quotaPolling: flagEnv(env, 'QUOTA_POLLING', role !== 'collector'),
    sync: {
      centralUrl,
      secret,
      batchSize: Math.min(5_000, Math.round(numberEnv(env, 'SYNC_BATCH_SIZE', 500))),
      debounceMs: numberEnv(env, 'SYNC_DEBOUNCE_MS', 2_500),
      heartbeatMs: numberEnv(env, 'SYNC_HEARTBEAT_MS', 90_000),
      maxBackoffMs: numberEnv(env, 'SYNC_MAX_BACKOFF_MS', 300_000),
      retireAfterDays: numberEnv(env, 'SYNC_DEVICE_RETIRE_DAYS', 30)
    }
  };
}
