import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addLocalChat,
  baseTime,
  close,
  eventRecords,
  localEvent,
  openStore,
  parsed,
  partSummary,
  remoteEvent,
  removeDir,
  sample,
  tempDir
} from './testSupport.js';
import { calculateThreadUsageEstimates, listWindows, windowDetail } from './windows.js';
import type { WindowDetail } from './types.js';

const UNSETTLED = { settledThrough: null };

function share(detail: WindowDetail | null, threadId: string): number | undefined {
  return detail?.sessions.find((session) => session.threadId === threadId)?.percent;
}

test('two simultaneous sessions on different devices share one quota increase by cost', () => {
  const directory = tempDir('attr-devices');
  const server = openStore(directory, 'server');
  try {
    const t = baseTime();
    const resetsAt = t + 4 * 3600;
    server.insertRateLimitSnapshots([sample(t, 30, resetsAt), sample(t + 60, 35, resetsAt)]);
    addLocalChat(server, 'session-b', [localEvent('b1', 'session-b', t + 20, 0.2)]);
    server.ingestRemoteRecords('laptop', eventRecords([remoteEvent('a1', 'session-a', t + 30, 0.3)]));

    const detail = windowDetail(server, 300, undefined, resetsAt, null, UNSETTLED);
    close(share(detail, 'session-a'), 3, 'laptop session A');
    close(share(detail, 'session-b'), 2, 'server session B');
    assert.deepEqual(detail?.sessions.find((row) => row.threadId === 'session-a')?.deviceIds, ['laptop']);
    assert.deepEqual(detail?.sessions.find((row) => row.threadId === 'session-b')?.deviceIds, ['server']);
    // Both earned their share in a rise they shared with the other device.
    close(detail?.sessions.find((row) => row.threadId === 'session-a')?.sharedPercent, 3, 'shared share of A');
    close(detail?.devices.find((device) => device.deviceId === 'laptop')?.percent, 3, 'laptop device share');
    close(detail?.devices.find((device) => device.deviceId === 'server')?.percent, 2, 'server device share');
    close(detail?.attributedPercent, 5, 'attributed');
    close(detail?.unattributedPercent, 0, 'unattributed');

    const estimates = calculateThreadUsageEstimates(server, null, null);
    close(estimates.get('session-a')?.fiveHour?.percent, 3, 'chat table share of A');
    close(estimates.get('session-b')?.fiveHour?.percent, 2, 'chat table share of B');
  } finally {
    server.close();
    removeDir(directory);
  }
});

test('two simultaneous sessions on the same device share an increase by cost', () => {
  const directory = tempDir('attr-same-device');
  const store = openStore(directory, 'server');
  try {
    const t = baseTime();
    const resetsAt = t + 4 * 3600;
    store.insertRateLimitSnapshots([sample(t, 10, resetsAt), sample(t + 120, 16, resetsAt)]);
    addLocalChat(store, 'thread-a', [localEvent('a1', 'thread-a', t + 30, 0.3), localEvent('a2', 'thread-a', t + 100, 0.2)]);
    addLocalChat(store, 'thread-b', [localEvent('b1', 'thread-b', t + 40, 0.1)]);

    const detail = windowDetail(store, 300, undefined, resetsAt, null, UNSETTLED);
    close(share(detail, 'thread-a'), 5, 'thread A');
    close(share(detail, 'thread-b'), 1, 'thread B');
    assert.equal(detail?.devices.length, 1);
  } finally {
    store.close();
    removeDir(directory);
  }
});

test('sequential sessions separated by a quota sample do not share', () => {
  const directory = tempDir('attr-sequential');
  const server = openStore(directory, 'server');
  try {
    const t = baseTime();
    const resetsAt = t + 4 * 3600;
    server.insertRateLimitSnapshots([sample(t, 10, resetsAt), sample(t + 60, 12, resetsAt), sample(t + 120, 15, resetsAt)]);
    addLocalChat(server, 'first', [localEvent('f1', 'first', t + 20, 0.5)]);
    server.ingestRemoteRecords('laptop', eventRecords([remoteEvent('s1', 'second', t + 70, 0.1)]));

    const detail = windowDetail(server, 300, undefined, resetsAt, null, UNSETTLED);
    close(share(detail, 'first'), 2, 'first session');
    close(share(detail, 'second'), 3, 'second session');
    close(detail?.sessions.find((row) => row.threadId === 'first')?.sharedPercent, 0, 'nothing shared');
  } finally {
    server.close();
    removeDir(directory);
  }
});

