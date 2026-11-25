import { randomUUID } from 'node:crypto';
import type { EvidenceBundle, Review, Task } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';
import type { WorkspaceManager } from '../git/workspaces.js';
import { digest, fail } from '../workflows/engine.js';

// Reconstruct the complete gate input from authoritative Git and persisted evidence.
// IDs alone never authorize acceptance: contents, configuration, and HEAD must match.
export class EvidenceManager {
  constructor(private store: Store, private workspaces: WorkspaceManager) {}
  body(task: Task) {
    const details = this.workspaces.inspect(task);
    if (details.dirty || details.currentHead !== details.head_sha || details.truncated) fail('STALE_EVIDENCE', 'Final evidence requires the clean recorded HEAD and a complete captured diff.');
    const plan = this.store.plan(task.approved_plan_revision_id ?? '');
    if (!plan || task.current_plan_revision_id !== plan.id || digest(JSON.parse(plan.body_json)) !== plan.sha256_digest) fail('STALE_EVIDENCE', 'The approved plan changed.');
    const project = this.store.db.prepare('SELECT config_json FROM projects WHERE id=?').get(task.project_id) as { config_json: string };
    const commands = JSON.parse(project.config_json).validationCommands ?? [];
    if (!commands.length) fail('STALE_EVIDENCE', 'Required checks are NOT RUN.');
    const configDigest = digest(commands);
    const checks = commands.map((command: { name: string; argv: string[] }) => {
      const check = this.store.db.prepare('SELECT * FROM validation_runs WHERE task_id=? AND commit_sha=? AND name=? ORDER BY rowid DESC LIMIT 1').get(task.id, details.currentHead, command.name) as Record<string, unknown> | undefined;
      if (!check || check.status !== 'passed' || check.exit_code !== 0 || check.config_digest !== configDigest || check.argv_json !== JSON.stringify(command.argv)) fail('STALE_EVIDENCE', 'Required checks failed, are missing, or are stale for the current commit.');
      return { id: check.id, name: check.name, commitSha: check.commit_sha, configDigest: check.config_digest, exitCode: check.exit_code, log: check.log_text };
    });
    const review = this.store.db.prepare('SELECT * FROM reviews WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task.id) as Review | undefined;
    if (!review || review.status !== 'current' || review.commit_sha !== details.currentHead || review.verdict !== 'pass' || JSON.parse(review.findings_json).some((finding: { severity: string }) => ['critical', 'high'].includes(finding.severity))) fail('STALE_EVIDENCE', 'An independent passing review of the exact current commit is required.');
    const reviewRun = this.store.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(review.run_id) as { stage: string; provider: string; status: string; approved_plan_id: string; approved_plan_digest: string } | undefined;
    if (!reviewRun || reviewRun.stage !== 'review' || reviewRun.provider !== 'codex' || reviewRun.status !== 'succeeded' || reviewRun.approved_plan_id !== plan.id || reviewRun.approved_plan_digest !== plan.sha256_digest) fail('STALE_EVIDENCE', 'Independent review provenance does not match this approved plan.');
    const implementations = this.store.db.prepare("SELECT id,stage,summary FROM agent_runs WHERE task_id=? AND stage IN ('implement','repair') AND approved_plan_id=? AND status='succeeded' ORDER BY rowid").all(task.id, plan.id);
    const reviewHistory = this.store.db.prepare('SELECT id,commit_sha,verdict,findings_json,summary FROM reviews WHERE task_id=? ORDER BY rowid').all(task.id);
    const decisions = this.store.db.prepare("SELECT id,action,feedback,commit_sha FROM approvals WHERE task_id=? AND gate='final' AND action='request_changes' ORDER BY rowid").all(task.id);
    return { taskId: task.id, planId: plan.id, planDigest: plan.sha256_digest, baseSha: details.base_sha, commitSha: details.currentHead, workspaceDigest: details.workspaceDigest, changedFiles: details.changedFiles, diff: details.diff, checks, review: { id: review.id, runId: review.run_id, verdict: review.verdict, findings: JSON.parse(review.findings_json), summary: review.summary }, reviewHistory, implementations, requestedChanges: decisions };
  }
  create(task: Task) {
    const body = this.body(task), id = randomUUID();
    this.store.db.prepare('INSERT INTO evidence_bundles VALUES (?,?,?,?,?,?)').run(id, task.id, body.commitSha, JSON.stringify(body), digest(body), new Date().toISOString());
    return this.latest(task.id)!;
  }
  latest(taskId: string) { return this.store.db.prepare('SELECT * FROM evidence_bundles WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as EvidenceBundle | undefined; }
  verify(task: Task): EvidenceBundle {
    const bundle = this.latest(task.id);
    if (!bundle || digest(JSON.parse(bundle.body_json)) !== bundle.sha256_digest || digest(this.body(task)) !== bundle.sha256_digest) fail('STALE_EVIDENCE', 'The displayed evidence is stale. Revalidate and rereview the current commit before accepting.');
    return bundle;
  }
}
