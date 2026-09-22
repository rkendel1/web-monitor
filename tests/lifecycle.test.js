import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Import the module we want to test.
// Since we want to test recordObservation, but it's not exported, we can test it through the routes or we can import it if we export it, or we can test the status function and mock state!
// Wait! Let's check what is exported from src/server/monitors.js:
// `runMonitorCheck` and `createMonitorRoutes` are exported.
// Wait, can we test the routes directly?
// Yes! createMonitorRoutes(application) returns an object of route functions.
// We can call these route functions directly with our mock parameters!
// Let's check what routes are available:
// - 'POST /api/observations/submit'
// Let's write a test that calls this route or tests the state transitions.

import { createMonitorRoutes } from '../src/server/monitors.js';

function createMockApp() {
  const store = {
    Monitors: new Map(),
    MonitorObservations: new Map(),
    PendingObservations: new Map()
  };

  const notifications = [];

  const app = {
    state: {
      collection(name) {
        return {
          insert: async (data, id) => {
            store[name].set(id, { ...data });
          },
          update: async (id, data) => {
            const existing = store[name].get(id) || {};
            store[name].set(id, { ...existing, ...data });
          },
          get: async (id) => {
            return store[name].get(id) || null;
          },
          delete: async (id) => {
            store[name].delete(id);
          },
          find: async (query) => {
            const results = [];
            for (const item of store[name].values()) {
              let match = true;
              for (const key in query) {
                if (item[key] !== query[key]) {
                  match = false;
                  break;
                }
              }
              if (match) {
                results.push(item);
              }
            }
            return results;
          }
        };
      }
    },
    notifications: {
      create: async (data) => {
        notifications.push(data);
        return { id: randomUUID() };
      }
    }
  };

  return { app, store, notifications };
}

test('Monitor check & submit observation lifecycle (ACTIVE -> observation -> condition false/true)', async () => {
  const { app, store, notifications } = createMockApp();
  const routes = createMonitorRoutes(app);

  const monitorId = 'monitor-123';
  const tenantId = 'test-tenant';
  const ownerId = 'user-123';

  // Seed a monitor
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/product',
    pageTitle: 'Product Page',
    condition: { type: 'numeric_threshold', target: 'price', operator: 'lt', value: 500 },
    target: { selector: 'p.price' },
    status: 'active',
    scheduleInterval: '1h'
  }, monitorId);

  // Seed a pending observation check (simulating runMonitorCheck queuing for authenticated_browser)
  const pendingId = 'pending-123';
  await app.state.collection('PendingObservations').insert({
    id: pendingId,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/product',
    condition: { type: 'numeric_threshold', target: 'price', operator: 'lt', value: 500 },
    target: { selector: 'p.price' }
  }, pendingId);

  const principal = { principalId: ownerId, scopes: ['monitors.write', 'monitors.read'] };

  // 1. Submit observation with condition false (price = 550)
  const submitRoute = routes['POST /api/observations/submit'];
  await submitRoute({
    tenantId,
    principal,
    body: {
      pendingId,
      observation: {
        authentication: 'authenticated',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/product',
        execution: 'authenticated_browser',
        valueText: '$550',
        numericValue: 550,
        selector: 'p.price'
      }
    }
  });

  // Verify monitor status is still active (not triggered)
  const monitorAfterFirst = await app.state.collection('Monitors').get(monitorId);
  assert.equal(monitorAfterFirst.status, 'active');
  assert.equal(notifications.length, 0); // No notification for condition false
  assert.equal(store.PendingObservations.has(pendingId), false); // Pending request removed

  // 2. Queue another check and submit with condition true (price = 450)
  const pendingId2 = 'pending-456';
  await app.state.collection('PendingObservations').insert({
    id: pendingId2,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/product',
    condition: { type: 'numeric_threshold', target: 'price', operator: 'lt', value: 500 },
    target: { selector: 'p.price' }
  }, pendingId2);

  await submitRoute({
    tenantId,
    principal,
    body: {
      pendingId: pendingId2,
      observation: {
        authentication: 'authenticated',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/product',
        execution: 'authenticated_browser',
        valueText: '$450',
        numericValue: 450,
        selector: 'p.price'
      }
    }
  });

  // Verify monitor is now triggered and notification is sent
  const monitorAfterSecond = await app.state.collection('Monitors').get(monitorId);
  assert.equal(monitorAfterSecond.status, 'triggered');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor.triggered');
  assert.equal(notifications[0].recipient, ownerId);
  assert.equal(notifications[0].channel, undefined);
});

