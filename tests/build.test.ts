import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import { FactoryService } from '../apps/factory-service/src/service.js';
import { WorkspaceFiles } from '../apps/factory-service/src/git/workspace-files.js';
import { git, WorkspaceManager } from '../apps/factory-service/src/git/workspaces.js';
import { digest } from '../apps/factory-service/src/workflows/engine.js';
import type { ReviewAdapter, ImplementationAdapter, PlannerAdapter } from '../apps/factory-service/src/agents/codex.js';
import type { ValidationAdapter, ValidationInput } from '../apps/factory-service/src/checks/validation.js';
import type { Command, ExecutionConfig, PlanRevision, Snapshot, Task, WorkspaceDetails } from '../packages/contracts/src/index.js';

const original = 'exports.greet = (name) => `Hello, ${name}!`;\n';
const implemented = 'exports.greet = (name, formal = false) => formal ? `Good day, ${name}.` : `Hello, ${name}!`;\n';
const check = { name: 'Tests', argv: [process.execPath, '-e', "const {greet}=require('./greeting.cjs'); if(greet('Ada')!=='Hello, Ada!' || greet('Ada',true)!=='Good day, Ada.') process.exit(2); console.log('greeting tests passed');"], timeoutMs: 2000 };
// Test-only execution of a fixed disposable fixture. Production uses CodexValidationRunner.
class FixtureValidator implements ValidationAdapter {
  async run(input: ValidationInput) {
    return new Promise<{ exitCode: number; log: string }>((resolve, reject) => {
      const child = execFile(input.command.argv[0], input.command.argv.slice(1), { cwd: input.cwd, env: { PATH: process.env.PATH, HOME: input.temporaryDirectory }, timeout: input.command.timeoutMs }, (error, stdout, stderr) => {
        input.signal.removeEventListener('abort', abort);
        if (input.signal.aborted) { reject(new Error('cancelled')); return; }
        const log = stdout + stderr; input.onOutput(log);
        resolve({ exitCode: error ? typeof error.code === 'number' ? error.code : 124 : 0, log });
      });
      const abort = () => child.kill('SIGKILL');
      input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort();
    });
  }
}
async function setup(t: { after: (fn: () => unknown) => void }, options: { hang?: boolean; implementer?: ImplementationAdapter; reviewer?: ReviewAdapter; validator?: ValidationAdapter; commands?: ExecutionConfig['validationCommands']; enabled?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-build-')), repo = join(directory, 'repository');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'greeting.cjs'), original);
  git(repo, ['add', '--', 'greeting.cjs']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '-m', 'Initial fixture']);
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(repo, 'keep-dirty.txt'), 'Never overwrite my main checkout.\n');
  let implementationCalls = 0;
  const planner: PlannerAdapter = { async health() { return { available: true, authenticated: true, message: 'Fixture' }; }, async plan() { return { summary: 'Add optional formal greeting', assumptions: [], questions: [], steps: ['Update greeting.cjs', 'Validate backward compatibility'], affectedAreas: ['greeting.cjs'], acceptanceCriteria: ['Default greeting stays unchanged'], testStrategy: ['Run greeting tests'], risks: [] }; } };
  const implementer: ImplementationAdapter = { async implement(input) {
    implementationCalls++;
    const tools = new WorkspaceFiles(input.cwd, input.guard);
    const before = JSON.parse(tools.call('read_repository_file', { path: 'greeting.cjs' }));
    tools.call('write_repository_file', { path: 'greeting.cjs', content: options.hang ? '// preserved partial implementation\n' : implemented, expectedDigest: before.digest });
    input.onEvent({ type: 'progress', message: 'Fixture wrote greeting.cjs in its task worktree.' });
    if (options.hang) await new Promise<void>((_resolve, reject) => { if (input.signal.aborted) reject(new Error('cancelled')); else input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    return { summary: 'Added the optional formal greeting', limitations: [], touchedPaths: tools.touched() };
  } };
  let store = new Store(join(directory, 'factory.db'));
  const reviewer: ReviewAdapter = options.reviewer ?? { async review(input) { return { commitSha: input.commitSha, verdict: 'pass', summary: 'Fixture independent review passed', findings: [] }; } };
  const serviceOptions = { planner, implementer: options.implementer ?? implementer, reviewer, validator: options.validator ?? new FixtureValidator(), dataDir: directory, workspaceRoot: join(directory, 'worktrees') };
  let service = new FactoryService(store, serviceOptions);
  t.after(async () => { await Promise.all([service.planning.close(), service.builds.close()]); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = <T>(payload: Command): T => { const result = service.dispatch(payload); assert.ok(result.ok, JSON.stringify(result)); return result.data as T; };
  const snapshot = () => call<Snapshot>({ type: 'snapshot' });
  const { id: projectId } = call<{ id: string }>({ type: 'project.add', name: 'Build fixture', path: repo });
  const configure = (commands = options.commands ?? [check], enabled = options.enabled ?? true) => {
    const project = snapshot().projects[0];
    call({ type: 'project.configure', projectId, expectedVersion: project.version, config: { executionEnabled: enabled, trustedRepository: true, validationCommands: commands } });
  };
  configure();
  const makeTask = async (title = 'Formal greeting') => {
    const { id: requestId } = call<{ id: string }>({ type: 'request.create', projectId, title, body: 'Implement an optional formal greeting without changing the default.', kind: 'feature', priority: 'normal', acceptanceCriteria: ['The original call still works'] });
    const task = call<Task>({ type: 'task.createFromRequest', requestId });
    call({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'codex' });
    await service.planning.idle(); return snapshot().tasks.find(item => item.id === task.id)!;
  };
  const approve = (task: Task) => { const plan = snapshot().plans.find(plan => plan.task_id === task.id)!; return call<Task>({ type: 'task.reviewPlan', taskId: task.id, expectedVersion: task.version, revisionId: plan.id, digest: plan.sha256_digest, action: 'approve' }); };
  const resume = (task: Task, stage: 'implement' | 'validate', details?: WorkspaceDetails) => {
    details ??= call<WorkspaceDetails>({ type: 'workspace.inspect', taskId: task.id });
    return call<Task>({ type: 'task.resume', taskId: task.id, expectedVersion: task.version, stage, expectedHead: details.currentHead, expectedWorkspaceDigest: details.workspaceDigest });
  };
  return { directory, repo, mainHead, projectId, call, snapshot, makeTask, approve, resume, configure, get service() { return service; }, get store() { return store; }, get implementationCalls() { return implementationCalls; },
    async restart() { await Promise.all([service.planning.close(), service.builds.close()]); store.close(); store = new Store(join(directory, 'factory.db')); service = new FactoryService(store, serviceOptions); service.recover(); },
  };
}
const waitFor = async (predicate: () => boolean) => { for (let attempt = 0; !predicate() && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'Expected worker state was not reached'); };

test('approved plan builds in its own worktree, commits, and validates the exact HEAD', async t => {
  const h = await setup(t); const task = await h.makeTask();
  assert.equal(h.snapshot().workspaces.length, 0); h.approve(task); await h.service.builds.idle();
  const snapshot = h.snapshot(), workspace = snapshot.workspaces[0];
  assert.equal(snapshot.tasks[0].status, 'FINAL_REVIEW', snapshot.tasks[0].reason ?? '');
  assert.equal(readFileSync(join(h.repo, 'greeting.cjs'), 'utf8'), original);
  assert.equal(readFileSync(join(h.repo, 'keep-dirty.txt'), 'utf8'), 'Never overwrite my main checkout.\n');
  assert.equal(git(h.repo, ['rev-parse', 'HEAD']).trim(), h.mainHead);
  assert.notEqual(workspace.head_sha, workspace.base_sha);
  assert.equal(snapshot.validations[0].commit_sha, workspace.head_sha); assert.equal(snapshot.validations[0].status, 'passed');
  assert.match(snapshot.validations[0].log_text, /greeting tests passed/);
  assert.equal(snapshot.approvals.filter(approval => approval.gate === 'final').length, 0);
});
test('implementation before approval is denied without creating a branch or worktree', async t => {
  const h = await setup(t); const task = await h.makeTask();
  const denied = h.service.dispatch({ type: 'task.run', taskId: task.id, expectedVersion: task.version });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'APPROVAL_REQUIRED');
  assert.equal(h.snapshot().workspaces.length, 0); assert.equal(git(h.repo, ['branch', '--list', 'factory/*']).trim(), '');
});
test('missing configured validation is visible and can recover without rerunning implementation', async t => {
  const h = await setup(t, { commands: [] }); h.approve(await h.makeTask()); await h.service.builds.idle();
  let snapshot = h.snapshot(); assert.equal(snapshot.tasks[0].status, 'BLOCKED'); assert.match(snapshot.tasks[0].reason!, /NOT RUN/);
  const head = snapshot.workspaces[0].head_sha;
  h.configure([check]); h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle();
  snapshot = h.snapshot(); assert.equal(snapshot.tasks[0].status, 'FINAL_REVIEW'); assert.equal(snapshot.workspaces[0].head_sha, head); assert.equal(h.implementationCalls, 1);
});
test('failing checks preserve the commit and never mark the task reviewed or accepted', async t => {
  const h = await setup(t, { commands: [{ name: 'Fail', argv: [process.execPath, '-e', "console.error('expected failure');process.exit(7)"], timeoutMs: 2000 }] });
  h.approve(await h.makeTask()); await h.service.builds.idle();
  const snapshot = h.snapshot(); assert.equal(snapshot.tasks[0].status, 'BLOCKED'); assert.equal(snapshot.validations[0].exit_code, 7); assert.equal(snapshot.validations[0].status, 'failed'); assert.ok(snapshot.workspaces[0].head_sha);
});
test('cancellation preserves partial edits and prevents a late completion from publishing', async t => {
  const h = await setup(t, { hang: true }); h.approve(await h.makeTask());
  await waitFor(() => h.snapshot().events.some(event => event.type === 'run.progress' && JSON.parse(event.payload_json).message?.includes('Fixture wrote')));
  const task = h.snapshot().tasks[0], workspace = h.snapshot().workspaces[0];
  h.call({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: 'Stop partial implementation' }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'CANCELLED'); assert.match(readFileSync(join(workspace.path, 'greeting.cjs'), 'utf8'), /preserved partial/);
  assert.equal(git(workspace.path, ['rev-parse', 'HEAD']).trim(), workspace.base_sha); assert.equal(h.snapshot().validations.length, 0);
});
test('two simultaneous implementation tasks use different worktrees and branches', async t => {
  const h = await setup(t, { enabled: false }); const first = await h.makeTask('First greeting'), second = await h.makeTask('Second greeting'); h.approve(first); h.approve(second); h.configure([check], true);
  for (const task of h.snapshot().tasks) h.call({ type: 'task.run', taskId: task.id, expectedVersion: task.version });
  await h.service.builds.idle(); const snapshot = h.snapshot();
  assert.ok(snapshot.tasks.every(task => task.status === 'FINAL_REVIEW'), JSON.stringify(snapshot.tasks));
  assert.notEqual(snapshot.workspaces[0].path, snapshot.workspaces[1].path); assert.notEqual(snapshot.workspaces[0].branch, snapshot.workspaces[1].branch);
  assert.equal(git(h.repo, ['rev-parse', 'HEAD']).trim(), h.mainHead);
});
test('validation source changes invalidate earlier passing evidence', async t => {
  const validator: ValidationAdapter = { async run(input) { if (input.command.name === 'Mutate') writeFileSync(join(input.cwd, 'greeting.cjs'), '// validation changed source\n'); return { exitCode: 0, log: 'done' }; } };
  const h = await setup(t, { validator, commands: [check, { ...check, name: 'Mutate' }] }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.ok(h.snapshot().validations.every(check => check.status === 'stale'));
});
test('recovery refuses a stale worktree inspection', async t => {
  const h = await setup(t, { commands: [] }); h.approve(await h.makeTask()); await h.service.builds.idle();
  const task = h.snapshot().tasks[0], details = h.call<WorkspaceDetails>({ type: 'workspace.inspect', taskId: task.id });
  writeFileSync(join(details.path, 'greeting.cjs'), '// human edit after inspection\n');
  const denied = h.service.dispatch({ type: 'task.resume', taskId: task.id, expectedVersion: task.version, stage: 'implement', expectedHead: details.currentHead, expectedWorkspaceDigest: details.workspaceDigest });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'STALE_EVIDENCE');
});
test('startup reconciles interrupted implementation and preserves its worktree for explicit resume', async t => {
  const h = await setup(t, { enabled: false }); const task = await h.makeTask(); const queued = h.approve(task); h.configure([check], true);
  const building = h.service.workflow.transition(task.id, queued.version, 'BUILDING', 'test.started');
  const workspace = await h.service.builds.workspaces.ensure(building);
  writeFileSync(join(workspace.path, 'greeting.cjs'), '// partial edit survived restart\n');
  h.store.db.prepare("INSERT INTO agent_runs(id,task_id,stage,provider,status,attempt,started_at,recovery_stage,approved_plan_id) VALUES (?,?,'implement','codex','running',1,?,'implement',?)").run(randomUUID(), task.id, new Date().toISOString(), building.approved_plan_revision_id);
  await h.restart(); let snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'BLOCKED'); assert.ok(snapshot.runs.some(run => run.status === 'interrupted')); assert.match(readFileSync(join(workspace.path, 'greeting.cjs'), 'utf8'), /survived restart/);
  h.resume(snapshot.tasks[0], 'implement'); await h.service.builds.idle(); snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'FINAL_REVIEW', snapshot.tasks[0].reason ?? ''); assert.equal(snapshot.workspaces[0].path, workspace.path);
});
test('external commits after validation invalidate the current evidence', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  const workspace = h.snapshot().workspaces[0]; writeFileSync(join(workspace.path, 'greeting.cjs'), implemented + '// subsequent human edit\n');
  git(workspace.path, ['add', '--', 'greeting.cjs']); git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '-m', 'Human followup']);
  h.call({ type: 'workspace.inspect', taskId: workspace.task_id });
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().validations[0].status, 'stale');
});
test('worktree file tools deny traversal, Git metadata, symlink escapes, and stale file digests', async t => {
  const h = await setup(t, { commands: [] }); h.approve(await h.makeTask()); await h.service.builds.idle();
  const workspace = h.snapshot().workspaces[0], tools = new WorkspaceFiles(workspace.path, () => {});
  assert.throws(() => tools.call('write_repository_file', { path: '../escape.txt', content: 'bad', expectedDigest: null }), /scope/);
  assert.throws(() => tools.call('write_repository_file', { path: '.git/config', content: 'bad', expectedDigest: null }), /scope/);
  symlinkSync(h.repo, join(workspace.path, 'escape'));
  assert.throws(() => tools.call('write_repository_file', { path: 'escape/greeting.cjs', content: 'bad', expectedDigest: null }), /Symlink/);
  assert.throws(() => tools.call('write_repository_file', { path: 'greeting.cjs', content: 'bad', expectedDigest: '0'.repeat(64) }), /digest changed/);
  assert.equal(readFileSync(join(h.repo, 'greeting.cjs'), 'utf8'), original);
});
test('validation logs redact credentials before persistence', async t => {
  const h = await setup(t, { validator: { async run(input) { input.onOutput('DB_PASSWORD=topsecret\n'); return { exitCode: 0, log: 'DB_PASSWORD=topsecret\n' }; } } }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.match(h.snapshot().validations[0].log_text, /REDACTED/); assert.doesNotMatch(JSON.stringify(h.snapshot()), /topsecret/);
});
test('the global worker cap covers planning and builds, and stop-all cancels the queue', async t => {
  const h = await setup(t, { hang: true }); h.approve(await h.makeTask('First worker')); h.approve(await h.makeTask('Second worker'));
  await waitFor(() => h.snapshot().events.filter(event => event.type === 'run.progress' && JSON.parse(event.payload_json).message?.includes('Fixture wrote')).length === 2);
  const request = h.call<{ id: string }>({ type: 'request.create', projectId: h.projectId, title: 'Queued planning', body: 'Plan another greeting.', kind: 'feature', priority: 'normal', acceptanceCriteria: [] });
  const task = h.call<Task>({ type: 'task.createFromRequest', requestId: request.id });
  h.call({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'codex' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.snapshot().runs.filter(run => ['starting','running'].includes(run.status)).length, 2);
  assert.equal(h.snapshot().runs.find(run => run.task_id === task.id)?.status, 'queued');
  assert.equal(h.call<{ stopped: number }>({ type: 'agents.stopAll', reason: 'Emergency test stop' }).stopped, 3);
  await Promise.all([h.service.planning.idle(), h.service.builds.idle()]);
  assert.ok(h.snapshot().tasks.every(task => task.status === 'CANCELLED'));
});
test('cancelling validation preserves the implementation commit and marks its running check cancelled', async t => {
  const validator: ValidationAdapter = { async run(input) { input.onOutput('check is running\n'); return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } };
  const h = await setup(t, { validator }); h.approve(await h.makeTask());
  await waitFor(() => h.snapshot().validations[0]?.status === 'running');
  const task = h.snapshot().tasks[0], head = h.snapshot().workspaces[0].head_sha;
  h.call({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: 'Stop check' }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'CANCELLED'); assert.equal(h.snapshot().validations[0].status, 'cancelled'); assert.equal(h.snapshot().workspaces[0].head_sha, head);
});
test('interrupted validation recovers against the same commit without repeating implementation', async t => {
  const h = await setup(t, { enabled: false }); const task = await h.makeTask(), queued = h.approve(task); h.configure([check], true);
  const building = h.service.workflow.transition(task.id, queued.version, 'BUILDING', 'test.started'), workspace = await h.service.builds.workspaces.ensure(building);
  const tools = new WorkspaceFiles(workspace.path, () => {}), before = JSON.parse(tools.call('read_repository_file', { path: 'greeting.cjs' }));
  tools.call('write_repository_file', { path: 'greeting.cjs', content: implemented, expectedDigest: before.digest });
  const head = await h.service.builds.workspaces.commit(building, workspace, tools.touched());
  h.service.workflow.transition(task.id, building.version, 'VALIDATING', 'test.validation');
  const runId = randomUUID();
  h.store.db.prepare("INSERT INTO agent_runs(id,task_id,stage,provider,status,attempt,started_at,recovery_stage,approved_plan_id) VALUES (?,?,'implement','codex','running',1,?,'validate',?)").run(runId, task.id, new Date().toISOString(), building.approved_plan_revision_id);
  h.store.db.prepare("INSERT INTO validation_runs(id,task_id,commit_sha,name,argv_json,log_path,started_at,status,run_id,config_digest) VALUES (?,?,?,?,?,?,?,'running',?,?)").run(randomUUID(), task.id, head, check.name, JSON.stringify(check.argv), join(h.directory, 'interrupted.log'), new Date().toISOString(), runId, digest([check]));
  await h.restart(); assert.equal(h.snapshot().validations[0].status, 'interrupted');
  h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW'); assert.equal(h.implementationCalls, 0); assert.equal(h.snapshot().workspaces[0].head_sha, head);
});
test('a simulated approved plan cannot start a real implementation even on an enabled project', async t => {
  const h = await setup(t);
  const request = h.call<{ id: string }>({ type: 'request.create', projectId: h.projectId, title: 'Simulation', body: 'Simulated request', kind: 'feature', priority: 'normal', acceptanceCriteria: [] });
  const created = h.call<Task>({ type: 'task.createFromRequest', requestId: request.id });
  const proposed = h.call<Task>({ type: 'task.assign', taskId: created.id, expectedVersion: created.version, provider: 'fake' });
  const approved = h.approve(proposed);
  const denied = h.service.dispatch({ type: 'task.run', taskId: created.id, expectedVersion: approved.version });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'POLICY_DENIED');
  assert.equal(h.snapshot().workspaces.length, 0);
});
test('untrusted execution and mid-run project configuration changes are rejected', async t => {
  const h = await setup(t, { hang: true });
  const project = h.snapshot().projects[0];
  const denied = h.service.dispatch({ type: 'project.configure', projectId: project.id, expectedVersion: project.version, config: { executionEnabled: true, trustedRepository: false, validationCommands: [check] } });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'POLICY_DENIED');
  h.approve(await h.makeTask()); await waitFor(() => h.snapshot().tasks[0].status === 'BUILDING');
  const concurrent = h.service.dispatch({ type: 'project.configure', projectId: project.id, expectedVersion: project.version, config: { executionEnabled: false, trustedRepository: true, validationCommands: [] } });
  assert.equal(concurrent.ok, false); if (!concurrent.ok) assert.equal(concurrent.error.code, 'CONFLICT');
  h.call({ type: 'agents.stopAll', reason: 'Finish test' }); await h.service.builds.idle();
});
test('changing required checks invalidates existing code-review evidence', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW');
  h.configure([{ ...check, name: 'Changed required test' }]);
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().validations[0].status, 'stale');
});
test('an invalid managed root is rejected before creating anything in the main checkout', async t => {
  const h = await setup(t, { enabled: false }); const queued = h.approve(await h.makeTask());
  const building = h.service.workflow.transition(queued.id, queued.version, 'BUILDING', 'test.started');
  const nested = join(h.repo, 'nested-workspaces'), manager = new WorkspaceManager(h.store, nested);
  await assert.rejects(manager.ensure(building), /outside the registered checkout/); assert.equal(existsSync(nested), false);
});
test('an existing task branch is preserved rather than overwritten on collision', async t => {
  const h = await setup(t, { enabled: false }); const task = await h.makeTask(), queued = h.approve(task); h.configure([check], true);
  const branch = `factory/${task.id}-formal-greeting`; git(h.repo, ['branch', branch, 'main']);
  h.call({ type: 'task.run', taskId: task.id, expectedVersion: queued.version }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(git(h.repo, ['rev-parse', branch]).trim(), h.mainHead);
  assert.equal(existsSync(h.snapshot().workspaces[0].path), false);
});
test('validation timeout is visible and cannot become passing evidence', async t => {
  const h = await setup(t, { commands: [{ name: 'Timeout', argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 100 }] });
  h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().validations[0].status, 'timed_out'); assert.match(h.snapshot().tasks[0].reason!, /three-repair limit/);
});
test('a missing completed worktree becomes recovery-required without deleting its branch', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  const workspace = h.snapshot().workspaces[0]; rmSync(workspace.path, { recursive: true, force: true });
  await h.restart();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().workspaces[0].cleanup_status, 'recovery_required'); assert.equal(h.snapshot().validations[0].status, 'stale');
  assert.equal(git(h.repo, ['rev-parse', workspace.branch]).trim(), workspace.head_sha);
});

