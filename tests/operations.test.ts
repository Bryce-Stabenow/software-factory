import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import { FactoryService } from '../apps/factory-service/src/service.js';
import { restoreBackup } from '../scripts/restore-backup.js';
import type { Command, Diagnostics, Request, Snapshot, StoredExport, Task } from '../packages/contracts/src/index.js';

function setup(t: { after: (fn: () => unknown) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'kulumin-operations-')), repo = join(directory, 'private-repo-name');
  execFileSync('git', ['init','-b','main',repo], { stdio: 'ignore' });
  const store = new Store(join(directory, 'factory.db')), service = new FactoryService(store, { dataDir: directory });
  t.after(async () => { await Promise.all([service.planning.close(), service.builds.close(), service.operations.close()]); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = <T>(payload: Command): T => { const result = service.dispatch(payload); assert.ok(result.ok, JSON.stringify(result)); return result.data as T; };
  const { id: projectId } = call<{ id: string }>({ type: 'project.add', name: 'Private customer name', path: repo });
  const create = () => call<{ id: string }>({ type: 'request.create', projectId, title: 'Private feature title', body: 'Original private request body DB_PASSWORD=do-not-export', kind: 'feature', priority: 'normal', acceptanceCriteria: ['Original criterion'] });
  const snapshot = () => call<Snapshot>({ type: 'snapshot' });
  const update = (request: Request, title = 'Edited private title') => call<Request>({ type: 'request.update', requestId: request.id, expectedVersion: request.version, projectId, title, body: 'Updated private body', kind: 'bug', priority: 'high', acceptanceCriteria: ['Updated criterion'] });
  return { directory, store, service, projectId, call, create, snapshot, update };
}
test('request revisions are immutable and edits use optimistic concurrency', t => {
  const h = setup(t), created = h.create(), original = h.snapshot().requests[0];
  const updated = h.update(original); assert.equal(updated.version, 2); assert.equal(updated.type, 'bug');
  assert.equal(h.snapshot().requestRevisions.length, 2);
  assert.equal(JSON.parse(h.snapshot().requestRevisions[0].body_json).title, original.title);
  const stale = h.service.dispatch({ type: 'request.update', requestId: created.id, expectedVersion: 1, projectId: h.projectId, title: 'Stale overwrite', body: 'No', kind: 'feature', priority: 'normal', acceptanceCriteria: [] });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, 'STALE_VERSION');
  assert.equal(h.snapshot().requests[0].version, 2);
  assert.throws(() => h.store.db.prepare("UPDATE request_revisions SET body_json='{}'").run(), /immutable/);
});
test('editing and archiving a request preserve the original task input and its approval', t => {
  const h = setup(t), { id } = h.create();
  const task = h.call<Task>({ type: 'task.createFromRequest', requestId: id });
  h.update(h.snapshot().requests[0]);
  const proposed = h.call<Task>({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'fake' });
  const plan = h.snapshot().plans[0]; assert.match(plan.body_json, /Original criterion/); assert.doesNotMatch(plan.body_json, /Updated criterion/);
  h.call({ type: 'task.reviewPlan', taskId: task.id, expectedVersion: proposed.version, revisionId: plan.id, digest: plan.sha256_digest, action: 'approve' });
  const request = h.snapshot().requests[0]; h.call({ type: 'request.archive', requestId: id, expectedVersion: request.version, archived: true });
  const final = h.snapshot().tasks[0]; assert.equal(final.status, 'QUEUED_FOR_BUILD'); assert.equal(final.approved_plan_revision_id, plan.id);
  assert.equal(h.store.requestForTask(final).version, 1); assert.equal(h.store.requestForTask(final).priority, 'normal');
  assert.equal(h.snapshot().approvals.length, 1);
});
test('archive and restore are durable and archived requests cannot create tasks or be edited', t => {
  const h = setup(t), { id } = h.create();
  const archived = h.call<Request>({ type: 'request.archive', requestId: id, expectedVersion: 1, archived: true });
  assert.equal(archived.status, 'archived'); assert.equal(archived.version, 2);
  assert.equal(h.service.dispatch({ type: 'task.createFromRequest', requestId: id }).ok, false);
  assert.throws(() => h.update(archived));
  const restored = h.call<Request>({ type: 'request.archive', requestId: id, expectedVersion: archived.version, archived: false });
  assert.equal(restored.status, 'open'); assert.equal(restored.version, 3); h.call({ type: 'task.createFromRequest', requestId: id });
  assert.equal(h.store.requestForTask(h.snapshot().tasks[0]).version, 3);
});
test('revised requests create a separate task without replacing approved work', t => {
  const h = setup(t), { id } = h.create(); h.call({ type: 'task.createFromRequest', requestId: id });
  const edited = h.update(h.snapshot().requests[0]);
  const duplicate = h.call<{ id: string }>({ type: 'request.duplicate', requestId: id, expectedVersion: edited.version });
  assert.notEqual(duplicate.id, id); h.call({ type: 'task.createFromRequest', requestId: duplicate.id });
  assert.equal(h.snapshot().tasks.length, 2); assert.equal(h.snapshot().requests.find(request => request.id === duplicate.id)?.title, edited.title);
});
test('support diagnostics contain no request content, paths, source, credentials, or raw errors', t => {
  const h = setup(t); const request = h.create(), task = h.call<Task>({ type: 'task.createFromRequest', requestId: request.id });
  h.store.db.prepare("INSERT INTO agent_runs(id,task_id,stage,provider,status,attempt,started_at,error_code,summary) VALUES (?,?,'plan','codex','failed',1,?,'PROVIDER_ERROR',?)").run(randomUUID(), task.id, new Date().toISOString(), 'password=hidden private transcript');
  const report = h.call<Diagnostics>({ type: 'diagnostics.get' });
  assert.equal(report.storage.integrity, 'ok'); assert.equal(report.storage.schemaVersion, 7); assert.equal(report.counts.openRequests, 1); assert.equal(report.recentErrors[0].code, 'PROVIDER_ERROR');
  const serialized = JSON.stringify(report); assert.doesNotMatch(serialized, /Private|private-repo|DB_PASSWORD|do-not-export|hidden|transcript|\/Users\//);
  const exported = h.call<StoredExport>({ type: 'diagnostics.export' });
  const bytes = readFileSync(exported.path); assert.equal(createHash('sha256').update(bytes).digest('hex'), exported.sha256);
  assert.equal(statSync(exported.path).mode & 0o777, 0o600); assert.doesNotMatch(bytes.toString(), /Private|do-not-export|hidden/);
});
test('database backup is consistent, restores to a new directory, and never overwrites data', async t => {
  const h = setup(t); const request = h.create(); h.call({ type: 'task.createFromRequest', requestId: request.id }); h.update(h.snapshot().requests[0]);
  const response = await h.service.handle({ type: 'backup.create' }); assert.ok(response.ok); const backup = response.data as StoredExport;
  const database = new Database(backup.path, { readonly: true }); assert.equal(database.prepare('SELECT COUNT(*) AS n FROM request_revisions').get()!.n, 2); database.close();
  const restoredPath = join(h.directory, 'restored'); await restoreBackup(backup.path, restoredPath);
  const restored = new Store(join(restoredPath, 'factory.db'));
  assert.equal(restored.snapshot().requests[0].version, 2); assert.equal(restored.requestForTask(restored.snapshot().tasks[0]).version, 1); restored.close();
  await assert.rejects(restoreBackup(backup.path, restoredPath), /never overwritten/);
  assert.equal(h.snapshot().requests[0].version, 2);
});
test('backup rejects invalid input and future schemas without changing the source', async t => {
  const h = setup(t), path = join(h.directory, 'future.db'), database = new Database(path);
  database.exec('CREATE TABLE schema_migrations(version INTEGER);INSERT INTO schema_migrations VALUES(999)'); database.close();
  const before = readFileSync(path); await assert.rejects(restoreBackup(path, join(h.directory, 'future-restore')), /different version/); assert.deepEqual(readFileSync(path), before);
});
test('migration 6 preserves pre-existing requests and task request versions across restart', t => {
  const h = setup(t); const request = h.create(); h.call({ type: 'task.createFromRequest', requestId: request.id });
  // Reconstruct the exact pre-migration shape in a separate fixture, preserving historical tables.
  const path = join(h.directory, 'legacy.db'); h.store.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  const legacy = new Database(path); legacy.exec('DROP TRIGGER immutable_request_revision_update;DROP TRIGGER immutable_request_revision_delete;DROP TABLE request_revisions;DROP TABLE initialization_runs;ALTER TABLE agent_runs DROP COLUMN implementation_started;DELETE FROM schema_migrations WHERE version>=6'); legacy.close();
  const migrated = new Store(path); const snapshot = migrated.snapshot();
  assert.equal(snapshot.requestRevisions.length, 1); assert.equal(migrated.requestForTask(snapshot.tasks[0]).title, 'Private feature title');
  assert.equal(migrated.db.pragma('foreign_key_check').length, 0); migrated.close();
});

test('starting a saved request creates one task and plans immediately without approving execution', t => {
  const h = setup(t), { id } = h.create();
  assert.equal(h.snapshot().tasks.length, 0);
  const task = h.call<Task>({ type: 'request.startTask', requestId: id, expectedVersion: 1, provider: 'fake' });
  assert.equal(task.status, 'PLAN_REVIEW');
  assert.equal(task.approved_plan_revision_id, null);
  assert.equal(h.snapshot().workspaces.length, 0);
  const duplicate = h.service.dispatch({ type: 'request.startTask', requestId: id, expectedVersion: 1, provider: 'fake' });
  assert.equal(duplicate.ok, false);
  assert.equal(h.snapshot().tasks.length, 1);
  assert.equal(h.snapshot().plans.length, 1);
});
test('starting requests rejects stale or archived inputs and reuses an existing unstarted task', t => {
  const h = setup(t), { id } = h.create();
  const request = h.snapshot().requests[0]; h.update(request);
  assert.equal(h.service.dispatch({ type: 'request.startTask', requestId: id, expectedVersion: 1, provider: 'fake' }).ok, false);
  assert.equal(h.snapshot().tasks.length, 0);
  const archived = h.call<Request>({ type: 'request.archive', requestId: id, expectedVersion: 2, archived: true });
  assert.equal(h.service.dispatch({ type: 'request.startTask', requestId: id, expectedVersion: archived.version, provider: 'fake' }).ok, false);
  const restored = h.call<Request>({ type: 'request.archive', requestId: id, expectedVersion: archived.version, archived: false });
  const inbox = h.call<Task>({ type: 'task.createFromRequest', requestId: id });
  const planned = h.call<Task>({ type: 'request.startTask', requestId: id, expectedVersion: restored.version, provider: 'fake' });
  assert.equal(planned.id, inbox.id); assert.equal(planned.status, 'PLAN_REVIEW');
  assert.equal(h.snapshot().tasks.length, 1);
});
test('a planning enqueue failure rolls back task creation while preserving the saved request', t => {
  const h = setup(t), { id } = h.create();
  h.service.planning.enqueue = () => { throw new Error('Fixture enqueue failure'); };
  const result = h.service.dispatch({ type: 'request.startTask', requestId: id, expectedVersion: 1, provider: 'codex' });
  assert.equal(result.ok, false);
  assert.equal(h.snapshot().requests.length, 1);
  assert.equal(h.snapshot().tasks.length, 0);
  assert.equal(h.snapshot().events.filter(event => event.type === 'task.created').length, 0);
});
