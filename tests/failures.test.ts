import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionableFinding, classifyFailure, taskFailure } from '../packages/contracts/src/failures.js';
import { reviewSchema, type Task } from '../packages/contracts/src/index.js';

for (const [code, message, log, category] of [
  ['VALIDATION_FAILED', '', 'AssertionError: expected 2, got 3', 'code_defect'],
  ['VALIDATION_FAILED', '', 'sh: vite: command not found', 'environment'],
  ['VALIDATION_SETUP_REQUIRED', '', '', 'environment'],
  ['VALIDATION_FAILED', '', "Cannot find package 'typescript' imported from /repo/run.mjs", 'environment'],
  ['VALIDATION_FAILED', '', "Cannot find module './new-feature.js'", 'code_defect'],
  ['VALIDATION_FAILED', '', 'Error: listen EPERM: operation not permitted', 'environment'],
  ['VALIDATION_TIMEOUT', '', '', 'timeout'],
  ['PROVIDER_DISCONNECTED', '', '', 'provider'],
  ['AUTH_REQUIRED', '', '', 'provider'],
  ['MODEL_UNAVAILABLE', '', '', 'provider'],
  ['USAGE_LIMIT', '', '', 'provider'],
  ['INVALID_REVIEW', '', '', 'provider'],
  ['POLICY_DENIED', '', '', 'policy'],
  ['POLICY_DENIED', 'Independent review is blocked: missing evidence', '', 'review_blocked'],
  ['STALE_EVIDENCE', '', '', 'evidence'],
  ['REPAIR_LIMIT', 'The three-repair limit is exhausted.', 'command not found', 'repair_limit'],
  ['SERVICE_RESTART', '', '', 'interrupted'],
  ['INTERRUPTED', '', '', 'interrupted'],
  ['BUILD_FAILED', '', '', 'unknown'],
] as const) test(`classifies ${code}: ${message || log || category}`, () => {
  const result = classifyFailure(code, message, log);
  assert.equal(result.category, category);
  assert.ok(result.label); assert.ok(result.recovery);
});

test('historical blocked tasks receive classifications without migrations', () => {
  const task = { id: 'task', status: 'BLOCKED', reason: 'The three-repair limit for this approved plan is exhausted.' } as Task;
  assert.equal(taskFailure(task, [], [])?.category, 'repair_limit');
  assert.equal(taskFailure({ ...task, status: 'ACCEPTED' }, [], []), null);
});

test('review classification distinguishes cause, origin, and severity while retaining old reviews', () => {
  const finding = { severity: 'high' as const, file: 'src/a.ts', line: 1, title: 'Bug', rationale: 'Concrete defect', suggestedFix: 'Fix it' };
  const parsed = reviewSchema.parse({ commitSha: 'a'.repeat(40), verdict: 'changes_requested', summary: 'Review', findings: [finding, { ...finding, category: 'environment', origin: 'pre_existing' }] });
  assert.equal(actionableFinding(parsed.findings[0]), true);
  assert.equal(actionableFinding(parsed.findings[1]), false);
  assert.equal(actionableFinding({ ...finding, category: 'code_defect', origin: 'pre_existing' }), false);
  assert.equal(actionableFinding({ ...finding, category: 'code_defect', origin: 'unknown' }), false);
  assert.equal(actionableFinding({ ...finding, category: 'evidence', origin: 'unknown' }), false);
});

test('task classification uses the pipeline error even when the reviewer session succeeded', () => {
  const task = { id: 'task', status: 'BLOCKED', reason: 'Needs human attention.' } as Task;
  const event = { task_id: 'task', type: 'build.failed', payload_json: JSON.stringify({ code: 'REVIEW_BLOCKED' }) } as import('../packages/contracts/src/index.js').DomainEvent;
  assert.equal(taskFailure(task, [], [], [event])?.category, 'review_blocked');
  assert.equal(taskFailure(task, [], [], [{ ...event, type: 'evidence.invalidated' }])?.category, 'evidence');
});