test('Session expiration lifecycle (ACTIVE -> AUTHENTICATION_REQUIRED -> notification -> user re-authenticates -> ACTIVE)', async () => {
  const { app, store, notifications } = createMockApp();
  const routes = createMonitorRoutes(app);

  const monitorId = 'monitor-auth';
  const tenantId = 'test-tenant';
  const ownerId = 'user-123';
  const principal = { principalId: ownerId, scopes: ['monitors.write', 'monitors.read'] };

  // Seed monitor
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/private',
    pageTitle: 'Private Dashboard',
    condition: { type: 'text_appears', text: 'Success' },
    status: 'active',
    scheduleInterval: '1h'
  }, monitorId);

  // 1. Trigger check resulting in expired session (required)
  const pendingId = 'pending-auth-1';
  await app.state.collection('PendingObservations').insert({
    id: pendingId,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/private',
    condition: { type: 'text_appears', text: 'Success' }
  }, pendingId);

  const submitRoute = routes['POST /api/observations/submit'];
  await submitRoute({
    tenantId,
    principal,
    body: {
      pendingId,
      observation: {
        authentication: 'required',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/login?redirect=%2Fprivate',
        execution: 'authenticated_browser'
      }
    }
  });

  // Verify monitor is AUTHENTICATION_REQUIRED and notification sent
  const monitorExpired = await app.state.collection('Monitors').get(monitorId);
  assert.equal(monitorExpired.status, 'AUTHENTICATION_REQUIRED');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor.auth_expired');
  assert.equal(notifications[0].channel, undefined);
  const expiredObservations = await app.state.collection('MonitorObservations').find({ monitorId });
  assert.equal(expiredObservations[0].observation.authentication, 'authentication_required');
  assert.equal(expiredObservations[0].evaluation.triggered, false);

  // 2. User re-authenticates and next check succeeds
  const pendingId2 = 'pending-auth-2';
  await app.state.collection('PendingObservations').insert({
    id: pendingId2,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/private',
    condition: { type: 'text_appears', text: 'Success' }
  }, pendingId2);

  await submitRoute({
    tenantId,
    principal,
    body: {
      pendingId: pendingId2,
      observation: {
        authentication: 'authenticated',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/private',
        execution: 'authenticated_browser',
        present: false,
        valueText: 'Success'
      }
    }
  });

  // Verify monitor transitions back to active
  const monitorRestored = await app.state.collection('Monitors').get(monitorId);
  assert.equal(monitorRestored.status, 'active');
});

test('Session expiration lifecycle with explicit authentication_required (ACTIVE -> AUTHENTICATION_REQUIRED -> notification -> user re-authenticates -> ACTIVE)', async () => {
  const { app, store, notifications } = createMockApp();
  const routes = createMonitorRoutes(app);

  const monitorId = 'monitor-auth-explicit';
  const tenantId = 'test-tenant';
  const ownerId = 'user-123';
  const principal = { principalId: ownerId, scopes: ['monitors.write', 'monitors.read'] };

  // Seed monitor
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/private',
    pageTitle: 'Private Dashboard',
    condition: { type: 'text_appears', text: 'Success' },
    status: 'active',
    scheduleInterval: '1h'
  }, monitorId);

  // 1. Trigger check resulting in expired session (authentication_required)
  const pendingId = 'pending-auth-explicit-1';
  await app.state.collection('PendingObservations').insert({
    id: pendingId,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/private',
    condition: { type: 'text_appears', text: 'Success' }
  }, pendingId);

  const submitRoute = routes['POST /api/observations/submit'];
  await submitRoute({
    tenantId,
    principal,
    body: {
      pendingId,
      observation: {
        authentication: 'authentication_required',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/login?redirect=%2Fprivate',
        execution: 'authenticated_browser'
      }
    }
  });

  // Verify monitor is AUTHENTICATION_REQUIRED and notification sent
  const monitorExpired = await app.state.collection('Monitors').get(monitorId);
  assert.equal(monitorExpired.status, 'AUTHENTICATION_REQUIRED');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor.auth_expired');

  // 2. User re-authenticates and next check succeeds
  const pendingId2 = 'pending-auth-explicit-2';
  await app.state.collection('PendingObservations').insert({
    id: pendingId2,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/private',
    condition: { type: 'text_appears', text: 'Success' }
  }, pendingId2);

  await submitRoute({
    tenantId,
    principal,
    body: {
      pendingId: pendingId2,
      observation: {
        authentication: 'authenticated',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/private',
        execution: 'authenticated_browser',
        present: false,
        valueText: 'Success'
      }
    }
  });

  // Verify monitor transitions back to active
  const monitorRestored = await app.state.collection('Monitors').get(monitorId);
  assert.equal(monitorRestored.status, 'active');
});

test('Safety boundary (no credentials, cookies, headers, or secrets)', async () => {
  const { app } = createMockApp();
  const routes = createMonitorRoutes(app);

  const monitorId = 'monitor-safe';
  const tenantId = 'test-tenant';
  const ownerId = 'user-123';
  const principal = { principalId: ownerId, scopes: ['monitors.write', 'monitors.read'] };

  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/safe',
    pageTitle: 'Safe Page',
    condition: { type: 'text_appears', text: 'Safe' },
    status: 'active',
    scheduleInterval: '1h'
  }, monitorId);

  const pendingId = 'pending-safe';
  await app.state.collection('PendingObservations').insert({
    id: pendingId,
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/safe',
    condition: { type: 'text_appears', text: 'Safe' }
  }, pendingId);

  const payload = {
    pendingId,
    observation: {
      authentication: 'authenticated',
      observedAt: new Date().toISOString(),
      url: 'https://example.com/safe',
      execution: 'authenticated_browser',
      present: true,
      valueText: 'Safe',
      // Attaching forbidden credentials to verify they are either stripped or not accepted
      cookies: 'session=12345; auth=abc',
      password: 'mypassword',
      authorization: '******',
      apiKey: 'appport_key'
    }
  };

  const submitRoute = routes['POST /api/observations/submit'];
  await submitRoute({
    tenantId,
    principal,
    body: payload
  });

  // Fetch the recorded observation
  const observations = await app.state.collection('MonitorObservations').find({ monitorId });
  assert.equal(observations.length, 1);
  const savedObservation = observations[0].observation;

  // Assert that no sensitive keys exist in the saved observation payload
  assert.equal(savedObservation.cookies, undefined);
  assert.equal(savedObservation.password, undefined);
  assert.equal(savedObservation.authorization, undefined);
  assert.equal(savedObservation.apiKey, undefined);
});
