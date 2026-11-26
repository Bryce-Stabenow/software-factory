import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexImplementer, CodexReviewer, CodexPlanner } from '../apps/factory-service/src/agents/codex.js';
import { createPlanningSnapshot, SnapshotReader, snapshotDigest } from '../apps/factory-service/src/agents/snapshot.js';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import { FactoryService } from '../apps/factory-service/src/service.js';
import type { Command, Snapshot, Task } from '../packages/contracts/src/index.js';

const fixture = resolve('tests/fixtures/codex-server.mjs');
for (const mode of ['success', 'implicit-cwd', 'unsafe', 'unsafe-network', 'unsafe-roots', 'unsafe-tmp'] as const) {
  test(`implementer writes only with a confirmed task-worktree sandbox: ${mode}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'factory-implementer-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'ignore' });
    const path = join(directory, 'greeting.ts'), original = 'export const greet = (name: string) => name;\n';
    writeFileSync(path, original);
    const implementer = new CodexImplementer(process.execPath, [fixture, mode], 2000);
    const run = implementer.implement({ cwd: directory, guard() {}, prompt: 'Implement the greeting', signal: new AbortController().signal, onEvent() {} });
    if (mode === 'success' || mode === 'implicit-cwd') {
      assert.deepEqual((await run).touchedPaths, ['greeting.ts']);
      assert.match(readFileSync(path, 'utf8'), /Hello/);
    } else {
      await assert.rejects(run, error => (error as { code: string }).code === 'POLICY_DENIED');
      assert.equal(readFileSync(path, 'utf8'), original);
    }
  });
}
function setup(t: { after: (fn: () => unknown) => void }, mode = 'success', timeout = 2000) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-codex-test-'));
  const repo = join(directory, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'greeting.ts'), 'export const greet = (name: string) => name;\n');
  const store = new Store(join(directory, 'factory.db'));
  const planner = new CodexPlanner(process.execPath, [fixture, mode], timeout);
  const service = new FactoryService(store, { planner, dataDir: directory });
  t.after(async () => { await service.planning.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = <T>(command: Command) => { const result = service.dispatch(command); assert.ok(result.ok, JSON.stringify(result)); return result.data as T; };
  const project = call<{ id: string }>({ type: 'project.add', name: 'Fixture', path: repo });
  const request = call<{ id: string }>({ type: 'request.create', projectId: project.id, title: 'Formal greeting', body: 'Plan an optional prefix.', kind: 'feature', priority: 'normal', acceptanceCriteria: ['Default stays unchanged'] });
  const task = call<Task>({ type: 'task.createFromRequest', requestId: request.id });
  const snapshot = () => call<Snapshot>({ type: 'snapshot' });
  return { directory, repo, store, planner, service, task, call, snapshot, assign: () => call<Task>({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'codex' }) };
}

test('real-adapter protocol normalizes final items, persists sessions, and keeps approval gate', async t => {
  const h = setup(t); const queued = h.assign();
  assert.equal(queued.status, 'PLANNING');
  assert.equal(h.snapshot().runs[0].status, 'queued');
  await h.service.planning.idle();
  const snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'PLAN_REVIEW');
  assert.equal(snapshot.runs[0].provider_session_ref, 'fixture-thread');
  assert.equal(snapshot.runs[0].turn_ref, 'fixture-turn');
  assert.equal(snapshot.runs[0].status, 'succeeded');
  assert.equal(snapshot.approvals.length, 0);
  const plan = snapshot.plans[0];
  const accepted = h.call<Task>({ type: 'task.reviewPlan', taskId: h.task.id, expectedVersion: snapshot.tasks[0].version, revisionId: plan.id, digest: plan.sha256_digest, action: 'approve' });
  assert.equal(accepted.status, 'QUEUED_FOR_BUILD');
  assert.match(readFileSync(join(h.repo, 'greeting.ts'), 'utf8'), /export const greet/);
});
for (const [mode, expected] of [['invalid', 'INVALID_PLAN'], ['no-read', 'INVALID_PLAN'], ['failed', 'PROVIDER_ERROR'], ['exit', 'PROVIDER_DISCONNECTED'], ['unsafe', 'POLICY_DENIED'], ['unsafe-config', 'POLICY_DENIED'], ['signed-out', 'AUTH_REQUIRED'], ['permission', 'POLICY_DENIED']] as const) {
  test(`${mode} cannot become a successful plan`, async t => {
    const h = setup(t, mode); h.assign(); await h.service.planning.idle();
    const snapshot = h.snapshot();
    assert.ok(['FAILED', 'BLOCKED'].includes(snapshot.tasks[0].status));
    assert.equal(snapshot.runs[0].error_code, expected);
    assert.equal(snapshot.plans.length, 0); assert.equal(snapshot.approvals.length, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /\[REDACTED\]|private-email/);
    if (mode === 'permission') assert.equal((h.store.db.prepare('SELECT status FROM permission_requests').get() as { status: string }).status, 'denied');
  });
}
test('clarification pauses the gate and answers produce a new revision', async t => {
  const h = setup(t, 'questions'); h.assign(); await h.service.planning.idle();
  let snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'PLANNING_BLOCKED');
  const question = snapshot.questions[0];
  h.call({ type: 'task.answerQuestions', taskId: h.task.id, expectedVersion: snapshot.tasks[0].version, answers: [{ questionId: question.id, answer: 'Use a fixed prefix.' }] });
  await h.service.planning.idle(); snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'PLAN_REVIEW'); assert.equal(snapshot.plans.length, 2);
  assert.equal(snapshot.questions[0].answer, 'Use a fixed prefix.');
  assert.equal(snapshot.tasks[0].approved_plan_revision_id, null);
});
test('cancellation during a running turn stops the child and prevents late plan publication', async t => {
  const h = setup(t, 'hang'); h.assign();
  for (let attempts = 0; !h.snapshot().runs[0].turn_ref && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  const running = h.snapshot(); assert.equal(running.runs[0].turn_ref, 'fixture-turn');
  h.call({ type: 'task.cancel', taskId: h.task.id, expectedVersion: running.tasks[0].version, reason: 'Stop this test run' });
  await h.service.planning.idle();
  const snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'CANCELLED'); assert.equal(snapshot.runs[0].status, 'cancelled'); assert.equal(snapshot.plans.length, 0);
});
test('timeouts fail visibly without producing a plan', async t => {
  const h = setup(t, 'hang', 150); h.assign(); await h.service.planning.idle();
  assert.equal(h.snapshot().runs[0].error_code, 'PROVIDER_TIMEOUT'); assert.equal(h.snapshot().plans.length, 0);
});
test('snapshots exclude secrets, ignored files, binary files, and symlink escapes', async t => {
  const h = setup(t);
  writeFileSync(join(h.repo, '.env'), 'secret=[REDACTED]');
  writeFileSync(join(h.repo, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(h.repo, 'ignored.txt'), 'never-send');
  writeFileSync(join(h.repo, 'blob.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(h.directory, 'outside.txt'), 'never-send');
  symlinkSync(join(h.directory, 'outside.txt'), join(h.repo, 'link.txt'));
  const snapshot = createPlanningSnapshot(h.repo, join(h.directory, 'snapshot'));
  assert.ok(snapshot.files.includes('greeting.ts'));
  for (const name of ['.env', 'ignored.txt', 'blob.bin', 'link.txt']) assert.ok(!snapshot.files.includes(name));
  const reader = new SnapshotReader(snapshot.path, snapshot.files);
  assert.throws(() => reader.call('read_repository_file', { path: '../outside.txt' }), /outside/);
  assert.throws(() => reader.call('read_repository_file', { path: '/etc/passwd' }), /outside/);
  assert.throws(() => reader.call('run_shell', {}), /Only snapshot/);
});
test('health strips account identity and does not claim model entitlement', async t => {
  const h = setup(t); const result = await h.service.handle({ type: 'provider.health', provider: 'codex' });
  assert.ok(result.ok); assert.doesNotMatch(JSON.stringify(result), /private-email/);
  assert.match(JSON.stringify(result), /completed planning turn/);
});
test('the planning queue enforces two concurrent runs and cancellation drains queued work', async t => {
  const h = setup(t, 'hang', 5000); h.assign();
  const ids = [h.task.id];
  for (let index = 0; index < 2; index++) {
    const request = h.call<{ id: string }>({ type: 'request.create', projectId: h.task.project_id, title: `Queued request ${index}`, body: 'Inspect the fixture.', kind: 'feature', priority: 'normal', acceptanceCriteria: [] });
    const task = h.call<Task>({ type: 'task.createFromRequest', requestId: request.id });
    ids.push(task.id); h.call({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'codex' });
  }
  for (let attempt = 0; h.snapshot().runs.filter(run => run.turn_ref).length < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const running = h.snapshot();
  assert.equal(running.runs.filter(run => run.status === 'running').length, 2);
  assert.equal(running.runs.filter(run => run.status === 'queued').length, 1);
  for (const id of ids) {
    const task = h.snapshot().tasks.find(task => task.id === id)!;
    h.call({ type: 'task.cancel', taskId: id, expectedVersion: task.version, reason: 'Cancel test queue' });
  }
  await h.service.planning.idle();
  assert.equal(h.snapshot().runs.filter(run => run.status === 'cancelled').length, 3);
});
test('a failed planning attempt can retry with an explicitly selected model', async t => {
  const h = setup(t, 'failed'); h.assign(); await h.service.planning.idle();
  const task = h.snapshot().tasks[0];
  h.call({ type: 'task.retry', taskId: task.id, expectedVersion: task.version, planningModel: 'explicit-model' });
  await h.service.planning.idle();
  assert.equal(h.snapshot().runs.at(-1)?.model, 'explicit-model');
  assert.equal(JSON.parse(h.snapshot().tasks[0].provider_policy_json).planningModel, 'explicit-model');
});
test('a revision requested from a real plan uses a fresh session and requires new approval', async t => {
  const h = setup(t); h.assign(); await h.service.planning.idle();
  const before = h.snapshot(); const plan = before.plans[0];
  h.call({ type: 'task.reviewPlan', taskId: h.task.id, expectedVersion: before.tasks[0].version, revisionId: plan.id, digest: plan.sha256_digest, action: 'request_changes', feedback: 'Include backward compatibility checks.' });
  await h.service.planning.idle();
  const after = h.snapshot(); assert.equal(after.plans.length, 2); assert.equal(after.runs.length, 2);
  assert.equal(after.tasks[0].status, 'PLAN_REVIEW'); assert.equal(after.tasks[0].approved_plan_revision_id, null);
  assert.equal(after.approvals[0].action, 'request_changes');
});
test('inherited MCP servers are explicitly disabled before a planning thread starts', async t => {
  const h = setup(t, 'inherited-mcp'); h.assign(); await h.service.planning.idle();
  assert.equal(h.snapshot().tasks[0].status, 'PLAN_REVIEW');
  assert.equal(h.snapshot().runs[0].status, 'succeeded');
});
test('snapshot integrity checks reject newly created files', async t => {
  const h = setup(t); const snapshot = createPlanningSnapshot(h.repo, join(h.directory, 'snapshot'));
  writeFileSync(join(snapshot.path, 'unexpected.txt'), 'unexpected mutation');
  assert.throws(() => snapshotDigest(snapshot.path, snapshot.files), /inventory changed/);
});

for (const mode of ['success', 'no-read', 'permission', 'unsafe', 'review-write'] as const) {
  test(`independent reviewer protocol is read-only and requires actual source reads: ${mode}`, async t => {
    const h = setup(t), reviewer = new CodexReviewer(process.execPath, [fixture, mode], 2000);
    const snapshot = createPlanningSnapshot(h.repo, join(h.directory, 'review-snapshot'));
    const run = reviewer.review({ cwd: snapshot.path, files: snapshot.files, commitSha: 'a'.repeat(40), signal: new AbortController().signal, onEvent() {}, prompt: 'Review commit ' + 'a'.repeat(40) });
    if (mode === 'success') { const review = await run; assert.equal(review.verdict, 'pass'); assert.equal(review.commitSha, 'a'.repeat(40)); }
    else await assert.rejects(run, error => ['POLICY_DENIED','INVALID_REVIEW'].includes((error as { code: string }).code));
    assert.equal(snapshotDigest(snapshot.path, snapshot.files), snapshot.digest);
  });
}

test('planning retry retains omitted choices and null resets only planning', async t => {
  const h = setup(t, 'failed');
  h.call({ type: 'task.assign', taskId: h.task.id, expectedVersion: h.task.version, provider: 'codex', planningModel: 'plan-id', implementationModel: 'build-id', reviewModel: 'review-id' });
  await h.service.planning.idle();
  for (const override of [{}, { planningModel: null }]) {
    const task = h.snapshot().tasks[0];
    h.call({ type: 'task.retry', taskId: task.id, expectedVersion: task.version, ...override });
    await h.service.planning.idle();
    const policy = JSON.parse(h.snapshot().tasks[0].provider_policy_json);
    assert.equal(policy.planningModel, 'planningModel' in override ? null : 'plan-id');
    assert.equal(policy.implementationModel, 'build-id');
    assert.equal(policy.reviewModel, 'review-id');
  }
});

test('implementation verification tools await results and let the same session retry failed checks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-verification-tool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'ignore' });
  writeFileSync(join(directory, 'greeting.ts'), 'export const greet = (name: string) => name;\n');
  let calls = 0;
  const implementer = new CodexImplementer(process.execPath, [fixture, 'verification'], 3000);
  const result = await implementer.implement({ cwd: directory, guard() {}, prompt: 'Implement and verify', signal: new AbortController().signal, onEvent() {},
    async runVerification() {
      calls++; await new Promise(resolve => setTimeout(resolve, 10));
      return { passed: calls > 1, checks: [{ name: 'Build', status: calls > 1 ? 'passed' : 'failed', exitCode: calls > 1 ? 0 : 1, log: 'Captured command output', reason: null }] };
    },
  });
  assert.equal(calls, 2); assert.deepEqual(result.touchedPaths, ['greeting.ts']);
});
for (const mode of ['verification-args', 'verification-skip']) test(`implementation cannot bypass verification or substitute arbitrary commands: ${mode}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-verification-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'ignore' });
  writeFileSync(join(directory, 'greeting.ts'), 'export const greet = (name: string) => name;\n');
  let calls = 0;
  const implementer = new CodexImplementer(process.execPath, [fixture, mode], 3000);
  await assert.rejects(implementer.implement({ cwd: directory, guard() {}, prompt: 'Implement and verify', signal: new AbortController().signal, onEvent() {},
    async runVerification() { calls++; return { passed: true, checks: [] }; },
  }));
  assert.equal(calls, 0);
});

test('cancellation aborts and drains an implementation verification tool', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-verification-cancel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'ignore' });
  writeFileSync(join(directory, 'greeting.ts'), 'export const greet = (name: string) => name;\n');
  const controller = new AbortController();
  let drained = false;
  const implementer = new CodexImplementer(process.execPath, [fixture, 'verification'], 3000);
  await assert.rejects(implementer.implement({ cwd: directory, guard() {}, prompt: 'Implement and verify', signal: controller.signal, onEvent() {},
    async runVerification(signal) {
      setTimeout(() => controller.abort(), 10);
      try {
        await new Promise<void>((_resolve, reject) => {
          if (signal!.aborted) reject(new Error('stopped'));
          else signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        });
        return { passed: true, checks: [] };
      } finally { drained = true; }
    },
  }), error => (error as { code: string }).code === 'CANCELLED');
  assert.equal(drained, true);
});
