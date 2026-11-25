import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const source = resolve(process.argv[2] ?? 'apps/desktop/src-tauri/target/release/bundle/macos/Kulumin.app');
execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict',source], { stdio: 'inherit' });
const directory = mkdtempSync(join(tmpdir(), 'kulumin-package-')), app = join(directory, 'Relocated Kulumin.app');
cpSync(source, app, { recursive: true });
execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict',app], { stdio: 'inherit' });
const companion = join(app, 'Contents/Resources/companion'), node = join(companion, 'runtime/node'), main = join(companion, 'dist/apps/factory-service/src/main.js');
const manifest = JSON.parse(readFileSync(join(companion, 'manifest.json'), 'utf8'));
assert.equal(manifest.arch, process.arch);
for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(companion, file.path))).digest('hex'), file.sha256, file.path);
const data = join(directory, 'data'), home = join(directory, 'empty-home'); mkdirSync(home);
const repo = join(directory, 'repository'); execFileSync('/usr/bin/git', ['init','-b','main',repo], { stdio: 'ignore' }); writeFileSync(join(repo,'README.md'), '# Disposable package fixture\n');
let current;
function start() {
  // No inherited Node, npm, project cwd, credentials, NODE_PATH, or development resources.
  const child = spawn(node, [main], { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: home, FACTORY_DATA_DIR: data, FACTORY_PACKAGED: '1' }, stdio: ['pipe','pipe','pipe'] });
  const pending = [], lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => {});
  lines.on('line', line => pending.shift()?.resolve(JSON.parse(line)));
  child.once('exit', () => { for (const request of pending.splice(0)) request.reject(new Error('Packaged companion exited before replying.')); });
  child.on('error', error => { for (const request of pending.splice(0)) request.reject(error); });
  return { child, async call(payload) {
    const response = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Packaged command timeout.')), 10000); pending.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); child.stdin.write(JSON.stringify(payload) + '\n'); });
    assert.ok(response.ok, JSON.stringify(response)); return response.data;
  }, async close() { const stopped = new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged service did not shut down cleanly.')); }, 7000); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Packaged service exited unsuccessfully.')); }); }); child.stdin.end(); await stopped; } };
}
try {
  current = start(); assert.equal((await current.call({ type: 'snapshot' })).projects.length, 0, 'Release launches do not seed demo repositories');
  const project = await current.call({ type: 'project.add', name: 'Disposable package fixture', path: repo });
  const configuration = await current.call({ type: 'project.configuration.get', projectId: project.id });
  assert.equal(configuration.exists, false);
  await current.call({ type: 'project.configuration.save', projectId: project.id, expectedVersion: 1, expectedDigest: null, configuration: { version: 1, worktree_init: { commands: [] }, verification: { commands: [{ name: 'Fixture', run: ['node', 'test.js'] }] } }, local: { executionEnabled: false, trustedRepository: false } });
  const savedConfiguration = await current.call({ type: 'project.configuration.get', projectId: project.id });
  assert.equal(savedConfiguration.configuration.verification.commands[0].name, 'Fixture');
  assert.equal(savedConfiguration.authorized, true); assert.equal(savedConfiguration.local.initializationNetworkAllowed, false);
  assert.match(readFileSync(join(repo, '.kulumin.yml'), 'utf8'), /worktree_init:/);
  const request = await current.call({ type: 'request.create', projectId: project.id, title: 'Package persistence fixture', body: 'Original scope', kind: 'chore', priority: 'normal', acceptanceCriteria: ['Original scope preserved'] });
  const task = await current.call({ type: 'task.createFromRequest', requestId: request.id });
  await current.call({ type: 'request.update', requestId: request.id, expectedVersion: 1, projectId: project.id, title: 'Updated package fixture', body: 'Updated scope', kind: 'feature', priority: 'high', acceptanceCriteria: ['Updated scope'] });
  await current.call({ type: 'request.archive', requestId: request.id, expectedVersion: 2, archived: true });
  await current.call({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: 'fake' });
  const snapshot = await current.call({ type: 'snapshot' }); assert.match(snapshot.plans[0].body_json, /Original scope preserved/); assert.equal(snapshot.requests[0].status,'archived');
  const diagnostics = await current.call({ type: 'diagnostics.get' }); assert.equal(diagnostics.application.packaged,true); assert.equal(diagnostics.storage.integrity,'ok'); assert.equal(diagnostics.storage.schemaVersion,7);
  const report = await current.call({ type: 'diagnostics.export' }); assert.doesNotMatch(readFileSync(report.path,'utf8'), /Original scope|Updated scope|repository|empty-home/);
  const backup = await current.call({ type: 'backup.create' }); assert.ok(existsSync(backup.path));
  await current.close(); current = undefined; assert.equal(existsSync(join(data,'service.lock')),false);
  current = start(); assert.equal((await current.call({ type:'snapshot' })).requests[0].version,3); await current.close(); current = undefined;
  const restored = join(directory,'restored');
  execFileSync(node, [join(companion,'dist/scripts/restore-backup.js'),'--backup',backup.path,'--data-dir',restored], { cwd: directory, env: { PATH:'/usr/bin:/bin',HOME:home }, stdio:'inherit' });
  assert.ok(existsSync(join(restored,'factory.db')));
  console.log(JSON.stringify({ result: 'passed', relocatedApp: app, architecture: manifest.arch, bundledNode: manifest.node, resourcesVerified: manifest.files.length, checkoutIndependent: true, externalNodeRequired: false, data, backupRestore: 'passed' }));
} finally { if (current) { current.child.stdin.end(); current.child.kill(); } }
