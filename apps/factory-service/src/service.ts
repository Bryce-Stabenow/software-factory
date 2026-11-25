import { repositoryConfigurationState, writeRepositoryConfiguration, verificationCommands } from './configuration/repository.js';
import { Operations } from './operations/diagnostics.js';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { ZodError } from 'zod';
import { taskPolicySchema, defaultAgentSettings, agentDefaultsSchema, resolveAgentDefaults, commandSchema, executionConfigSchema, repositoryConfigurationSchema, localProjectSettingsSchema, type Command, type Project, type Request, type Response } from '../../../packages/contracts/src/index.js';
import { Store } from './persistence/store.js';
import { digest, FactoryError, fail, Workflow } from './workflows/engine.js';
import { FakeAgent } from './agents/fake.js';
import { PlanningJobs } from './agents/planning-jobs.js';
import type { ReviewAdapter, ImplementationAdapter, PlannerAdapter } from './agents/codex.js';
import type { ProviderHealth, Question } from '../../../packages/contracts/src/index.js';
import { resolve } from 'node:path';
import { BuildJobs, executionConfig } from './agents/build-jobs.js';
import { defaultWorkspaceRoot, WorkspaceManager } from './git/workspaces.js';
import { Delivery } from './git/delivery.js';
import { RunPool } from './scheduler/run-pool.js';
import type { ValidationAdapter } from './checks/validation.js';
import { childEnvironment, CodexError } from './agents/rpc.js';

