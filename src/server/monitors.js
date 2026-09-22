import { randomUUID } from 'node:crypto';
import { conditionLabel, normalizeInterval, parseConditionInput } from '../shared/conditions.js';
import { evaluateObservation, observeHtml } from './observation.js';

const MONITORS = 'Monitors';
const OBSERVATIONS = 'MonitorObservations';

function collection(application, name) {
  return application.state.collection(name);
}

function parseUrlQuery(requestUrl, name) {
  const url = new URL(requestUrl ?? '/', 'http://web-monitor.local');
  return url.searchParams.get(name);
}

function monitorStatus(monitor, nextTriggered) {
  if (monitor.deletedAt) {
    return 'deleted';
  }
  if (monitor.status === 'paused') {
    return 'paused';
  }
  return nextTriggered ? 'triggered' : 'active';
}

function requirePrincipal(principal) {
  if (!principal) {
    throw Object.assign(new Error('Authentication is required'), { status: 401, code: 'UNAUTHENTICATED' });
  }
  return principal;
}

function requireScope(principal, scope) {
  if (!principal.scopes.includes(scope)) {
    throw Object.assign(new Error(`The ${scope} scope is required`), { status: 403, code: 'FORBIDDEN' });
  }
}

function sortNewestFirst(items) {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function observationTimestamp(item) {
  return item.observedAt ?? item.createdAt ?? new Date().toISOString();
}

async function listOwnedMonitors(application, tenantId, ownerId) {
  const items = await collection(application, MONITORS).find({ tenantId, ownerId });
  return sortNewestFirst(items).filter((item) => !item.deletedAt);
}

async function getMonitor(application, tenantId, ownerId, monitorId) {
  const item = await collection(application, MONITORS).get(monitorId);
  if (!item || item.tenantId !== tenantId || item.ownerId !== ownerId || item.deletedAt) {
    throw Object.assign(new Error('Monitor not found'), { status: 404, code: 'NOT_FOUND' });
  }
  return item;
}

async function listObservations(application, tenantId, ownerId, monitorId) {
  const items = await collection(application, OBSERVATIONS).find({ tenantId, ownerId, monitorId });
  return [...items].sort((left, right) => observationTimestamp(right).localeCompare(observationTimestamp(left)));
}

function systemPrincipal(tenantId) {
  return {
    principalId: 'appport:web-monitor',
    principalType: 'system',
    tenantId,
    scopes: ['notifications.admin']
  };
}

async function recordObservation(application, monitor, observation, evaluation, options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const observationId = randomUUID();
  await collection(application, OBSERVATIONS).insert({
    id: observationId,
    monitorId: monitor.id,
    tenantId: monitor.tenantId,
    ownerId: monitor.ownerId,
    observedAt,
    observation,
    evaluation,
    triggered: Boolean(evaluation.triggered),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    source: options.source ?? 'job'
  }, observationId);

  const updatedMonitor = {
    ...monitor,
    updatedAt: observedAt,
    lastCheckedAt: observedAt,
    lastObservation: observation,
    lastEvaluation: evaluation,
    status: monitorStatus(monitor, evaluation.triggered),
    ...(evaluation.triggered ? { triggeredAt: observedAt } : {})
  };

  await collection(application, MONITORS).update(monitor.id, {
    updatedAt: updatedMonitor.updatedAt,
    lastCheckedAt: updatedMonitor.lastCheckedAt,
    lastObservation: updatedMonitor.lastObservation,
    lastEvaluation: updatedMonitor.lastEvaluation,
    status: updatedMonitor.status,
    ...(updatedMonitor.triggeredAt ? { triggeredAt: updatedMonitor.triggeredAt } : {})
  });

  const previouslyTriggered = Boolean(monitor.lastEvaluation?.triggered);
  if (!options.skipNotification && !previouslyTriggered && evaluation.triggered) {
    const summaryValue = observation.numericValue != null ? `$${observation.numericValue}` : observation.valueText || conditionLabel(monitor.condition);
    await application.notifications.create({
      tenantId: monitor.tenantId,
      recipient: monitor.ownerId,
      type: 'monitor.triggered',
      title: 'Monitor triggered',
      body: `${monitor.pageTitle}: ${summaryValue}`,
      priority: 'high',
      source: { type: 'monitor', id: monitor.id },
      data: {
        monitorId: monitor.id,
        url: monitor.url,
        value: summaryValue,
        condition: conditionLabel(monitor.condition)
      },
      channel: 'browser'
    }, systemPrincipal(monitor.tenantId));
  }
}

async function createMonitor(application, tenantId, principal, input) {
  const condition = input.condition ?? parseConditionInput(input.conditionInput);
  const scheduleInterval = normalizeInterval(input.schedule);
  const monitorId = randomUUID();
  const createdAt = new Date().toISOString();

  const monitor = {
    id: monitorId,
    tenantId,
    ownerId: principal.principalId,
    url: input.url,
    pageTitle: input.title,
    conditionInput: input.conditionInput,
    condition: input.initialObservation?.valueText && condition.type === 'value_changes'
      ? { ...condition, initialValue: input.initialObservation.valueText }
      : condition,
    target: input.target ?? {},
    scheduleInterval,
    status: 'active',
    notes: input.notes ?? '',
    createdAt,
    updatedAt: createdAt,
    ...(input.initialObservation ? { lastObservation: input.initialObservation } : {}),
    ...(input.initialEvaluation ? { lastEvaluation: input.initialEvaluation } : {})
  };

  const schedule = await application.jobs.scheduleRecurring({
    tenantId,
    type: 'monitor.check',
    payload: { monitorId },
    interval: scheduleInterval,
    createdBy: principal.principalId
  });

  await collection(application, MONITORS).insert({
    ...monitor,
    scheduleId: schedule.id
  }, monitorId);

  if (input.initialObservation && input.initialEvaluation) {
    await recordObservation(application, { ...monitor, scheduleId: schedule.id }, input.initialObservation, input.initialEvaluation, {
      observedAt: createdAt,
      source: 'extension-capture',
      skipNotification: true
    });
  }

  return {
    ...monitor,
    scheduleId: schedule.id
  };
}

export async function runMonitorCheck(application, job) {
  const monitor = await collection(application, MONITORS).get(job.payload?.monitorId);
  if (!monitor || monitor.deletedAt || monitor.status === 'paused') {
    return;
  }

  const response = await fetch(monitor.url, {
    headers: {
      'user-agent': 'AppPort-Web-Monitor/1.0',
      accept: 'text/html,application/xhtml+xml'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${monitor.url}: ${response.status}`);
  }

  const html = await response.text();
  const observation = observeHtml(monitor, html);
  const evaluation = evaluateObservation(monitor, observation, monitor.lastObservation);
  await recordObservation(application, monitor, observation, evaluation, {
    observedAt: new Date().toISOString(),
    source: 'job',
    jobId: job.id
  });
}

export function createMonitorRoutes(application) {
  return {
    'GET /api/session': async ({ principal }) => {
      const authenticated = requirePrincipal(principal);
      return {
        principalId: authenticated.principalId,
        tenantId: authenticated.tenantId,
        scopes: authenticated.scopes
      };
    },
    'GET /api/monitors': async ({ tenantId, principal }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.read');
      const monitors = await listOwnedMonitors(application, tenantId, authenticated.principalId);
      return { items: monitors };
    },
    'GET /api/monitor': async ({ tenantId, principal, request }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.read');
      const id = parseUrlQuery(request.url, 'id');
      if (!id) {
        throw Object.assign(new Error('Monitor id is required'), { status: 400, code: 'INVALID_INPUT' });
      }
      const monitor = await getMonitor(application, tenantId, authenticated.principalId, id);
      const observations = await listObservations(application, tenantId, authenticated.principalId, id);
      return { monitor, observations };
    },
    'POST /api/monitors': async ({ tenantId, principal, body }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.write');
      return createMonitor(application, tenantId, authenticated, body ?? {});
    },
    'POST /api/monitors/pause': async ({ tenantId, principal, body }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.write');
      const monitor = await getMonitor(application, tenantId, authenticated.principalId, body?.id);
      if (monitor.scheduleId) {
        await application.jobs.disableSchedule(tenantId, monitor.scheduleId);
      }
      await collection(application, MONITORS).update(monitor.id, {
        status: 'paused',
        updatedAt: new Date().toISOString()
      });
      return { ok: true };
    },
    'POST /api/monitors/resume': async ({ tenantId, principal, body }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.write');
      const monitor = await getMonitor(application, tenantId, authenticated.principalId, body?.id);
      const schedule = await application.jobs.scheduleRecurring({
        tenantId,
        type: 'monitor.check',
        payload: { monitorId: monitor.id },
        interval: monitor.scheduleInterval,
        createdBy: authenticated.principalId
      });
      await collection(application, MONITORS).update(monitor.id, {
        status: 'active',
        scheduleId: schedule.id,
        updatedAt: new Date().toISOString()
      });
      return { ok: true };
    },
    'POST /api/monitors/delete': async ({ tenantId, principal, body }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.write');
      const monitor = await getMonitor(application, tenantId, authenticated.principalId, body?.id);
      if (monitor.scheduleId) {
        await application.jobs.disableSchedule(tenantId, monitor.scheduleId);
      }
      await collection(application, MONITORS).update(monitor.id, {
        status: 'deleted',
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return { ok: true };
    }
  };
}