function finalCommand(h: Awaited<ReturnType<typeof setup>>, action: 'accept' | 'request_changes' | 'reject' = 'accept', feedback = ''): Command {
  const snapshot = h.snapshot(), bundle = snapshot.evidence.at(-1)!;
  return { type: 'task.reviewFinal', taskId: snapshot.tasks[0].id, expectedVersion: snapshot.tasks[0].version, bundleId: bundle.id, digest: bundle.sha256_digest, expectedHead: bundle.commit_sha, action, feedback };
}
const passedReview: ReviewAdapter = { async review(input) { return { commitSha: input.commitSha, verdict: 'pass', summary: 'Reviewed source, tests and approved scope.', findings: [] }; } };
const finding = { severity: 'high' as const, file: 'greeting.cjs', line: 1, title: 'Formal branch needs a correction', rationale: 'The formal greeting differs from the approved scope.', suggestedFix: 'Fix the formal branch while preserving the default.' };

test('final acceptance records the exact commit and immutable evidence, survives restart, and never merges', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  const before = h.snapshot();
  assert.equal(before.tasks[0].status, 'FINAL_REVIEW'); assert.equal(before.reviews.length, 1);
  assert.notEqual(before.reviews[0].run_id, before.runs.find(run => run.stage === 'implement')!.id);
  const bundle = before.evidence[0], body = JSON.parse(bundle.body_json);
  assert.equal(body.checks[0].commitSha, bundle.commit_sha); assert.equal(body.review.id, before.reviews[0].id);
  assert.throws(() => h.store.db.prepare("UPDATE evidence_bundles SET body_json='{}'").run(), /immutable/);
  assert.throws(() => h.service.workflow.transition(before.tasks[0].id, before.tasks[0].version, 'ACCEPTED', 'bypass'), /durable human acceptance/);
  h.call(finalCommand(h));
  const accepted = h.snapshot(); assert.equal(accepted.tasks[0].status, 'ACCEPTED'); assert.equal(accepted.tasks[0].accepted_commit_sha, bundle.commit_sha);
  const decision = h.store.db.prepare("SELECT * FROM approvals WHERE gate='final'").get() as { artifact_id: string; artifact_digest: string; commit_sha: string };
  assert.equal(decision.artifact_id, bundle.id); assert.equal(decision.artifact_digest, bundle.sha256_digest); assert.equal(decision.commit_sha, bundle.commit_sha);
  await h.restart(); assert.equal(h.snapshot().tasks[0].status, 'ACCEPTED');
  assert.equal(git(h.repo, ['rev-parse', 'HEAD']).trim(), h.mainHead);
  assert.throws(() => h.service.workflow.transition(h.snapshot().tasks[0].id, h.snapshot().tasks[0].version, 'MERGED', 'bypass'), /separately authorized/);
});
test('final decisions reject forged artifacts, digests, commit SHAs, and stale versions', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  const command = finalCommand(h);
  for (const replacement of [{ bundleId: randomUUID() }, { digest: '0'.repeat(64) }, { expectedHead: '0'.repeat(40) }, { expectedVersion: 1 }]) {
    const denied = h.service.dispatch({ ...command, ...replacement }); assert.equal(denied.ok, false);
  }
  assert.equal(h.snapshot().approvals.filter(approval => approval.gate === 'final').length, 0); assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW');
});
test('dirty edits and external commits revoke final evidence before acceptance', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  const command = finalCommand(h), workspace = h.snapshot().workspaces[0];
  writeFileSync(join(workspace.path, 'greeting.cjs'), implemented + '// changed after review\n');
  const denied = h.service.dispatch(command); assert.equal(denied.ok, false);
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().reviews[0].status, 'stale');
  assert.equal(h.snapshot().approvals.filter(approval => approval.gate === 'final').length, 0);
});
test('changing an accepted commit revokes acceptance but retains the human decision history', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle(); h.call(finalCommand(h));
  const workspace = h.snapshot().workspaces[0];
  writeFileSync(join(workspace.path, 'greeting.cjs'), implemented + '// human followup\n');
  git(workspace.path, ['add', '--all']); git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Followup']);
  await h.restart();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().tasks[0].accepted_commit_sha, null);
  assert.equal(h.snapshot().approvals.filter(approval => approval.gate === 'final' && approval.action === 'accept').length, 1);
});
test('evidence verification detects altered checks and captured logs', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  h.store.db.prepare("UPDATE validation_runs SET log_text='replaced evidence' WHERE status='passed'").run();
  assert.equal(h.service.dispatch(finalCommand(h)).ok, false); assert.equal(h.snapshot().tasks[0].status, 'BLOCKED');
});
test('review changes trigger repair, a new commit, fresh checks, and fresh independent review', async t => {
  let reviews = 0, writes = 0;
  const reviewer: ReviewAdapter = { async review(input) {
    reviews++; if (reviews === 1) return { commitSha: input.commitSha, verdict: 'changes_requested', summary: 'Please correct the formal branch.', findings: [finding] };
    return passedReview.review(input);
  } };
  const implementer: ImplementationAdapter = { async implement(input) {
    writes++; const tools = new WorkspaceFiles(input.cwd, input.guard), before = JSON.parse(tools.call('read_repository_file', { path: 'greeting.cjs' }));
    if (writes > 1) assert.match(input.prompt, /Formal branch needs a correction/);
    tools.call('write_repository_file', { path: 'greeting.cjs', content: implemented + (writes > 1 ? '// independently requested repair\n' : ''), expectedDigest: before.digest });
    return { summary: writes > 1 ? 'Corrected the review finding' : 'Implemented greeting', limitations: [], touchedPaths: tools.touched() };
  } };
  const h = await setup(t, { reviewer, implementer }); h.approve(await h.makeTask()); await h.service.builds.idle();
  const snapshot = h.snapshot(); assert.equal(snapshot.tasks[0].status, 'FINAL_REVIEW', snapshot.tasks[0].reason ?? '');
  assert.equal(reviews, 2); assert.equal(writes, 2); assert.equal(snapshot.runs.filter(run => run.stage === 'repair').length, 1);
  assert.notEqual(snapshot.reviews[0].commit_sha, snapshot.reviews[1].commit_sha); assert.equal(snapshot.reviews[0].status, 'stale');
  assert.equal(snapshot.validations.length, 2); assert.equal(snapshot.validations[1].commit_sha, snapshot.reviews[1].commit_sha);
  assert.equal(JSON.parse(snapshot.evidence[0].body_json).reviewHistory.length, 2);
});
test('failed validation triggers bounded repair and fresh successful checks before review', async t => {
  let checks = 0;
  const validator: ValidationAdapter = { async run() { checks++; return { exitCode: checks === 1 ? 2 : 0, log: checks === 1 ? 'Expected formal greeting; actual differed' : 'Assertions passed' }; } };
  const h = await setup(t, { validator }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW'); assert.equal(checks, 2); assert.equal(h.snapshot().runs.filter(run => run.stage === 'repair').length, 1);
  assert.equal(h.snapshot().validations[0].status, 'failed'); assert.equal(h.snapshot().validations[1].status, 'passed');
});
test('persistent review defects exhaust exactly three repairs and remain blocked after restart', async t => {
  const reviewer: ReviewAdapter = { async review(input) { return { commitSha: input.commitSha, verdict: 'changes_requested', summary: 'Still defective.', findings: [finding] }; } };
  const h = await setup(t, { reviewer }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.match(h.snapshot().tasks[0].reason!, /three-repair limit/);
  assert.equal(h.snapshot().runs.filter(run => run.stage === 'repair').length, 3); assert.equal(h.snapshot().reviews.length, 4); assert.equal(h.snapshot().evidence.length, 0);
  await h.restart(); h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().runs.filter(run => run.stage === 'repair').length, 3);
});
test('blocked reviews and contradictory critical pass verdicts cannot reach final review', async t => {
  const reviewer: ReviewAdapter = { async review(input) { return { commitSha: input.commitSha, verdict: 'pass', summary: 'Contradictory verdict', findings: [{ ...finding, severity: 'critical' }] }; } };
  const h = await setup(t, { reviewer }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.ok(h.snapshot().reviews.every(review => review.verdict === 'changes_requested')); assert.equal(h.snapshot().evidence.length, 0);
});
test('an explicitly blocked review preserves findings without attempting a repair', async t => {
  const reviewer: ReviewAdapter = { async review(input) { return { commitSha: input.commitSha, verdict: 'blocked', summary: 'Cannot establish a required acceptance criterion.', findings: [] }; } };
  const h = await setup(t, { reviewer }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().runs.filter(run => run.stage === 'repair').length, 0); assert.equal(h.snapshot().reviews[0].verdict, 'blocked');
});
test('a reviewer cannot return a verdict for a different commit', async t => {
  const reviewer: ReviewAdapter = { async review() { return { commitSha: '0'.repeat(40), verdict: 'pass', summary: 'Wrong commit', findings: [] }; } };
  const h = await setup(t, { reviewer }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().reviews.length, 0); assert.equal(h.snapshot().evidence.length, 0);
});
test('source mutation during review invalidates validation and prevents publication', async t => {
  let h: Awaited<ReturnType<typeof setup>>;
  const reviewer: ReviewAdapter = { async review(input) {
    writeFileSync(join(h.snapshot().workspaces[0].path, 'greeting.cjs'), implemented + '// changed mid-review\n');
    return passedReview.review(input);
  } };
  h = await setup(t, { reviewer }); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().validations[0].status, 'stale'); assert.equal(h.snapshot().reviews.length, 0);
});
test('cancelling independent review stops publication and supports explicit revalidation recovery', async t => {
  let reviewing = false, hang = true;
  const reviewer: ReviewAdapter = { async review(input) {
    reviewing = true;
    if (hang) await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return passedReview.review(input);
  } };
  const h = await setup(t, { reviewer }); h.approve(await h.makeTask()); await waitFor(() => reviewing);
  const task = h.snapshot().tasks[0]; h.call({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: 'Stop review' }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'CANCELLED'); assert.equal(h.snapshot().evidence.length, 0); assert.equal(h.snapshot().reviews.length, 0);
  hang = false; h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle(); assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW'); assert.equal(h.implementationCalls, 1);
});
test('human changes require feedback, remain in scope, and create a fresh evidence bundle before acceptance', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  const before = h.snapshot(), originalCommand = finalCommand(h);
  assert.equal(h.service.dispatch(finalCommand(h, 'request_changes')).ok, false);
  h.call(finalCommand(h, 'request_changes', 'Check the formal branch again within the approved scope.')); await h.service.builds.idle();
  const after = h.snapshot(); assert.equal(after.tasks[0].status, 'FINAL_REVIEW', after.tasks[0].reason ?? ''); assert.equal(after.evidence.length, 2); assert.equal(after.reviews.length, 2);
  assert.notEqual(before.evidence[0].id, after.evidence[1].id); assert.equal(h.service.dispatch(originalCommand).ok, false);
  assert.equal(after.approvals.filter(approval => approval.gate === 'final' && approval.action === 'request_changes').length, 1);
  h.call(finalCommand(h)); assert.equal(h.snapshot().tasks[0].status, 'ACCEPTED');
});
test('final rejection requires a reason and preserves the reviewed worktree', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.service.dispatch(finalCommand(h, 'reject')).ok, false);
  h.call(finalCommand(h, 'reject', 'This change is no longer needed.'));
  assert.equal(h.snapshot().tasks[0].status, 'REJECTED'); assert.ok(existsSync(h.snapshot().workspaces[0].path)); assert.equal(h.snapshot().tasks[0].accepted_commit_sha, null);
});
test('restart interrupts a reviewer without assuming pass or automatically resuming', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  h.store.db.prepare("UPDATE tasks SET status='CODE_REVIEW' WHERE id=?").run(h.snapshot().tasks[0].id);
  h.store.db.prepare("INSERT INTO agent_runs(id,task_id,stage,provider,status,attempt,started_at,recovery_stage,approved_plan_id) VALUES (?,?,'review','codex','running',2,?,'review',?)").run(randomUUID(), h.snapshot().tasks[0].id, new Date().toISOString(), h.snapshot().tasks[0].approved_plan_revision_id);
  await h.restart(); assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().runs.at(-1)?.status, 'interrupted');
  h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle(); assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW');
});

