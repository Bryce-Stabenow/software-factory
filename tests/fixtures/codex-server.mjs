import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const mode = process.argv[2] ?? 'success';
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const threadId = 'fixture-thread';
const turnId = 'fixture-turn';
let prompt = '';
let reviewing = false;
const plan = () => ({ summary: 'Add a formal greeting', assumptions: ['Existing behavior stays the default'], questions: mode === 'questions' && prompt.includes('Clarification answers: []') ? ['Should the formal prefix be configurable?'] : [], steps: ['Update greeting.ts', 'Add coverage'], affectedAreas: ['greeting.ts'], acceptanceCriteria: ['The old call still works'], testStrategy: ['Add unit tests'], risks: ['Tests have not run'] });
const complete = () => {
  if (mode === 'hang' || mode === 'permission') return;
  const text = mode === 'invalid' ? '{invalid' : JSON.stringify(reviewing ? { commitSha: 'a'.repeat(40), verdict: 'pass', summary: 'Independent fixture review', findings: [] } : plan());
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'message', type: 'agentMessage', text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: mode === 'failed' ? 'failed' : 'completed', items: [], error: mode === 'failed' ? { message: 'sk-provider-secret-must-not-be-stored' } : null } } });
};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (!frame.method && frame.id === 'read-request') { assert.equal(frame.result.success, true); assert.match(frame.result.contentItems[0].text, /greet/); complete(); return; }
  if (frame.method === 'initialize') { assert.equal(frame.params.capabilities.experimentalApi, true); send({ id: frame.id, result: { userAgent: 'codex-cli/fixture' } }); }
  if (frame.method === 'account/read') send({ id: frame.id, result: { account: mode === 'signed-out' ? null : { type: 'chatgpt', email: 'private-email-not-for-client@example.com' } } });
  if (frame.method === 'model/list') send({ id: frame.id, result: { data: [{ model: 'fixture-model', displayName: 'Fixture model', isDefault: true }] } });
  if (frame.method === 'config/read') send({ id: frame.id, result: { config: { features: { shell_tool: mode === 'unsafe-config' }, mcp_servers: mode === 'inherited-mcp' ? { fixture: { enabled: process.argv.includes('mcp_servers.fixture.enabled=false') ? false : true } } : {} } } });
  if (frame.method === 'thread/start') {
    assert.equal(frame.params.sandbox, 'read-only'); assert.equal(frame.params.approvalPolicy, 'never'); assert.equal(frame.params.ephemeral, true);
    assert.deepEqual(frame.params.dynamicTools.map(tool => tool.name), ['list_repository_files', 'read_repository_file']);
    send({ id: frame.id, result: { thread: { id: threadId }, approvalPolicy: 'never', sandbox: { type: mode === 'unsafe' ? 'dangerFullAccess' : 'readOnly', networkAccess: false } } });
  }
  if (frame.method === 'turn/start') {
    assert.deepEqual(frame.params.sandboxPolicy, { type: 'readOnly', networkAccess: false }); reviewing = !!frame.params.outputSchema.properties.verdict; if (!reviewing) assert.ok(frame.params.outputSchema.properties.questions); else assert.match(frame.params.input[0].text, /Review commit/);
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
