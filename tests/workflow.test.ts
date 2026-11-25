import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import { FactoryService } from '../apps/factory-service/src/service.js';
import { assertTransition, digest, FactoryError, transitions } from '../apps/factory-service/src/workflows/engine.js';
import { statuses, type Command, type PlanRevision, type Snapshot, type Task } from '../packages/contracts/src/index.js';

function harness(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-test-'));
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'dirty.txt'), 'keep my uncommitted work\n');
  let store = new Store(join(dir, 'factory.db'));
  let service = new FactoryService(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = <T>(command: Command): T => { const result = service.dispatch(command); if (!result.ok) throw new FactoryError(result.error.code, result.error.message); return result.data as T; };
  const { id: projectId } = call<{ id: string }>({ type: 'project.add', name: 'Fixture', path: repo });
  const { id: requestId } = call<{ id: string }>({ type: 'request.create', projectId, title: 'Add a feature', body: 'Deliver a small change.', kind: 'feature', priority: 'normal', acceptanceCriteria: ['It works'] });
  const task = call<Task>({ type: 'task.createFromRequest', requestId });
  return {
    call, task, repo,
    get store() { return store; }, get service() { return service; },
    restart() { store.close(); store = new Store(join(dir, 'factory.db')); service = new FactoryService(store); service.recover(); },
    assign() { return call<Task>({ type: 'task.assign', taskId: task.id, expectedVersion: 1, provider: 'fake' }); },
    currentPlan() { const snapshot = call<Snapshot>({ type: 'snapshot' }); return snapshot.plans.at(-1)!; },
    review(task: Task, plan: PlanRevision, action: 'approve' | 'request_changes' | 'reject', feedback = '') { return call<Task>({ type: 'task.reviewPlan', taskId: task.id, expectedVersion: task.version, revisionId: plan.id, digest: plan.sha256_digest, action, feedback }); },
  };
}
const errorCode = (code: string) => (error: unknown) => error instanceof FactoryError && error.code === code;