test('completed Milestone 3 tasks can continue through independent review without implementation', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  h.store.db.prepare("UPDATE tasks SET status='CODE_REVIEW' WHERE id=?").run(h.snapshot().tasks[0].id);
  const task = h.snapshot().tasks[0]; h.call({ type: 'task.startReview', taskId: task.id, expectedVersion: task.version }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW', h.snapshot().tasks[0].reason ?? ''); assert.equal(h.implementationCalls, 1); assert.equal(h.snapshot().reviews.length, 2);
});
test('orphaned repair stages reconcile to an explicit recovery gate', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle();
  h.store.db.prepare("UPDATE tasks SET status='REPAIRING' WHERE id=?").run(h.snapshot().tasks[0].id);
  await h.restart(); assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.match(h.snapshot().tasks[0].reason!, /between pipeline stages/);
});
test('project check changes revoke acceptance and require new validation and review', async t => {
  const h = await setup(t); h.approve(await h.makeTask()); await h.service.builds.idle(); h.call(finalCommand(h));
  h.configure([{ ...check, name: 'Updated checks' }]);
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().tasks[0].accepted_commit_sha, null); assert.equal(h.snapshot().reviews[0].status, 'stale');
  h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle(); assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW');
});
test('cancelling a repair preserves edits and prevents fresh evidence publication', async t => {
  let writes = 0, repairing = false;
  const implementer: ImplementationAdapter = { async implement(input) {
    writes++; const tools = new WorkspaceFiles(input.cwd, input.guard), before = JSON.parse(tools.call('read_repository_file', { path: 'greeting.cjs' }));
    tools.call('write_repository_file', { path: 'greeting.cjs', content: implemented + (writes > 1 ? '// preserved partial repair\n' : ''), expectedDigest: before.digest });
    if (writes > 1) { repairing = true; await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
    return { summary: 'Fixture write', limitations: [], touchedPaths: tools.touched() };
  } };
  const reviewer: ReviewAdapter = { async review(input) { return { commitSha: input.commitSha, verdict: 'changes_requested', summary: 'Repair needed', findings: [finding] }; } };
  const h = await setup(t, { implementer, reviewer }); h.approve(await h.makeTask()); await waitFor(() => repairing);
  const task = h.snapshot().tasks[0], workspace = h.snapshot().workspaces[0];
  h.call({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: 'Stop the partial repair' }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'CANCELLED'); assert.match(readFileSync(join(workspace.path, 'greeting.cjs'), 'utf8'), /preserved partial repair/); assert.equal(h.snapshot().evidence.length, 0);
});


test('missing validation tools block for setup without consuming repair attempts and recover through validation', async t => {
  let calls = 0;
  const h = await setup(t, { validator: { async run() { return ++calls === 1 ? { exitCode: 127, log: 'sh: tsx: command not found\n' } : { exitCode: 0, log: 'Test suite passed after dependency setup' }; } } });
  h.approve(await h.makeTask()); await h.service.builds.idle();
  let snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'BLOCKED');
  assert.match(snapshot.tasks[0].reason ?? '', /npm ci/);
  assert.equal(snapshot.runs.filter(run => run.stage === 'repair').length, 0);
  assert.equal(snapshot.validations[0].status, 'failed');
  assert.match(snapshot.validations[0].reason ?? '', /setup failure/);
  assert.equal(h.implementationCalls, 1);
  h.resume(snapshot.tasks[0], 'validate'); await h.service.builds.idle();
  snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'FINAL_REVIEW');
  assert.equal(snapshot.runs.filter(run => run.stage === 'repair').length, 0);
  assert.equal(h.implementationCalls, 1);
});

