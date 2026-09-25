import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ConfigError, loadTrackerConfig } from './config.js';
import { removeDir, tempDir } from './testSupport.js';

test('roles, device identity, and sync settings come from the environment', () => {
  const directory = tempDir('config');
  try {
    const standalone = loadTrackerConfig({ DATA_DIR: directory });
    assert.equal(standalone.role, 'standalone');
    assert.equal(standalone.quotaPolling, true);
    // The default device id is remembered, so a later hostname change keeps it.
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'device.json'), 'utf8')) as { deviceId: string; installId: string };
    assert.equal(stored.deviceId, standalone.deviceId);
    assert.equal(loadTrackerConfig({ DATA_DIR: directory }).installId, stored.installId);

    const collector = loadTrackerConfig({
      DATA_DIR: directory,
      TRACKER_ROLE: 'collector',
      DEVICE_ID: 'laptop',
      DEVICE_LABEL: 'Daniel laptop',
      CENTRAL_URL: 'http://latitude7370:8893/',
      SYNC_SECRET: 'shared-secret',
      SYNC_BATCH_SIZE: '250'
    });
    assert.equal(collector.deviceId, 'laptop');
    assert.equal(collector.deviceLabel, 'Daniel laptop');
    assert.equal(collector.sync.centralUrl, 'http://latitude7370:8893');
    assert.equal(collector.sync.batchSize, 250);
    assert.equal(collector.quotaPolling, false, 'collectors leave account polling to the server');
    assert.equal(collector.installId, stored.installId);

    assert.throws(() => loadTrackerConfig({ DATA_DIR: directory, TRACKER_ROLE: 'server' }), ConfigError);
    assert.throws(() => loadTrackerConfig({ DATA_DIR: directory, TRACKER_ROLE: 'collector', SYNC_SECRET: 'x' }), /CENTRAL_URL/);
    assert.throws(() => loadTrackerConfig({ DATA_DIR: directory, TRACKER_ROLE: 'collector', CENTRAL_URL: 'ftp://x', SYNC_SECRET: 'x' }), ConfigError);
    assert.throws(() => loadTrackerConfig({ DATA_DIR: directory, DEVICE_ID: 'bad id!' }), /DEVICE_ID/);
    assert.throws(() => loadTrackerConfig({ DATA_DIR: directory, TRACKER_ROLE: 'hub' }), /TRACKER_ROLE/);
  } finally {
    removeDir(directory);
  }
});
