import { z } from 'zod';

export const statuses = ['INBOX', 'PLANNING', 'PLANNING_BLOCKED', 'PLAN_REVIEW', 'QUEUED_FOR_BUILD', 'BUILDING', 'VALIDATING', 'CODE_REVIEW', 'REPAIRING', 'FINAL_REVIEW', 'ACCEPTED', 'MERGED', 'BLOCKED', 'FAILED', 'REJECTED', 'CANCELLED'] as const;
export type TaskStatus = typeof statuses[number];
export const planSchema = z.object({
  summary: z.string().min(1), assumptions: z.array(z.string()), questions: z.array(z.string()),
  steps: z.array(z.string()).min(1), affectedAreas: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()), testStrategy: z.array(z.string()).min(1), risks: z.array(z.string()),
});
export type Plan = z.infer<typeof planSchema>;
export const implementationSchema = z.object({ summary: z.string().min(1).max(20000), limitations: z.array(z.string().max(4000)).max(100) });
export type ImplementationResult = z.infer<typeof implementationSchema>;
export const reviewSchema = z.object({
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/), verdict: z.enum(['pass', 'changes_requested', 'blocked']),
  summary: z.string().min(1).max(20000),
  findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), file: z.string().max(2000), line: z.number().int().positive().nullable(), title: z.string().min(1).max(500), rationale: z.string().min(1).max(4000), suggestedFix: z.string().max(4000) })).max(100),
});
export type ReviewResult = z.infer<typeof reviewSchema>;
export interface Review { id: string; task_id: string; run_id: string; commit_sha: string; verdict: string; findings_json: string; summary: string; status: string; created_at: string }
export interface EvidenceBundle { id: string; task_id: string; commit_sha: string; body_json: string; sha256_digest: string; created_at: string }
export const validationCommandSchema = z.object({ name: z.string().trim().min(1).max(100), argv: z.array(z.string().max(4000)).min(1).max(100), timeoutMs: z.number().int().min(100).max(300000).default(60000) }).refine(value => value.argv[0].trim().length > 0 && value.argv.every(arg => !arg.includes('\0')), 'Commands require a nonempty executable and no NUL bytes');
export const executionConfigSchema = z.object({ executionEnabled: z.boolean(), trustedRepository: z.boolean(), validationCommands: z.array(validationCommandSchema).max(12), implementationTimeoutMs: z.number().int().min(1000).max(1800000).default(900000), maxImplementationAttempts: z.number().int().min(1).max(5).default(2) });
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
const repositoryCommand = (maximum: number) => z.object({
  name: z.string().trim().min(1).max(100), run: z.array(z.string().max(4000)).min(1).max(100),
  timeout_seconds: z.number().min(.1).max(maximum).default(60),
}).strict().refine(command => command.run[0].trim().length > 0 && command.run.every(arg => !arg.includes('\0')), 'Commands require an executable and no NUL bytes');
export const repositoryConfigurationSchema = z.object({
  version: z.literal(1),
  worktree_init: z.object({ network: z.boolean().default(false), commands: z.array(repositoryCommand(1800)).max(12) }).strict(),
  verification: z.object({ commands: z.array(repositoryCommand(300)).max(12) }).strict(),
}).strict().refine(config => [config.worktree_init.commands, config.verification.commands].every(commands => new Set(commands.map(command => command.name)).size === commands.length), 'Command names must be unique within each section');
export type RepositoryConfiguration = z.infer<typeof repositoryConfigurationSchema>;
export const localProjectSettingsSchema = executionConfigSchema.omit({ validationCommands: true }).extend({ initializationNetworkAllowed: z.boolean().default(false) });
export type LocalProjectSettings = z.infer<typeof localProjectSettingsSchema>;
export interface RepositoryConfigurationState { path: string; exists: boolean; digest: string | null; configuration: RepositoryConfiguration | null; committed: boolean; error: string | null; authorized: boolean; local: LocalProjectSettings; legacyVerification: ExecutionConfig['validationCommands'] }
export interface InitializationRun { id: string; task_id: string; workspace_id: string; run_id: string; source_sha: string; file_digest: string; config_digest: string; status: string; log_text: string; reason: string | null; results_json: string; started_at: string; finished_at: string | null }
const version = z.number().int().positive();
const id = z.string().uuid();
const text = z.string().trim().min(1).max(20000);
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('events.list'), afterSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal('project.add'), path: text, name: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal('project.configuration.get'), projectId: id }),
  z.object({ type: z.literal('project.configuration.save'), projectId: id, expectedVersion: version, expectedDigest: z.string().length(64).nullable(), configuration: repositoryConfigurationSchema, local: localProjectSettingsSchema }),
  z.object({ type: z.literal('project.configure'), projectId: id, expectedVersion: version, config: executionConfigSchema }),
  z.object({ type: z.literal('request.create'), projectId: id, title: z.string().trim().min(1).max(200), body: text, kind: z.enum(['feature', 'bug', 'refactor', 'chore']), priority: z.enum(['low', 'normal', 'high']), acceptanceCriteria: z.array(text).max(30) }),
  z.object({ type: z.literal('request.update'), requestId: id, expectedVersion: version, projectId: id, title: z.string().trim().min(1).max(200), body: text, kind: z.enum(['feature', 'bug', 'refactor', 'chore']), priority: z.enum(['low', 'normal', 'high']), acceptanceCriteria: z.array(text).max(30) }),
  z.object({ type: z.literal('request.archive'), requestId: id, expectedVersion: version, archived: z.boolean() }),
  z.object({ type: z.literal('request.startTask'), requestId: id, expectedVersion: version, provider: z.enum(['fake', 'codex']), model: z.string().min(1).max(120).optional() }),
  z.object({ type: z.literal('request.duplicate'), requestId: id, expectedVersion: version }),
  z.object({ type: z.literal('diagnostics.get') }),
  z.object({ type: z.literal('diagnostics.export') }),
  z.object({ type: z.literal('backup.create') }),
  z.object({ type: z.literal('storage.open') }),
  z.object({ type: z.literal('task.createFromRequest'), requestId: id }),
  z.object({ type: z.literal('provider.health'), provider: z.literal('codex') }),
  z.object({ type: z.literal('task.assign'), taskId: id, expectedVersion: version, provider: z.enum(['fake', 'codex']), model: z.string().min(1).max(120).optional() }),
  z.object({ type: z.literal('task.retry'), taskId: id, expectedVersion: version, model: z.string().min(1).max(120).optional() }),
  z.object({ type: z.literal('task.startReview'), taskId: id, expectedVersion: version }),
  z.object({ type: z.literal('task.run'), taskId: id, expectedVersion: version }),
  z.object({ type: z.literal('task.resume'), taskId: id, expectedVersion: version, stage: z.enum(['implement', 'validate', 'review', 'initialize']), expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/), expectedWorkspaceDigest: z.string().length(64) }),
  z.object({ type: z.literal('task.reviewFinal'), taskId: id, expectedVersion: version, bundleId: id, digest: z.string().length(64), expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/), action: z.enum(['accept', 'request_changes', 'reject']), feedback: z.string().max(20000).default('') }),
  z.object({ type: z.literal('delivery.inspect'), taskId: id }),
  z.object({ type: z.literal('delivery.merge'), taskId: id, expectedVersion: version, expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/), expectedDefaultHead: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  z.object({ type: z.literal('delivery.push'), taskId: id, expectedVersion: version, target: z.enum(['task', 'default']), remote: z.string().min(1).max(200), expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  z.object({ type: z.literal('workspace.inspect'), taskId: id }),
  z.object({ type: z.literal('workspace.open'), taskId: id }),
  z.object({ type: z.literal('agents.stopAll'), reason: text }),
  z.object({ type: z.literal('task.answerQuestions'), taskId: id, expectedVersion: version, answers: z.array(z.object({ questionId: id, answer: text })).min(1).max(30) }),
  z.object({ type: z.literal('task.reviewPlan'), taskId: id, expectedVersion: version, revisionId: id, digest: z.string().length(64), action: z.enum(['approve', 'request_changes', 'reject']), feedback: z.string().max(20000).default('') }),
  z.object({ type: z.literal('task.cancel'), taskId: id, expectedVersion: version, reason: text }),
]);
export type Command = z.input<typeof commandSchema>;
export interface Project { id: string; name: string; repo_path: string; default_branch: string; config_json: string; version: number; created_at: string; updated_at: string }
export interface Request { id: string; project_id: string; title: string; body: string; type: string; priority: string; acceptance_criteria_json: string; status: string; version: number; created_at: string; updated_at: string }
export interface RequestRevision { request_id: string; version: number; body_json: string; created_at: string }
export interface Task { id: string; request_id: string; project_id: string; title: string; status: TaskStatus; version: number; provider_policy_json: string; accepted_commit_sha: string | null; current_plan_revision_id: string | null; approved_plan_revision_id: string | null; reason: string | null; recovery_action: string | null; created_at: string; updated_at: string }
export interface PlanRevision { id: string; task_id: string; revision_number: number; body_json: string; body_markdown: string; sha256_digest: string; created_at: string }
export interface DomainEvent { sequence: number; project_id: string | null; task_id: string | null; type: string; payload_json: string; created_at: string }
export interface Approval { id: string; task_id: string; gate: string; action: string; artifact_id: string; artifact_digest: string; feedback: string; actor: string; decided_at: string }
export interface AgentRun { id: string; task_id: string; stage: string; provider: string; model: string | null; status: string; provider_session_ref: string | null; turn_ref: string | null; attempt: number; started_at: string; finished_at: string | null; error_code: string | null; summary: string | null; heartbeat_at?: string | null; recovery_stage?: string | null }
export interface Workspace { id: string; task_id: string; path: string; branch: string; base_sha: string; head_sha: string | null; cleanup_status: string; created_at: string }
export interface WorkspaceDetails extends Workspace { reviewBaseSha: string; currentHead: string; workspaceDigest: string; dirty: boolean; changedFiles: string[]; diff: string; truncated: boolean }
export interface DeliveryDetails { defaultBranch: string; defaultHead: string; taskBranch: string; remotes: string[]; mergeBlocker: string | null }
export interface ValidationRun { id: string; task_id: string; commit_sha: string; name: string; argv_json: string; exit_code: number | null; status: string; log_text: string; reason: string | null; started_at: string; finished_at: string | null }
export interface Question { id: string; task_id: string; plan_revision_id: string; prompt: string; answer: string | null; status: string }
export interface ProviderHealth { id: 'fake' | 'codex'; available: boolean; authenticated: boolean; message: string; version?: string; models?: { model: string; name: string; isDefault: boolean }[] }
export interface Snapshot { projects: Project[]; requests: Request[]; requestRevisions: RequestRevision[]; tasks: Task[]; plans: PlanRevision[]; approvals: Approval[]; events: DomainEvent[]; runs: AgentRun[]; questions: Question[]; reviews: Review[]; evidence: EvidenceBundle[]; workspaces: Workspace[]; validations: ValidationRun[]; initializations: InitializationRun[]; providers: ProviderHealth[]; cursor: number; health: { provider: 'mixed'; mode: string; service: string } }
export type ErrorCode = 'INVALID_TRANSITION' | 'STALE_VERSION' | 'APPROVAL_REQUIRED' | 'STALE_PLAN_REVISION' | 'STALE_EVIDENCE' | 'NOT_FOUND' | 'INVALID_INPUT' | 'PROJECT_INVALID' | 'WORKSPACE_CONFLICT' | 'POLICY_DENIED' | 'CONFLICT' | 'INTERNAL_ERROR';
export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };

export interface Diagnostics {
  formatVersion: 1; generatedAt: string; application: { version: string; packaged: boolean; platform: string; arch: string; node: string; nodeAbi: string; uptimeSeconds: number };
  storage: { schemaVersion: number; integrity: string; databaseBytes: number; walBytes: number; availableBytes: number | null };
  counts: { projects: number; openRequests: number; archivedRequests: number; tasks: Record<string, number>; runs: Record<string, number>; eventCursor: number; staleHeartbeats: number };
  provider: { checked: boolean; available: boolean; authenticated: boolean }; recentErrors: { stage: string; code: string; count: number }[]; notices: string[];
}
export interface StoredExport { path: string; filename: string; bytes: number; sha256: string }
