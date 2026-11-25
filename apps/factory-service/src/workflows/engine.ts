import { resolveExecutionConfiguration, verificationDigest } from '../configuration/repository.js';
import { createHash, randomUUID } from 'node:crypto';
import type { EvidenceBundle, ErrorCode, Task, TaskStatus } from '../../../../packages/contracts/src/index.js';
import { planSchema } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';

export class FactoryError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}
export function fail(code: ErrorCode, message: string): never { throw new FactoryError(code, message); }
export function digest(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return '[' + input.map(canonical).join(',') + ']';
    if (input !== null && typeof input === 'object') return '{' + Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}';
    return JSON.stringify(input);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  INBOX: ['PLANNING'], PLANNING: ['PLANNING_BLOCKED', 'PLAN_REVIEW', 'FAILED', 'BLOCKED'],
  PLANNING_BLOCKED: ['PLANNING'], PLAN_REVIEW: ['PLANNING', 'REJECTED', 'QUEUED_FOR_BUILD'],
  QUEUED_FOR_BUILD: ['BUILDING', 'BLOCKED'], BUILDING: ['BLOCKED', 'VALIDATING', 'FAILED'],
  VALIDATING: ['REPAIRING', 'CODE_REVIEW', 'BLOCKED', 'FAILED'], CODE_REVIEW: ['VALIDATING', 'REPAIRING', 'FINAL_REVIEW', 'BLOCKED'],
  REPAIRING: ['VALIDATING', 'BLOCKED'], FINAL_REVIEW: ['REPAIRING', 'PLANNING', 'REJECTED', 'ACCEPTED', 'BLOCKED'],
  ACCEPTED: ['MERGED', 'BLOCKED'], MERGED: [], BLOCKED: ['PLANNING', 'QUEUED_FOR_BUILD'], FAILED: ['PLANNING', 'QUEUED_FOR_BUILD'], REJECTED: [], CANCELLED: ['QUEUED_FOR_BUILD'],
};
export function assertTransition(from: TaskStatus, to: TaskStatus) {
  const cancellable = !['ACCEPTED', 'MERGED', 'REJECTED', 'CANCELLED'].includes(from);
  if (!(to === 'CANCELLED' && cancellable) && !transitions[from].includes(to)) fail('INVALID_TRANSITION', `Cannot move ${from} to ${to}`);
}

