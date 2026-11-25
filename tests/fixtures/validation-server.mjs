import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const mode = process.argv[2] ?? 'pass';
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let commandId, processId;
const output = (stream, text) => send({ method: 'command/exec/outputDelta', params: { processId, stream, deltaBase64: Buffer.from(text).toString('base64'), capReached: false } });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: { userAgent: 'validation-fixture' } });
  if (frame.method === 'config/read') send({ id: frame.id, result: { config: { mcp_servers: {}, features: {} } } });
  if (frame.method === 'command/exec') {
    assert.equal(frame.params.sandboxPolicy.type, 'workspaceWrite'); assert.equal(frame.params.sandboxPolicy.networkAccess, mode === 'initialization');
    assert.equal(frame.params.sandboxPolicy.excludeSlashTmp, true); assert.equal(frame.params.sandboxPolicy.excludeTmpdirEnvVar, true);
    assert.equal(frame.params.sandboxPolicy.writableRoots.length, 2); assert.equal(frame.params.sandboxPolicy.writableRoots[0], frame.params.cwd);
    assert.equal(frame.params.env.OPENAI_API_KEY, undefined); assert.equal(frame.params.streamStdoutStderr, true);
    commandId = frame.id; processId = frame.params.processId;
    if (mode === 'permission') { send({ id: 'unexpected-permission', method: 'item/commandExecution/requestApproval', params: {} }); return; }
    if (mode === 'hang') { output('stdout', 'worker ready\n'); return; }
    output('stdout', 'DB_PASSWORD=top'); output('stderr', 'independent stderr\n'); output('stdout', 'secret\n');
    send({ id: frame.id, result: { exitCode: mode === 'invalid' ? '0' : 0, stdout: '', stderr: '' } });
  }
  if (frame.method === 'command/exec/terminate') {
    assert.equal(frame.params.processId, processId); send({ id: frame.id, result: {} });
    send({ id: commandId, result: { exitCode: 143, stdout: '', stderr: '' } });
  }
});
lines.on('close', () => process.exit(0));
