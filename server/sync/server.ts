import crypto from 'node:crypto';
import express from 'express';
import type { UsageStore } from '../db.js';
import { debugEnabled, isProviderId } from '../providers.js';
import type { ProviderId, TrackerRole } from '../types.js';
import {
  SYNC_PROTOCOL_VERSION,
  parseSyncRecord,
  type CollectorStatusReport,
  type HeartbeatResponse,
  type ParsedSyncRecord,
  type UploadResponse
} from './protocol.js';
import type { DeviceRegistry } from './registry.js';

const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_RECORDS_PER_UPLOAD = 10_000;
const ROLES = new Set<TrackerRole>(['standalone', 'server', 'collector']);

export interface SyncRouterOptions {
  secret: string;
  registry: DeviceRegistry;
  stores: Record<ProviderId, UsageStore>;
  /** The server's own device id; a collector may not use it. */
  selfDeviceId: string;
  /** Called after records were stored, so caches and listeners can react. */
  onIngest?: (provider: ProviderId, deviceId: string, stored: number) => void;
  now?: () => number;
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Constant-time check of `Authorization: Bearer <secret>`. */
export function authorized(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return crypto.timingSafeEqual(digest(match[1]), digest(secret));
}

interface Identity {
  deviceId: string;
  label: string;
  installId: string;
  role: TrackerRole;
}

function readIdentity(body: Record<string, unknown>, selfDeviceId: string): Identity | { status: number; error: string } {
  if (body.protocol !== SYNC_PROTOCOL_VERSION) {
    return { status: 400, error: `Unsupported sync protocol ${String(body.protocol)}; this server speaks ${SYNC_PROTOCOL_VERSION}. Update both machines to the same version.` };
  }
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  if (!DEVICE_ID_PATTERN.test(deviceId)) return { status: 400, error: 'deviceId is missing or invalid' };
  if (deviceId === selfDeviceId) {
    return { status: 409, error: `Device id "${deviceId}" belongs to the central server. Set a different DEVICE_ID on this collector.` };
  }
  const installId = typeof body.installId === 'string' && body.installId ? body.installId.slice(0, 100) : 'unknown';
  const deviceLabel = typeof body.deviceLabel === 'string' && body.deviceLabel.trim()
    ? body.deviceLabel.trim().slice(0, 80)
    : deviceId;
  const status = body.status as Partial<CollectorStatusReport> | undefined;
  const role = status && typeof status.role === 'string' && ROLES.has(status.role as TrackerRole)
    ? status.role as TrackerRole
    : 'collector';
  return { deviceId, label: deviceLabel, installId, role };
}

function isStatusReport(value: unknown): value is CollectorStatusReport {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  return typeof status.now === 'number' && typeof status.providers === 'object' && status.providers !== null;
}

/**
 * The endpoints collectors talk to. Every request needs the shared secret.
 * Uploads are idempotent: records carry stable keys, so a retried batch, a
 * duplicate, or a batch that arrives out of order changes nothing twice. The
 * response acknowledges exactly the sequence numbers that are now committed.
 */
export function createSyncRouter(options: SyncRouterOptions): express.Router {
  const router = express.Router();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  router.use(express.json({ limit: '64mb' }));
  router.use((request, response, next) => {
    if (!authorized(request.header('authorization'), options.secret)) {
      response.status(401).json({ error: 'Missing or wrong sync secret. SYNC_SECRET must match on both machines.' });
      return;
    }
    next();
  });

  router.post('/upload', (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const identity = readIdentity(body, options.selfDeviceId);
    if ('error' in identity) {
      response.status(identity.status).json({ error: identity.error });
      return;
    }
    const provider = body.provider;
    if (!isProviderId(provider)) {
      response.status(400).json({ error: 'provider must be "codex" or "claude"' });
      return;
    }
    if (!Array.isArray(body.records) || body.records.length > MAX_RECORDS_PER_UPLOAD) {
      response.status(400).json({ error: `records must be an array of at most ${MAX_RECORDS_PER_UPLOAD}` });
      return;
    }

    const serverNow = now();
    const valid: ParsedSyncRecord[] = [];
    const rejected: UploadResponse['rejected'] = [];
    for (const raw of body.records) {
      const parsed = parseSyncRecord(raw, serverNow);
      if (typeof parsed === 'string') {
        const seq = typeof (raw as { seq?: unknown })?.seq === 'number' ? (raw as { seq: number }).seq : -1;
        if (seq >= 0) rejected.push({ seq, error: parsed });
      } else {
        valid.push(parsed);
      }
    }

    let acked: number[];
    try {
      acked = options.stores[provider].ingestRemoteRecords(identity.deviceId, valid).acked;
    } catch (error) {
      console.warn(`Could not store an upload from ${identity.deviceId}:`, (error as Error).message);
      response.status(500).json({ error: 'The server could not store this batch; it will be retried.' });
      return;
    }
    options.registry.recordContact(identity, serverNow);
    options.registry.recordUpload(identity.deviceId, acked.length, serverNow);
    if (rejected.length > 0 && debugEnabled()) {
      console.warn(`Rejected ${rejected.length} records from ${identity.deviceId}: ${rejected[0].error}`);
    }
    options.onIngest?.(provider, identity.deviceId, acked.length);
    const result: UploadResponse = {
      ok: true,
      acked,
      rejected,
      serverInstanceId: options.registry.instanceId,
      serverTime: serverNow
    };
    response.json(result);
  });

  router.post('/heartbeat', (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const identity = readIdentity(body, options.selfDeviceId);
    if ('error' in identity) {
      response.status(identity.status).json({ error: identity.error });
      return;
    }
    if (!isStatusReport(body.status)) {
      response.status(400).json({ error: 'status is missing or invalid' });
      return;
    }
    const serverNow = now();
    options.registry.recordContact(identity, serverNow);
    options.registry.recordStatus(identity.deviceId, body.status, serverNow);
    const result: HeartbeatResponse = {
      ok: true,
      serverInstanceId: options.registry.instanceId,
      serverTime: serverNow
    };
    response.json(result);
  });

  return router;
}
