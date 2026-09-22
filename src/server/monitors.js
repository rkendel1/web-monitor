import { createHash, randomUUID } from 'node:crypto';
import { conditionLabel, normalizeInterval, parseConditionInput } from '../shared/conditions.js';
import { normalizeAuthState } from '../shared/auth-detection.js';
import { evaluateObservation, observeHtml } from './observation.js';
import { createNotificationEvent } from './notifications.js';

const MONITORS = 'Monitors';
const OBSERVATIONS = 'MonitorObservations';
const PENDING_OBSERVATIONS = 'PendingObservations';
const TRIGGER_EVENTS = 'MonitorTriggeredEvents';

function collection(application, name) {
  return application.state.collection(name);
}

function parseUrlQuery(requestUrl, name) {
  const url = new URL(requestUrl ?? '/', 'http://web-monitor.local');
  return url.searchParams.get(name);
}

function monitorStatus(monitor, nextTriggered, observation) {
  if (monitor.deletedAt) {
    return 'deleted';
  }
  if (monitor.status === 'paused') {
    return 'paused';
  }
  if (normalizeAuthState(observation?.authentication) === 'authentication_required') {
    return 'AUTHENTICATION_REQUIRED';
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
  const observationId = options.observationId ?? randomUUID();
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

  const nextStatus = monitorStatus(monitor, evaluation.triggered, observation);

  const updatedMonitor = {
    ...monitor,
    updatedAt: observedAt,
    lastCheckedAt: observedAt,
    lastObservation: observation,
    lastEvaluation: evaluation,
    status: nextStatus,
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

  const previouslyAuthRequired = monitor.status === 'AUTHENTICATION_REQUIRED';
  if (nextStatus === 'AUTHENTICATION_REQUIRED' && !previouslyAuthRequired) {
    await createNotificationEvent(application, {
      tenantId: monitor.tenantId,
      recipient: monitor.ownerId,
      type: 'monitor.auth_expired',
      title: 'Sign-in required',
      body: `${monitor.pageTitle}: Open the page, sign in, and this monitor will continue automatically.`,
      priority: 'high',
      channel: (monitor.notificationPolicy ?? { channels: ['browser'] }).channels.includes('browser') ? 'browser' : undefined,
      source: { type: 'monitor', id: monitor.id },
      data: {
        monitorId: monitor.id,
        url: monitor.url,
        condition: conditionLabel(monitor.condition),
        status: 'AUTHENTICATION_REQUIRED',
        deliveryPolicy: monitor.notificationPolicy ?? { channels: ['browser'] }
      },
    }, systemPrincipal(monitor.tenantId));
  }

  const previouslyTriggered = Boolean(monitor.lastEvaluation?.triggered);
  if (!options.skipNotification && !previouslyTriggered && evaluation.triggered && nextStatus !== 'AUTHENTICATION_REQUIRED') {
    const summaryValue = observation.numericValue != null ? `$${observation.numericValue}` : observation.valueText || conditionLabel(monitor.condition);
    const deliveryPolicy = monitor.notificationPolicy ?? { channels: ['browser'] };
    const triggerId = createHash('sha256')
      .update(`${monitor.id}:${observationId}:${JSON.stringify(evaluation)}`)
      .digest('hex')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
    const triggerCollection = collection(application, TRIGGER_EVENTS);
    if (await triggerCollection.get(triggerId)) {
      return;
    }
    const notification = await createNotificationEvent(application, {
      tenantId: monitor.tenantId,
      recipient: monitor.ownerId,
      type: 'monitor_triggered',
      title: 'Monitor triggered',
      body: `${monitor.pageTitle}: ${summaryValue}`,
      priority: 'high',
      channel: deliveryPolicy.channels.includes('browser') ? 'browser' : undefined,
      source: { type: 'monitor', id: monitor.id },
      data: {
        monitorId: monitor.id,
        observationId,
        url: monitor.url,
        value: summaryValue,
        condition: monitor.condition,
        observedAt,
        observedValues: {
          valueText: observation.valueText,
          numericValue: observation.numericValue,
          present: observation.present,
          selector: observation.selector
        },
        evidence: {
          observationId,
          evaluation
        },
        deliveryPolicy
      },
    }, systemPrincipal(monitor.tenantId));
    await triggerCollection.insert({
      id: triggerId,
      type: 'monitor_triggered',
      monitorId: monitor.id,
      observationId,
      observedAt,
      condition: monitor.condition,
      observedValues: {
        valueText: observation.valueText,
        numericValue: observation.numericValue,
        present: observation.present,
        selector: observation.selector
      },
      evidence: { evaluation },
      deliveryPolicy,
      notificationId: notification.id
    }, triggerId);
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
    observationMode: input.observationMode ?? 'public',
    authenticationState: normalizeAuthState(input.authenticationState ?? 'public'),
    notificationPolicy: {
      channels: [...new Set(
        Array.isArray(input.notificationPolicy?.channels)
          ? input.notificationPolicy.channels.filter((channel) => typeof channel === 'string' && channel.trim())
          : ['browser']
      )]
    },
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

  const initialObservation = input.initialObservation
    ? {
        ...input.initialObservation,
        authentication: normalizeAuthState(input.initialObservation.authentication)
      }
    : null;
  const initialEvaluation = initialObservation?.authentication === 'authentication_required'
    ? { triggered: false, summary: 'Sign-in required' }
    : initialObservation
      ? evaluateObservation(monitor, initialObservation, null)
      : input.initialEvaluation;

  if (initialObservation && initialEvaluation) {
    await recordObservation(application, { ...monitor, scheduleId: schedule.id }, initialObservation, initialEvaluation, {
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

  if (monitor.observationMode === 'authenticated_browser') {
    const pendingId = randomUUID();
    await collection(application, PENDING_OBSERVATIONS).insert({
      id: pendingId,
      monitorId: monitor.id,
      tenantId: monitor.tenantId,
      ownerId: monitor.ownerId,
      url: monitor.url,
      condition: monitor.condition,
      target: monitor.target,
      createdAt: new Date().toISOString(),
      jobId: job.id
    }, pendingId);
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
    'GET /api/observations/pending': async ({ tenantId, principal }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.read');
      const items = await collection(application, PENDING_OBSERVATIONS).find({
        tenantId,
        ownerId: authenticated.principalId
      });
      return { items };
    },
    'POST /api/observations/submit': async ({ tenantId, principal, body }) => {
      const authenticated = requirePrincipal(principal);
      requireScope(authenticated, 'monitors.write');
      const { pendingId, observation } = body ?? {};
      if (!pendingId || !observation) {
        throw Object.assign(new Error('pendingId and observation are required'), { status: 400, code: 'INVALID_INPUT' });
      }

      // Sanitize observation to ensure no credentials or secrets ever enter the state
      const {
        url, observedAt, execution, authentication,
        valueText, numericValue, present, selector, error
      } = observation;
      const sanitizedObservation = {
        url,
        observedAt,
        execution,
        authentication: normalizeAuthState(authentication),
        ...(valueText !== undefined ? { valueText } : {}),
        ...(numericValue !== undefined ? { numericValue } : {}),
        ...(present !== undefined ? { present } : {}),
        ...(selector !== undefined ? { selector } : {}),
        ...(error !== undefined ? { error } : {})
      };

      const pending = await collection(application, PENDING_OBSERVATIONS).get(pendingId);
      if (!pending || pending.tenantId !== tenantId || pending.ownerId !== authenticated.principalId) {
        throw Object.assign(new Error('Pending observation not found'), { status: 404, code: 'NOT_FOUND' });
      }

      const monitor = await collection(application, MONITORS).get(pending.monitorId);
      if (!monitor || monitor.deletedAt) {
        await collection(application, PENDING_OBSERVATIONS).delete(pendingId);
        throw Object.assign(new Error('Monitor not found or deleted'), { status: 404, code: 'NOT_FOUND' });
      }

      if (monitor.status === 'paused') {
        await collection(application, PENDING_OBSERVATIONS).delete(pendingId);
        return { ok: true };
      }

      if (sanitizedObservation.authentication === 'authentication_required') {
        const evaluation = { triggered: false, summary: 'Sign-in required' };
        await recordObservation(application, monitor, sanitizedObservation, evaluation, {
          observedAt: sanitizedObservation.observedAt || new Date().toISOString(),
          observationId: pendingId,
          source: 'extension-polling',
          jobId: pending.jobId
        });
        await collection(application, PENDING_OBSERVATIONS).delete(pendingId);
        return { ok: true };
      }

      const evaluation = evaluateObservation(monitor, sanitizedObservation, monitor.lastObservation);
      await recordObservation(application, monitor, sanitizedObservation, evaluation, {
        observedAt: sanitizedObservation.observedAt || new Date().toISOString(),
        observationId: pendingId,
        source: 'extension-polling',
        jobId: pending.jobId
      });

      await collection(application, PENDING_OBSERVATIONS).delete(pendingId);
      return { ok: true };
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
