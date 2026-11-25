import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statuses, type Request, type Task } from '../packages/contracts/src/index.js';
import { filterRequests, groupRequests, isRequestCompleted } from '../apps/desktop/src/request-view.js';

function request(id: string, project = 'a', overrides: Partial<Request> = {}): Request {
  return { id, project_id: project, title: 'Feature ' + id, body: '', type: 'feature', priority: 'normal',
    acceptance_criteria_json: '[]', status: 'open', version: 1, created_at: '', updated_at: '', ...overrides };
}
const requests = [
  request('merged', 'a'), request('building-b', 'b'), request('accepted', 'b'),
  request('failed', 'a', { priority: 'high' }), request('saved', 'b'),
  request('cancelled', 'a'), request('building-a', 'a'), request('rejected', 'b'),
  request('archived', 'b', { status: 'archived', priority: 'high' }),
];
const taskStatuses: Record<string, Task['status']> = {
  merged: 'MERGED', accepted: 'ACCEPTED', 'building-b': 'BUILDING', 'building-a': 'BUILDING',
  failed: 'FAILED', cancelled: 'CANCELLED', rejected: 'REJECTED', archived: 'FAILED',
};
const taskFor = (id: string) => taskStatuses[id] ? {
  status: taskStatuses[id], provider_policy_json: JSON.stringify({ provider: id === 'archived' ? 'fake' : 'codex' }),
} : undefined;
const ids = (items: Request[]) => items.map(item => item.id);
const projectName = () => 'Same project name';

test('defaults hide only accepted and merged work, and clearing reveals completed and archived requests', () => {
  assert.deepEqual(ids(filterRequests(requests, taskFor)), ['building-b', 'failed', 'saved', 'cancelled', 'building-a', 'rejected']);
  assert.deepEqual(ids(filterRequests(requests, taskFor, { hideCompleted: false, archive: 'all' })), ids(requests));
  for (const status of statuses) assert.equal(isRequestCompleted({ status }), status === 'ACCEPTED' || status === 'MERGED');
  assert.equal(isRequestCompleted(undefined), false);
});

test('status groups combine projects, follow contract order and preserve request order within each status', () => {
  const visible = filterRequests(requests, taskFor);
  const groups = groupRequests(visible, taskFor, 'status', projectName);
  assert.deepEqual(groups.map(group => group.key), ['BUILDING', 'FAILED', 'REJECTED', 'CANCELLED', 'saved']);
  assert.deepEqual(ids(groups[0].requests), ['building-b', 'building-a']);
  assert.deepEqual(groups[0].requests.map(item => item.project_id), ['b', 'a']);
  assert.equal(groups.at(-1)?.label, 'Saved for later');
  assert.deepEqual(groups.flatMap(group => ids(group.requests)).sort(), ids(visible).sort());
});

test('project groups use stable IDs even for duplicate names and preserve first appearance order', () => {
  const visible = filterRequests(requests, taskFor);
  const groups = groupRequests(visible, taskFor, 'project', projectName);
  assert.deepEqual(groups.map(group => [group.key, group.label]), [['b', 'Same project name'], ['a', 'Same project name']]);
  assert.deepEqual(ids(groups[0].requests), ['building-b', 'saved', 'rejected']);
  assert.deepEqual(groups.flatMap(group => ids(group.requests)).sort(), ids(visible).sort());
});

test('archive, search, project, priority, provider and attention compose before either grouping', () => {
  const filters = { archive: 'all', query: 'FEATURE', projectId: 'b', priority: 'high', provider: 'fake', attentionOnly: true };
  for (const mode of ['status', 'project'] as const) {
    const groups = groupRequests(filterRequests(requests, taskFor, filters), taskFor, mode, projectName);
    assert.equal(groups.length, 1);
    assert.deepEqual(ids(groups[0].requests), ['archived']);
    assert.deepEqual(groupRequests(filterRequests(requests, taskFor, { ...filters, archive: 'open' }), taskFor, mode, projectName), []);
    assert.deepEqual(groupRequests([], taskFor, mode, projectName), []);
  }
  assert.deepEqual(ids(filterRequests(requests, taskFor, { query: 'REQ-build' })), ['building-b', 'building-a']);
  assert.deepEqual(ids(filterRequests(requests, taskFor, { query: 'KUL-BUILDI' })), ['building-b', 'building-a']);
  assert.deepEqual(ids(filterRequests(requests, taskFor, { archive: 'archived', provider: 'codex' })), []);
});

test('live completion removes a request without changing the source collection', () => {
  const items = [request('live')];
  let status: Task['status'] = 'FINAL_REVIEW';
  const lookup = () => ({ status, provider_policy_json: '{}' });
  assert.equal(filterRequests(items, lookup).length, 1);
  status = 'ACCEPTED';
  assert.equal(filterRequests(items, lookup).length, 0);
  assert.equal(filterRequests(items, lookup, { hideCompleted: false }).length, 1);
  assert.equal(items.length, 1);
});
