import { resolveExecutionConfiguration, verificationDigest, type ResolvedExecutionConfig } from '../configuration/repository.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { implementationSchema, executionConfigSchema, type ExecutionConfig, type Project, type Request, type Task, reviewSchema, type WorkspaceDetails } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';
import { digest, fail, FactoryError, Workflow } from '../workflows/engine.js';
import { CodexReviewer, CodexImplementer, type ReviewAdapter, type ImplementationAdapter, type PlannerEvent } from './codex.js';
import { CodexError } from './rpc.js';
import { allowedPath, createPlanningSnapshot, snapshotDigest, redact } from './snapshot.js';
import { EvidenceManager } from '../checks/evidence.js';
import { WorkspaceManager } from '../git/workspaces.js';
import { CodexValidationRunner, validationEnvironmentFailure, redactLog, type ValidationAdapter } from '../checks/validation.js';
import { RunPool } from '../scheduler/run-pool.js';

export function executionConfig(project: Project): ExecutionConfig {
  return executionConfigSchema.parse({ executionEnabled: false, trustedRepository: false, validationCommands: [], ...JSON.parse(project.config_json) });
}
type BuildJob = { id: string; taskId: string; stage: 'implement' | 'validate' | 'review' | 'repair' | 'initialize'; controller: AbortController; done: Promise<void>; finish: () => void; queuedAt: number; configDigest?: string };
export class BuildJobs {
  private jobs = new Map<string, BuildJob>();
  private closing = false;
  readonly evidence: EvidenceManager;
  constructor(private store: Store, private workflow: Workflow, readonly workspaces: WorkspaceManager, private dataDir: string, private pool: RunPool, private implementer: ImplementationAdapter = new CodexImplementer(), private validator: ValidationAdapter = new CodexValidationRunner(), private reviewer: ReviewAdapter = new CodexReviewer()) { this.evidence = new EvidenceManager(store, workspaces); }
  private project(task: Task) { return this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project; }
  private assertAllowed(task: Task) {
    this.workflow.assertApproved(task);
    const workspace = this.workspaces.get(task.id);
    const config = resolveExecutionConfiguration(this.project(task), workspace && existsSync(workspace.path) ? workspace.path : undefined);
    if (!config.executionEnabled || !config.trustedRepository) fail('POLICY_DENIED', 'Enable execution for this trusted repository in Projects before starting an implementation.');
    const source = this.store.db.prepare('SELECT r.provider,r.status FROM plan_revisions p JOIN agent_runs r ON r.id=p.created_by_run_id WHERE p.id=?').get(task.approved_plan_revision_id) as { provider: string; status: string } | undefined;
    if (source?.provider !== 'codex' || source.status !== 'succeeded') fail('POLICY_DENIED', 'Simulated plans cannot authorize real implementation. Generate and approve a real Codex plan.');
    return config;
  }
  private assertPriorProcessStopped(taskId: string) {
    const interrupted = this.store.db.prepare("SELECT process_pid FROM agent_runs WHERE task_id=? AND status IN ('interrupted','stopping') AND process_pid IS NOT NULL").all(taskId) as { process_pid: number }[];
    for (const run of interrupted) {
      try { process.kill(run.process_pid, 0); fail('CONFLICT', `A process exists at the previous provider PID (${run.process_pid}). Inspect it before recovery; the factory will not terminate it automatically.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  enqueue(taskId: string, expectedVersion: number, stage: 'implement' | 'validate' | 'review' | 'repair' | 'initialize' = 'implement', recovery?: { expectedHead: string; expectedWorkspaceDigest: string }) {
    if (this.closing) fail('CONFLICT', 'The factory service is shutting down.');
    return this.store.transaction(() => {
      let task = this.workflow.getTask(taskId, expectedVersion);
      const config = this.assertAllowed(task);
      this.assertPriorProcessStopped(taskId);
      if (this.jobs.has(taskId) || this.store.db.prepare("SELECT id FROM agent_runs WHERE task_id=? AND status IN ('queued','starting','running','waiting_permission','stopping')").get(taskId)) fail('CONFLICT', 'This task already has pending or active work.');
      if (stage === 'repair') {
        if (task.status !== 'FINAL_REVIEW') fail('INVALID_TRANSITION', 'Human-requested repairs require final review.');
        this.assertRepairBudget(task);
        task = this.workflow.transition(task.id, task.version, 'REPAIRING', 'repair.human_requested');
      } else if (stage === 'review' && task.status === 'CODE_REVIEW' && !recovery) {
        // Continue a completed Milestone 3 task through fresh checks and independent review.
      } else if (recovery) {
        if (!['BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status)) fail('INVALID_TRANSITION', 'Only stopped or interrupted implementation work can be resumed.');
        const details = this.workspaces.inspect(task);
        if (details.currentHead !== recovery.expectedHead || details.workspaceDigest !== recovery.expectedWorkspaceDigest) fail('STALE_EVIDENCE', 'The worktree changed since inspection. Refresh its changes before resuming.');
        if (stage !== 'implement' && details.dirty) fail('WORKSPACE_CONFLICT', 'Validation requires a clean committed worktree. Resume implementation to finish and commit preserved edits first.');
        task = this.workflow.transition(task.id, task.version, 'QUEUED_FOR_BUILD', 'task.recovery_authorized');
      } else if (task.status !== 'QUEUED_FOR_BUILD') {
        const workspace = this.workspaces.get(taskId);
        const previous = this.store.db.prepare("SELECT id FROM agent_runs WHERE task_id=? AND stage IN ('implement','validate','review','repair') LIMIT 1").get(taskId);
        if (!previous || !['BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status) || workspace && !(workspace.cleanup_status === 'creating' && !existsSync(workspace.path))) fail('INVALID_TRANSITION', 'Inspect the preserved worktree and use explicit recovery before restarting implementation.');
        task = this.workflow.transition(task.id, task.version, 'QUEUED_FOR_BUILD', 'build.setup_retried');
      }
      const attempts = this.store.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE task_id=? AND stage=? AND approved_plan_id=? AND implementation_started=1').get(task.id, stage, task.approved_plan_revision_id) as { n: number };
      if (stage === 'implement' && attempts.n >= config.maxImplementationAttempts) fail('POLICY_DENIED', 'The implementation attempt limit for this plan is exhausted. Preserve the worktree and revise the request or raise the project limit before retrying.');
      const id = randomUUID(), plan = this.store.plan(task.approved_plan_revision_id!)!;
      this.store.db.prepare("INSERT INTO agent_runs(id,task_id,stage,provider,status,attempt,started_at,owner_id,owner_pid,heartbeat_at,recovery_stage,approved_plan_id,approved_plan_digest) VALUES (?,?,?,'codex','queued',?,?,?,?,?,?,?,?)").run(id, task.id, ['review','initialize'].includes(stage) ? 'validate' : stage, attempts.n + 1, new Date().toISOString(), this.pool.ownerId, process.pid, new Date().toISOString(), stage, plan.id, plan.sha256_digest);
      if (stage === 'implement') this.store.db.prepare('UPDATE agent_runs SET implementation_started=0 WHERE id=?').run(id);
      this.store.event('build.queued', task.project_id, task.id, { runId: id, stage, approvedPlanId: plan.id });
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const job: BuildJob = { id, taskId, stage, controller: new AbortController(), done, finish, queuedAt: Date.now() };
      this.jobs.set(taskId, job);
      setImmediate(() => { void this.run(job).finally(() => { this.jobs.delete(taskId); finish(); }); });
      return task;
    });
  }
  private guard(job: BuildJob, status: 'BUILDING' | 'VALIDATING' | 'CODE_REVIEW' | 'REPAIRING') {
    job.controller.signal.throwIfAborted();
    const task = this.workflow.getTask(job.taskId);
    if (task.status !== status) fail('INVALID_TRANSITION', 'The task is no longer authorized for this stage.');
    const config = this.assertAllowed(task);
    if (job.configDigest && job.configDigest !== verificationDigest(config)) fail('STALE_EVIDENCE', 'Repository configuration changed during execution.');
    const run = this.store.db.prepare('SELECT owner_id,approved_plan_id,approved_plan_digest FROM agent_runs WHERE id=?').get(job.id) as { owner_id: string; approved_plan_id: string; approved_plan_digest: string };
    const plan = this.store.plan(task.approved_plan_revision_id!)!;
    if (run.owner_id !== this.pool.ownerId || run.approved_plan_id !== plan.id || run.approved_plan_digest !== plan.sha256_digest) fail('APPROVAL_REQUIRED', 'The run lease or approved plan no longer matches this task.');
    this.workspaces.verify(task);
    return task;
  }
  private event(job: BuildJob, event: PlannerEvent) {
    if (job.controller.signal.aborted) return;
    const task = this.workflow.getTask(job.taskId);
    this.store.transaction(() => {
      if (event.type === 'process') this.store.db.prepare('UPDATE agent_runs SET process_pid=? WHERE id=?').run(event.pid, job.id);
      if (event.type === 'session') this.store.db.prepare('UPDATE agent_runs SET provider_session_ref=?,process_pid=? WHERE id=?').run(event.sessionId, event.pid ?? null, job.id);
      if (event.type === 'turn') this.store.db.prepare('UPDATE agent_runs SET turn_ref=? WHERE id=?').run(event.turnId, job.id);
      if (event.type === 'model') this.store.db.prepare('UPDATE agent_runs SET model=? WHERE id=?').run(event.model, job.id);
      if (event.type === 'permission_denied') this.store.db.prepare("INSERT INTO permission_requests VALUES (?,?,?,?,'denied',?,?)").run(randomUUID(), task.id, job.id, event.method, event.message, new Date().toISOString());
      this.store.event(`run.${event.type}`, task.project_id, task.id, { runId: job.id, ...event });
    });
  }
  private async run(job: BuildJob) {
    let release: (() => void) | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const priority = this.store.requestForTask(this.workflow.getTask(job.taskId));
      release = await this.pool.acquire(job.controller.signal, priority.priority, job.queuedAt);
      job.controller.signal.throwIfAborted();
      let task = this.workflow.getTask(job.taskId);
      let config = this.assertAllowed(task);
      this.store.transaction(() => {
        if (job.stage !== 'repair' && !(job.stage === 'review' && task.status === 'CODE_REVIEW')) task = this.workflow.transition(task.id, task.version, 'BUILDING', 'build.started');
        this.store.db.prepare("UPDATE agent_runs SET status='starting',heartbeat_at=? WHERE id=?").run(new Date().toISOString(), job.id);
      });
      // Approval is checked before creating or touching the task worktree.
      heartbeat = setInterval(() => this.store.db.prepare('UPDATE agent_runs SET heartbeat_at=? WHERE id=? AND owner_id=?').run(new Date().toISOString(), job.id, this.pool.ownerId), 2000);
      const workspace = await this.workspaces.ensure(task, job.controller.signal, pid => this.event(job, { type: 'process', pid }));
      this.store.db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(job.id);
      config = resolveExecutionConfiguration(this.project(task), workspace.path);
      job.configDigest = verificationDigest(config);
      await this.initialize(job, config, job.stage === 'initialize');
      if (job.stage === 'implement' || job.stage === 'repair') await this.implement(job, config, job.stage === 'repair');
      else {
        if (this.workspaces.changed(workspace).length) fail('WORKSPACE_CONFLICT', 'Preserved edits are uncommitted. Resume implementation before validation.');
        this.store.db.prepare('UPDATE workspaces SET head_sha=? WHERE id=?').run(this.workspaces.head(workspace), workspace.id);
      }
      let reuseValidationRun = !['implement','repair'].includes(job.stage);
      if (!reuseValidationRun) this.finishRun(job);
      while (true) {
        task = this.workflow.getTask(task.id);
        this.workflow.transition(task.id, task.version, 'VALIDATING', 'validation.started');
        if (!reuseValidationRun) this.nextRun(job, 'validate');
        reuseValidationRun = false;
        let repairReason: string | undefined;
        try { await this.validate(job, config); this.finishRun(job); }
        catch (error) {
          if (!(error instanceof CodexError) || !['VALIDATION_FAILED', 'VALIDATION_TIMEOUT'].includes(error.code) || job.controller.signal.aborted) throw error;
          this.finishRun(job, 'failed', error.message);
          repairReason = error.message;
        }
        if (!repairReason) {
          task = this.guard(job, 'VALIDATING');
          if (verificationDigest(this.assertAllowed(task)) !== verificationDigest(config)) fail('STALE_EVIDENCE', 'Validation configuration changed while checks were running.');
          this.workflow.transition(task.id, task.version, 'CODE_REVIEW', 'validation.passed');
          this.nextRun(job, 'review');
          const review = await this.review(job);
          this.finishRun(job);
          if (review.verdict === 'blocked') fail('POLICY_DENIED', 'Independent review is blocked: ' + review.summary);
          if (review.verdict === 'pass' && !review.findings.some(finding => ['critical', 'high'].includes(finding.severity))) {
            task = this.guard(job, 'CODE_REVIEW');
            this.store.transaction(() => {
              const bundle = this.evidence.create(task);
              this.workflow.transition(task.id, task.version, 'FINAL_REVIEW', 'final_review.ready');
              this.store.event('build.completed', task.project_id, task.id, { runId: job.id, commitSha: bundle.commit_sha, evidenceId: bundle.id, next: 'human_acceptance' });
            });
            break;
          }
          repairReason = 'Independent review requested changes: ' + review.summary;
        }
        task = this.workflow.getTask(task.id);
        this.assertRepairBudget(task);
        this.workflow.transition(task.id, task.version, 'REPAIRING', 'repair.started');
        this.nextRun(job, 'repair');
        this.store.event('repair.context', task.project_id, task.id, { reason: repairReason });
        await this.implement(job, config, true);
        this.finishRun(job);
      }
    } catch (error) {
      const stopped = job.controller.signal.aborted;
      const code = stopped ? 'CANCELLED' : error instanceof CodexError || error instanceof FactoryError ? error.code : 'BUILD_FAILED';
      const message = stopped ? 'Work stopped. The task worktree and partial edits were preserved.' : error instanceof CodexError || error instanceof FactoryError ? error.message : 'Implementation or validation failed. The worktree and logs were preserved for inspection and recovery.';
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE agent_runs SET status=?,finished_at=?,error_code=?,summary=COALESCE(summary,?) WHERE id=? AND status IN ('queued','starting','running','stopping')").run(stopped ? this.closing ? 'interrupted' : 'cancelled' : 'failed', new Date().toISOString(), code, message, job.id);
        this.store.db.prepare("UPDATE validation_runs SET status=?,reason=?,finished_at=? WHERE run_id=? AND status='running'").run(stopped ? this.closing ? 'interrupted' : 'cancelled' : code === 'VALIDATION_TIMEOUT' ? 'timed_out' : 'failed', message, new Date().toISOString(), job.id);
        this.store.db.prepare("UPDATE initialization_runs SET status=?,reason=?,finished_at=? WHERE run_id=? AND status='running'").run(stopped ? this.closing ? 'interrupted' : 'cancelled' : 'failed', message, new Date().toISOString(), job.id);
        const task = this.workflow.getTask(job.taskId);
        if (['QUEUED_FOR_BUILD', 'BUILDING', 'VALIDATING', 'CODE_REVIEW', 'REPAIRING'].includes(task.status)) this.workflow.transition(task.id, task.version, 'BLOCKED', 'build.blocked', message, 'Inspect the preserved worktree and checks, then explicitly resume implementation or re-run validation.');
        this.store.event(stopped ? 'build.interrupted' : 'build.failed', task.project_id, task.id, { runId: job.id, code, message });
      });
    } finally { if (heartbeat) clearInterval(heartbeat); release?.(); }
  }
  private async initialize(job: BuildJob, config: ResolvedExecutionConfig, force: boolean) {
    if (!config.repositoryDigest) return;
    const task = this.workflow.getTask(job.taskId), workspace = this.workspaces.verify(task);
    const previous = this.store.db.prepare('SELECT status FROM initialization_runs WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1').get(workspace.id) as { status: string } | undefined;
    const successful = this.store.db.prepare("SELECT id FROM initialization_runs WHERE workspace_id=? AND config_digest=? AND status='succeeded' ORDER BY rowid DESC LIMIT 1").get(workspace.id, config.initializationDigest);
    if (!force && successful && previous?.status === 'succeeded') return;
    const id = randomUUID(), source = this.workspaces.head(workspace), before = this.workspaces.fingerprint(workspace);
    const directory = join(this.dataDir, 'artifacts', task.id, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.store.db.prepare("INSERT INTO initialization_runs(id,task_id,workspace_id,run_id,source_sha,file_digest,config_digest,status,started_at) VALUES (?,?,?,?,?,?,?,'running',?)").run(id, task.id, workspace.id, job.id, source, config.repositoryDigest, config.initializationDigest, new Date().toISOString());
    this.store.event('initialization.started', task.project_id, task.id, { initializationId: id, commands: config.initializationCommands.map(command => command.name), network: config.initializationNetwork });
    let log = '';
    const results: { name: string; argv: string[]; exitCode: number }[] = [];
    const capture = (output: string) => {
      const safe = redactLog(output).slice(0, 130000);
      this.store.db.prepare('UPDATE initialization_runs SET log_text=?,results_json=? WHERE id=?').run(safe, JSON.stringify(results), id);
      writeFileSync(join(directory, 'initialization.log'), safe, { mode: 0o600 });
      this.store.event('initialization.output', task.project_id, task.id, { initializationId: id });
    };
    for (const command of config.initializationCommands) {
      job.controller.signal.throwIfAborted(); this.assertAllowed(this.workflow.getTask(task.id));
      const prefix = log + '\n' + command.name + '\n';
      capture(prefix);
      let result;
      try {
        result = await this.validator.run({ cwd: workspace.path, temporaryDirectory: join(directory, 'temporary'), command, networkAccess: config.initializationNetwork, processId: randomUUID(), signal: job.controller.signal, onProcess: pid => this.event(job, { type: 'process', pid }), onOutput: output => capture(prefix + output) });
      } catch (error) {
        if (job.controller.signal.aborted) throw error;
        fail('POLICY_DENIED', 'Worktree initialization did not complete. Inspect its log and project settings, then retry initialization. No code repair was attempted.');
      }
      results.push({ name: command.name, argv: command.argv, exitCode: result.exitCode });
      log = (prefix + redactLog(result.log)).slice(0, 130000); capture(log);
      job.controller.signal.throwIfAborted(); this.assertAllowed(this.workflow.getTask(task.id));
      if (this.workspaces.head(workspace) !== source || this.workspaces.fingerprint(workspace) !== before) fail('WORKSPACE_CONFLICT', 'Initialization changed source files or HEAD. Inspect the preserved worktree before recovery. Hooks may only prepare ignored dependencies and local artifacts.');
      if (result.exitCode !== 0) fail('POLICY_DENIED', 'Worktree initialization failed. Inspect its log, fix setup, and retry. No implementation or code repair was attempted.');
    }
    this.store.db.prepare("UPDATE initialization_runs SET status='succeeded',finished_at=? WHERE id=?").run(new Date().toISOString(), id);
    this.store.event('initialization.completed', task.project_id, task.id, { initializationId: id, status: 'succeeded' });
  }
  private assertRepairBudget(task: Task) {
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id=? AND stage='repair' AND approved_plan_id=?").get(task.id, task.approved_plan_revision_id) as { n: number };
    if (count.n >= 3) fail('POLICY_DENIED', 'The three-repair limit for this approved plan is exhausted. Inspect findings and logs; revise the request in a new task if more work is needed.');
  }
  private finishRun(job: BuildJob, status = 'succeeded', message?: string) {
    this.store.db.prepare("UPDATE agent_runs SET status=?,finished_at=?,exit_code=?,summary=COALESCE(summary,?) WHERE id=? AND status IN ('starting','running')").run(status, new Date().toISOString(), status === 'succeeded' ? 0 : 1, message ?? null, job.id);
  }
  private nextRun(job: BuildJob, stage: 'validate' | 'review' | 'repair') {
    job.controller.signal.throwIfAborted();
    const task = this.workflow.getTask(job.taskId), plan = this.store.plan(task.approved_plan_revision_id!)!;
    this.assertAllowed(task);
    const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE task_id=? AND stage=? AND approved_plan_id=?').get(task.id, stage, plan.id) as { n: number };
    job.id = randomUUID();
    this.store.db.prepare("INSERT INTO agent_runs(id,task_id,stage,provider,status,attempt,started_at,owner_id,owner_pid,heartbeat_at,recovery_stage,approved_plan_id,approved_plan_digest) VALUES (?,?,?,'codex','running',?,?,?,?,?,?,?,?)").run(job.id, task.id, stage, count.n + 1, new Date().toISOString(), this.pool.ownerId, process.pid, new Date().toISOString(), stage, plan.id, plan.sha256_digest);
    this.store.event('run.started', task.project_id, task.id, { runId: job.id, stage, attempt: count.n + 1 });
  }
  private async implement(job: BuildJob, config: ExecutionConfig, repair: boolean) {
    const status = repair ? 'REPAIRING' : 'BUILDING';
    const task = this.guard(job, status), workspace = this.workspaces.verify(task), plan = this.store.plan(task.approved_plan_revision_id!)!;
    this.store.db.prepare('UPDATE agent_runs SET implementation_started=1 WHERE id=?').run(job.id);
    const request = this.store.requestForTask(task);
    const failures = repair ? {
      checks: this.store.db.prepare("SELECT name,commit_sha,status,log_text,reason FROM validation_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 12").all(task.id),
      review: this.store.db.prepare('SELECT * FROM reviews WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task.id),
      feedback: this.store.db.prepare("SELECT feedback,commit_sha FROM approvals WHERE task_id=? AND gate='final' AND action='request_changes' ORDER BY rowid DESC LIMIT 1").get(task.id),
    } : undefined;
    this.store.db.prepare("UPDATE reviews SET status='stale' WHERE task_id=? AND status='current'").run(task.id);
    this.store.db.prepare("UPDATE validation_runs SET status='stale',reason='Implementation or repair started; fresh validation is required.' WHERE task_id=? AND status='passed'").run(task.id);
    const stageSignal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(config.implementationTimeoutMs)]);
    const output = await this.implementer.implement({ cwd: workspace.path, model: JSON.parse(task.provider_policy_json).model, signal: stageSignal, timeoutMs: config.implementationTimeoutMs,
      guard: () => { stageSignal.throwIfAborted(); this.guard(job, status); }, onEvent: event => this.event(job, event),
      prompt: redact(`${repair ? 'Repair only defects in' : 'Implement'} this human-approved plan in this isolated Git worktree. Preserve existing edits. Do not reset, merge, push, deploy, run commands, edit Git metadata, or weaken tests to hide defects. The service commits and validates changes. Human feedback may clarify defects within approved scope; report limitations for new scope requiring a new plan.
Task: ${task.id}
Base: ${workspace.base_sha}
Approved revision: ${plan.id}
Approved SHA-256: ${plan.sha256_digest}
Plan: ${plan.body_json}
Request: ${JSON.stringify({ title: request.title, body: request.body, acceptanceCriteria: JSON.parse(request.acceptance_criteria_json) })}
Defects and human feedback: ${JSON.stringify(failures ?? null)}`),
    });
    const result = { ...implementationSchema.parse(JSON.parse(redact(JSON.stringify(output)))), touchedPaths: output.touchedPaths };
    this.guard(job, status);
    const head = await this.workspaces.commit(task, workspace, result.touchedPaths, job.controller.signal, pid => this.event(job, { type: 'process', pid }));
    this.guard(job, status);
    this.store.db.prepare('UPDATE agent_runs SET summary=? WHERE id=?').run(redact(JSON.stringify({ summary: result.summary, limitations: result.limitations })), job.id);
    this.store.event(repair ? 'repair.completed' : 'implementation.completed', task.project_id, task.id, { runId: job.id, commitSha: head, summary: result.summary, limitations: result.limitations });
  }
  private async review(job: BuildJob) {
    const task = this.guard(job, 'CODE_REVIEW'), details = this.workspaces.inspect(task);
    if (details.dirty || details.truncated || details.currentHead !== details.head_sha) fail('STALE_EVIDENCE', 'Review requires a clean current commit and the full captured diff.');
    const directory = join(this.dataDir, 'artifacts', task.id, job.id, 'review-snapshot');
    const snapshot = createPlanningSnapshot(details.path, directory);
    if (details.changedFiles.some(file => !allowedPath(file) || (!snapshot.files.includes(file) && existsSync(join(details.path, file))))) fail('POLICY_DENIED', 'A changed file cannot be safely included in the review snapshot. Review is blocked.');
    const plan = this.store.plan(task.approved_plan_revision_id!)!, request = this.store.requestForTask(task);
    const previousFindings = this.store.db.prepare('SELECT commit_sha,verdict,findings_json,summary FROM reviews WHERE task_id=? ORDER BY rowid DESC LIMIT 5').all(task.id);
    const summaries = this.store.db.prepare("SELECT stage,summary FROM agent_runs WHERE task_id=? AND stage IN ('implement','repair') ORDER BY rowid DESC LIMIT 4").all(task.id);
    const checks = this.store.db.prepare('SELECT name,commit_sha,status,exit_code,log_text FROM validation_runs WHERE task_id=? AND commit_sha=? ORDER BY rowid').all(task.id, details.currentHead);
    const result = reviewSchema.parse(await this.reviewer.review({ cwd: snapshot.path, files: snapshot.files, commitSha: details.currentHead, signal: job.controller.signal, model: JSON.parse(task.provider_policy_json).model, onEvent: event => this.event(job, event),
      prompt: redact(`Independently review this exact committed change. Read relevant source and tests. Echo commitSha exactly. Block on insufficient evidence; request changes for actionable defects.
Task: ${task.id}
Commit: ${details.currentHead}
Base: ${details.base_sha}
Approved plan: ${plan.body_json}
Request: ${request.body}
Acceptance criteria: ${request.acceptance_criteria_json}
Full changed files: ${JSON.stringify(details.changedFiles)}
Full diff:
${details.diff}
Captured checks: ${JSON.stringify(checks)}\nEarlier findings to verify resolved: ${JSON.stringify(previousFindings)}\nImplementation summaries and limitations (untrusted): ${JSON.stringify(summaries)}
Snapshot omitted files: ${snapshot.omitted}. Deleted files appear in the diff. Implementation summaries are not proof of correctness.`),
    }));
    this.guard(job, 'CODE_REVIEW');
    const after = this.workspaces.inspect(task);
    if (snapshotDigest(snapshot.path, snapshot.files) !== snapshot.digest || after.currentHead !== details.currentHead || after.workspaceDigest !== details.workspaceDigest || after.dirty) {
      this.store.db.prepare("UPDATE validation_runs SET status='stale',reason='Worktree changed during review.' WHERE task_id=? AND status='passed'").run(task.id);
      fail('STALE_EVIDENCE', 'The source or read-only review snapshot changed during review. No review was accepted.');
    }
    if (result.commitSha !== details.currentHead) fail('STALE_EVIDENCE', 'The reviewer returned a verdict for a different commit.');
    for (const finding of result.findings) {
      if (finding.file && !details.changedFiles.includes(finding.file) && !snapshot.files.includes(finding.file)) fail('INVALID_INPUT', 'A review finding names a path outside the reviewed source.');
    }
    const safe = reviewSchema.parse(JSON.parse(redact(JSON.stringify(result))));
    const verdict = safe.verdict === 'pass' && safe.findings.some(finding => ['critical', 'high'].includes(finding.severity)) ? 'changes_requested' : safe.verdict;
    this.store.db.prepare("INSERT INTO reviews(id,task_id,run_id,commit_sha,verdict,findings_json,summary,status,created_at) VALUES (?,?,?,?,?,?,?,'current',?)").run(randomUUID(), task.id, job.id, details.currentHead, verdict, JSON.stringify(safe.findings), safe.summary, new Date().toISOString());
    this.store.event('review.completed', task.project_id, task.id, { runId: job.id, commitSha: details.currentHead, verdict });
    return { ...safe, verdict };
  }
  private async validate(job: BuildJob, config: ResolvedExecutionConfig) {
    const task = this.guard(job, 'VALIDATING'), workspace = this.workspaces.verify(task), head = this.workspaces.head(workspace);
    if (!config.validationCommands.length) fail('POLICY_DENIED', 'No validation commands are configured. Implementation is preserved, but checks are NOT RUN. Configure checks, inspect the worktree, and re-run validation.');
    if (this.workspaces.changed(workspace).length) fail('STALE_EVIDENCE', 'Validation requires a clean current commit.');
    const before = this.workspaces.fingerprint(workspace), configDigest = verificationDigest(config);
    for (const command of config.validationCommands) {
      this.guard(job, 'VALIDATING');
      const id = randomUUID(), directory = join(this.dataDir, 'artifacts', task.id, id), logPath = join(directory, 'validation.log');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.store.transaction(() => {
        this.store.db.prepare("INSERT INTO validation_runs(id,task_id,commit_sha,name,argv_json,log_path,started_at,status,run_id,config_digest) VALUES (?,?,?,?,?,?,?,'running',?,?)").run(id, task.id, head, command.name, JSON.stringify(command.argv), logPath, new Date().toISOString(), job.id, configDigest);
        this.store.event('validation.command_started', task.project_id, task.id, { validationId: id, name: command.name, commitSha: head });
      });
      const result = await this.validator.run({ cwd: workspace.path, temporaryDirectory: join(directory, 'temporary'), command, processId: id, signal: job.controller.signal, onProcess: pid => this.event(job, { type: 'process', pid }), onOutput: log => {
        const safe = redactLog(log).slice(0, 130000);
        writeFileSync(logPath, safe, { mode: 0o600 });
        this.store.db.prepare('UPDATE validation_runs SET log_text=? WHERE id=?').run(safe, id);
        this.store.event('validation.output', task.project_id, task.id, { validationId: id });
      } });
      this.guard(job, 'VALIDATING');
      const stale = this.workspaces.head(workspace) !== head || this.workspaces.fingerprint(workspace) !== before;
      const log = redactLog(result.log).slice(0, 130000);
      const setupRequired = result.exitCode !== 0 ? validationEnvironmentFailure(log) : null;
      writeFileSync(logPath, log, { mode: 0o600 });
      this.store.transaction(() => {
        this.store.db.prepare('UPDATE validation_runs SET exit_code=?,status=?,log_text=?,reason=?,finished_at=? WHERE id=?').run(result.exitCode, stale ? 'stale' : result.exitCode === 0 ? 'passed' : result.exitCode === 124 ? 'timed_out' : 'failed', log, stale ? 'The check changed the source or HEAD; evidence is invalid.' : result.exitCode === 0 ? null : setupRequired ? setupRequired : result.exitCode === 124 ? 'Command exceeded its configured timeout.' : 'Command exited with a nonzero status.', new Date().toISOString(), id);
        if (stale) this.store.db.prepare("UPDATE validation_runs SET status='stale' WHERE task_id=? AND commit_sha=? AND status='passed'").run(task.id, head);
        this.store.event('validation.completed', task.project_id, task.id, { validationId: id, exitCode: result.exitCode, stale, commitSha: head });
      });
      if (stale) fail('STALE_EVIDENCE', 'Validation changed the worktree or HEAD. Prior checks are stale; inspect the preserved edits before recovery.');
      if (setupRequired) throw new CodexError('VALIDATION_SETUP_REQUIRED', setupRequired);
      if (result.exitCode === 124) throw new CodexError('VALIDATION_TIMEOUT', 'A configured validation command exceeded its timeout. The commit and captured output are preserved.');
      if (result.exitCode !== 0) throw new CodexError('VALIDATION_FAILED', 'A configured validation command failed. Inspect its captured log.');
    }
  }
  inspect(taskId: string): WorkspaceDetails {
    const task = this.workflow.getTask(taskId);
    try {
      const details = this.workspaces.inspect(task);
      if (['CODE_REVIEW','FINAL_REVIEW','ACCEPTED'].includes(task.status)) {
        if (details.currentHead !== details.head_sha || details.dirty) this.invalidate(task, 'The worktree changed after validation or review.');
        else if (['FINAL_REVIEW','ACCEPTED'].includes(task.status)) {
          try { this.evidence.verify(task); } catch { this.invalidate(task, 'The final evidence no longer matches the current commit, checks, or review.'); }
        }
      }
      return details;
    } catch (error) {
      if (['CODE_REVIEW','FINAL_REVIEW','ACCEPTED'].includes(task.status)) this.invalidate(task, 'The saved worktree is missing or its Git metadata changed.');
      throw error;
    }
  }
  invalidate(task: Task, reason: string) {
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE validation_runs SET status='stale',reason=? WHERE task_id=? AND status='passed'").run(reason, task.id);
      this.store.db.prepare("UPDATE reviews SET status='stale' WHERE task_id=? AND status='current'").run(task.id);
      this.store.db.prepare('UPDATE tasks SET accepted_commit_sha=NULL WHERE id=?').run(task.id);
      this.workflow.transition(task.id, task.version, 'BLOCKED', 'evidence.invalidated', reason, 'Inspect the worktree, then revalidate and obtain a fresh independent review.');
    });
  }
  stop(taskId: string) { const job = this.jobs.get(taskId); if (job) { this.store.db.prepare("UPDATE agent_runs SET status='stopping' WHERE id=? AND status IN ('starting','running')").run(job.id); job.controller.abort(); } }
  recover() {
    this.store.transaction(() => {
      const runs = this.store.db.prepare("SELECT id,task_id FROM agent_runs WHERE stage IN ('implement','validate','review','repair') AND status IN ('queued','starting','running','waiting_permission','stopping')").all() as { id: string; task_id: string }[];
      for (const run of runs) {
        this.store.db.prepare("UPDATE agent_runs SET status='interrupted',finished_at=?,error_code='SERVICE_RESTART' WHERE id=?").run(new Date().toISOString(), run.id);
        this.store.db.prepare("UPDATE validation_runs SET status='interrupted',reason='The service stopped before the check completed.',finished_at=? WHERE run_id=? AND status='running'").run(new Date().toISOString(), run.id);
        this.store.db.prepare("UPDATE initialization_runs SET status='interrupted',reason='The service stopped during initialization.',finished_at=? WHERE run_id=? AND status='running'").run(new Date().toISOString(), run.id);
        const task = this.workflow.getTask(run.task_id);
        if (['QUEUED_FOR_BUILD', 'BUILDING', 'VALIDATING', 'CODE_REVIEW', 'REPAIRING'].includes(task.status)) this.workflow.transition(task.id, task.version, 'BLOCKED', 'build.recovery_required', 'The service stopped during implementation or validation. Completion was not assumed; the worktree and logs are preserved.', 'Inspect the current worktree before explicitly resuming. A surviving provider process must stop first.');
        this.store.event('run.interrupted', task.project_id, task.id, { runId: run.id, recovery: 'inspect_worktree' });
      }
    });
    for (const task of this.store.db.prepare("SELECT * FROM tasks WHERE status IN ('BUILDING','VALIDATING','REPAIRING') AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE task_id=tasks.id AND status IN ('queued','starting','running','waiting_permission','stopping'))").all() as Task[]) {
      this.workflow.transition(task.id, task.version, 'BLOCKED', 'build.recovery_required', 'The service stopped between pipeline stages. Completion was not assumed.', 'Inspect the preserved worktree and explicitly revalidate or resume implementation.');
    }
    for (const workspace of this.store.db.prepare('SELECT task_id FROM workspaces').all() as { task_id: string }[]) {
      const task = this.workflow.getTask(workspace.task_id);
      try { this.inspect(task.id); }
      catch {
        this.store.transaction(() => {
          this.store.db.prepare("UPDATE workspaces SET cleanup_status='recovery_required' WHERE task_id=? AND cleanup_status!='creating'").run(task.id);
          if (['CODE_REVIEW','FINAL_REVIEW','ACCEPTED'].includes(this.workflow.getTask(task.id).status)) {
            this.store.db.prepare("UPDATE validation_runs SET status='stale',reason='Worktree verification failed during restart.' WHERE task_id=? AND status='passed'").run(task.id);
            this.workflow.transition(task.id, task.version, 'BLOCKED', 'workspace.recovery_required', 'The saved worktree is missing or its Git metadata changed.', 'Restore or inspect the worktree. The factory will not overwrite or delete it.');
          }
        });
      }
    }
  }
  async idle() { await Promise.all([...this.jobs.values()].map(job => job.done)); }
  async close() { this.closing = true; for (const job of this.jobs.values()) job.controller.abort(); await this.idle(); }
}
