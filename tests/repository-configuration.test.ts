import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRepositoryConfiguration, readRepositoryConfiguration, writeRepositoryConfiguration, repositoryConfigurationState, resolveExecutionConfiguration } from '../apps/factory-service/src/configuration/repository.js';
import { digest } from '../apps/factory-service/src/workflows/engine.js';
import { git } from '../apps/factory-service/src/git/workspaces.js';
import type { Project } from '../packages/contracts/src/index.js';
const valid = 'version: 1\nworktree_init:\n  network: true\n  commands:\n    - name: Install\n      run: [npm, ci, --include=dev]\n      timeout_seconds: 300\nverification:\n  commands:\n    - name: Tests\n      run: [npm, test]\n';
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kulumin-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  writeFileSync(join(root, '.kulumin.yml'), valid);
  git(root, ['add', '.kulumin.yml']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Config']);
  const project = { repo_path: root, default_branch: 'main', config_json: JSON.stringify({ provider: 'codex', planningModel: null, implementationModel: null, reviewModel: null, repositoryConfigDigest: digest(parseRepositoryConfiguration(valid)), trustedRepository: true, executionEnabled: true }) } as Project;
  return { root, project };
}
test('strict versioned YAML accepts argv and rejects aliases, tags, duplicate keys, oversized files and unknown settings', () => {
  const config = parseRepositoryConfiguration(valid);
  assert.equal(config.verification.commands[0].timeout_seconds, 60);
  for (const text of [valid.replace('version: 1', 'version: 2'), valid + 'trustedRepository: true\n', valid + 'version: 1\n', valid.replace('[npm, test]', '&cmd [npm, test]') + 'extra: *cmd\n', valid.replace('[npm, test]', '!custom [npm, test]'), 'x'.repeat(65537), valid.replace('300', '1801')]) assert.throws(() => parseRepositoryConfiguration(text));
});
test('atomic YAML writes preserve document comments, reject stale saves and can roll back', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, '.kulumin.yml'), '# Shared setup\n' + valid);
  const old = readRepositoryConfiguration(root)!;
  writeRepositoryConfiguration(root, old.digest, old.configuration);
  assert.equal(readRepositoryConfiguration(root)!.text, old.text, 'Authorizing unchanged YAML preserves formatting and comments');
  const config = structuredClone(old.configuration); config.verification.commands[0].name = 'Updated tests';
  const write = writeRepositoryConfiguration(root, old.digest, config);
  assert.match(readFileSync(join(root, '.kulumin.yml'), 'utf8'), /# Shared setup/);
  assert.equal(readRepositoryConfiguration(root)!.configuration.verification.commands[0].name, 'Updated tests');
  assert.throws(() => writeRepositoryConfiguration(root, old.digest, config), /changed on disk/);
  write.rollback(); assert.equal(readRepositoryConfiguration(root)!.text, old.text);
  const second = writeRepositoryConfiguration(root, old.digest, config);
  writeFileSync(join(root, '.kulumin.yml'), valid + '# external edit\n');
  assert.throws(() => second.rollback(), /changed on disk/);
});
test('symlinked configuration is refused without modifying its target', t => {
  const { root } = fixture(t), path = join(root, '.kulumin.yml'), target = join(root, 'target.yml');
  writeFileSync(target, valid); rmSync(path); symlinkSync(target, path);
  assert.throws(() => readRepositoryConfiguration(root), /symlink/);
  assert.throws(() => writeRepositoryConfiguration(root, null, parseRepositoryConfiguration(valid)), /symlink/);
  assert.equal(readFileSync(target, 'utf8'), valid);
});
test('file requests never grant local network access; execution requires authorization and committed config', t => {
  const { root, project } = fixture(t);
  assert.equal(repositoryConfigurationState(project).committed, true);
  assert.throws(() => resolveExecutionConfiguration(project), /Allow it locally/);
  project.config_json = JSON.stringify({ ...JSON.parse(project.config_json), initializationNetworkAllowed: true });
  assert.equal(resolveExecutionConfiguration(project).initializationNetwork, true);
  writeFileSync(join(root, '.kulumin.yml'), valid + '# uncommitted\n');
  assert.throws(() => resolveExecutionConfiguration(project), /Commit/);
  writeFileSync(join(root, '.kulumin.yml'), valid.replace('[npm, test]', '[npm, run, changed]'));
  assert.throws(() => resolveExecutionConfiguration(project), /changed or has not been approved/);
});

test('project settings import YAML, enforce optimistic saves and restore the file if persistence fails', async t => {
  const { Store } = await import('../apps/factory-service/src/persistence/store.js');
  const { FactoryService } = await import('../apps/factory-service/src/service.js');
  const { root } = fixture(t), store = new Store(join(root, 'factory.db'));
  const service = new FactoryService(store, { dataDir: root, workspaceRoot: join(root, 'worktrees') });
  t.after(() => store.close());
  const added = service.dispatch({ type: 'project.add', name: 'Settings fixture', path: root }); assert.ok(added.ok);
  const project = store.snapshot().projects[0], state = repositoryConfigurationState(project);
  assert.equal(state.exists, true); assert.equal(state.authorized, false); assert.equal(state.local.initializationNetworkAllowed, false);
  const config = structuredClone(state.configuration!); config.verification.commands[0].name = 'Updated';
  const save = { type: 'project.configuration.save' as const, projectId: project.id, expectedVersion: project.version, expectedDigest: state.digest, configuration: config, local: { provider: 'codex', planningModel: null, implementationModel: null, reviewModel: null, executionEnabled: false, trustedRepository: false } };
  const before = readFileSync(join(root, '.kulumin.yml'), 'utf8');
  store.db.exec("CREATE TRIGGER reject_settings BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  assert.equal(service.dispatch(save).ok, false); assert.equal(readFileSync(join(root, '.kulumin.yml'), 'utf8'), before);
  assert.equal(store.snapshot().projects[0].version, project.version);
  store.db.exec('DROP TRIGGER reject_settings');
  assert.equal(service.dispatch({ ...save, expectedDigest: '0'.repeat(64) }).ok, false);
  assert.equal(service.dispatch(save).ok, true);
  assert.equal(service.dispatch(save).ok, false);
  const latest = repositoryConfigurationState(store.snapshot().projects[0]); assert.equal(latest.authorized, true); assert.equal(latest.committed, false);
  assert.equal(latest.configuration!.verification.commands[0].name, 'Updated');
  assert.equal(latest.local.executionEnabled, false);
  assert.equal(readRepositoryConfiguration(root)!.text.includes('trustedRepository'), false);
});

test('configuration refuses special files without blocking', t => {
  const { root } = fixture(t), path = join(root, '.kulumin.yml');
  rmSync(path); execFileSync('mkfifo', [path]);
  assert.throws(() => readRepositoryConfiguration(root), /regular file/);
});
