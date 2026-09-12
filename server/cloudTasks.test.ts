import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCloudTaskList } from './cloudTasks.js';

test('parses the codex cloud list JSON payload', () => {
  const tasks = parseCloudTaskList(JSON.stringify({
    tasks: [
      {
        id: 'task_1',
        url: 'https://chatgpt.com/codex/tasks/task_1',
        title: 'Add retry to sync job',
        status: 'ready',
        updated_at: '2026-09-10T15:04:05Z',
        environment_id: 'env_1',
        environment_label: 'school-dashboard',
        summary: { files_changed: 3, lines_added: 40, lines_removed: 12 },
        is_review: false,
        attempt_total: 1
      },
      { id: 'task_2', title: 'Review PR 42', status: { pending: {} }, updated_at: null, is_review: true }
    ],
    cursor: null
  }), 1_000);

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, 'Add retry to sync job');
  assert.equal(tasks[0].status, 'ready');
  assert.equal(tasks[0].updatedAt, 1_789_052_645);
  assert.equal(tasks[0].filesChanged, 3);
  assert.equal(tasks[0].environmentLabel, 'school-dashboard');
  assert.equal(tasks[1].status, 'pending');
  assert.equal(tasks[1].isReview, true);
  assert.equal(tasks[1].firstSeenAt, 1_000);
});

test('tolerates warnings printed before the JSON', () => {
  const tasks = parseCloudTaskList('warning: experimental\n{"tasks":[],"cursor":null}');
  assert.deepEqual(tasks, []);
});
