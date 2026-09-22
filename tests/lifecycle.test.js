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

import { createMonitorRoutes, runMonitorCheck } from '../src/server/monitors.js';

function createMockApp(overrides = {}) {
  const store = {
    Monitors: new Map(),
    MonitorObservations: new Map(),
    Observations: new Map(),
    PendingObservations: new Map(),
    MonitorTriggeredEvents: new Map(),
    MonitorExecutionEvidence: new Map(),
    ObservationExecutorHeartbeats: new Map()
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
    jobs: {
      scheduleRecurring: async ({ tenantId, type, payload, interval, createdBy }) => ({
        id: `schedule-${randomUUID()}`,
        tenantId,
        type,
        payload,
        interval,
        createdBy
      }),
      disableSchedule: async () => ({ ok: true })
    },
    notifications: {
      create: async (data) => {
        notifications.push(data);
        return { id: randomUUID() };
      }
    },
    ...overrides
  };

  return { app, store, notifications };
}

function createResponse({ status = 200, body = '', headers = { 'content-type': 'application/json' } } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? headers[name] ?? null;
      }
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
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
  assert.equal(notifications[0].type, 'monitor_triggered');
  assert.equal(notifications[0].recipient, ownerId);
  assert.deepEqual(notifications[0].data.deliveryPolicy, { channels: ['browser'] });
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
  assert.equal(monitorExpired.status, 'active');
  assert.equal(monitorExpired.executionState, 'authentication_required');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor.auth_expired');
  assert.equal(notifications[0].channel, 'browser');
  const expiredObservations = await app.state.collection('MonitorObservations').find({ monitorId });
  assert.equal(expiredObservations.length, 0);
  assert.equal((await app.state.collection('Observations').find({ tenantId })).length, 0);
  assert.equal((await app.state.collection('MonitorExecutionEvidence').find({ monitorId })).length, 1);

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
  assert.equal(monitorExpired.status, 'active');
  assert.equal(monitorExpired.executionState, 'authentication_required');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor.auth_expired');
  assert.equal((await app.state.collection('MonitorObservations').find({ monitorId })).length, 0);
  assert.equal((await app.state.collection('Observations').find({ tenantId })).length, 0);
  assert.equal((await app.state.collection('MonitorExecutionEvidence').find({ monitorId })).length, 1);

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

test('Triggered notification preserves durable evidence and never includes observation credentials', async () => {
  const { app, store, notifications } = createMockApp();
  const routes = createMonitorRoutes(app);
  const monitorId = 'monitor-evidence';
  const tenantId = 'test-tenant';
  const ownerId = 'user-123';
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/safe',
    pageTitle: 'Safe Page',
    condition: { type: 'text_appears', text: 'Safe' },
    status: 'active',
    scheduleInterval: '1h',
    notificationPolicy: { channels: ['browser'] }
  }, monitorId);
  await app.state.collection('PendingObservations').insert({
    id: 'pending-evidence',
    monitorId,
    tenantId,
    ownerId,
    url: 'https://example.com/safe',
    condition: { type: 'text_appears', text: 'Safe' }
  }, 'pending-evidence');

  await routes['POST /api/observations/submit']({
    tenantId,
    principal: { principalId: ownerId, scopes: ['monitors.write'] },
    body: {
      pendingId: 'pending-evidence',
      observation: {
        authentication: 'authenticated',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/safe',
        execution: 'authenticated_browser',
        valueText: 'Safe',
        present: true,
        password: 'do-not-store',
        cookies: 'session=secret',
        authorization: '******'
      }
    }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor_triggered');
  assert.equal(notifications[0].data.observationId, 'pending-evidence');
  assert.deepEqual(notifications[0].data.deliveryPolicy, { channels: ['browser'] });
  assert.equal(JSON.stringify(notifications[0]).includes('do-not-store'), false);
  assert.equal(store.MonitorTriggeredEvents.size, 1);
});

test('Unavailable browser executor records operational evidence without changing monitor lifecycle', async () => {
  const { app, store } = createMockApp();
  const monitorId = 'monitor-unavailable';
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://example.com/private',
    pageTitle: 'Private page',
    condition: { type: 'text_appears', text: 'Ready' },
    target: {},
    status: 'active',
    executionMode: 'authenticated_browser',
    executionState: 'available'
  }, monitorId);

  await runMonitorCheck(app, {
    id: 'job-unavailable',
    payload: { monitorId }
  });

  const monitor = store.Monitors.get(monitorId);
  assert.equal(monitor.status, 'active');
  assert.equal(monitor.executionState, 'unavailable');
  assert.equal(store.PendingObservations.size, 0);
  assert.equal(store.MonitorObservations.size, 0);
  assert.equal(store.MonitorExecutionEvidence.size, 1);
  assert.equal([...store.MonitorExecutionEvidence.values()][0].reason, 'browser_unavailable');

  await app.state.collection('ObservationExecutorHeartbeats').insert({
    id: 'test-tenant:authenticated-browser',
    tenantId: 'test-tenant',
    executionMode: 'authenticated_browser',
    executorId: 'authenticated-browser',
    heartbeatAt: new Date(Date.now() + 10_000).toISOString()
  }, 'test-tenant:authenticated-browser');
  await runMonitorCheck(app, {
    id: 'job-reconnected',
    payload: { monitorId }
  });
  assert.equal(store.Monitors.get(monitorId).executionState, 'available');
  assert.equal(store.PendingObservations.size, 1);
});

