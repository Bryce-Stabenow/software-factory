import type { AgentRun, DomainEvent, ReviewResult, Task, ValidationRun } from './index.js';

export const failureLabels = {
  code_defect: 'Code or test failure', environment: 'Environment or setup', timeout: 'Time limit exceeded',
  provider: 'Agent provider failure', policy: 'Permission or configuration', evidence: 'Stale or incomplete evidence',
  review_blocked: 'Review could not establish correctness', repair_limit: 'Repair attempts exhausted',
  interrupted: 'Work interrupted', unknown: 'Unclassified failure',
} as const;
export type FailureCategory = keyof typeof failureLabels;
export interface FailureClassification { category: FailureCategory; label: string; recovery: string }
const recovery: Record<FailureCategory, string> = {
  code_defect: 'Inspect the failed check or finding, then resume implementation.',
  environment: 'Fix worktree dependencies, toolchain, or sandbox compatibility, then revalidate.',
  timeout: 'Inspect progress and the command time limit before retrying validation.',
  provider: 'Check the agent connection and authentication, then retry the interrupted stage.',
  policy: 'Review project configuration and permissions before retrying.',
  evidence: 'Inspect the current worktree, then capture fresh checks and review evidence.',
  review_blocked: 'Inspect the review findings and missing evidence before retrying review.',
  repair_limit: 'Inspect the remaining defects. Accept with an override or start a revised task.',
  interrupted: 'Wait for the worker to stop, inspect preserved work, then resume.',
  unknown: 'Inspect the captured logs and preserved worktree before choosing recovery.',
};
export function classifyFailure(code: string | null | undefined, message = '', log = ''): FailureClassification {
  const detail = `${message}\n${log}`;
  let category: FailureCategory = 'unknown';
  if (['CANCELLED', 'SERVICE_RESTART', 'INTERRUPTED'].includes(code ?? '') || /interrupted|service stopped|work stopped/i.test(message)) category = 'interrupted';
  else if (code === 'STALE_EVIDENCE' || code === 'STALE_PLAN_REVISION' || /evidence no longer matches|worktree changed after|review snapshot changed/i.test(message)) category = 'evidence';
  else if (code === 'REPAIR_LIMIT' || /three-repair limit|repair.*exhausted/i.test(message)) category = 'repair_limit';
  else if (code === 'REVIEW_BLOCKED' || /independent review is blocked|No actionable code defect/i.test(message)) category = 'review_blocked';
  else if (code === 'VALIDATION_SETUP_REQUIRED' || /command not found|Cannot find package ['"]|Cannot find module ['"][^\n]*node_modules\/|(?:sh|bash|zsh|env):[^\n]*(?:not found|No such file)|Error: listen (?:EPERM|EACCES)|worktree initialization failed/i.test(detail)) category = 'environment';
  else if (code?.includes('TIMEOUT') || /exceeded.*timeout|timed out|time limit/i.test(message)) category = 'timeout';
  else if (code?.startsWith('PROVIDER_') || ['PROTOCOL_ERROR', 'INVALID_REVIEW', 'INVALID_OUTPUT', 'INVALID_PLAN', 'MODEL_UNAVAILABLE', 'AUTH_REQUIRED', 'USAGE_LIMIT'].includes(code ?? '')) category = 'provider';
  else if (code === 'POLICY_DENIED') category = 'policy';
  else if (['VALIDATION_FAILED', 'INVALID_IMPLEMENTATION', 'REVIEW_CHANGES_REQUESTED'].includes(code ?? '')) category = 'code_defect';
  return { category, label: failureLabels[category], recovery: recovery[category] };
}
export function taskFailure(task: Task, runs: AgentRun[], checks: ValidationRun[], events: DomainEvent[] = []): FailureClassification | null {
  if (!['BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status)) return null;
  const run = runs.filter(run => run.task_id === task.id).at(-1);
  const check = checks.filter(check => check.task_id === task.id && check.status !== 'passed').at(-1);
  const event = events.filter(event => event.task_id === task.id && ['build.failed', 'build.interrupted', 'evidence.invalidated', 'build.recovery_required'].includes(event.type)).at(-1);
  const payload = event ? JSON.parse(event.payload_json) : null;
  const code = event?.type === 'evidence.invalidated' ? 'STALE_EVIDENCE' : payload?.code ?? run?.error_code;
  return classifyFailure(code, task.reason ?? run?.summary ?? '', check?.log_text ?? '');
}
export function findingClassification(finding: ReviewResult['findings'][number]): string {
  const category = { code_defect: 'Code defect', environment: 'Environment', evidence: 'Missing evidence', scope: 'Scope', other: 'Other' }[finding.category ?? 'code_defect'];
  const origin = { introduced: 'Introduced by this change', pre_existing: 'Pre-existing', unknown: 'Origin uncertain' }[finding.origin ?? 'unknown'];
  return `${category} · ${origin}`;
}
export function actionableFinding(finding: ReviewResult['findings'][number]): boolean {
  return (!finding.category || finding.category === 'code_defect') && (!finding.origin || finding.origin === 'introduced');
}
