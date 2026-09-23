import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MonitorIntentCapabilityError,
  createMonitorIntentCompiler,
  normalizeMonitorDraft,
  validateMonitorDraft
} from '../src/shared/monitor-intent.js';

const draft = {
  target: { kind: 'web_page', locator: 'https://example.com/product/123' },
  observation: {
    fields: [
      { name: 'price', type: 'number' },
      { name: 'availability', type: 'boolean' }
    ]
  },
  condition: { field: 'price', operator: 'lt', value: 500 },
  schedule: { kind: 'interval', minutes: 60 },
  execution: { mode: 'authenticated_browser' }
};

test('normalizes and validates a strict MonitorDraft', () => {
  assert.equal(normalizeMonitorDraft(draft).condition.operator, 'less_than');
  assert.equal(normalizeMonitorDraft({
    ...draft,
    condition: { field: 'price', operator: 'below', value: '$500' }
  }).condition.value, 500);
  assert.deepEqual(validateMonitorDraft({
    ...draft,
    condition: { field: 'availability', operator: 'equals', value: true }
  }).condition, { field: 'availability', operator: 'equals', value: true });
});

test('rejects unknown fields, invented operators, and executable selectors', () => {
  assert.throws(() => validateMonitorDraft({ ...draft, extra: true }), /unknown field/);
  assert.throws(() => validateMonitorDraft({
    ...draft,
    condition: { field: 'price', operator: 'between', value: [1, 2] }
  }), /Unsupported condition operator/);
  assert.throws(() => validateMonitorDraft({
    ...draft,
    target: { ...draft.target, selector: 'javascript:alert(1)' }
  }), /executable content/);
  assert.throws(() => validateMonitorDraft({
    ...draft,
    condition: { field: 'price', operator: 'less_than', value: 'not-a-number' }
  }), /does not match observed field type/);
});

test('returns clarification without inventing a monitor', async () => {
  const compiler = createMonitorIntentCompiler({
    model: { generate: async () => ({ clarification: { required: true, question: 'Which application status should trigger the notification?' } }) }
  });
  assert.deepEqual(await compiler.compile({ text: 'Watch my application.' }), {
    clarification: { required: true, question: 'Which application status should trigger the notification?' }
  });
});

test('fails explicitly when no local model is available', async () => {
  const compiler = createMonitorIntentCompiler();
  await assert.rejects(() => compiler.compile({ text: 'Watch this page.' }), MonitorIntentCapabilityError);
});
