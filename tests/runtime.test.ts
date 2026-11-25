import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRuntime } from '../apps/factory-service/src/runtime.js';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

test('concurrent shutdown callers share a drain before another service can acquire the lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-lifecycle-'));
  try {
    const runtime = startRuntime(directory);
    assert.throws(() => startRuntime(directory), /already using/);
    const first = runtime.close(); const second = runtime.close();
    assert.equal(first, second);
    await second;
    assert.equal(existsSync(join(directory, 'service.lock')), false);
    const restarted = startRuntime(directory);
    assert.equal(restarted.service.dispatch({ type: 'snapshot' }).ok, true);
    await restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('the OS releases service ownership after a process crash without deleting task data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-owner-crash-'));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/runtime-owner.mjs'), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error('Runtime fixture exited before becoming ready')); }); });
    assert.throws(() => startRuntime(directory), /already using/);
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await stopped;
    const restarted = startRuntime(directory); assert.equal(restarted.service.dispatch({ type: 'snapshot' }).ok, true); await restarted.close();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
});