test('transition matrix denies every undocumented edge', () => {
  for (const from of statuses) for (const to of statuses) {
    const cancellable = to === 'CANCELLED' && !['ACCEPTED', 'MERGED', 'REJECTED', 'CANCELLED'].includes(from);
    if (transitions[from].includes(to) || cancellable) assert.doesNotThrow(() => assertTransition(from, to));
    else assert.throws(() => assertTransition(from, to), errorCode('INVALID_TRANSITION'));
  }
});
test('canonical digests ignore object key order and retain array order', () => {
  assert.equal(digest({ b: 2, a: { z: 3, y: 4 } }), digest({ a: { y: 4, z: 3 }, b: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});
test('request → task → fake proposal → exact approval persists across restart', t => {
  const h = harness(t); const task = h.assign(); const plan = h.currentPlan();
  assert.equal(task.status, 'PLAN_REVIEW');
  const approved = h.review(task, plan, 'approve');
  assert.equal(approved.status, 'QUEUED_FOR_BUILD');
  h.restart();
  const snapshot = h.call<Snapshot>({ type: 'snapshot' });
  assert.equal(snapshot.tasks[0].approved_plan_revision_id, plan.id);
  assert.equal(snapshot.approvals[0].artifact_digest, plan.sha256_digest);
  assert.equal(snapshot.approvals[0].actor, 'local-human');
  assert.equal(snapshot.events.at(-1)?.type, 'plan.approve');
  assert.equal(readFileSync(join(h.repo, 'dirty.txt'), 'utf8'), 'keep my uncommitted work\n');
});
test('build cannot bypass a missing durable approval', t => {
  const h = harness(t); const task = h.assign();
  assert.throws(() => h.service.workflow.transition(task.id, task.version, 'QUEUED_FOR_BUILD', 'test'), errorCode('APPROVAL_REQUIRED'));
  assert.equal(h.store.task(task.id)?.status, 'PLAN_REVIEW');
});
test('building rechecks durable approval even if task pointers are set', t => {
  const h = harness(t); const task = h.assign(); const plan = h.currentPlan();
  h.store.db.prepare("UPDATE tasks SET status='QUEUED_FOR_BUILD', approved_plan_revision_id=? WHERE id=?").run(plan.id, task.id);
  assert.throws(() => h.service.workflow.transition(task.id, task.version, 'BUILDING', 'test'), errorCode('APPROVAL_REQUIRED'));
});
test('stale task version prevents a double approval and duplicate events', t => {
  const h = harness(t); const task = h.assign(); const plan = h.currentPlan();
  h.review(task, plan, 'approve');
  const before = h.call<Snapshot>({ type: 'snapshot' });
  assert.throws(() => h.review(task, plan, 'approve'), errorCode('STALE_VERSION'));
  const after = h.call<Snapshot>({ type: 'snapshot' });
  assert.equal(after.approvals.length, 1); assert.equal(after.cursor, before.cursor);
});
test('changed plan digest is rejected without persisting a decision', t => {
  const h = harness(t); const task = h.assign(); const plan = h.currentPlan();
  assert.throws(() => h.review(task, { ...plan, sha256_digest: '0'.repeat(64) }, 'approve'), errorCode('STALE_PLAN_REVISION'));
  assert.equal(h.call<Snapshot>({ type: 'snapshot' }).approvals.length, 0);
});
test('requesting changes generates an immutable revision and rejects stale review', t => {
  const h = harness(t); const task = h.assign(); const old = h.currentPlan();
  const updated = h.review(task, old, 'request_changes', 'Cover the empty state');
  assert.equal(updated.status, 'PLAN_REVIEW'); assert.equal(h.currentPlan().revision_number, 2);
  assert.equal(updated.approved_plan_revision_id, null);
  assert.throws(() => h.review(updated, old, 'approve'), errorCode('STALE_PLAN_REVISION'));
  assert.throws(() => h.store.db.prepare('UPDATE plan_revisions SET body_json=? WHERE id=?').run('{}', old.id), /immutable/);
});
test('transition and event writes roll back together if event persistence fails', t => {
  const h = harness(t);
  h.store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk simulation'); END");
  assert.throws(() => h.service.workflow.transition(h.task.id, 1, 'PLANNING', 'task.assigned'), /disk simulation/);
  assert.equal(h.store.task(h.task.id)?.status, 'INBOX'); assert.equal(h.store.task(h.task.id)?.version, 1);
});
test('approval and state change roll back together on event failure', t => {
  const h = harness(t); const task = h.assign(); const plan = h.currentPlan();
  h.store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk simulation'); END");
  assert.throws(() => h.review(task, plan, 'approve'), errorCode('INTERNAL_ERROR'));
  assert.equal(h.store.task(task.id)?.status, 'PLAN_REVIEW');
  assert.equal(h.call<Snapshot>({ type: 'snapshot' }).approvals.length, 0);
});
test('cancellation preserves history and records a visible recovery action', t => {
  const h = harness(t); const task = h.assign();
  const cancelled = h.call<Task>({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: 'Priorities changed' });
  assert.equal(cancelled.status, 'CANCELLED'); assert.ok(cancelled.recovery_action);
  assert.equal(h.call<Snapshot>({ type: 'snapshot' }).plans.length, 1);
});
test('restart reconciles in-flight fake runs without assuming success', t => {
  const h = harness(t); const task = h.service.workflow.transition(h.task.id, 1, 'PLANNING', 'task.assigned');
  h.store.db.prepare("INSERT INTO agent_runs (id,task_id,stage,provider,status,attempt,started_at) VALUES ('interrupted-run',?,'plan','fake','running',1,?)").run(task.id, new Date().toISOString());
  h.restart();
  assert.equal(h.store.task(task.id)?.status, 'FAILED');
  assert.equal((h.store.db.prepare('SELECT status FROM agent_runs').get() as { status: string }).status, 'interrupted');
  const cursor = h.call<Snapshot>({ type: 'snapshot' }).cursor;
  h.service.recover(); assert.equal(h.call<Snapshot>({ type: 'snapshot' }).cursor, cursor);
});
test('event cursor replays strictly ordered new events', t => {
  const h = harness(t); const cursor = h.call<Snapshot>({ type: 'snapshot' }).cursor;
  h.assign();
  const events = h.store.events(cursor);
  assert.equal(events.length, 4);
  assert.ok(events.every((event, index) => event.sequence > (index ? events[index - 1].sequence : cursor)));
  assert.equal(h.store.events(events.at(-1)!.sequence).length, 0);
});
test('renderer cannot send arbitrary status or acceptance commands', t => {
  const h = harness(t);
  const result = h.service.dispatch({ type: 'task.transition', taskId: h.task.id, status: 'ACCEPTED' });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT');
  assert.equal(h.store.task(h.task.id)?.status, 'INBOX');
});
test('one request creates only one task and foreign keys are enforced', t => {
  const h = harness(t);
  assert.throws(() => h.call({ type: 'task.createFromRequest', requestId: h.task.request_id }), errorCode('CONFLICT'));
  assert.throws(() => h.store.db.prepare('DELETE FROM projects WHERE id=?').run(h.task.project_id), /FOREIGN KEY/);
});
