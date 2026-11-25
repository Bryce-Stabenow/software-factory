import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSelectionItems, encodeModelSelection, decodeModelSelection } from '../apps/desktop/src/model-selection.js';
import { commandSchema, resolveAgentDefaults } from '../packages/contracts/src/index.js';

test('inheritance, catalog default and IDs have distinct lossless selections', () => {
  for (const value of [undefined, null, 'inherit', 'catalog', 'model:custom']) assert.equal(decodeModelSelection(encodeModelSelection(value)), value);
  const defaults = { provider: 'fake' as const, planningModel: 'plan', implementationModel: 'build', reviewModel: 'review' };
  assert.deepEqual(resolveAgentDefaults(defaults, { planningModel: null, implementationModel: undefined, reviewModel: 'other' }), { ...defaults, planningModel: null, reviewModel: 'other' });
});
test('catalog failures and missing saved IDs retain selectable values', () => {
  const items = modelSelectionItems('saved-id', undefined, true, 'project-id');
  assert.equal(items[0].label, 'Use project default (project-id)');
  assert.ok(items.some(item => item.value === 'model:saved-id'));
  const refreshed = modelSelectionItems('saved-id', [{ model: 'new-id', name: 'New', isDefault: true }]);
  assert.ok(refreshed.some(item => item.value === 'model:saved-id'));
  assert.equal(modelSelectionItems('saved-id', [{ model: 'saved-id', name: 'Saved', isDefault: false }]).filter(item => item.value === 'model:saved-id').length, 1);
});

test('new commands reject the removed shared model and retry rejects other stages', () => {
  const taskId = '00000000-0000-4000-8000-000000000001';
  assert.equal(commandSchema.safeParse({ type: 'task.assign', taskId, expectedVersion: 1, model: 'old' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'task.retry', taskId, expectedVersion: 1, reviewModel: 'other' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'task.retry', taskId, expectedVersion: 1, planningModel: null }).success, true);
});