test('a late remote event recomputes only the historical window it belongs to', () => {
  const directory = tempDir('attr-late');
  const server = openStore(directory, 'server');
  try {
    const t = baseTime(3);
    const lateBank = t + 4 * 3600;
    const otherBank = lateBank + 5 * 3600;
    server.insertRateLimitSnapshots([
      sample(t, 40, lateBank),
      sample(t + 60, 45, lateBank),
      sample(t + 5 * 3600, 5, otherBank),
      sample(t + 5 * 3600 + 60, 9, otherBank)
    ]);
    addLocalChat(server, 'session-a', [
      localEvent('a1', 'session-a', t + 20, 0.1),
      localEvent('a2', 'session-a', t + 5 * 3600 + 30, 0.1)
    ]);

    // Only the server's own session is known: it gets the whole rise.
    close(share(windowDetail(server, 300, undefined, lateBank, null, UNSETTLED), 'session-a'), 5, 'before');
    close(share(windowDetail(server, 300, undefined, otherBank, null, UNSETTLED), 'session-a'), 4, 'other window');
    assert.ok(server.getWindowAttribution('*', 300, lateBank));
    assert.ok(server.getWindowAttribution('*', 300, otherBank));

    // The laptop reconnects and delivers an event logged at 10:00:30.
    server.ingestRemoteRecords('laptop', eventRecords([remoteEvent('late-1', 'session-b', t + 30, 0.1)]));
    assert.equal(server.getWindowAttribution('*', 300, lateBank), null, 'the affected window was invalidated');
    assert.ok(server.getWindowAttribution('*', 300, otherBank), 'an unrelated window keeps its cached result');

    const after = windowDetail(server, 300, undefined, lateBank, null, UNSETTLED);
    close(share(after, 'session-a'), 2.5, 'A after the late event');
    close(share(after, 'session-b'), 2.5, 'B after the late event');
    close(share(windowDetail(server, 300, undefined, otherBank, null, UNSETTLED), 'session-a'), 4, 'other window unchanged');
    // Raw events are never discarded because attribution was computed earlier.
    assert.equal(server.getTokenEventsBetween(t, t + 60).length, 2);
  } finally {
    server.close();
    removeDir(directory);
  }
});

test('duplicate and out-of-order uploads are counted once', () => {
  const directory = tempDir('attr-duplicates');
  const server = openStore(directory, 'server');
  try {
    const t = baseTime();
    const resetsAt = t + 4 * 3600;
    server.insertRateLimitSnapshots([sample(t, 0, resetsAt), sample(t + 600, 6, resetsAt)]);
    addLocalChat(server, 'local-chat', [localEvent('l1', 'local-chat', t + 60, 0.2, 1_000)]);
    const events = [
      remoteEvent('r1', 'remote-chat', t + 100, 0.1, 2_000),
      remoteEvent('r2', 'remote-chat', t + 200, 0.1, 2_000),
      remoteEvent('r3', 'remote-chat', t + 300, 0.2, 2_000)
    ];
    // Events arrive newest first, before the part that describes them, and twice.
    server.ingestRemoteRecords('laptop', eventRecords([...events].reverse()));
    const beforePart = server.getThreadSummaries().find((thread) => thread.threadId === 'remote-chat');
    assert.equal(beforePart?.totalTokens, 6_000);
    assert.equal(beforePart?.titleSource, 'fallback');

    server.ingestRemoteRecords('laptop', parsed([{
      kind: 'part',
      key: 'remote-chat.jsonl',
      data: { ...partSummary('remote-chat', 'remote-chat.jsonl', { title: 'Remote work', sourceFile: 'C:\\laptop\\remote.jsonl' }) }
    }]));
    server.ingestRemoteRecords('laptop', eventRecords(events));
    server.ingestRemoteRecords('laptop', eventRecords([events[1]]));

    const remote = server.getThreadSummaries().find((thread) => thread.threadId === 'remote-chat');
    assert.equal(remote?.totalTokens, 6_000);
    assert.equal(remote?.title, 'Remote work');
    assert.deepEqual(remote?.deviceIds, ['laptop']);
    assert.equal(server.getTokenTotals().totalTokens, 7_000);
    assert.equal(server.getTokenTotals().threads, 2);
    assert.equal(server.getModelUsageSummaries()[0].totalTokens, 7_000);
    assert.equal(server.getLocalDailyUsage(30).reduce((sum, day) => sum + day.tokens, 0), 7_000);

    const detail = windowDetail(server, 300, undefined, resetsAt, null, UNSETTLED);
    close(share(detail, 'remote-chat'), 4, 'remote share');
    close(share(detail, 'local-chat'), 2, 'local share');
    assert.equal(detail?.tokens, 7_000);
  } finally {
    server.close();
    removeDir(directory);
  }
});

