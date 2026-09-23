import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeMonitor,
  hashNormalizedContent,
  normalizeTargetUrl,
  normalizeWebContent
} from '../src/server/semantic-monitor.js';

function app(model) {
  const data = new Map([
    ['Monitors', new Map([['m1', {
      id: 'm1', name: 'FDA', target: 'https://Example.com/news?utm_source=x&b=2&a=1',
      description: 'Announcements', instructions: 'FDA approval', enabled: true
    }]])],
    ['WebObservations', new Map()],
    ['SemanticDecisions', new Map()]
  ]);
  return {
    semanticDecision: model,
    fetch: async () => ({
      ok: true, status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<nav>Menu</nav><main><h1>Approval</h1><p>FDA approved</p></main>'
    }),
    state: { collection(name) {
      const store = data.get(name) ?? new Map();
      data.set(name, store);
      return {
        get: async (id) => store.get(id) ?? null,
        insert: async (value, id) => store.set(id, value),
        update: async (id, value) => store.set(id, { ...store.get(id), ...value }),
        find: async (query) => [...store.values()].filter((item) => Object.entries(query).every(([key, value]) => item[key] === value))
      };
    } }
  };
}

test('normalizes tracking parameters and presentation noise deterministically', () => {
  assert.equal(normalizeTargetUrl('https://Example.com/news?utm_source=x&b=2&a=1'), 'https://example.com/news?a=1&b=2');
  const first = normalizeWebContent('<nav>x</nav><h1>Title</h1><p>Hello   world</p>', 'https://example.com');
  const second = normalizeWebContent('<h1>Title</h1><p>Hello world</p>', 'https://example.com');
  assert.equal(hashNormalizedContent(first), hashNormalizedContent(second));
});

test('persists one observation and semantic decision, then skips unchanged content', async () => {
  let calls = 0;
  const application = app({ decide: async () => { calls += 1; return { relevant: true, action: 'notify', reason: 'FDA approval' }; } });
  const first = await executeMonitor(application, 'm1');
  const second = await executeMonitor(application, 'm1');
  assert.equal(first.status, 'changed');
  assert.equal(second.status, 'unchanged');
  assert.equal(calls, 1);
});

test('records explicit capability failure when local inference is unavailable', async () => {
  const result = await executeMonitor(app(null), 'm1');
  assert.equal(result.decision.decision.status, 'capability_error');
});
