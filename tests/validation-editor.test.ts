import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionConfig, formatCheckCommand, parseCheckCommand } from '../apps/desktop/src/validation-editor.js';
const settings = { executionEnabled: true, trustedRepository: true, implementationTimeoutMs: 900000, maxImplementationAttempts: 2 };

test('validation editor preserves quoted paths and literal arguments without shell expansion', () => {
  assert.deepEqual(parseCheckCommand('node "scripts/check file.cjs" --pattern "$HOME/*.ts"'), ['node', 'scripts/check file.cjs', '--pattern', '$HOME/*.ts']);
  for (const argv of [['/path with spaces/node', 'test.cjs', '', "a'b", 'a\\b', 'one\ntwo'], ['npm', 'run', 'build']]) {
    assert.deepEqual(parseCheckCommand(formatCheckCommand(argv)), argv);
  }
});
test('validation editor catches shell syntax, incomplete quoting, and missing commands', () => {
  for (const text of ['', 'npm test && npm run build', 'npm test | tee log', 'npm test > log', 'node $(whoami)', '"unterminated', 'node \\']) assert.throws(() => parseCheckCommand(text));
});
test('validation editor preserves configured argv and converts timeouts accurately', () => {
  const config = buildExecutionConfig([{ name: ' Tests ', command: 'node "check file.cjs"', timeoutSeconds: .5 }], settings);
  assert.deepEqual(config.validationCommands, [{ name: 'Tests', argv: ['node', 'check file.cjs'], timeoutMs: 500 }]);
});
test('validation editor requires named unique checks for execution but permits planning only', () => {
  assert.throws(() => buildExecutionConfig([], settings), /at least one/);
  assert.deepEqual(buildExecutionConfig([], { ...settings, executionEnabled: false }).validationCommands, []);
  assert.throws(() => buildExecutionConfig([{ name: '', command: 'npm test', timeoutSeconds: 60 }], settings), /name/);
  assert.throws(() => buildExecutionConfig(['Tests','Tests'].map(name => ({ name, command: 'npm test', timeoutSeconds: 60 })), settings), /different name/);
  assert.throws(() => buildExecutionConfig([{ name: 'Tests', command: 'npm test', timeoutSeconds: 301 }], settings), /timeouts/);
  assert.throws(() => buildExecutionConfig([{ name: 'Tests', command: 'npm test', timeoutSeconds: 60 }], { ...settings, trustedRepository: false }), /Trust/);
});