test('an event another device already reported is not counted a second time', () => {
  const directory = tempDir('attr-foreign');
  const server = openStore(directory, 'server');
  try {
    const t = baseTime();
    addLocalChat(server, 'copied', [localEvent('same-event', 'copied', t + 10, 0.4, 3_000)]);
    // A transcript copied to the laptop produces the same device-independent id.
    server.ingestRemoteRecords('laptop', eventRecords([
      { ...remoteEvent('same-event', 'copied', t + 10, 0.4, 3_000), partId: 'copied.jsonl' }
    ]));
    assert.equal(server.getTokenTotals().totalTokens, 3_000);
    assert.deepEqual(server.getThreadSummaries()[0].deviceIds, ['server']);
  } finally {
    server.close();
    removeDir(directory);
  }
});

test('quota resets start a new window and never share attribution', () => {
  const directory = tempDir('attr-resets');
  const store = openStore(directory, 'server');
  try {
    const t = baseTime(3);
    const first = t + 4 * 3600;
    const second = first + 5 * 3600;
    store.insertRateLimitSnapshots([
      sample(t, 10, first),
      sample(t + 60, 20, first),
      // Usage fell sharply without a new reset time: an early reset inside the window.
      sample(t + 120, 1, first),
      sample(t + 180, 4, first),
      sample(first + 60, 2, second),
      sample(first + 120, 6, second)
    ]);
    addLocalChat(store, 'before-reset', [localEvent('x1', 'before-reset', t + 30, 0.1)]);
    addLocalChat(store, 'after-reset', [localEvent('y1', 'after-reset', t + 150, 0.1)]);
    addLocalChat(store, 'next-window', [localEvent('z1', 'next-window', first + 90, 0.1)]);

    const windows = listWindows(store, 300, undefined, null, UNSETTLED);
    assert.deepEqual(windows.map((window) => window.resetsAt), [second, first]);
    const firstDetail = windowDetail(store, 300, undefined, first, null, UNSETTLED);
    close(share(firstDetail, 'before-reset'), 10, 'before the early reset');
    close(share(firstDetail, 'after-reset'), 3, 'after the early reset');
    assert.equal(share(firstDetail, 'next-window'), undefined);
    close(share(windowDetail(store, 300, undefined, second, null, UNSETTLED), 'next-window'), 4, 'next window');
    assert.ok(firstDetail?.points.some((point) => point.reset), 'the chart marks the early reset');
  } finally {
    store.close();
    removeDir(directory);
  }
});

test('historical 5-hour windows are listed newest first with their own breakdowns', () => {
  const directory = tempDir('windows-5h');
  const server = openStore(directory, 'server');
  try {
    const t = baseTime(1);
    const resets = [t - 6 * 3600, t - 1 * 3600, t + 4 * 3600];
    const finals = [22, 64, 9];
    resets.forEach((resetsAt, index) => {
      const start = resetsAt - 5 * 3600;
      server.insertRateLimitSnapshots([
        sample(start + 300, 0, resetsAt),
        sample(start + 1800, Math.round(finals[index] / 2), resetsAt),
        sample(start + 3600, finals[index], resetsAt)
      ]);
      addLocalChat(server, `local-${index}`, [localEvent(`l-${index}`, `local-${index}`, start + 900, 0.3)]);
      server.ingestRemoteRecords('laptop', eventRecords([remoteEvent(`r-${index}`, `laptop-${index}`, start + 2400, 0.1)]));
    });
    const current = sample(t + 60, 9, resets[2]);
    const settledThrough = resets[1] - 60;

    const windows = listWindows(server, 300, undefined, current, { settledThrough });
    assert.deepEqual(windows.map((window) => window.resetsAt), [...resets].reverse());
    assert.deepEqual(windows.map((window) => window.finalPercent), [...finals].reverse());
    assert.equal(windows[0].current, true);
    assert.equal(windows[1].current, false);
    assert.deepEqual(windows.map((window) => window.provisional), [true, true, false]);
    assert.equal(windows[2].sessionCount, 2);

    const oldest = windowDetail(server, 300, undefined, resets[0], current, { settledThrough });
    assert.ok(oldest);
    assert.equal(oldest.provisional, false);
    assert.equal(oldest.windowStartsAt, resets[0] - 5 * 3600);
    close(share(oldest, 'local-0'), 11, 'first half of the rise');
    close(share(oldest, 'laptop-0'), 11, 'second half of the rise');
    assert.equal(oldest.sessions.find((session) => session.threadId === 'laptop-0')?.tokens, 1_000);
    close(oldest.sessions.find((session) => session.threadId === 'laptop-0')?.costUsd, 0.1, 'window cost');
    close(oldest.coverage, 1, 'fully attributed');
    assert.deepEqual(oldest.points.map((point) => point.usedPercent), [0, 11, 22]);
    assert.equal(windowDetail(server, 300, undefined, resets[0] - 10 * 3600, current, { settledThrough }), null);
  } finally {
    server.close();
    removeDir(directory);
  }
});

