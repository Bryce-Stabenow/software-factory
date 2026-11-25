import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexValidationRunner, missingValidationDependency, validationEnvironmentFailure } from '../apps/factory-service/src/checks/validation.js';

for (const mode of ['pass', 'invalid', 'permission', 'hang']) test(`sandboxed validation protocol: ${mode}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runner = new CodexValidationRunner(process.execPath, [resolve('tests/fixtures/validation-server.mjs'), mode]);
  const cancellation = new AbortController(), published: string[] = [];
  const result = runner.run({ cwd: directory, temporaryDirectory: join(directory, 'temporary'), command: { name: 'Fixture', argv: ['node', 'test.cjs'], timeoutMs: 1000 }, processId: 'fixture-check', signal: cancellation.signal, onProcess() {}, onOutput(log) { published.push(log); if (mode === 'hang' && log.includes('worker ready')) cancellation.abort(); } });
  if (mode === 'pass') {
    const completed = await result; assert.equal(completed.exitCode, 0); assert.match(completed.log, /REDACTED/);
    assert.ok(published.length > 0); assert.ok(published.every(log => !log.includes('topsecret') && !log.includes('DB_PASSWORD=top')));
    assert.match(completed.log, /independent stderr/);
  } else await assert.rejects(result, (error: unknown) => (error as { code: string }).code === (mode === 'hang' ? 'CANCELLED' : mode === 'permission' ? 'POLICY_DENIED' : 'VALIDATION_FAILED'));
});


test('missing check dependencies are distinguished from source test failures', () => {
  for (const log of ['sh: tsx: command not found', '/bin/sh: vitest: not found', 'env: node: No such file or directory', "Error: Cannot find package 'tsx' imported from /work/check.js", "Error: Cannot find module '/work/node_modules/typescript/bin/tsc'"]) assert.equal(missingValidationDependency(log), true, log);
  for (const log of ['Assertion failed: expected 2, received 3', "Error: Cannot find module './src/greeting.js'", 'SyntaxError: Unexpected token', 'Test case command not found behavior failed']) {
    assert.equal(missingValidationDependency(log), false, log);
  }
});


test('sandbox socket startup errors request compatible tooling without authorizing code repairs', () => {
  assert.match(validationEnvironmentFailure('Error: listen EPERM: operation not permitted /temporary/tsx-501/test.pipe') ?? '', /node --import tsx/);
  assert.equal(validationEnvironmentFailure('AssertionError: expected listener to return EPERM'), null);
});