// Repository-backed execution fixtures use the same planner/implementation/review gates.
async function configureYaml(h: Awaited<ReturnType<typeof setup>>, options: { network?: boolean; allowNetwork?: boolean; commit?: boolean; commands?: { name: string; run: string[]; timeout_seconds: number }[] } = {}) {
  const project = h.snapshot().projects[0];
  h.call({ type: 'project.configuration.save', projectId: project.id, expectedVersion: project.version, expectedDigest: null,
    configuration: { version: 1, worktree_init: { network: options.network ?? false, commands: options.commands ?? [{ name: 'Prepare dependencies', run: [process.execPath, '-e', "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ready','ready')"], timeout_seconds: 2 }] }, verification: { commands: [{ name: check.name, run: check.argv, timeout_seconds: 2 }] } },
    local: { executionEnabled: true, trustedRepository: true, initializationNetworkAllowed: options.allowNetwork ?? false } });
  // Dependency output must stay ignored in each worktree.
  writeFileSync(join(h.repo, '.gitignore'), 'node_modules/\n');
  if (options.commit !== false) { git(h.repo, ['add', '.kulumin.yml', '.gitignore']); git(h.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Shared setup']); }
}
test('YAML initializes every new worktree before implementation and verifies afterward; retries reuse successful setup', async t => {
  const calls: { name: string; network: boolean }[] = [], runner = new FixtureValidator();
  const h = await setup(t, { validator: { async run(input) { calls.push({ name: input.command.name, network: input.networkAccess === true }); return runner.run(input); } } });
  await configureYaml(h, { network: true, allowNetwork: true });
  h.approve(await h.makeTask()); await h.service.builds.idle();
  let snapshot = h.snapshot();
  assert.equal(snapshot.tasks[0].status, 'FINAL_REVIEW', snapshot.tasks[0].reason ?? '');
  assert.deepEqual(calls, [{ name: 'Prepare dependencies', network: true }, { name: 'Tests', network: false }]);
  assert.equal(snapshot.initializations[0].status, 'succeeded');
  assert.equal(readFileSync(join(snapshot.workspaces[0].path, 'node_modules/ready'), 'utf8'), 'ready');
  assert.ok(JSON.parse(snapshot.evidence[0].body_json).initialization);
  // Stop at an explicit recovery gate and verify setup is not repeated automatically.
  h.service.builds.invalidate(snapshot.tasks[0], 'Fixture needs revalidation');
  h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle();
  assert.equal(h.snapshot().initializations.length, 1);
  h.approve(await h.makeTask('Second worktree')); await h.service.builds.idle();
  assert.equal(h.snapshot().initializations.length, 2);
  assert.equal(calls.filter(call => call.name === 'Prepare dependencies').length, 2);
  snapshot = h.snapshot(); assert.ok(snapshot.tasks.every(task => task.status === 'FINAL_REVIEW'));
});
test('initialization failure blocks before implementation without consuming repair budget, then retries on resume', async t => {
  let fail = true;
  const runner = new FixtureValidator();
  const h = await setup(t, { validator: { async run(input) { if (input.command.name === 'Prepare dependencies' && fail) { input.onOutput('setup failed'); return { exitCode: 7, log: 'setup failed' }; } return runner.run(input); } } });
  await configureYaml(h); h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.implementationCalls, 0);
  assert.equal(h.snapshot().initializations[0].status, 'failed'); assert.equal(h.snapshot().validations.length, 0);
  assert.equal(h.snapshot().runs.filter(run => run.stage === 'repair').length, 0);
  fail = false; h.resume(h.snapshot().tasks[0], 'implement'); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW', h.snapshot().tasks[0].reason ?? ''); assert.equal(h.snapshot().initializations.length, 2); assert.equal(h.implementationCalls, 1);
});
test('initialization cancellation preserves logs and worktree and resumes explicitly', async t => {
  let hang = true, started = false;
  const runner = new FixtureValidator();
  const h = await setup(t, { validator: { async run(input) {
    if (input.command.name === 'Prepare dependencies' && hang) { started = true; input.onOutput('partial initialization\nAPI_TOKEN=secret-value\n'); await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
    return runner.run(input);
  } } });
  await configureYaml(h); h.approve(await h.makeTask()); await waitFor(() => started);
  const task = h.snapshot().tasks[0]; h.call({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: 'Stop setup' }); await h.service.builds.idle();
  assert.equal(h.snapshot().initializations[0].status, 'cancelled'); assert.match(h.snapshot().initializations[0].log_text, /partial initialization/); assert.doesNotMatch(h.snapshot().initializations[0].log_text, /secret-value/); assert.equal(h.implementationCalls, 0);
  hang = false; h.resume(h.snapshot().tasks[0], 'implement'); await h.service.builds.idle(); assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW');
});
test('initialization source edits are preserved and block implementation', async t => {
  const h = await setup(t);
  await configureYaml(h, { commands: [{ name: 'Mutate', run: [process.execPath, '-e', "require('fs').writeFileSync('greeting.cjs','// hook source edit')"], timeout_seconds: 2 }] });
  h.approve(await h.makeTask()); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.match(h.snapshot().tasks[0].reason!, /changed source/); assert.equal(h.implementationCalls, 0); assert.match(readFileSync(join(h.snapshot().workspaces[0].path, 'greeting.cjs'), 'utf8'), /hook source edit/);
});
test('uncommitted YAML and missing local initialization network permission cannot create a worktree', async t => {
  const h = await setup(t); await configureYaml(h, { network: true, allowNetwork: false });
  const task = await h.makeTask(), plan = h.snapshot().plans.find(plan => plan.task_id === task.id)!;
  const result = h.service.dispatch({ type: 'task.reviewPlan', taskId: task.id, expectedVersion: task.version, revisionId: plan.id, digest: plan.sha256_digest, action: 'approve' });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error.message, /Allow it locally/);
  assert.equal(h.snapshot().workspaces.length, 0); assert.equal(h.implementationCalls, 0);
});
test('explicit initialize recovery reruns setup then validates without another implementation', async t => {
  const h = await setup(t); await configureYaml(h); h.approve(await h.makeTask()); await h.service.builds.idle();
  h.service.builds.invalidate(h.snapshot().tasks[0], 'Dependencies removed');
  const task = h.snapshot().tasks[0], details = h.call<WorkspaceDetails>({ type: 'workspace.inspect', taskId: task.id });
  h.call({ type: 'task.resume', taskId: task.id, expectedVersion: task.version, stage: 'initialize', expectedHead: details.currentHead, expectedWorkspaceDigest: details.workspaceDigest }); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW', h.snapshot().tasks[0].reason ?? ''); assert.equal(h.snapshot().initializations.length, 2); assert.equal(h.implementationCalls, 1);
});
test('uncommitted YAML blocks approval dispatch before creating a worktree', async t => {
  const h = await setup(t); await configureYaml(h, { commit: false });
  const task = await h.makeTask(), plan = h.snapshot().plans.find(plan => plan.task_id === task.id)!;
  const result = h.service.dispatch({ type: 'task.reviewPlan', taskId: task.id, expectedVersion: task.version, revisionId: plan.id, digest: plan.sha256_digest, action: 'approve' });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error.message, /Commit/);
  assert.equal(h.snapshot().workspaces.length, 0); assert.equal(h.snapshot().tasks[0].approved_plan_revision_id, null);
});
test('restart interrupts initialization and retries it without assuming success', async t => {
  const h = await setup(t); await configureYaml(h); h.approve(await h.makeTask()); await h.service.builds.idle();
  const task = h.snapshot().tasks[0], initialization = h.snapshot().initializations[0];
  h.store.db.prepare("UPDATE tasks SET status='BUILDING' WHERE id=?").run(task.id);
  h.store.db.prepare("UPDATE initialization_runs SET status='running',finished_at=NULL WHERE id=?").run(initialization.id);
  h.store.db.prepare("UPDATE agent_runs SET status='running',finished_at=NULL WHERE id=?").run(initialization.run_id);
  await h.restart();
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().initializations[0].status, 'interrupted');
  h.resume(h.snapshot().tasks[0], 'validate'); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW', h.snapshot().tasks[0].reason ?? ''); assert.equal(h.snapshot().initializations[1].status, 'succeeded'); assert.equal(h.implementationCalls, 1);
});
test('changed worktree YAML cannot weaken verification or authorize final acceptance', async t => {
  const h = await setup(t); await configureYaml(h); h.approve(await h.makeTask()); await h.service.builds.idle();
  const workspace = h.snapshot().workspaces[0];
  writeFileSync(join(workspace.path, '.kulumin.yml'), 'version: 1\nworktree_init: {commands: []}\nverification: {commands: []}\n');
  assert.equal(h.service.dispatch(finalCommand(h)).ok, false);
  assert.equal(h.snapshot().tasks[0].status, 'BLOCKED'); assert.equal(h.snapshot().tasks[0].accepted_commit_sha, null);
});
test('repeated setup failures do not exhaust implementation attempts', async t => {
  let ready = false;
  const runner = new FixtureValidator();
  const h = await setup(t, { validator: { async run(input) { return !ready && input.command.name === 'Prepare dependencies' ? { exitCode: 1, log: 'Dependencies unavailable' } : runner.run(input); } } });
  await configureYaml(h); h.approve(await h.makeTask()); await h.service.builds.idle();
  for (let attempt = 0; attempt < 3; attempt++) { h.resume(h.snapshot().tasks[0], 'implement'); await h.service.builds.idle(); }
  assert.equal(h.implementationCalls, 0); assert.equal(h.snapshot().initializations.length, 4);
  ready = true; h.resume(h.snapshot().tasks[0], 'implement'); await h.service.builds.idle();
  assert.equal(h.snapshot().tasks[0].status, 'FINAL_REVIEW', h.snapshot().tasks[0].reason ?? ''); assert.equal(h.implementationCalls, 1);
});