test('historical 7-day windows use only the keys of their scope', () => {
  const directory = tempDir('windows-7d');
  const store = openStore(directory, 'server');
  try {
    const t = baseTime(1);
    const weekly = 10_080;
    const previous = t - 2 * 86_400;
    const current = previous + 7 * 86_400;
    const key = 'claude:seven-day';
    store.insertRateLimitSnapshots([
      sample(previous - 6 * 86_400, 5, previous, weekly, key),
      sample(previous - 3 * 86_400, 40, previous, weekly, key),
      sample(previous - 86_400, 71, previous, weekly, key),
      // A model-scoped weekly cap with its own reset time must not become a window here.
      sample(previous - 3 * 86_400, 90, previous + 3_600, weekly, 'claude:seven-day-scoped:fable'),
      sample(previous - 86_400, 95, previous + 3_600, weekly, 'claude:seven-day-scoped:fable'),
      sample(t - 3_600, 3, current, weekly, key),
      sample(t, 12, current, weekly, key)
    ]);
    addLocalChat(store, 'weekly-chat', [localEvent('w1', 'weekly-chat', previous - 4 * 86_400, 0.2)]);

    const windows = listWindows(store, weekly, [key], sample(t, 12, current, weekly, key), UNSETTLED);
    assert.deepEqual(windows.map((window) => window.resetsAt), [current, previous]);
    assert.equal(windows[1].peakPercent, 71);
    const detail = windowDetail(store, weekly, [key], previous, null, UNSETTLED);
    close(share(detail, 'weekly-chat'), 35, 'weekly share');
    close(detail?.unattributedPercent, 31, 'rises with no local events');
  } finally {
    store.close();
    removeDir(directory);
  }
});

test('renaming the device also relabels cached window results', () => {
  const directory = tempDir('windows-relabel');
  let store = openStore(directory, 'old-name');
  try {
    const t = baseTime();
    const resetsAt = t + 4 * 3600;
    store.insertRateLimitSnapshots([sample(t, 1, resetsAt), sample(t + 60, 3, resetsAt)]);
    addLocalChat(store, 'renamed', [localEvent('n1', 'renamed', t + 30, 0.1)]);
    assert.deepEqual(windowDetail(store, 300, undefined, resetsAt, null, UNSETTLED)?.devices.map((d) => d.deviceId), ['old-name']);
    store.close();
    store = openStore(directory, 'new-name');
    const detail = windowDetail(store, 300, undefined, resetsAt, null, UNSETTLED);
    assert.deepEqual(detail?.devices.map((d) => d.deviceId), ['new-name']);
    assert.deepEqual(detail?.sessions[0].deviceIds, ['new-name']);
  } finally {
    store.close();
    removeDir(directory);
  }
});

test('idle reset times that slide forward are not listed as windows', () => {
  const directory = tempDir('windows-idle');
  const store = openStore(directory, 'server');
  try {
    const t = baseTime(1);
    const idle = Array.from({ length: 30 }, (_, index) => sample(t + index * 60, 0, t + index * 60 + 5 * 3600));
    store.insertRateLimitSnapshots(idle);
    addLocalChat(store, 'earlier', [localEvent('e1', 'earlier', t + 3600, 0.1)]);
    assert.deepEqual(listWindows(store, 300, undefined, null, UNSETTLED), []);
    assert.equal(calculateThreadUsageEstimates(store, null, null).size, 0);
  } finally {
    store.close();
    removeDir(directory);
  }
});
