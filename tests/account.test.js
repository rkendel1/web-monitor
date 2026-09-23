import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRoutes, createAttentionEvent } from '../src/server/account.js';
import { deliverNotification, NOTIFICATION_DELIVERIES } from '../src/server/notification-delivery.js';

function app() {
  const stores = {
    NotificationChannels: new Map(),
    NotificationRoutes: new Map(),
    AttentionEvents: new Map(),
    [NOTIFICATION_DELIVERIES]: new Map()
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
    body: { type: 'web' }
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
  const notifications = await routes['GET /account/notifications']({ tenantId: 'account-a', principal });
  assert.equal(notifications.items.length, 1);
  assert.equal(notifications.items[0].status, 'pending');
  const delivery = notifications.items[0];
  assert.equal((await deliverNotification(application, delivery.id)).status, 'delivered');
  assert.equal((await deliverNotification(application, delivery.id)).attempt_count, 1);
  assert.equal((await routes['POST /account/notifications/:id/read']({
    tenantId: 'account-a', principal, params: { id: delivery.id }
  })).read_at !== null, true);
  await assert.rejects(
    routes['GET /account/notifications/:id']({
      tenantId: 'account-b',
      principal: { ...principal, tenantId: 'account-b' },
      params: { id: delivery.id }
    }),
    (error) => error.code === 'NOT_FOUND'
  );
});

test('attention routing is idempotent and excludes disabled or foreign channels', async () => {
  const application = app();
  const routes = createAccountRoutes(application);
  const channel = await routes['POST /account/channels']({
    tenantId: 'account-a', principal, body: { type: 'web' }
  });
  const foreign = await routes['POST /account/channels']({
    tenantId: 'account-b',
    principal: { ...principal, tenantId: 'account-b' },
    body: { type: 'web' }
  });
  await routes['POST /account/notification-routes']({
    tenantId: 'account-a', principal, body: { channel_id: channel.id, event_type: 'important' }
  });
  application.state.collection('NotificationRoutes').insert({
    id: 'foreign-route',
    account_id: 'account-a',
    channel_id: foreign.id,
    event_type: 'important',
    enabled: true
  }, 'foreign-route');
  const event = {
    id: 'attention-1', account_id: 'account-a', source_type: 'app',
    source_id: 'source-1', event_type: 'important', title: 'Review'
  };
  await createAttentionEvent(application, event);
  await createAttentionEvent(application, event);
  assert.equal((await application.state.collection(NOTIFICATION_DELIVERIES).find({
    attention_event_id: 'attention-1'
  })).length, 1);
});

test('delivery failures are bounded and become terminal', async () => {
  const application = app();
  const routes = createAccountRoutes(application);
  const channel = await routes['POST /account/channels']({
    tenantId: 'account-a', principal, body: { type: 'web' }
  });
  await routes['POST /account/notification-routes']({
    tenantId: 'account-a', principal, body: { channel_id: channel.id, event_type: 'important' }
  });
  await createAttentionEvent(application, {
    id: 'attention-failure', account_id: 'account-a', source_type: 'web',
    source_id: 'source-1', event_type: 'important', title: 'Failure'
  });
  const delivery = (await application.state.collection(NOTIFICATION_DELIVERIES).find({}))[0];
  const adapterRegistry = {
    resolve: () => ({
      validate: () => true,
      deliver: async () => { throw new Error('provider unavailable'); }
    })
  };
  assert.equal((await deliverNotification(application, delivery.id, { adapterRegistry })).status, 'failed');
  assert.equal((await deliverNotification(application, delivery.id, { adapterRegistry })).status, 'failed');
  assert.equal((await deliverNotification(application, delivery.id, { adapterRegistry })).status, 'suppressed');
  assert.equal((await application.state.collection(NOTIFICATION_DELIVERIES).get(delivery.id)).attempt_count, 3);
});
