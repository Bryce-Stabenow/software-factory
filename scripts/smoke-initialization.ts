// Opt-in real Codex app-server command execution; no model inference or user repository changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexValidationRunner } from '../apps/factory-service/src/checks/validation.js';
import { git } from '../apps/factory-service/src/git/workspaces.js';
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kulumin-initialization-smoke-'))), repo = join(directory, 'repository'), worktree = join(directory, 'worktree');
try {
  mkdirSync(repo); mkdirSync(join(repo, 'fixture-dependency'));
  writeFileSync(join(repo, 'fixture-dependency/package.json'), JSON.stringify({ name: 'kulumin-fixture-dependency', version: '1.0.0', main: 'index.cjs' }));
  writeFileSync(join(repo, 'fixture-dependency/index.cjs'), 'module.exports = 42;\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'kulumin-init-fixture', version: '1.0.0', private: true, dependencies: { 'kulumin-fixture-dependency': 'file:./fixture-dependency' }, scripts: { test: `node -e "if(require('kulumin-fixture-dependency')!==42)process.exit(1)"` } }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: repo, stdio: 'pipe', timeout: 15000 });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git(repo, ['add', '.']); git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Fixture']);
  git(repo, ['worktree', 'add', '-b', 'fixture', worktree]);
  const runner = new CodexValidationRunner();
  const run = async (name: string, argv: string[], networkAccess: boolean) => {
    const result = await runner.run({ cwd: worktree, temporaryDirectory: join(directory, name), command: { name, argv, timeoutMs: 30000 }, networkAccess, processId: name, signal: AbortSignal.timeout(35000), onProcess() {}, onOutput() {} });
    assert.equal(result.exitCode, 0, result.log);
  };
  await run('initialization', ['npm', 'ci', '--include=dev', '--offline', '--no-audit', '--no-fund'], true);
  await run('verification', ['npm', 'test'], false);
  assert.equal(readFileSync(join(worktree, 'node_modules/kulumin-fixture-dependency/index.cjs'), 'utf8'), 'module.exports = 42;\n');
  assert.equal(git(worktree, ['status', '--porcelain']).trim(), '');
  console.log('Real app-server: npm ci initialized an isolated worktree; offline npm test passed; source stayed clean. No model inference or registry downloads.');
} finally { rmSync(directory, { recursive: true, force: true }); }
