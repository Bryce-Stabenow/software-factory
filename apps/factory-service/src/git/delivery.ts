import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command, DeliveryDetails, Project, Task } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';
import { fail, type Workflow } from '../workflows/engine.js';
import { assertNoGitFilters, git, type WorkspaceManager } from './workspaces.js';

type MergeCommand = Extract<Command, { type: 'delivery.merge' }>;
type PushCommand = Extract<Command, { type: 'delivery.push' }>;

export class Delivery {
  private pending = new Set<string>();
  private merging: string | null = null;
  constructor(private store: Store, private workflow: Workflow, private workspaces: WorkspaceManager) {}
  private project(task: Task) { return this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project; }
  private accepted(task: Task) {
    if (!['ACCEPTED', 'MERGED'].includes(task.status) || !task.accepted_commit_sha) fail('APPROVAL_REQUIRED', 'Accept the reviewed commit before merging or pushing.');
    if (!this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND gate='final' AND action='accept' AND commit_sha=? AND actor='local-human'").get(task.id, task.accepted_commit_sha)) fail('APPROVAL_REQUIRED', 'The exact commit needs recorded human acceptance.');
    const workspace = this.workspaces.verify(task);
    if (this.workspaces.head(workspace) !== task.accepted_commit_sha || this.workspaces.changed(workspace).length) fail('STALE_EVIDENCE', 'The task worktree changed after acceptance. Restore the accepted clean commit before delivery.');
    if (this.store.db.prepare("SELECT r.id FROM agent_runs r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND r.status IN ('queued','starting','running','waiting_permission','stopping')").get(task.project_id)) fail('CONFLICT', 'Wait for this project’s workers to stop before merging or pushing.');
    return workspace;
  }
  inspect(taskId: string): DeliveryDetails {
    const task = this.workflow.getTask(taskId), workspace = this.accepted(task), project = this.project(task);
    const defaultHead = git(project.repo_path, ['rev-parse', '--verify', `refs/heads/${project.default_branch}^{commit}`]).trim();
    let mergeBlocker: string | null = null;
    if (git(project.repo_path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== project.default_branch) mergeBlocker = `Check out ${project.default_branch} in the registered repository before merging.`;
    else if (git(project.repo_path, ['status', '--porcelain', '--untracked-files=all']).trim()) mergeBlocker = 'Commit or stash changes in the registered repository before merging.';
    else if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(name => existsSync(resolve(project.repo_path, git(project.repo_path, ['rev-parse', '--git-path', name]).trim())))) mergeBlocker = 'Finish the existing Git merge, rebase, or cherry-pick before merging.';
    return { defaultBranch: project.default_branch, defaultHead, taskBranch: workspace.branch, remotes: git(project.repo_path, ['remote']).trim().split('\n').filter(name => name && !name.startsWith('-')), mergeBlocker };
  }
  verifyMerged(task: Task) {
    if (this.merging !== task.id) fail('POLICY_DENIED', 'Merging requires a separately authorized delivery operation.');
    const project = this.project(task);
    git(project.repo_path, ['merge-base', '--is-ancestor', task.accepted_commit_sha!, `refs/heads/${project.default_branch}`]);
  }
  merge(command: MergeCommand) {
    const task = this.workflow.getTask(command.taskId, command.expectedVersion), project = this.project(task);
    if (task.status !== 'ACCEPTED') fail('INVALID_TRANSITION', 'Only an accepted task can be merged.');
    if (this.pending.has(project.id)) fail('CONFLICT', 'A delivery operation is already running for this project.');
    const details = this.inspect(task.id);
    if (task.accepted_commit_sha !== command.expectedHead || details.defaultHead !== command.expectedDefaultHead) fail('STALE_EVIDENCE', 'The displayed branch commits changed. Refresh delivery before merging.');
    if (details.mergeBlocker) fail('WORKSPACE_CONFLICT', details.mergeBlocker);
    assertNoGitFilters(project.repo_path);
    // Detect conflicts without touching the index or either worktree.
    try { git(project.repo_path, ['merge-tree', '--write-tree', details.defaultHead, command.expectedHead]); }
    catch { fail('WORKSPACE_CONFLICT', 'These branches have merge conflicts. Resolve the conflicting changes and review them before retrying; both worktrees were preserved.'); }
    try {
      git(project.repo_path, ['-c', 'user.name=Kulumin Factory', '-c', 'user.email=factory@localhost', '-c', 'merge.autoStash=false', 'merge', '--no-edit', '--no-gpg-sign', '--no-verify', command.expectedHead]);
    } catch { fail('WORKSPACE_CONFLICT', 'Git could not merge the accepted commit. Inspect the registered checkout for an unfinished merge before retrying.'); }
    this.merging = task.id;
    try {
      return this.store.transaction(() => {
        const result = this.workflow.transition(task.id, task.version, 'MERGED', 'delivery.merged');
        this.store.event('delivery.mergeRecorded', project.id, task.id, { branch: project.default_branch, acceptedCommit: command.expectedHead, commit: git(project.repo_path, ['rev-parse', 'HEAD']).trim() });
        return result;
      });
    } finally { this.merging = null; }
  }
  async push(command: PushCommand) {
    const task = this.workflow.getTask(command.taskId, command.expectedVersion), project = this.project(task), workspace = this.accepted(task);
    if (this.pending.has(project.id)) fail('CONFLICT', 'A delivery operation is already running for this project.');
    const details = this.inspect(task.id);
    if (!details.remotes.includes(command.remote)) fail('INVALID_INPUT', 'Select a configured Git remote.');
    if (command.target === 'default' && task.status !== 'MERGED') fail('INVALID_TRANSITION', 'Merge this task before pushing the default branch.');
    const head = command.target === 'task' ? task.accepted_commit_sha! : details.defaultHead;
    const branch = command.target === 'task' ? workspace.branch : project.default_branch;
    if (command.target === 'default') git(project.repo_path, ['merge-base', '--is-ancestor', task.accepted_commit_sha!, head]);
    if (head !== command.expectedHead) fail('STALE_EVIDENCE', 'The displayed commit changed. Refresh delivery before pushing.');
    this.pending.add(project.id);
    try {
      await new Promise<void>((done, reject) => {
        // Explicit user delivery uses the user's normal SSH/credential configuration.
        // Pin the source SHA and destination ref; never force-push or invoke hooks.
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', project.repo_path, 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--no-signed', command.remote, `${head}:refs/heads/${branch}`], { detached: process.platform !== 'win32', stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
        // Finish before the desktop bridge's 45-second request timeout.
        const timer = setTimeout(() => {
          try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
        }, 30000);
        child.once('error', () => { clearTimeout(timer); reject(new Error('push failed')); });
        child.once('close', code => { clearTimeout(timer); if (code === 0) done(); else reject(new Error('push failed')); });
      });
      this.store.event('delivery.pushed', project.id, task.id, { branch, commit: head, remote: command.remote });
      return { branch, commit: head, remote: command.remote };
    } catch { fail('WORKSPACE_CONFLICT', 'Push failed. Check Git authentication, remote access, and whether the remote branch has newer commits. No force push was attempted; refresh and retry.'); }
    finally { this.pending.delete(project.id); }
  }
}
