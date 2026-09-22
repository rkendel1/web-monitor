import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateObservation, observeHtml } from '../src/server/observation.js';
import { parseConditionInput } from '../src/shared/conditions.js';

const html = `
<!doctype html>
<html>
  <body>
    <main>
      <h1>Demo product</h1>
      <p class="price">$499</p>
      <p class="status">Applications Open</p>
      <button>Book now</button>
    </main>
  </body>
</html>`;

test('observeHtml extracts numeric threshold observations', () => {
  const monitor = {
    condition: parseConditionInput('price drops below $500'),
    target: { selector: 'p.price' }
  };

  const observation = observeHtml(monitor, html);
  assert.equal(observation.numericValue, 499);
  assert.equal(evaluateObservation(monitor, observation, null).triggered, true);
});

test('observeHtml extracts text and element observations', () => {
  const textMonitor = {
    condition: parseConditionInput('page contains "Applications Open"'),
    target: { text: 'Applications Open' }
  };
  assert.equal(observeHtml(textMonitor, html).present, true);

  const elementMonitor = {
    condition: parseConditionInput('button "Book now" appears'),
    target: { selector: 'button' }
  };
  assert.equal(observeHtml(elementMonitor, html).present, true);
});
