import { resolveExecutionConfiguration, verificationDigest } from '../configuration/repository.js';
import { randomUUID } from 'node:crypto';
import type { EvidenceBundle, Review, Task, Project, InitializationRun } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';
import type { WorkspaceManager } from '../git/workspaces.js';
import { digest, fail, FactoryError } from '../workflows/engine.js';
import { classifyFailure } from '../../../../packages/contracts/src/failures.js';

// Reconstruct the complete gate input from authoritative Git and persisted evidence.
// IDs alone never authorize acceptance: contents, configuration, and HEAD must match.
export class EvidenceManager {
  constructor(private store: Store, private workspaces: WorkspaceManager) {}
  body(task: Task) {
    const details = this.workspaces.inspect(task);
    if (details.dirty || details.currentHead !== details.head_sha || details.truncated) fail('STALE_EVIDENCE', 'Final evidence requires the clean recorded HEAD and a complete captured diff.');
    const plan = this.store.plan(task.approved_plan_revision_id ?? '');
    if (!plan || task.current_plan_revision_id !== plan.id || digest(JSON.parse(plan.body_json)) !== plan.sha256_digest) fail('STALE_EVIDENCE', 'The approved plan changed.');
    const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project;
    const config = resolveExecutionConfiguration(project, details.path), commands = config.validationCommands;
    if (!commands.length) fail('STALE_EVIDENCE', 'Required checks are NOT RUN.');
    const configDigest = verificationDigest(config);
    let initialization: InitializationRun | undefined;
    if (config.repositoryDigest) {
      initialization = this.store.db.prepare('SELECT * FROM initialization_runs WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1').get(details.id) as InitializationRun | undefined;
      if (!initialization || initialization.status !== 'succeeded' || initialization.config_digest !== config.initializationDigest) fail('STALE_EVIDENCE', 'Successful worktree initialization is required for this configuration.');
    }
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
    return { ...(initialization ? { repositoryDigest: config.repositoryDigest, initialization: { id: initialization.id, configDigest: initialization.config_digest, results: JSON.parse(initialization.results_json) } } : {}), taskId: task.id, planId: plan.id, planDigest: plan.sha256_digest, baseSha: details.reviewBaseSha, commitSha: details.currentHead, workspaceDigest: details.workspaceDigest, changedFiles: details.changedFiles, diff: details.diff, checks, review: { id: review.id, runId: review.run_id, verdict: review.verdict, findings: JSON.parse(review.findings_json), summary: review.summary }, reviewHistory, implementations, requestedChanges: decisions };
  }
  // Override evidence reports failed/missing checks honestly. It relaxes quality
  // gates only; the approved plan, clean commit, complete diff and digest remain bound.
  overrideBody(task: Task) {
    const details = this.workspaces.inspect(task);
    if (details.dirty || details.truncated) fail('STALE_EVIDENCE', 'Override acceptance requires a clean committed worktree and a complete captured diff. Commit preserved edits and inspect again.');
    const plan = this.store.plan(task.approved_plan_revision_id ?? '');
    if (!plan || task.current_plan_revision_id !== plan.id || digest(JSON.parse(plan.body_json)) !== plan.sha256_digest) fail('STALE_EVIDENCE', 'The approved plan changed.');
    const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project;
    let config: ReturnType<typeof resolveExecutionConfiguration> | undefined, configurationError: string | null = null;
    try { config = resolveExecutionConfiguration(project, details.path); }
    catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      configurationError = error.message;
    }
    const validations = this.store.db.prepare('SELECT id,name,commit_sha,config_digest,argv_json,exit_code,status,reason,log_text FROM validation_runs WHERE task_id=? AND commit_sha=? ORDER BY rowid').all(task.id, details.currentHead) as { id: string; name: string; commit_sha: string; config_digest: string; argv_json: string; exit_code: number | null; status: string; reason: string | null; log_text: string }[];
    const checks = (config?.validationCommands ?? []).map(command => {
      const check = validations.filter(check => check.name === command.name).at(-1);
      const current = check && check.config_digest === verificationDigest(config!) && check.argv_json === JSON.stringify(command.argv);
      return { id: check?.id ?? command.name, name: command.name, commitSha: details.currentHead, status: !check ? 'not_run' : current ? check.status : 'stale', exitCode: check?.exit_code ?? null, log: check?.log_text ?? '', reason: check?.reason ?? null };
    });
    const reviewHistory = this.store.db.prepare('SELECT id,commit_sha,verdict,findings_json,summary,status FROM reviews WHERE task_id=? ORDER BY rowid').all(task.id) as Review[];
    const review = reviewHistory.filter(review => review.commit_sha === details.currentHead).at(-1);
    const runs = this.store.db.prepare('SELECT id,stage,status,error_code,summary FROM agent_runs WHERE task_id=? ORDER BY rowid').all(task.id) as { id: string; stage: string; status: string; error_code: string | null; summary: string | null }[];
    const implementations = runs.filter(run => ['implement', 'repair'].includes(run.stage) && run.status === 'succeeded');
    const failures = runs.filter(run => run.error_code || ['failed', 'interrupted', 'cancelled'].includes(run.status)).map(run => ({ ...run, ...classifyFailure(run.error_code, run.summary ?? '') }));
    const blocker = this.store.db.prepare("SELECT payload_json FROM events WHERE task_id=? AND type IN ('build.failed','build.interrupted','evidence.invalidated','build.recovery_required') ORDER BY sequence DESC LIMIT 1").get(task.id) as { payload_json: string } | undefined;
    const pipelineBlocker = blocker ? JSON.parse(blocker.payload_json) : null;
    const initializations = this.store.db.prepare('SELECT id,status,reason,config_digest,results_json,log_text FROM initialization_runs WHERE task_id=? ORDER BY rowid').all(task.id);
    return { mode: 'override' as const, taskId: task.id, planId: plan.id, planDigest: plan.sha256_digest, baseSha: details.reviewBaseSha, commitSha: details.currentHead, workspaceDigest: details.workspaceDigest, changedFiles: details.changedFiles, diff: details.diff, configurationDigest: digest(JSON.parse(project.config_json)), configurationError, checks, validations, initializations, failures, pipelineBlocker, implementations, review: review ? { id: review.id, verdict: review.verdict, status: review.status, findings: JSON.parse(review.findings_json), summary: review.summary } : null, reviewHistory };
  }
  create(task: Task, override = false) {
    const body = override ? this.overrideBody(task) : this.body(task), id = randomUUID();
    this.store.db.prepare('INSERT INTO evidence_bundles VALUES (?,?,?,?,?,?)').run(id, task.id, body.commitSha, JSON.stringify(body), digest(body), new Date().toISOString());
    return this.latest(task.id)!;
  }
  latest(taskId: string) { return this.store.db.prepare('SELECT * FROM evidence_bundles WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as EvidenceBundle | undefined; }
  verify(task: Task, allowOverride = false): EvidenceBundle {
    const bundle = this.latest(task.id);
    if (!bundle) fail('STALE_EVIDENCE', 'No final evidence is available.');
    const body = JSON.parse(bundle.body_json), override = body.mode === 'override';
    if (override && !allowOverride && !this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND gate='final' AND action='accept_override' AND artifact_id=? AND artifact_digest=? AND commit_sha=? AND actor='local-human'").get(task.id, bundle.id, bundle.sha256_digest, bundle.commit_sha)) fail('APPROVAL_REQUIRED', 'This evidence requires explicit human override acceptance.');
    if (digest(body) !== bundle.sha256_digest || digest(override ? this.overrideBody(task) : this.body(task)) !== bundle.sha256_digest) fail('STALE_EVIDENCE', 'The displayed evidence is stale. Refresh the worktree and capture current evidence before accepting.');
    return bundle;
  }
}