export class FactoryService {
  readonly workflow: Workflow;
  readonly adapter = new FakeAgent();
  readonly planning: PlanningJobs;
  readonly builds: BuildJobs;
  readonly operations: Operations;
  readonly delivery: Delivery;
  private codexHealth: ProviderHealth = { id: 'codex', available: false, authenticated: false, message: 'Not checked. Check the local Codex CLI connection in Settings.' };
  constructor(readonly store: Store, options: { planner?: PlannerAdapter; implementer?: ImplementationAdapter; validator?: ValidationAdapter; reviewer?: ReviewAdapter; dataDir?: string; workspaceRoot?: string } = {}) {
    this.workflow = new Workflow(store);
    const dataDir = options.dataDir ?? resolve('.factory/service'), pool = new RunPool();
    this.operations = new Operations(store, dataDir);
    this.planning = new PlanningJobs(store, this.workflow, dataDir, options.planner, pool);
    this.builds = new BuildJobs(store, this.workflow, new WorkspaceManager(store, options.workspaceRoot ?? defaultWorkspaceRoot(dataDir)), dataDir, pool, options.implementer, options.validator, options.reviewer);
    this.delivery = new Delivery(store, this.workflow, this.builds.workspaces);
    this.workflow.verifyMerged = task => this.delivery.verifyMerged(task);
    this.workflow.verifyFinalEvidence = task => this.builds.evidence.verify(task);
  }
  async handle(input: unknown): Promise<Response> {
    const command = commandSchema.safeParse(input);
    if (command.success && command.data.type === 'delivery.push') {
      try { return { ok: true, data: await this.delivery.push(command.data) }; }
      catch (error) { return { ok: false, error: { code: error instanceof FactoryError ? error.code : 'INTERNAL_ERROR', message: error instanceof FactoryError ? error.message : 'Push failed. Check remote access and Git authentication, then retry.' } }; }
    }
    if (command.success && command.data.type === 'backup.create') {
      try { return { ok: true, data: await this.operations.backup() }; }
      catch { return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The database backup could not be completed. Check available storage.' } }; }
    }
    if (command.success && command.data.type === 'storage.open') {
      try {
        if (process.platform !== 'darwin') fail('POLICY_DENIED', 'Open data folder currently supports macOS.');
        await new Promise<void>((resolve, reject) => execFile('open', [this.operations.dataDir], { env: childEnvironment(), timeout: 5000 }, error => error ? reject(error) : resolve()));
        return { ok: true, data: { opened: true } };
      } catch { return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The data folder could not be opened.' } }; }
    }
    if (command.success && command.data.type === 'provider.health') {
      this.codexHealth = { id: 'codex', ...await this.planning.planner.health() };
      return { ok: true, data: this.codexHealth };
    }
    if (command.success && command.data.type === 'workspace.open') {
      try {
        if (process.platform !== 'darwin') fail('POLICY_DENIED', 'Open worktree currently supports macOS. Copy the workspace path instead.');
        const workspace = this.builds.inspect(command.data.taskId);
        await new Promise<void>((resolve, reject) => execFile('open', [workspace.path], { env: childEnvironment(), timeout: 5000 }, error => error ? reject(error) : resolve()));
        return { ok: true, data: { opened: true } };
      } catch (error) { return { ok: false, error: { code: error instanceof FactoryError ? error.code : 'INTERNAL_ERROR', message: error instanceof FactoryError ? error.message : 'The worktree could not be opened.' } }; }
    }
    return this.dispatch(input);
  }

  dispatch(input: unknown): Response {
    try { return { ok: true, data: this.execute(commandSchema.parse(input)) }; }
    catch (error) {
      if (error instanceof FactoryError) return { ok: false, error: { code: error.code, message: error.message } };
      if (error instanceof CodexError) return { ok: false, error: { code: error.code === 'POLICY_DENIED' ? 'POLICY_DENIED' : error.code === 'CONFLICT' ? 'CONFLICT' : 'INTERNAL_ERROR', message: error.message } };
      if (error instanceof ZodError) return { ok: false, error: { code: 'INVALID_INPUT', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') } };
      // Never send raw process output, paths, credentials, or SQLite errors to clients.
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The command could not be completed. No workflow change was committed.' } };
    }
  }

  private execute(command: Command): unknown {
    const now = new Date().toISOString();
    switch (command.type) {
      case 'diagnostics.get': return this.operations.diagnostics(this.codexHealth);
      case 'diagnostics.export': return this.operations.exportDiagnostics(this.codexHealth);
      case 'backup.create': case 'storage.open': fail('INVALID_INPUT', 'This operation requires the asynchronous command handler.');
      case 'snapshot': return this.store.transaction(() => ({ ...this.store.snapshot(), providers: [{ id: 'fake', available: true, authenticated: true, message: 'Deterministic simulation; no model calls.' }, this.codexHealth] }));
      case 'provider.health': fail('INVALID_INPUT', 'Provider checks require the asynchronous command handler.');
      case 'workspace.open': fail('INVALID_INPUT', 'Opening a worktree requires the asynchronous command handler.');
      case 'delivery.inspect': return this.delivery.inspect(command.taskId);
      case 'delivery.merge': return this.delivery.merge(command);
      case 'delivery.push': fail('INVALID_INPUT', 'Pushing requires the asynchronous command handler.');
      case 'workspace.inspect': return this.builds.inspect(command.taskId);
      case 'project.configuration.get': {
        const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(command.projectId) as Project | undefined;
        if (!project) fail('NOT_FOUND', 'Project not found.');
        return repositoryConfigurationState(project);
      }
      case 'project.configuration.save': {
        let written: ReturnType<typeof writeRepositoryConfiguration> | undefined;
        try {
          return this.store.transaction(() => {
            const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(command.projectId) as Project | undefined;
            if (!project) fail('NOT_FOUND', 'Project not found.');
            if (project.version !== command.expectedVersion) fail('STALE_VERSION', 'The project settings changed. Reload before saving.');
            if (this.store.db.prepare("SELECT r.id FROM agent_runs r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND r.status IN ('queued','starting','running','waiting_permission','stopping')").get(project.id)) fail('CONFLICT', 'Stop active or queued runs before changing project settings.');
            const configuration = repositoryConfigurationSchema.parse(command.configuration), local = localProjectSettingsSchema.parse(command.local);
            if (local.executionEnabled && (!local.trustedRepository || !configuration.verification.commands.length)) fail('POLICY_DENIED', 'Trust the repository and configure verification before enabling implementation.');
            const stored = JSON.parse(project.config_json), configDigest = digest(configuration);
            written = writeRepositoryConfiguration(project.repo_path, command.expectedDigest, configuration);
            if (stored.repositoryConfigDigest !== configDigest) {
              this.store.db.prepare("UPDATE validation_runs SET status='stale',reason='Repository configuration changed.' WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND status='passed'").run(project.id);
              for (const task of this.store.db.prepare("SELECT * FROM tasks WHERE project_id=? AND status IN ('CODE_REVIEW','FINAL_REVIEW','ACCEPTED')").all(project.id) as import('../../../packages/contracts/src/index.js').Task[]) this.builds.invalidate(task, 'Repository configuration changed; initialize, revalidate and review again.');
            }
            this.store.db.prepare('UPDATE projects SET config_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({ ...stored, ...local, validationCommands: verificationCommands(configuration), repositoryConfigDigest: configDigest }), now, project.id);
            this.store.event('project.configured', project.id, null, { version: project.version + 1, repositoryConfigDigest: configDigest });
            return { id: project.id, digest: written.digest };
          });
        } catch (error) { if (written) written.rollback(); throw error; }
      }
      case 'project.configure': return this.store.transaction(() => {
        const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(command.projectId) as Project | undefined;
        if (!project) fail('NOT_FOUND', 'Project not found.');
        if (project.version !== command.expectedVersion) fail('STALE_VERSION', 'The project settings changed. Refresh before saving.');
        if (this.store.db.prepare("SELECT r.id FROM agent_runs r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND r.status IN ('queued','starting','running','waiting_permission','stopping')").get(project.id)) fail('CONFLICT', 'Stop the project’s active or queued runs before changing execution settings.');
        if (repositoryConfigurationState(project).exists || JSON.parse(project.config_json).repositoryConfigDigest) fail('POLICY_DENIED', 'Use repository-backed project settings to update .kulumin.yml.');
        const config = executionConfigSchema.parse(command.config);
        if (config.executionEnabled && !config.trustedRepository) fail('POLICY_DENIED', 'Execution must remain disabled for untrusted repositories.');
        if (new Set(config.validationCommands.map(check => check.name)).size !== config.validationCommands.length) fail('INVALID_INPUT', 'Validation command names must be unique.');
        if (digest(executionConfig(project).validationCommands) !== digest(config.validationCommands)) {
          this.store.db.prepare("UPDATE validation_runs SET status='stale',reason='Project validation configuration changed.' WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND status='passed'").run(project.id);
          const reviewed = this.store.db.prepare("SELECT * FROM tasks WHERE project_id=? AND status IN ('CODE_REVIEW','FINAL_REVIEW','ACCEPTED')").all(project.id) as import('../../../packages/contracts/src/index.js').Task[];
          for (const task of reviewed) this.builds.invalidate(task, 'Required validation commands changed after the previous checks passed.');
        }
        this.store.db.prepare('UPDATE projects SET config_json=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(JSON.stringify({ ...JSON.parse(project.config_json), ...config }), now, project.id, project.version);
        this.store.event('project.configured', project.id, null, { executionEnabled: config.executionEnabled, validationCommands: config.validationCommands.map(check => check.name), version: project.version + 1 });
        return { id: project.id };
      });
      case 'events.list': return this.store.events(command.afterSequence);
      case 'project.add': {
        let root: string, branch: string, dirty: boolean;
        try {
          const path = realpathSync(command.path);
          const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          root = realpathSync(git('rev-parse', '--show-toplevel'));
          if (git('rev-parse', '--is-bare-repository') !== 'false') fail('PROJECT_INVALID', 'Bare repositories are not supported.');
          git('worktree', 'list', '--porcelain');
          try { branch = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, ''); }
          catch {
            branch = git('symbolic-ref', '--short', 'HEAD');
            for (const candidate of ['main', 'master']) {
              try { git('show-ref', '--verify', `refs/heads/${candidate}`); branch = candidate; break; }
              catch { /* With no conventional default, keep the attached branch. */ }
            }
          }
          dirty = git('status', '--porcelain').length > 0;
        } catch { fail('PROJECT_INVALID', 'Choose a local non-bare Git repository with an attached branch and available Git tooling.'); }
        return this.store.transaction(() => {
          if (this.store.db.prepare('SELECT id FROM projects WHERE repo_path=?').get(root)) fail('CONFLICT', 'This repository is already registered.');
          const id = randomUUID();
          this.store.db.prepare('INSERT INTO projects(id,name,repo_path,default_branch,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, command.name, root, branch, JSON.stringify({ ...defaultAgentSettings, executionEnabled: false, trustedRepository: false, validationCommands: [], dirtyAtRegistration: dirty }), now, now);
          this.store.event('project.created', id, null, { name: command.name, dirty });
          return { id };
        });
      }
      case 'request.create': return this.store.transaction(() => {
        if (!this.store.db.prepare('SELECT id FROM projects WHERE id=?').get(command.projectId)) fail('NOT_FOUND', 'Project not found.');
        const id = randomUUID();
        this.store.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, command.projectId, command.title, command.body, command.kind, command.priority, JSON.stringify(command.acceptanceCriteria), 'open', 1, now, now);
        this.store.recordRequest(id);
        this.store.event('request.created', command.projectId, null, { requestId: id });
        return { id };
      });
      case 'request.update': return this.store.transaction(() => {
        const request = this.getRequest(command.requestId, command.expectedVersion);
        if (request.status === 'archived') fail('INVALID_TRANSITION', 'Restore the request before editing it.');
        if (!this.store.db.prepare('SELECT id FROM projects WHERE id=?').get(command.projectId)) fail('NOT_FOUND', 'Project not found.');
        this.store.db.prepare('UPDATE requests SET project_id=?,title=?,body=?,type=?,priority=?,acceptance_criteria_json=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(command.projectId, command.title, command.body, command.kind, command.priority, JSON.stringify(command.acceptanceCriteria), now, request.id, request.version);
        this.store.recordRequest(request.id);
        this.store.event('request.updated', command.projectId, null, { requestId: request.id, version: request.version + 1, existingTasksPreserved: true });
        return this.getRequest(request.id);
      });
      case 'request.archive': return this.store.transaction(() => {
        const request = this.getRequest(command.requestId, command.expectedVersion), status = command.archived ? 'archived' : 'open';
        if (request.status === status) fail('CONFLICT', 'The request already has that archive status.');
        this.store.db.prepare('UPDATE requests SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, now, request.id, request.version);
        this.store.recordRequest(request.id);
        this.store.event(command.archived ? 'request.archived' : 'request.restored', request.project_id, null, { requestId: request.id, version: request.version + 1 });
        return this.getRequest(request.id);
      });
      case 'request.duplicate': return this.store.transaction(() => {
        const request = this.getRequest(command.requestId, command.expectedVersion);
        return this.execute({ type: 'request.create', projectId: request.project_id, title: request.title, body: request.body, kind: request.type as 'feature', priority: request.priority as 'normal', acceptanceCriteria: JSON.parse(request.acceptance_criteria_json) });
      });
      case 'request.startTask': return this.store.transaction(() => {
        const request = this.getRequest(command.requestId, command.expectedVersion);
        if (request.status === 'archived') fail('INVALID_TRANSITION', 'Restore the request before starting a task.');
        let task = this.store.db.prepare('SELECT * FROM tasks WHERE request_id=?').get(request.id) as import('../../../packages/contracts/src/index.js').Task | undefined;
        if (task && task.status !== 'INBOX') fail('CONFLICT', 'This request already has a started task. Open its issue to follow progress or retry.');
        task ??= this.execute({ type: 'task.createFromRequest', requestId: request.id }) as import('../../../packages/contracts/src/index.js').Task;
        return this.execute({ type: 'task.assign', taskId: task.id, expectedVersion: task.version, provider: command.provider, planningModel: command.planningModel, implementationModel: command.implementationModel, reviewModel: command.reviewModel });
      });
      case 'task.createFromRequest': return this.store.transaction(() => {
        const request = this.store.db.prepare('SELECT * FROM requests WHERE id=?').get(command.requestId) as Request | undefined;
        if (!request) fail('NOT_FOUND', 'Request not found.');
        if (request.status === 'archived') fail('INVALID_TRANSITION', 'Restore the archived request before creating a task.');
        if (this.store.db.prepare('SELECT id FROM tasks WHERE request_id=?').get(request.id)) fail('CONFLICT', 'This request already has a task.');
        const id = randomUUID();
        this.store.db.prepare("INSERT INTO tasks (id,request_id,project_id,title,status,provider_policy_json,created_at,updated_at) VALUES (?,?,?,?,'INBOX',?,?,?)").run(id, request.id, request.project_id, request.title, JSON.stringify({ ...defaultAgentSettings, requestVersion: request.version }), now, now);
        this.store.event('task.created', request.project_id, id, { requestId: request.id, requestVersion: request.version });
        return this.workflow.getTask(id);
      });
      case 'task.assign': return this.store.transaction(() => {
        const task = this.workflow.getTask(command.taskId);
        const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project;
        const policy = resolveAgentDefaults(agentDefaultsSchema.parse(JSON.parse(project.config_json)), command);
        this.workflow.transition(command.taskId, command.expectedVersion, 'PLANNING', 'task.assigned');
        this.store.db.prepare('UPDATE tasks SET provider_policy_json=? WHERE id=?').run(JSON.stringify(taskPolicySchema.parse({ ...JSON.parse(task.provider_policy_json), ...policy })), task.id);
        return policy.provider === 'codex' ? this.planning.enqueue(task.id) : this.plan(task.id);
      });
      case 'task.reviewPlan': return this.store.transaction(() => {
        const task = this.workflow.reviewPlan(command.taskId, command.expectedVersion, command.revisionId, command.digest, command.action, command.feedback ?? '');
        if (command.action === 'request_changes') return JSON.parse(task.provider_policy_json).provider === 'codex' ? this.planning.enqueue(task.id) : this.plan(task.id);
        const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as Project;
        if (command.action === 'approve' && JSON.parse(task.provider_policy_json).provider === 'codex' && executionConfig(project).executionEnabled) return this.builds.enqueue(task.id, task.version);
        return task;
      });
      case 'task.reviewFinal': {
        let task = this.workflow.getTask(command.taskId, command.expectedVersion);
        if (task.status !== 'FINAL_REVIEW') fail('INVALID_TRANSITION', 'This task is not awaiting final human review.');
        // Inspect outside the decision transaction so invalidation survives a rejected stale command.
        this.builds.inspect(task.id);
        task = this.workflow.getTask(task.id, command.expectedVersion);
        return this.store.transaction(() => {
          this.workflow.assertApproved(task);
          const evidence = this.builds.evidence.verify(task);
          if (evidence.id !== command.bundleId || evidence.sha256_digest !== command.digest || evidence.commit_sha !== command.expectedHead) fail('STALE_EVIDENCE', 'The displayed final evidence or commit does not match. Refresh before deciding.');
          if (this.store.db.prepare("SELECT id FROM agent_runs WHERE task_id=? AND status IN ('queued','starting','running','waiting_permission','stopping')").get(task.id)) fail('CONFLICT', 'Wait for the current worker to stop before deciding.');
          if (command.action !== 'accept' && !command.feedback?.trim()) fail('INVALID_INPUT', 'Explain the requested changes or rejection.');
          this.store.db.prepare('INSERT INTO approvals(id,task_id,gate,action,artifact_id,artifact_digest,commit_sha,feedback,actor,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), task.id, 'final', command.action, evidence.id, evidence.sha256_digest, evidence.commit_sha, command.feedback ?? '', 'local-human', now);
          if (command.action === 'request_changes') return this.builds.enqueue(task.id, task.version, 'repair');
          const result = this.workflow.transition(task.id, task.version, command.action === 'accept' ? 'ACCEPTED' : 'REJECTED', 'final.' + command.action, command.action === 'reject' ? command.feedback : undefined, command.action === 'reject' ? 'The worktree is preserved. Create a revised request if needed.' : undefined);
          if (command.action === 'accept') this.store.db.prepare('UPDATE tasks SET accepted_commit_sha=? WHERE id=?').run(evidence.commit_sha, task.id);
          return this.workflow.getTask(result.id);
        });
      }
      case 'task.startReview': return this.builds.enqueue(command.taskId, command.expectedVersion, 'review');
      case 'task.run': return this.builds.enqueue(command.taskId, command.expectedVersion);
      case 'task.resume': return this.builds.enqueue(command.taskId, command.expectedVersion, command.stage, command);
      case 'task.retry': return this.store.transaction(() => {
        const task = this.workflow.getTask(command.taskId, command.expectedVersion);
        if (this.store.db.prepare("SELECT id FROM agent_runs WHERE task_id=? AND stage IN ('implement','validate','review','repair') LIMIT 1").get(task.id)) fail('INVALID_TRANSITION', 'Use worktree recovery for implementation tasks; planning retry cannot discard an implementation workspace.');
        if (!['FAILED', 'BLOCKED'].includes(task.status)) fail('INVALID_TRANSITION', 'Only failed or blocked planning can be retried.');
        const previous = this.store.db.prepare('SELECT process_pid FROM agent_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(task.id) as { process_pid: number | null } | undefined;
        if (previous?.process_pid) {
          try { process.kill(previous.process_pid, 0); fail('CONFLICT', 'A previous provider process may still be alive. Stop it before retrying.'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        this.workflow.transition(task.id, task.version, 'PLANNING', 'task.retried');
        if (command.planningModel !== undefined) this.store.db.prepare('UPDATE tasks SET provider_policy_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(task.provider_policy_json), planningModel: command.planningModel }), task.id);
        return JSON.parse(task.provider_policy_json).provider === 'codex' ? this.planning.enqueue(task.id) : this.plan(task.id);
      });
      case 'task.answerQuestions': return this.store.transaction(() => {
        const task = this.workflow.getTask(command.taskId, command.expectedVersion);
        if (task.status !== 'PLANNING_BLOCKED') fail('INVALID_TRANSITION', 'This task is not awaiting clarification.');
        const questions = this.store.db.prepare("SELECT * FROM questions WHERE task_id=? AND plan_revision_id=? AND status='open'").all(task.id, task.current_plan_revision_id) as Question[];
        if (command.answers.length !== questions.length || new Set(command.answers.map(answer => answer.questionId)).size !== questions.length || command.answers.some(answer => !questions.some(question => question.id === answer.questionId))) fail('INVALID_INPUT', 'Answer every open question from the current plan revision exactly once.');
        for (const answer of command.answers) this.store.db.prepare("UPDATE questions SET answer=?,status='answered',answered_at=? WHERE id=?").run(answer.answer, now, answer.questionId);
        this.store.event('questions.answered', task.project_id, task.id, { revisionId: task.current_plan_revision_id });
        this.workflow.transition(task.id, task.version, 'PLANNING', 'task.planning_resumed');
        return JSON.parse(task.provider_policy_json).provider === 'codex' ? this.planning.enqueue(task.id) : this.plan(task.id);
      });
      case 'task.cancel': {
        const hasBuild = !!this.store.db.prepare("SELECT id FROM agent_runs WHERE task_id=? AND stage IN ('implement','validate','review','repair') LIMIT 1").get(command.taskId);
        const task = this.workflow.transition(command.taskId, command.expectedVersion, 'CANCELLED', 'task.cancelled', command.reason, hasBuild ? 'Inspect the preserved worktree, then explicitly resume implementation or validation.' : 'Create a new task from a revised request.');
        this.planning.stop(task.id);
        this.builds.stop(task.id);
        return task;
      }
      case 'agents.stopAll': return this.store.transaction(() => {
        const tasks = this.store.db.prepare("SELECT DISTINCT t.* FROM tasks t JOIN agent_runs r ON r.task_id=t.id WHERE r.status IN ('queued','starting','running','waiting_permission','stopping') AND t.status NOT IN ('CANCELLED','REJECTED','ACCEPTED','MERGED')").all() as import('../../../packages/contracts/src/index.js').Task[];
        for (const task of tasks) this.execute({ type: 'task.cancel', taskId: task.id, expectedVersion: task.version, reason: command.reason });
        return { stopped: tasks.length };
      });
    }
  }

  private getRequest(id: string, expectedVersion?: number): Request {
    const request = this.store.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as Request | undefined;
    if (!request) fail('NOT_FOUND', 'Request not found.');
    if (expectedVersion !== undefined && request.version !== expectedVersion) fail('STALE_VERSION', 'The request changed. Refresh before saving.');
    return request;
  }
  private plan(taskId: string) {
    const task = this.workflow.getTask(taskId);
    const request = this.store.requestForTask(task);
    const runId = randomUUID();
    const attempt = this.store.db.prepare('SELECT COUNT(*)+1 AS n FROM agent_runs WHERE task_id=?').get(taskId) as { n: number };
    this.store.db.prepare("INSERT INTO agent_runs (id,task_id,stage,provider,status,attempt,started_at) VALUES (?,?,'plan','fake','running',?,?)").run(runId, taskId, attempt.n, new Date().toISOString());
    this.store.event('run.started', task.project_id, taskId, { runId, stage: 'plan', provider: 'fake', simulation: true });
    const feedback = this.store.db.prepare("SELECT feedback FROM approvals WHERE task_id=? AND action='request_changes' ORDER BY decided_at").all(taskId) as { feedback: string }[];
    const result = this.workflow.propose(taskId, task.version, this.adapter.plan(request, feedback.map(row => row.feedback)), runId);
    this.store.db.prepare("UPDATE agent_runs SET status='succeeded', finished_at=?, exit_code=0, summary='Simulated plan generated; no repository inspected.' WHERE id=?").run(new Date().toISOString(), runId);
    this.store.event('run.completed', task.project_id, taskId, { runId, status: 'succeeded' });
    return result;
  }

  recover() {
    this.builds.recover();
    // The runtime lock gives one service owner. Never resume/spawn a recovered run automatically.
    this.store.transaction(() => {
      const runs = this.store.db.prepare("SELECT id,task_id FROM agent_runs WHERE stage='plan' AND status IN ('queued','starting','running','waiting_permission','stopping')").all() as { id: string; task_id: string }[];
      for (const run of runs) {
        this.store.db.prepare("UPDATE agent_runs SET status='interrupted', finished_at=?, error_code='SERVICE_RESTART', summary='Interrupted; completion was not assumed.' WHERE id=?").run(new Date().toISOString(), run.id);
        const task = this.workflow.getTask(run.task_id);
        if (task.status === 'PLANNING') this.workflow.transition(task.id, task.version, 'FAILED', 'task.interrupted', 'Planning was interrupted by service shutdown; completion was not assumed.', 'Use Retry planning after checking that the previous provider process has stopped.');
        this.store.event('run.interrupted', task.project_id, task.id, { runId: run.id });
      }
    });
  }
}
