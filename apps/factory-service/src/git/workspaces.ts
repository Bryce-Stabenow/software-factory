import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Project, Task, Workspace, WorkspaceDetails } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';
import { fail } from '../workflows/engine.js';
import { allowedPath, redact } from '../agents/snapshot.js';
import { CodexError } from '../agents/rpc.js';

const gitEnvironment = () => ({ PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
export function git(path: string, args: string[], maxBuffer = 4 * 1024 * 1024): string {
  try { return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', path, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { fail('WORKSPACE_CONFLICT', 'Git could not complete the workspace operation. Check the repository, branch, and existing worktree; preserved files were not reset.'); }
}
async function mutateGit(path: string, args: string[], signal?: AbortSignal, onProcess?: (pid: number) => void) {
  return new Promise<void>((resolve, reject) => {
    let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Process already exited. */ } };
    const stop = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 500); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 60000);
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', path, ...args], { env: gitEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    child.on('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new CodexError('CANCELLED', 'The Git operation stopped; existing worktree data was preserved.'));
      else if (spawnFailed || code !== 0) reject(new CodexError('WORKSPACE_CONFLICT', timedOut ? 'The Git operation exceeded its one-minute timeout. Inspect the preserved Git state before retrying.' : 'Git could not complete the task-worktree operation. Existing branches and paths were preserved.'));
      else resolve();
    });
    try { if (child.pid) onProcess?.(child.pid); } catch { spawnFailed = true; stop(); }
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  });
}
export function assertNoGitFilters(path: string) {
  let filters = '';
  try { filters = execFileSync('git', ['-C', path, 'config', '--get-regexp', '^filter\\..*\\.(process|smudge|clean)$'], { encoding: 'utf8', timeout: 5000, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if ((error as { status?: number }).status !== 1) fail('WORKSPACE_CONFLICT', 'Git filter configuration could not be inspected.'); }
  if (filters.trim()) fail('POLICY_DENIED', 'This repository configures executable Git filters. Disable those filters or use a separate repository before factory execution.');
}
export function defaultWorkspaceRoot(dataDir: string) {
  const instance = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
  return join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/Kulumin' : '.local/share/kulumin', 'workspaces', instance);
}
const outside = (root: string, path: string) => { const rel = relative(root, path); return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel); };

export class WorkspaceManager {
  constructor(private store: Store, readonly root: string) {}
  get(taskId: string) { return this.store.db.prepare('SELECT * FROM workspaces WHERE task_id=?').get(taskId) as Workspace | undefined; }
  private project(task: Task) { return this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project; }
  verify(task: Task, workspace = this.get(task.id)): Workspace {
    if (!workspace) fail('NOT_FOUND', 'This task has no implementation worktree.');
    if (!existsSync(workspace.path) || lstatSync(workspace.path).isSymbolicLink()) fail('WORKSPACE_CONFLICT', 'The saved worktree is missing or replaced. Restore it before resuming; no files were deleted.');
    const root = realpathSync(this.root), path = realpathSync(workspace.path);
    if (path !== workspace.path || outside(root, path) || path !== join(root, task.project_id, task.id)) fail('WORKSPACE_CONFLICT', 'The worktree path is outside its managed location.');
    const project = this.project(task);
    if (!outside(realpathSync(project.repo_path), path)) fail('WORKSPACE_CONFLICT', 'Implementation cannot use the registered main checkout as its worktree.');
    const common = realpathSync(git(path, ['rev-parse', '--git-common-dir']).trim().startsWith('/') ? git(path, ['rev-parse', '--git-common-dir']).trim() : resolve(path, git(path, ['rev-parse', '--git-common-dir']).trim()));
    const expectedCommon = realpathSync(resolve(project.repo_path, git(project.repo_path, ['rev-parse', '--git-common-dir']).trim()));
    if (common !== expectedCommon || realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim()) !== path || git(path, ['symbolic-ref', '--short', 'HEAD']).trim() !== workspace.branch) fail('WORKSPACE_CONFLICT', 'The worktree repository or branch changed. Inspect it before resuming.');
    git(path, ['merge-base', '--is-ancestor', workspace.base_sha, 'HEAD']);
    return workspace;
  }
  async ensure(task: Task, signal?: AbortSignal, onProcess?: (pid: number) => void): Promise<Workspace> {
    let workspace = this.get(task.id);
    if (workspace && existsSync(workspace.path)) {
      this.verify(task, workspace);
      this.store.db.prepare("UPDATE workspaces SET cleanup_status='active' WHERE id=?").run(workspace.id);
      return this.get(task.id)!;
    }
    const project = this.project(task);
    assertNoGitFilters(project.repo_path);
    let ancestor = resolve(this.root);
    while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
    const candidate = resolve(realpathSync(ancestor), relative(ancestor, resolve(this.root)));
    if (!outside(realpathSync(project.repo_path), candidate)) fail('POLICY_DENIED', 'Managed worktrees must be outside the registered checkout.');
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.root);
    if (!outside(realpathSync(project.repo_path), root)) fail('POLICY_DENIED', 'Managed worktrees must be outside the registered checkout.');
    if (!workspace) {
      let base: string;
      try { base = git(project.repo_path, ['rev-parse', '--verify', `refs/heads/${project.default_branch}^{commit}`]).trim(); }
      catch { fail('WORKSPACE_CONFLICT', 'The project’s default branch needs a committed base. Create its initial commit, then retry build setup.'); }
      const branch = `factory/${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'}`;
      const path = join(root, task.project_id, task.id);
      if (!outside(realpathSync(project.repo_path), path)) fail('POLICY_DENIED', 'A task worktree cannot be inside the registered checkout.');
      const id = randomUUID();
      this.store.transaction(() => {
        this.store.db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?)').run(id, task.id, path, branch, base, null, 'creating', new Date().toISOString());
        this.store.db.prepare('UPDATE tasks SET worktree_id=? WHERE id=?').run(id, task.id);
        this.store.event('workspace.prepared', task.project_id, task.id, { workspaceId: id, branch, base });
      });
      workspace = this.get(task.id)!;
    } else if (workspace.cleanup_status !== 'creating') fail('WORKSPACE_CONFLICT', 'The previous worktree is missing. Restore it before resuming; the factory will not recreate or overwrite it.');
    if (existsSync(workspace.path)) fail('WORKSPACE_CONFLICT', 'The managed worktree path is already occupied.');
    mkdirSync(resolve(workspace.path, '..'), { recursive: true, mode: 0o700 });
    // No force, reset, checkout of the main tree, hooks, push, or merge.
    await mutateGit(project.repo_path, ['worktree', 'add', '-b', workspace.branch, workspace.path, workspace.base_sha], signal, onProcess);
    signal?.throwIfAborted();
    this.verify(task, workspace);
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE workspaces SET cleanup_status='active',head_sha=? WHERE id=?").run(workspace!.base_sha, workspace!.id);
      this.store.event('workspace.created', task.project_id, task.id, { workspaceId: workspace!.id, branch: workspace!.branch, base: workspace!.base_sha });
    });
    return this.get(task.id)!;
  }
  head(workspace: Workspace) { return git(workspace.path, ['rev-parse', '--verify', 'HEAD']).trim(); }
  changed(workspace: Workspace, against = 'HEAD') {
    return [...new Set([...git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', against]).split('\0'), ...git(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))].sort();
  }
  fingerprint(workspace: Workspace) {
    const hash = createHash('sha256').update(this.head(workspace));
    for (const name of this.changed(workspace)) {
      const path = join(workspace.path, name); hash.update(name + '\0');
      if (!existsSync(path)) hash.update('deleted');
      else { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) fail('WORKSPACE_CONFLICT', 'The worktree contains an unsupported or oversized uncommitted path. Inspect it before resuming.'); hash.update(readFileSync(path)); }
    }
    return hash.digest('hex');
  }
  async commit(task: Task, workspace: Workspace, touchedPaths: string[] = [], signal?: AbortSignal, onProcess?: (pid: number) => void) {
    this.verify(task, workspace); assertNoGitFilters(workspace.path);
    const tracked = new Set(git(workspace.path, ['ls-files', '-z']).split('\0'));
    const changed = [...new Set([...this.changed(workspace), ...touchedPaths])].filter(name => existsSync(join(workspace.path, name)) || tracked.has(name));
    if (changed.length > 200) fail('POLICY_DENIED', 'Implementation changed more than 200 paths. Inspect the preserved worktree.');
    for (const name of changed) {
      if (!allowedPath(name) || /(^|\/)(\.gitattributes|\.gitmodules)$/.test(name) || name.includes('\\') || name.includes('\0')) fail('POLICY_DENIED', 'The worktree contains a changed path outside the implementation policy. Inspect it before committing.');
      if (existsSync(join(workspace.path, name)) && !lstatSync(join(workspace.path, name)).isFile()) fail('POLICY_DENIED', 'Only regular implementation files may be committed.');
    }
    if (changed.length) {
      await mutateGit(workspace.path, ['add', '--all', '--force', '--', ...changed], signal, onProcess);
      signal?.throwIfAborted();
      if (git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only']).trim()) await mutateGit(workspace.path, ['-c', 'user.name=Kulumin Factory', '-c', 'user.email=factory@localhost', 'commit', '--no-gpg-sign', '--no-verify', '-m', `Implement: ${task.title}`], signal, onProcess);
      signal?.throwIfAborted();
    }
    const head = this.head(workspace);
    if (this.changed(workspace).length) fail('WORKSPACE_CONFLICT', 'Uncommitted changes remain after the implementation commit.');
    this.store.db.prepare('UPDATE workspaces SET head_sha=? WHERE id=?').run(head, workspace.id);
    return head;
  }
  inspect(task: Task): WorkspaceDetails {
    const workspace = this.verify(task);
    // Review only the task's contribution relative to the shared default-branch
    // history. Keep the original creation base for workspace integrity checks.
    const project = this.project(task);
    const bases = git(workspace.path, ['merge-base', '--all', 'HEAD', `refs/heads/${project.default_branch}`]).trim().split('\n');
    if (bases.length !== 1) fail('WORKSPACE_CONFLICT', 'The task and default branch have ambiguous shared history. Merge the default branch into the task before reviewing.');
    const common = bases[0]!;
    const reviewBaseSha = common === workspace.base_sha || git(workspace.path, ['merge-base', workspace.base_sha, common]).trim() === workspace.base_sha ? common : workspace.base_sha;
    let diff = '', truncated = false;
    try { diff = git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', reviewBaseSha, '--']); }
    catch { diff = 'Diff exceeds the capture limit or Git could not render it. Open the worktree to inspect all changes.'; truncated = true; }
    if (diff.length > 150000) { diff = diff.slice(0, 150000); truncated = true; }
    return { ...workspace, reviewBaseSha, currentHead: this.head(workspace), workspaceDigest: this.fingerprint(workspace), dirty: this.changed(workspace).length > 0, changedFiles: this.changed(workspace, reviewBaseSha), diff: redact(diff), truncated };
  }
}
