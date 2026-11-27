import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'success';
const healthOnly = mode.startsWith('health-');
const trace = event => { if (healthOnly && process.argv[3]) appendFileSync(process.argv[3], JSON.stringify(event) + '\n'); };
trace({ pid: process.pid });
process.on('exit', () => trace({ exited: true }));
const usageFixture = JSON.parse(readFileSync(new URL('./codex-usage.json', import.meta.url), 'utf8'));
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const threadId = 'fixture-thread';
const turnId = 'fixture-turn';
let prompt = '';
let reviewing = false;
let implementing = false;
let cwd;
let verificationAvailable = false;
const plan = () => ({ summary: 'Add a formal greeting', assumptions: ['Existing behavior stays the default'], questions: mode === 'questions' && prompt.includes('Clarification answers: []') ? ['Should the formal prefix be configurable?'] : [], steps: ['Update greeting.ts', 'Add coverage'], affectedAreas: ['greeting.ts'], acceptanceCriteria: ['The old call still works'], testStrategy: ['Add unit tests'], risks: ['Tests have not run'] });
const complete = () => {
  if (mode === 'hang' || mode === 'permission') return;
  const text = mode === 'invalid' ? '{invalid' : JSON.stringify(implementing ? { summary: 'Updated greeting through the worktree tool', limitations: [] } : reviewing ? { commitSha: 'a'.repeat(40), verdict: 'pass', summary: 'Independent fixture review', findings: [] } : plan());
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'message', type: 'agentMessage', text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: mode === 'failed' ? 'failed' : 'completed', items: [], error: mode === 'failed' ? { message: '[REDACTED]' } : null } } });
};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (healthOnly) {
    trace({ method: frame.method });
    assert.ok(!['thread/start', 'turn/start'].includes(frame.method), 'Health must never start inference');
    if (mode === 'health-hang-initialize' && frame.method === 'initialize') return;
    if (mode === 'health-hang-account' && frame.method === 'account/read') return;
    if (mode === 'health-hang-catalog' && frame.method === 'model/list') return;
  }
  if (frame.method === 'account/rateLimits/read') {
    if (mode === 'health-signed-out') assert.fail('Signed-out accounts must not request usage');
    if (mode === 'health-timeout') return;
    if (mode === 'health-disconnect') { process.exit(0); return; }
    if (mode === 'health-unsupported' || mode === 'health-error') {
      send({ id: frame.id, error: { code: mode === 'health-unsupported' ? -32601 : -32000, message: 'private-token-fixture private-email-fixture@example.invalid' } }); return;
    }
    send({ id: frame.id, result: mode === 'health-missing' ? { rateLimits: null } : mode === 'health-malformed' ? { rateLimits: { primary: 'broken' } } : usageFixture }); return;
  }
  if (!frame.method && frame.id === 'verification-request') {
    assert.equal(frame.result.success, true);
    const result = JSON.parse(frame.result.contentItems[0].text);
    if (!result.passed) send({ id: 'verification-request', method: 'item/tool/call', params: { threadId, turnId, tool: 'run_verification', arguments: {} } });
    else complete();
    return;
  }
  if (!frame.method && frame.id === 'write-request') {
    assert.equal(frame.result.success, true);
    if (verificationAvailable && mode !== 'verification-skip') send({ id: 'verification-request', method: 'item/tool/call', params: { threadId, turnId, tool: 'run_verification', arguments: mode === 'verification-args' ? { command: ['sh', '-c', 'do not run'] } : {} } });
    else complete();
    return;
  }
  if (!frame.method && frame.id === 'read-request') {
    assert.equal(frame.result.success, true); assert.match(frame.result.contentItems[0].text, /greet/);
    if (implementing) send({ id: 'write-request', method: 'item/tool/call', params: { threadId, turnId, tool: 'write_repository_file', arguments: { path: 'greeting.ts', content: 'export const greet = (name: string) => `Hello, ${name}!`;\n', expectedDigest: JSON.parse(frame.result.contentItems[0].text).digest } } });
    else complete();
    return;
  }
  if (frame.method === 'initialize') { assert.equal(frame.params.capabilities.experimentalApi, true); send({ id: frame.id, result: { userAgent: 'codex-cli/fixture' } }); }
  if (frame.method === 'account/read') send({ id: frame.id, result: { account: (mode === 'signed-out' || mode === 'health-signed-out') ? null : { type: 'chatgpt', email: 'private-email-not-for-client@example.com' } } });
  if (frame.method === 'model/list') send({ id: frame.id, result: { data: [{ model: 'fixture-model', displayName: 'Fixture model', isDefault: true }] } });
  if (frame.method === 'config/read') send({ id: frame.id, result: { config: { features: { shell_tool: mode === 'unsafe-config' }, mcp_servers: mode === 'inherited-mcp' ? { fixture: { enabled: process.argv.includes('mcp_servers.fixture.enabled=false') ? false : true } } : {} } } });
  if (frame.method === 'thread/start') {
    verificationAvailable = frame.params.dynamicTools.some(tool => tool.name === 'run_verification');
    implementing = frame.params.dynamicTools.some(tool => tool.name === 'write_repository_file'); cwd = frame.params.cwd;
    assert.equal(frame.params.sandbox, implementing ? 'workspace-write' : 'read-only'); assert.equal(frame.params.approvalPolicy, 'never'); assert.equal(frame.params.ephemeral, true);
    assert.deepEqual(frame.params.dynamicTools.map(tool => tool.name), implementing ? ['list_repository_files', 'read_repository_file', 'write_repository_file', 'delete_repository_file', ...(verificationAvailable ? ['run_verification'] : [])] : ['list_repository_files', 'read_repository_file']);
    if (implementing) assert.deepEqual(frame.params.config, { sandbox_workspace_write: { writable_roots: [cwd], network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true } });
    send({ id: frame.id, result: { thread: { id: threadId }, approvalPolicy: 'never', sandbox: { type: mode === 'unsafe' ? 'dangerFullAccess' : implementing ? 'workspaceWrite' : 'readOnly', networkAccess: mode === 'unsafe-network', ...(implementing ? { writableRoots: mode === 'unsafe-roots' ? [cwd, '/'] : mode === 'implicit-cwd' ? [] : [cwd], excludeSlashTmp: mode !== 'unsafe-tmp', excludeTmpdirEnvVar: true } : {}) } } });
  }
  if (frame.method === 'turn/start') {
    assert.deepEqual(frame.params.sandboxPolicy, implementing ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } : { type: 'readOnly', networkAccess: false }); reviewing = !!frame.params.outputSchema.properties.verdict; if (!reviewing && !implementing) assert.ok(frame.params.outputSchema.properties.questions); else if (reviewing) assert.match(frame.params.input[0].text, /Review commit/);
    prompt = frame.params.input[0].text;
    if (mode === 'exit') { process.exit(0); return; }
    send({ id: frame.id, result: { turn: { id: turnId } } });
    if (mode === 'permission') send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'do not run' } });
    else if (mode === 'hang') send({ method: 'item/started', params: { threadId, turnId, item: { type: 'reasoning' } } });
    else if (mode === 'no-read') complete();
    else if (mode === 'review-write') send({ id: 'write-request', method: 'item/tool/call', params: { threadId, turnId, tool: 'write_repository_file', arguments: { path: 'greeting.ts', content: 'bad' } } });
    else send({ id: 'read-request', method: 'item/tool/call', params: { threadId, turnId, tool: 'read_repository_file', arguments: { path: 'greeting.ts' } } });
  }
  if (frame.method === 'turn/interrupt') { send({ id: frame.id, result: {} }); send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', items: [] } } }); }
});
lines.on('close', () => process.exit(0));
