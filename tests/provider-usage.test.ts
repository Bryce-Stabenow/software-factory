import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { normalizeCodexUsage, usageState } from '../apps/factory-service/src/agents/codex-usage.js';
import { CodexPlanner, type PlannerAdapter } from '../apps/factory-service/src/agents/codex.js';
import { FactoryService } from '../apps/factory-service/src/service.js';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import type { ProviderHealth, Snapshot } from '../packages/contracts/src/index.js';
import { localUsageTime, remainingText, resetText, usageNeedsRefresh, windowLabel } from '../apps/desktop/src/provider-usage.js';

const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/codex-usage.json'), 'utf8'));
const checkedAt = '2026-11-27T00:00:00.000Z';
test('named groups include all windows and suppress the legacy summary without inferring models', () => {
  const usage = normalizeCodexUsage(fixture, checkedAt);
  assert.equal(usage.status, 'ready');
  assert.equal(usage.checkedAt, checkedAt);
  assert.equal(usage.groups.length, 2);
  assert.deepEqual(usage.groups.flatMap(group => group.windows.map(window => window.remainingPercent)), [75, 0, 99.75, 100]);
  assert.equal(usage.groups[0].windows[0].resetsAt, new Date(1800000000 * 1000).toISOString());
  assert.equal(usage.groups[1].windows[0].durationMinutes, 90);
  assert.ok(usage.groups.every(group => group.scope === 'shared' && group.model === null));
  assert.equal(usage.groups[0].plan, 'plus');
  assert.equal(usage.groups[0].credits?.balance, '12.50');
  assert.doesNotMatch(JSON.stringify(usage), /private-|not-authoritative|accessToken|accountId|email/);
});
test('legacy-only, identical unnamed summary, and malformed named entries retain valid windows', () => {
  const legacy = normalizeCodexUsage({ rateLimits: fixture.rateLimits });
  assert.equal(legacy.groups.length, 1);
  const unnamed = { ...fixture.rateLimits, limitId: null, limitName: null };
  assert.equal(normalizeCodexUsage({ ...fixture, rateLimits: unnamed }).groups.length, 2);
  assert.equal(normalizeCodexUsage({ rateLimits: fixture.rateLimits, rateLimitsByLimitId: { codex: false } }).groups.length, 1);
  const partial = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: '25', windowDurationMins: -1, resetsAt: 1800000000000 }, secondary: { usedPercent: 25.125, windowDurationMins: 17, resetsAt: 0 } } });
  assert.deepEqual(partial.groups[0].windows[0], { id: 'primary', remainingPercent: null, durationMinutes: null, resetsAt: null });
  assert.equal(partial.groups[0].windows[1].remainingPercent, 74.875);
  assert.equal(partial.groups[0].windows[1].resetsAt, '1970-01-01T00:00:00.000Z');
  assert.equal(normalizeCodexUsage({ rateLimits: { primary: false, secondary: { usedPercent: 15 } } }).groups[0].windows.length, 1);
});
test('percentages are finite and bounded; missing values and unknown shapes stay explicit', () => {
  for (const [used, left] of [[0,100], [100,0], [150,0], [-10,100], [NaN,null], [Infinity,null], [null,null], [undefined,null]] as const) {
    assert.equal(normalizeCodexUsage({ rateLimits: { primary: { usedPercent: used } } }).groups[0].windows[0].remainingPercent, left);
  }
  for (const value of [{}, { rateLimits: null }, { rateLimitsByLimitId: {} }]) assert.equal(normalizeCodexUsage(value).status, 'unavailable');
  for (const value of [null, [], { rateLimits: 'bad' }, { rateLimits: { primary: false } }]) assert.equal(normalizeCodexUsage(value).status, 'error');
  const creditOnly = normalizeCodexUsage({ rateLimits: { credits: { unlimited: true, balance: 'private-token-fixture' }, planType: 'private-account-fixture', limitName: 'private-email@example.invalid' } });
  assert.deepEqual(creditOnly.groups[0].windows, []);
  assert.equal(creditOnly.groups[0].credits?.unlimited, true);
  assert.equal(creditOnly.groups[0].credits?.balance, null);
  assert.equal(creditOnly.groups[0].plan, null);
  assert.doesNotMatch(JSON.stringify(creditOnly), /private-/);
});
for (const [mode, status] of [
  ['success','ready'], ['unsupported','unsupported'], ['missing','unavailable'], ['malformed','error'],
  ['error','error'], ['disconnect','error'], ['timeout','error'], ['signed-out','signed_out'],
  ['hang-initialize','error'], ['hang-account','error'], ['hang-catalog','error'],
] as const) test('health protocol, cleanup and privacy: ' + mode, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-protocol-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, 'trace.jsonl');
  const planner = new CodexPlanner(process.execPath, [resolve('tests/fixtures/codex-server.mjs'), 'health-' + mode, trace], 2000, undefined, mode.includes('hang') || mode === 'timeout' ? 1000 : 10000);
  const started = Date.now();
  const health = await planner.health();
  assert.equal(health.usage?.status, status);
  assert.ok(Date.now() - started < 15000);
  if (!mode.startsWith('hang-') && mode !== 'signed-out') {
    assert.equal(health.available, true);
    assert.equal(health.authenticated, true);
    assert.equal(health.models?.[0].model, 'fixture-model');
  }
  if (mode === 'signed-out') { assert.equal(health.available, true); assert.equal(health.authenticated, false); assert.deepEqual(health.models, []); }
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.exited));
  const pid = events[0].pid;
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  assert.ok(!events.some(event => ['thread/start','turn/start'].includes(event.method)));
  if (mode === 'signed-out') assert.ok(!events.some(event => event.method === 'account/rateLimits/read'));
  assert.doesNotMatch(JSON.stringify(health), /private-|accountId|accessToken|email/);
});
test('service coalesces refreshes, propagates snapshots, and clears failed or signed-out usage', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-service-')), store = new Store(join(directory, 'factory.db'));
  let calls = 0;
  let resolveHealth!: (health: Omit<ProviderHealth, 'id'>) => void;
  let rejectHealth!: (error: Error) => void;
  const planner: PlannerAdapter = { health() { calls++; return new Promise((resolve, reject) => { resolveHealth = resolve; rejectHealth = reject; }); }, async plan() { throw new Error('No inference'); } };
  const service = new FactoryService(store, { planner, dataDir: directory });
  t.after(async () => { await service.planning.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const snapshot = () => { const response = service.dispatch({ type: 'snapshot' }); assert.ok(response.ok); return response.data as Snapshot; };
  const refresh = () => service.handle({ type: 'provider.health', provider: 'codex' });
  const first = refresh(), second = refresh();
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveHealth({ available: true, authenticated: true, message: 'Signed in', usage: normalizeCodexUsage(fixture, checkedAt) });
  assert.deepEqual(await first, await second);
  assert.equal(snapshot().providers[1].usage?.groups.length, 2);
  const diagnostics = service.dispatch({ type: 'diagnostics.export' }); assert.ok(diagnostics.ok);
  const exported = readFileSync((diagnostics.data as { path: string }).path, 'utf8');
  assert.doesNotMatch(exported, /private-|remainingPercent|limitName|credits/);
  const failed = refresh(); await Promise.resolve(); rejectHealth(new Error('private-token-fixture'));
  const result = await failed;
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.equal(snapshot().providers[1].usage?.status, 'error');
  assert.deepEqual(snapshot().providers[1].usage?.groups, []);
  const signedOut = refresh(); await Promise.resolve();
  resolveHealth({ available: true, authenticated: false, message: 'Signed out', usage: normalizeCodexUsage(fixture) });
  await signedOut;
  assert.equal(snapshot().providers[1].usage?.status, 'signed_out');
  assert.deepEqual(snapshot().providers[1].usage?.groups, []);
  const unsupported = refresh(); await Promise.resolve();
  resolveHealth({ available: true, authenticated: true, message: 'Signed in', models: [{ model: 'fixture-model', name: 'Fixture', isDefault: true }], usage: usageState('unsupported', 'Not supported') });
  await unsupported;
  assert.equal(snapshot().providers[1].authenticated, true);
  assert.equal(snapshot().providers[1].models?.length, 1);
  assert.deepEqual(snapshot().providers[1].usage?.groups, []);
  assert.equal(calls, 4);
});
test('presentation uses provider durations, locale timestamps, fractional percentages and 60-second freshness', () => {
  assert.equal(remainingText(75), '75% left');
  assert.equal(remainingText(0), '0% left');
  assert.equal(remainingText(99.75), new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(99.75) + '% left');
  assert.equal(remainingText(0.001), '<0.1% left');
  assert.equal(remainingText(99.999), '>99.9% left');
  assert.equal(remainingText(null), 'Percentage unavailable');
  assert.match(windowLabel({ id: 'primary', remainingPercent: 0, durationMinutes: 90, resetsAt: null }), /90 minutes/);
  assert.match(windowLabel({ id: 'secondary', remainingPercent: 0, durationMinutes: null, resetsAt: null }), /duration unknown/);
  const usage = normalizeCodexUsage(fixture, checkedAt);
  assert.equal(usageNeedsRefresh(undefined), true);
  assert.equal(usageNeedsRefresh(usage, Date.parse(checkedAt) + 60000), false);
  assert.equal(usageNeedsRefresh(usage, Date.parse(checkedAt) + 60001), true);
  assert.equal(localUsageTime(checkedAt), new Date(checkedAt).toLocaleString());
  assert.match(resetText(checkedAt, Date.parse(checkedAt) + 1), /Reported reset:/);
  assert.equal(usage.groups[0].windows[1].remainingPercent, 0);
});

test('usage component renders accessible indicators, all groups, credits and distinct non-ready states', async () => {
  const filename = resolve('apps/desktop/src/ProviderUsage.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'usage-test', inlineTemplate: true });
  const output = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('from "vue"', 'from ' + JSON.stringify(import.meta.resolve('vue')))
    .replaceAll("from 'vue'", 'from ' + JSON.stringify(import.meta.resolve('vue')))
    .replaceAll("from './provider-usage'", 'from ' + JSON.stringify(pathToFileURL(resolve('apps/desktop/src/provider-usage.ts')).href));
  const component = (await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'))).default;
  const render = (props: Record<string, unknown>) => renderToString(createSSRApp(component, { loading: false, ...props }));
  const usage = normalizeCodexUsage(fixture, checkedAt);
  const html = await render({ usage });
  assert.equal((html.match(/<progress /g) ?? []).length, 4);
  assert.match(html, /75% left/); assert.match(html, /0% left/);
  assert.match(html, /value="75"/); assert.match(html, /max="100"/);
  assert.match(html, /aria-valuetext="75% left"/);
  assert.match(html, /Shared account limits/); assert.match(html, /Additional Codex/);
  assert.match(html, /Credit balance: 12.50/); assert.match(html, /Last checked:/);
  assert.doesNotMatch(html, /not-authoritative|private-/);
  const unknown = normalizeCodexUsage({ rateLimits: { primary: {} } });
  assert.match(await render({ usage: unknown }), /Percentage unavailable/);
  assert.doesNotMatch(await render({ usage: unknown }), /<progress /);
  assert.match(await render({}), /not been checked/);
  for (const status of ['signed_out','unavailable','unsupported','error'] as const) {
    const text = status + ' explanation';
    const state = await render({ usage: usageState(status, text) });
    assert.ok(state.includes(text)); assert.doesNotMatch(state, /<progress /);
  }
  const loading = await render({ usage, loading: true });
  assert.match(loading, /aria-busy="true"/); assert.match(loading, /Checking Codex usage/); assert.doesNotMatch(loading, /<progress /);
  const failed = await render({ usage, refreshError: 'Refresh failed' });
  assert.match(failed, /role="alert"/); assert.doesNotMatch(failed, /<progress /);
});