test('Service executor persists canonical observations and preserves evaluation semantics', async () => {
  const fetchCalls = [];
  const { app, store, notifications } = createMockApp({
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return createResponse({
        status: 200,
        body: { data: { price: 450 } }
      });
    },
    resolveServiceAuthorizationContext: async ({ authorizationContext }) => ({
      headers: {
        authorization: `context-token:${authorizationContext}`
      }
    })
  });

  const monitorId = 'monitor-service-success';
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://api.example.com/price',
    pageTitle: 'Service price',
    condition: { type: 'numeric_threshold', target: 'price', operator: 'lt', value: 500 },
    target: {
      path: 'data.price',
      request: {
        headers: {
          authorization: 'config-token',
          'x-client': 'web-monitor'
        }
      }
    },
    execution: {
      mode: 'service',
      authorizationContext: 'inventory-api'
    },
    executionMode: 'service',
    executionState: 'available',
    status: 'active',
    scheduleId: 'schedule-1'
  }, monitorId);

  await runMonitorCheck(app, {
    id: 'job-service-success',
    payload: { monitorId }
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.headers.authorization, 'context-token:inventory-api');
  assert.equal(fetchCalls[0].options.headers['x-client'], 'web-monitor');
  assert.equal(fetchCalls[0].options.headers.cookie, undefined);

  const observations = [...store.MonitorObservations.values()];
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observation.executor.mode, 'service');
  assert.equal(observations[0].observation.executionMode, 'service');
  assert.equal(observations[0].observation.subject.id, 'https://api.example.com/price');
  assert.equal(observations[0].observation.values.numericValue, 450);
  assert.equal(observations[0].observation.numericValue, 450);
  assert.equal(observations[0].evaluation.triggered, true);
  assert.equal(store.Monitors.get(monitorId).executionState, 'available');
  assert.equal(store.Monitors.get(monitorId).status, 'triggered');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'monitor_triggered');
  assert.equal(JSON.stringify(notifications[0]).includes('context-token:inventory-api'), false);
});

test('Service authentication failures persist execution evidence without fabricating observations', async () => {
  const { app, store, notifications } = createMockApp();
  const monitorId = 'monitor-service-auth';
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://api.example.com/private',
    pageTitle: 'Private service',
    condition: { type: 'text_appears', text: 'Ready' },
    target: { path: 'message' },
    execution: {
      mode: 'service',
      authorizationContext: 'missing-service-auth'
    },
    executionMode: 'service',
    executionState: 'available',
    status: 'active',
    scheduleId: 'schedule-2'
  }, monitorId);

  await runMonitorCheck(app, {
    id: 'job-service-auth',
    payload: { monitorId }
  });

  assert.equal(store.MonitorObservations.size, 0);
  assert.equal(store.MonitorExecutionEvidence.size, 1);
  const [evidence] = [...store.MonitorExecutionEvidence.values()];
  assert.equal(evidence.executionState, 'authentication_required');
  assert.equal(evidence.reason, 'authentication_required');
  assert.equal(evidence.evidence.reason, 'authentication_required');
  assert.equal(store.Monitors.get(monitorId).status, 'active');
  assert.equal(notifications.length, 0);
});

