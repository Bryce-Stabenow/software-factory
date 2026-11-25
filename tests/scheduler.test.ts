import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunPool } from '../apps/factory-service/src/scheduler/run-pool.js';

test('available workers prefer priority and keep FIFO within a priority', async () => {
  const pool = new RunPool(1), signal = new AbortController().signal, release = await pool.acquire(signal);
  const order: string[] = [], time = Date.now();
  const normal = pool.acquire(signal, 'normal', time).then(release => { order.push('normal'); release(); });
  const first = pool.acquire(signal, 'high', time + 1).then(release => { order.push('first high'); release(); });
  const second = pool.acquire(signal, 'high', time + 2).then(release => { order.push('second high'); release(); });
  release(); await Promise.all([normal, first, second]); assert.deepEqual(order, ['first high', 'second high', 'normal']);
});
test('aged low-priority requests are not starved by newly queued high-priority work', async () => {
  const pool = new RunPool(1), signal = new AbortController().signal, release = await pool.acquire(signal);
  const order: string[] = [];
  const low = pool.acquire(signal, 'low', Date.now() - 90000).then(release => { order.push('aged low'); release(); });
  const high = pool.acquire(signal, 'high').then(release => { order.push('new high'); release(); });
  release(); await Promise.all([low, high]); assert.deepEqual(order, ['aged low', 'new high']);
});
