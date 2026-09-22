import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, parseConditionInput } from '../src/shared/conditions.js';

test('parseConditionInput supports MVP condition forms', () => {
  assert.deepEqual(parseConditionInput('price drops below $500'), {
    type: 'numeric_threshold',
    target: 'price',
    operator: 'lt',
    value: 500,
    raw: 'price drops below $500'
  });

  assert.equal(parseConditionInput('page contains "Applications Open"').type, 'text_appears');
  assert.equal(parseConditionInput('page no longer contains "Sold Out"').type, 'text_disappears');
  assert.equal(parseConditionInput('status changed').type, 'value_changes');
  assert.equal(parseConditionInput('button "Book now" appears').type, 'element_appears');
});

test('evaluateCondition handles numeric and text transitions', () => {
  const numeric = parseConditionInput('price drops below $500');
  assert.equal(evaluateCondition(numeric, { numericValue: 499 }, null).triggered, true);
  assert.equal(evaluateCondition(numeric, { numericValue: 549 }, null).triggered, false);

  const appears = parseConditionInput('page contains "Applications Open"');
  assert.equal(evaluateCondition(appears, { present: true }, null).triggered, true);

  const changes = parseConditionInput('status changed');
  const evaluation = evaluateCondition({ ...changes, initialValue: 'Sold Out' }, { valueText: 'Applications Open' }, { valueText: 'Sold Out' });
  assert.equal(evaluation.triggered, true);
});