test('Service unavailability and recovery preserve scheduling and restore availability', async () => {
  let attempts = 0;
  const { app, store } = createMockApp({
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('ECONNREFUSED token=secret');
      }
      return createResponse({
        status: 200,
        body: { status: 'Ready' }
      });
    }
  });

  const monitorId = 'monitor-service-recovery';
  await app.state.collection('Monitors').insert({
    id: monitorId,
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://api.example.com/status',
    pageTitle: 'Service status',
    condition: { type: 'text_appears', text: 'Ready' },
    target: { path: 'status' },
    execution: { mode: 'service' },
    executionMode: 'service',
    executionState: 'available',
    status: 'active',
    scheduleId: 'schedule-3'
  }, monitorId);

  await runMonitorCheck(app, {
    id: 'job-service-down',
    payload: { monitorId }
  });

  assert.equal(store.Monitors.get(monitorId).status, 'active');
  assert.equal(store.Monitors.get(monitorId).executionState, 'unavailable');
  assert.equal(store.Monitors.get(monitorId).scheduleId, 'schedule-3');
  assert.equal(store.MonitorObservations.size, 0);
  assert.equal(store.MonitorExecutionEvidence.size, 1);
  assert.equal([...store.MonitorExecutionEvidence.values()][0].reason, 'service_unavailable');
  assert.equal(JSON.stringify([...store.MonitorExecutionEvidence.values()][0]).includes('secret'), false);

  await runMonitorCheck(app, {
    id: 'job-service-recovered',
    payload: { monitorId }
  });

  assert.equal(store.Monitors.get(monitorId).executionState, 'available');
  assert.equal(store.MonitorObservations.size, 1);
  assert.equal([...store.MonitorObservations.values()][0].evaluation.triggered, true);
});

test('Service executor errors are sanitized and unknown execution modes fail closed', async () => {
  const { app, store } = createMockApp({
    fetch: async () => createResponse({
      status: 500,
      body: { error: 'Authorization ******' }
    })
  });

  await app.state.collection('Monitors').insert({
    id: 'monitor-service-error',
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://api.example.com/error',
    pageTitle: 'Service error',
    condition: { type: 'text_appears', text: 'Ready' },
    target: {
      path: 'message',
      request: {
        headers: {
          authorization: 'monitor-token',
          cookie: 'session=123'
        }
      }
    },
    execution: { mode: 'service' },
    executionMode: 'service',
    executionState: 'available',
    status: 'active'
  }, 'monitor-service-error');

  await runMonitorCheck(app, {
    id: 'job-service-error',
    payload: { monitorId: 'monitor-service-error' }
  });

  const evidenceItems = [...store.MonitorExecutionEvidence.values()];
  assert.equal(evidenceItems.length, 1);
  assert.deepEqual(evidenceItems[0].error, {
    code: 'service_request_failed',
    message: 'Service request failed'
  });
  assert.equal(JSON.stringify(evidenceItems[0]).includes('super-secret'), false);
  assert.equal(JSON.stringify(evidenceItems[0]).includes('monitor-secret'), false);
  assert.equal(store.MonitorObservations.size, 0);

  await app.state.collection('Monitors').insert({
    id: 'monitor-unknown-executor',
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://example.com/unknown',
    pageTitle: 'Unknown executor',
    condition: { type: 'text_appears', text: 'Ready' },
    execution: { mode: 'remote_browser' },
    executionMode: 'remote_browser',
    executionState: 'available',
    status: 'active'
  }, 'monitor-unknown-executor');

  await runMonitorCheck(app, {
    id: 'job-unknown-executor',
    payload: { monitorId: 'monitor-unknown-executor' }
  });

  const unknownEvidence = [...store.MonitorExecutionEvidence.values()].find((item) => item.monitorId === 'monitor-unknown-executor');
  assert.equal(unknownEvidence.reason, 'executor_unavailable');
  assert.equal(unknownEvidence.evidence.executionMode, 'remote_browser');
  assert.equal(store.Monitors.get('monitor-unknown-executor').executionState, 'unavailable');
});

test('Equivalent browser and service observations produce equivalent evaluations', async () => {
  const { app, store } = createMockApp({
    fetch: async () => createResponse({
      status: 200,
      body: { message: 'Ready' }
    })
  });
  const routes = createMonitorRoutes(app);

  await app.state.collection('Monitors').insert({
    id: 'browser-equivalence',
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://example.com/browser',
    pageTitle: 'Browser equivalence',
    condition: { type: 'text_appears', text: 'Ready' },
    execution: { mode: 'authenticated_browser' },
    executionMode: 'authenticated_browser',
    executionState: 'available',
    status: 'active'
  }, 'browser-equivalence');
  await app.state.collection('PendingObservations').insert({
    id: 'pending-browser-equivalence',
    monitorId: 'browser-equivalence',
    tenantId: 'test-tenant',
    ownerId: 'user-123'
  }, 'pending-browser-equivalence');

  await routes['POST /api/observations/submit']({
    tenantId: 'test-tenant',
    principal: { principalId: 'user-123', scopes: ['monitors.write'] },
    body: {
      pendingId: 'pending-browser-equivalence',
      observation: {
        authentication: 'authenticated',
        observedAt: new Date().toISOString(),
        url: 'https://example.com/browser',
        execution: 'authenticated_browser',
        valueText: 'Ready',
        present: true
      }
    }
  });

  await app.state.collection('Monitors').insert({
    id: 'service-equivalence',
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: 'https://api.example.com/ready',
    pageTitle: 'Service equivalence',
    condition: { type: 'text_appears', text: 'Ready' },
    target: { path: 'message' },
    execution: { mode: 'service' },
    executionMode: 'service',
    executionState: 'available',
    status: 'active'
  }, 'service-equivalence');

  await runMonitorCheck(app, {
    id: 'job-service-equivalence',
    payload: { monitorId: 'service-equivalence' }
  });

  const browserObservation = [...store.MonitorObservations.values()].find((item) => item.monitorId === 'browser-equivalence');
  const serviceObservation = [...store.MonitorObservations.values()].find((item) => item.monitorId === 'service-equivalence');
  assert.deepEqual(browserObservation.evaluation, serviceObservation.evaluation);
  assert.equal(browserObservation.evaluation.triggered, true);
  assert.equal(browserObservation.observation.provenance.observationMethod, 'browser_page');
  assert.equal(serviceObservation.observation.provenance.observationMethod, 'http_request');
  assert.notEqual(
    browserObservation.observation.executor.mode,
    serviceObservation.observation.executor.mode
  );
});

