import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodexPlanner, serverArgs, connectPlanningRpc } from '../apps/factory-service/src/agents/codex.js';
import { CodexRpc } from '../apps/factory-service/src/agents/rpc.js';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import { FactoryService } from '../apps/factory-service/src/service.js';
import type { Command, Snapshot, Task } from '../packages/contracts/src/index.js';

const directory = resolve('.factory', `codex-smoke-${Date.now()}`);
const repo = join(directory, 'repository');
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'greeting.ts'), 'export function greet(name: string) { return `Hello, ${name}!`; }\n');
writeFileSync(join(repo, 'README.md'), '# Greeting fixture\nA disposable TypeScript example.\n');
const planner = new CodexPlanner(undefined, undefined, undefined, message => console.log(JSON.stringify({ step: 'disposable-repo-diagnostic', message })));
const health = await planner.health();
console.log(JSON.stringify({ step: 'health', ...health }));
assert.ok(health.available && health.authenticated, health.message);
if (process.argv.includes('--list-models')) process.exit(0);

// Explicit client-side sandbox probe on disposable files, never a model instruction.
const { rpc } = await connectPlanningRpc(process.env.FACTORY_CODEX_BINARY ?? 'codex', serverArgs, repo);
let networkRequests = 0;
const endpoint = createServer((_request, response) => { networkRequests++; response.end('factory-network-probe'); });
await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
try {
  console.log(JSON.stringify({ step: 'planning-tool-policy', verified: true }));
  const probe = await rpc.request('command/exec', { command: ['/bin/sh', '-c', 'printf changed > greeting.ts'], cwd: repo, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 10000 });
  assert.notEqual(probe.exitCode, 0, 'Read-only sandbox unexpectedly allowed a source write');
  assert.match(readFileSync(join(repo, 'greeting.ts'), 'utf8'), /export function greet/);
  console.log(JSON.stringify({ step: 'read-only-write-probe', denied: true }));
  const port = (endpoint.address() as AddressInfo).port;
  const network = await rpc.request('command/exec', { command: ['/usr/bin/curl', '--max-time', '2', '--noproxy', '*', `http://127.0.0.1:${port}`], cwd: repo, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 5000 });
  assert.notEqual(network.exitCode, 0, 'Read-only no-network sandbox allowed an HTTP request');
  assert.equal(networkRequests, 0);
  console.log(JSON.stringify({ step: 'read-only-network-probe', denied: true }));
} finally { await rpc.stop(); await new Promise<void>(resolve => endpoint.close(() => resolve())); }
if (process.argv.includes('--probe-only')) process.exit(0);

const store = new Store(join(directory, 'factory.db'));
const service = new FactoryService(store, { planner, dataDir: directory });
const call = <T>(payload: Command) => {
  const result = service.dispatch(payload);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data as T;
};
try {
  const project = call<{ id: string }>({ type: 'project.add', path: repo, name: 'Codex disposable fixture' });
  const request = call<{ id: string }>({ type: 'request.create', projectId: project.id, title: 'Plan an optional formal greeting', body: 'Inspect greeting.ts using the repository tools and propose an optional formal greeting parameter while preserving existing behavior. Do not implement changes. No clarification is needed; use a boolean flag defaulting to false.', kind: 'feature', priority: 'normal', acceptanceCriteria: ['Existing greet(name) behavior remains unchanged.', 'A formal greeting is available with an optional flag.'] });
  const task = call<Task>({ type: 'task.createFromRequest', requestId: request.id });
  call({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'codex' });
  await service.planning.idle();
  const result = call<Snapshot>({ type: 'snapshot' });
  console.log(JSON.stringify({ step: 'planning', task: result.tasks[0].status, runs: result.runs.map(run => ({ status: run.status, thread: run.provider_session_ref, turn: run.turn_ref, error: run.error_code, summary: run.summary })), planCount: result.plans.length, events: result.events.map(event => event.type) }));
  assert.ok(['PLAN_REVIEW', 'PLANNING_BLOCKED'].includes(result.tasks[0].status));
  assert.equal(result.runs[0].status, 'succeeded');
  assert.ok(result.events.some(event => event.type === 'run.progress' && JSON.parse(event.payload_json).message.includes('repository tool')));
  assert.equal(result.approvals.length, 0);
  assert.match(readFileSync(join(repo, 'greeting.ts'), 'utf8'), /export function greet/);
  console.log(`Smoke test passed. Artifacts: ${directory}`);
} finally { await service.planning.close(); store.close(); }