export class Workflow {
  verifyMerged?: (task: Task) => void;
  verifyFinalEvidence?: (task: Task) => EvidenceBundle;
  constructor(private store: Store) {}
  getTask(id: string, expectedVersion?: number): Task {
    const task = this.store.task(id) ?? fail('NOT_FOUND', 'Task not found');
    if (expectedVersion !== undefined && task.version !== expectedVersion) fail('STALE_VERSION', 'Task changed. Refresh before trying again.');
    return task;
  }
  assertApproved(task: Task) {
    if (!task.current_plan_revision_id || task.current_plan_revision_id !== task.approved_plan_revision_id) fail('APPROVAL_REQUIRED', 'The current plan requires human approval.');
    const plan = this.store.plan(task.current_plan_revision_id) ?? fail('APPROVAL_REQUIRED', 'Approved plan is missing.');
    if (digest(JSON.parse(plan.body_json)) !== plan.sha256_digest) fail('STALE_PLAN_REVISION', 'Plan digest changed.');
    const approval = this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND gate='plan' AND action='approve' AND artifact_id=? AND artifact_digest=? AND actor='local-human'").get(task.id, plan.id, plan.sha256_digest);
    if (!approval) fail('APPROVAL_REQUIRED', 'No durable human approval exists for this plan.');
  }
  // Internal service operation. The renderer has no arbitrary transition command.
  transition(id: string, expectedVersion: number, next: TaskStatus, event: string, reason?: string, recovery?: string) {
    return this.store.transaction(() => {
      const task = this.getTask(id, expectedVersion);
      assertTransition(task.status, next);
      if (['QUEUED_FOR_BUILD','BUILDING','REPAIRING','FINAL_REVIEW','ACCEPTED'].includes(next)) this.assertApproved(task);
      if (next === 'CODE_REVIEW') {
        const workspace = this.store.db.prepare('SELECT head_sha,path FROM workspaces WHERE task_id=?').get(id) as { head_sha: string | null; path: string } | undefined;
        const project = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) as import('../../../../packages/contracts/src/index.js').Project;
        const config = resolveExecutionConfiguration(project, workspace?.path);
        const commands = config.validationCommands ?? [];
        const checks = this.store.db.prepare("SELECT name,config_digest FROM validation_runs WHERE task_id=? AND commit_sha=? AND status='passed'").all(id, workspace?.head_sha ?? '') as { name: string; config_digest: string }[];
        if (!workspace?.head_sha || !commands.length || !commands.every((command: { name: string }) => checks.some(check => check.name === command.name && check.config_digest === verificationDigest(config)))) fail('STALE_EVIDENCE', 'Current-commit validation evidence is required before code review.');
      }
      if (next === 'FINAL_REVIEW' || next === 'ACCEPTED') {
        const evidence = this.verifyFinalEvidence?.(task) ?? fail('STALE_EVIDENCE', 'Verified current-commit evidence is required.');
        if (next === 'ACCEPTED' && !this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND gate='final' AND action='accept' AND artifact_id=? AND artifact_digest=? AND commit_sha=? AND actor='local-human'").get(task.id, evidence.id, evidence.sha256_digest, evidence.commit_sha)) fail('APPROVAL_REQUIRED', 'A durable human acceptance of this exact evidence and commit is required.');
      }
      if (next === 'MERGED') {
        if (!this.verifyMerged) fail('POLICY_DENIED', 'Merging requires a separately authorized delivery operation.');
        this.verifyMerged(task);
      }
      if (['FAILED', 'BLOCKED', 'REJECTED', 'CANCELLED'].includes(next) && (!reason?.trim() || !recovery?.trim())) fail('INVALID_INPUT', 'A visible reason and recovery action are required.');
      const result = this.store.db.prepare('UPDATE tasks SET status=?, version=version+1, reason=?, recovery_action=?, updated_at=? WHERE id=? AND version=?').run(next, reason ?? null, recovery ?? null, new Date().toISOString(), id, expectedVersion);
      if (result.changes !== 1) fail('STALE_VERSION', 'Task changed.');
      if (next === 'PLANNING') this.store.db.prepare('UPDATE tasks SET approved_plan_revision_id=NULL WHERE id=?').run(id);
      this.store.event(event, task.project_id, id, { from: task.status, to: next, version: expectedVersion + 1, reason, recovery });
      return this.getTask(id);
    });
  }
  propose(id: string, expectedVersion: number, input: unknown, runId: string) {
    const plan = planSchema.parse(input);
    return this.store.transaction(() => {
      const task = this.getTask(id, expectedVersion);
      if (task.status !== 'PLANNING') fail('INVALID_TRANSITION', 'Only a planning task can receive a proposal.');
      const revisionId = randomUUID();
      const count = this.store.db.prepare('SELECT COALESCE(MAX(revision_number),0)+1 AS n FROM plan_revisions WHERE task_id=?').get(id) as { n: number };
      const markdown = `# ${plan.summary}\n\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
      this.store.db.prepare('INSERT INTO plan_revisions VALUES (?,?,?,?,?,?,?,?)').run(revisionId, id, count.n, JSON.stringify(plan), markdown, digest(plan), runId, new Date().toISOString());
      this.store.db.prepare('UPDATE tasks SET current_plan_revision_id=?, approved_plan_revision_id=NULL WHERE id=?').run(revisionId, id);
      for (const prompt of plan.questions) this.store.db.prepare("INSERT INTO questions(id,task_id,plan_revision_id,prompt,status,created_at) VALUES (?,?,?,?,'open',?)").run(randomUUID(), id, revisionId, prompt, new Date().toISOString());
      return this.transition(id, expectedVersion, plan.questions.length ? 'PLANNING_BLOCKED' : 'PLAN_REVIEW', plan.questions.length ? 'question.opened' : 'plan.proposed');
    });
  }
  reviewPlan(id: string, version: number, revisionId: string, expectedDigest: string, action: 'approve' | 'request_changes' | 'reject', feedback: string) {
    return this.store.transaction(() => {
      const task = this.getTask(id, version);
      if (task.status !== 'PLAN_REVIEW') fail('INVALID_TRANSITION', 'Task is not awaiting plan review.');
      if (revisionId !== task.current_plan_revision_id) fail('STALE_PLAN_REVISION', 'Only the current plan can be reviewed.');
      const plan = this.store.plan(revisionId) ?? fail('NOT_FOUND', 'Plan not found');
      if (plan.sha256_digest !== expectedDigest || digest(JSON.parse(plan.body_json)) !== expectedDigest) fail('STALE_PLAN_REVISION', 'Plan digest does not match the displayed artifact.');
      if (action !== 'approve' && !feedback.trim()) fail('INVALID_INPUT', 'Please explain the requested changes or rejection.');
      this.store.db.prepare('INSERT INTO approvals (id,task_id,gate,action,artifact_id,artifact_digest,feedback,actor,decided_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, 'plan', action, revisionId, expectedDigest, feedback, 'local-human', new Date().toISOString());
      this.store.db.prepare('UPDATE tasks SET approved_plan_revision_id=? WHERE id=?').run(action === 'approve' ? revisionId : null, id);
      return this.transition(id, version, action === 'approve' ? 'QUEUED_FOR_BUILD' : action === 'reject' ? 'REJECTED' : 'PLANNING', `plan.${action}`, action === 'reject' ? feedback : undefined, action === 'reject' ? 'Create a revised request to try again.' : undefined);
    });
  }
}