test('Service monitor creation stores only authorization context, not credentials', async () => {
  const { app, store } = createMockApp();
  const routes = createMonitorRoutes(app);

  const created = await routes['POST /api/monitors']({
    tenantId: 'test-tenant',
    principal: { principalId: 'user-123', tenantId: 'test-tenant', scopes: ['monitors.write'] },
    body: {
      url: 'https://api.example.com/resource',
      title: 'Service monitor',
      conditionInput: 'page contains "Ready"',
      schedule: '15m',
      target: {
        path: 'message',
        request: {
          headers: {
            authorization: '******'
          }
        }
      },
      execution: {
        mode: 'service',
        authorizationContext: 'inventory-auth',
        username: 'alice',
        password: 'super-secret'
      }
    }
  });

  const savedMonitor = store.Monitors.get(created.id);
  assert.deepEqual(savedMonitor.execution, {
    mode: 'service',
    authorizationContext: 'inventory-auth'
  });
  assert.equal(JSON.stringify(savedMonitor).includes('super-secret'), false);
  assert.equal(JSON.stringify(savedMonitor).includes('alice'), false);
  assert.equal(savedMonitor.execution.authorizationContext, 'inventory-auth');
});

test('Canonical observations are retry-idempotent, historical, and cursor-queryable', async () => {
  const { app, store } = createMockApp({
    fetch: async () => createResponse({
      status: 200,
      body: { status: 'Ready' }
    })
  });
  const routes = createMonitorRoutes(app);
  const subject = {
    type: 'github_issue',
    id: 'acme/project/issues/42',
    locator: 'https://api.github.com/repos/acme/project/issues/42'
  };
  const monitor = {
    id: 'monitor-canonical',
    tenantId: 'test-tenant',
    ownerId: 'user-123',
    url: subject.locator,
    pageTitle: 'Issue',
    condition: { type: 'text_appears', text: 'Ready' },
    target: { path: 'status', subject },
    execution: { mode: 'service' },
    executionMode: 'service',
    executionState: 'available',
    status: 'active'
  };
  await app.state.collection('Monitors').insert(monitor, monitor.id);

  await runMonitorCheck(app, { id: 'job-retry', payload: { monitorId: monitor.id } });
  await runMonitorCheck(app, { id: 'job-retry', payload: { monitorId: monitor.id } });
  assert.equal(store.Observations.size, 1);
  assert.equal([...store.Observations.values()][0].provenance.observationMethod, 'http_request');

  await runMonitorCheck(app, { id: 'job-later', payload: { monitorId: monitor.id } });
  assert.equal(store.Observations.size, 2);

  const firstPage = await routes['GET /api/observations']({
    tenantId: 'test-tenant',
    principal: { principalId: 'user-123', scopes: ['monitors.read'] },
    request: {
      url: `/api/observations?subject=${encodeURIComponent(JSON.stringify(subject))}&limit=1`
    }
  });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);

  const secondPage = await routes['GET /api/observations']({
    tenantId: 'test-tenant',
    principal: { principalId: 'user-123', scopes: ['monitors.read'] },
    request: { url: `/api/observations?cursor=${firstPage.nextCursor}&limit=1` }
  });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
  const latest = await routes['GET /api/observations/latest']({
    tenantId: 'test-tenant',
    principal: { principalId: 'user-123', scopes: ['monitors.read'] },
    request: { url: `/api/observations/latest?subject=${encodeURIComponent(JSON.stringify(subject))}` }
  });
  assert.equal(latest.item.id, firstPage.items[0].id);
});
