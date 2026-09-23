import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRoutes, createAttentionEvent } from '../src/server/account.js';

function app() {
  const stores = {
    NotificationChannels: new Map(),
    NotificationRoutes: new Map(),
    AttentionEvents: new Map()
  };
  return {
    state: {
      collection(name) {
        const store = stores[name];
        return {
          get: async (id) => store.get(id) ?? null,
          find: async (query) => [...store.values()].filter((item) =>
            Object.entries(query).every(([key, value]) => item[key] === value)),
          insert: async (value, id) => store.set(id, value),
          update: async (id, value) => store.set(id, { ...store.get(id), ...value }),
          delete: async (id) => store.delete(id)
        };
      }
    }
  };
}

const principal = {
  principalId: 'user-a',
  tenantId: 'account-a',
  scopes: ['account.read', 'account.write']
};

test('account channels and routes are durable and isolated', async () => {
  const application = app();
  const routes = createAccountRoutes(application);
  const channel = await routes['POST /account/channels']({
    tenantId: 'account-a',
    principal,
    body: { type: 'email', configuration: { address: 'a@example.test' } }
  });
  assert.equal((await routes['GET /account/channels']({ tenantId: 'account-a', principal })).items.length, 1);
  await assert.rejects(
    routes['GET /account/channels/:id']({
      tenantId: 'account-b',
      principal: { ...principal, tenantId: 'account-b' },
      params: { id: channel.id }
    }),
    (error) => error.code === 'NOT_FOUND'
  );
  const route = await routes['POST /account/notification-routes']({
    tenantId: 'account-a',
    principal,
    body: { channel_id: channel.id, event_type: 'important' }
  });
  const attention = await createAttentionEvent(application, {
    account_id: 'account-a',
    source_type: 'web_monitor',
    source_id: 'monitor-1',
    event_type: 'important',
    title: 'Changed',
    evidence_id: 'observation-1'
  });
  assert.deepEqual(attention.channel_ids, [channel.id]);
  assert.equal(route.account_id, 'account-a');
});
