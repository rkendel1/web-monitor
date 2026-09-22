import { randomUUID } from 'node:crypto';
import { normalizeText, parseCurrencyValue } from '../shared/conditions.js';
import { observeHtml } from './observation.js';

export const EXECUTION_MODES = Object.freeze({
  AUTHENTICATED_BROWSER: 'authenticated_browser',
  SERVICE: 'service'
});

export const EXECUTION_STATES = Object.freeze({
  AVAILABLE: 'available',
  AUTHENTICATION_REQUIRED: 'authentication_required',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
});

export const observationResult = (observation) => ({ kind: 'observation', observation });
export const authenticationRequiredResult = (reason = 'authentication_required', evidence = {}) => ({
  kind: 'authentication_required',
  reason,
  evidence: {
    reason,
    ...evidence
  }
});
export const unavailableResult = (reason = 'executor_unavailable', evidence = {}) => ({
  kind: 'unavailable',
  reason,
  evidence: {
    reason,
    ...evidence
  }
});
export const errorResult = (error) => ({
  kind: 'error',
  error
});

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key'
]);

function stripSensitiveHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_HEADERS.has(String(name).toLowerCase())));
}

function getByPath(source, path) {
  if (!path) {
    return source;
  }

  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((value, segment) => {
      if (value == null) {
        return undefined;
      }
      if (Array.isArray(value) && /^\d+$/.test(segment)) {
        return value[Number(segment)];
      }
      return value[segment];
    }, source);
}

function serializeValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function extractObservedValues(monitor, payload) {
  const candidate = getByPath(payload, monitor.target?.valuePath ?? monitor.target?.path);

  switch (monitor.condition?.type) {
    case 'numeric_threshold': {
      const numericValue = typeof candidate === 'number'
        ? candidate
        : parseCurrencyValue(serializeValue(candidate));
      return {
        valueText: serializeValue(candidate),
        numericValue
      };
    }
    case 'text_appears':
    case 'text_disappears': {
      const valueText = serializeValue(candidate ?? payload);
      return {
        valueText,
        present: normalizeText(valueText).includes(normalizeText(monitor.condition.text))
      };
    }
    case 'value_changes':
      return {
        valueText: serializeValue(candidate)
      };
    case 'element_appears':
      return {
        valueText: serializeValue(candidate),
        present: Boolean(candidate)
      };
    default:
      return {
        valueText: serializeValue(candidate)
      };
  }
}

function sanitizeServiceError(error) {
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'service_request_failed';
  return {
    code,
    message: 'Service request failed'
  };
}

const HEARTBEATS = 'ObservationExecutorHeartbeats';

function collection(application) {
  return application.state.collection(HEARTBEATS);
}

export function createAuthenticatedBrowserExecutor(application, {
  heartbeatTtlMs = 30_000,
  executorId = 'authenticated-browser'
} = {}) {
  return {
    executionMode: EXECUTION_MODES.AUTHENTICATED_BROWSER,
    async isAvailable(request) {
      const tenantId = typeof request === 'string' ? request : request?.tenantId;
      const heartbeat = await collection(application).get(`${tenantId}:${executorId}`);
      return Boolean(heartbeat && Date.parse(heartbeat.heartbeatAt) + heartbeatTtlMs > Date.now());
    },
    async observe(monitor) {
      const pendingId = randomUUID();
      await application.state.collection('PendingObservations').insert({
        id: pendingId,
        monitorId: monitor.id,
        tenantId: monitor.tenantId,
        ownerId: monitor.ownerId,
        url: monitor.url,
        condition: monitor.condition,
        target: monitor.target,
        createdAt: new Date().toISOString()
      }, pendingId);
      return observationResult({ pendingId });
    },
    executorId
  };
}

export function createServiceObservationExecutor(application, {
  executorId = 'service-http',
  fetch: fetchImpl = application.fetch ?? globalThis.fetch,
  resolveAuthorizationContext = application.resolveServiceAuthorizationContext?.bind(application)
} = {}) {
  return {
    executionMode: EXECUTION_MODES.SERVICE,
    executorId,
    async isAvailable() {
      return true;
    },
    async observe(monitor) {
      const execution = monitor.execution ?? {};
      const authorizationContext = execution.authorizationContext;
      let resolvedAuthorization = null;
      if (authorizationContext) {
        if (!resolveAuthorizationContext) {
          return authenticationRequiredResult('authentication_required', {
            executor: EXECUTION_MODES.SERVICE,
            executionMode: EXECUTION_MODES.SERVICE
          });
        }
        resolvedAuthorization = await resolveAuthorizationContext({
          authorizationContext,
          tenantId: monitor.tenantId,
          ownerId: monitor.ownerId,
          monitorId: monitor.id
        });
        if (!resolvedAuthorization?.headers || Object.keys(resolvedAuthorization.headers).length === 0) {
          return authenticationRequiredResult('authentication_required', {
            executor: EXECUTION_MODES.SERVICE,
            executionMode: EXECUTION_MODES.SERVICE
          });
        }
      }

      const requestConfig = monitor.target?.request ?? {};
      const headers = {
        'user-agent': 'AppPort-Web-Monitor/1.0',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
        ...stripSensitiveHeaders(requestConfig.headers),
        ...(resolvedAuthorization?.headers ?? {})
      };

      let body = requestConfig.body;
      if (body && typeof body === 'object' && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
      }

      let response;
      try {
        response = await fetchImpl(monitor.url, {
          method: requestConfig.method ?? 'GET',
          headers,
          ...(body !== undefined ? { body } : {})
        });
      } catch (error) {
        return unavailableResult('service_unavailable', {
          executor: EXECUTION_MODES.SERVICE,
          executionMode: EXECUTION_MODES.SERVICE
        });
      }

      if (response.status === 401 || response.status === 403) {
        return authenticationRequiredResult('authentication_required', {
          executor: EXECUTION_MODES.SERVICE,
          executionMode: EXECUTION_MODES.SERVICE
        });
      }

      if ([429, 502, 503, 504].includes(response.status)) {
        return unavailableResult('service_unavailable', {
          executor: EXECUTION_MODES.SERVICE,
          executionMode: EXECUTION_MODES.SERVICE
        });
      }

      if (!response.ok) {
        return errorResult(sanitizeServiceError({
          code: 'service_request_failed'
        }));
      }

      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();
      if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
        const observedValues = observeHtml(monitor, raw);
        return observationResult({
          executor: EXECUTION_MODES.SERVICE,
          executionMode: EXECUTION_MODES.SERVICE,
          observedAt: new Date().toISOString(),
          subject: monitor.target?.subject ?? monitor.url,
          values: {
            ...(observedValues.valueText !== undefined ? { valueText: observedValues.valueText } : {}),
            ...(observedValues.numericValue !== undefined ? { numericValue: observedValues.numericValue } : {}),
            ...(observedValues.present !== undefined ? { present: observedValues.present } : {}),
            ...(observedValues.selector !== undefined ? { selector: observedValues.selector } : {})
          },
          evidence: {
            status: response.status,
            contentType
          },
          ...observedValues
        });
      }

      let payload = raw;
      if (contentType.includes('application/json')) {
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch (error) {
          return errorResult(sanitizeServiceError({
            code: 'service_response_invalid'
          }));
        }
      }

      const observedValues = extractObservedValues(monitor, payload);
      return observationResult({
        executor: EXECUTION_MODES.SERVICE,
        executionMode: EXECUTION_MODES.SERVICE,
        observedAt: new Date().toISOString(),
        subject: monitor.target?.subject ?? monitor.url,
        values: {
          ...(observedValues.valueText !== undefined ? { valueText: observedValues.valueText } : {}),
          ...(observedValues.numericValue !== undefined ? { numericValue: observedValues.numericValue } : {}),
          ...(observedValues.present !== undefined ? { present: observedValues.present } : {})
        },
        evidence: {
          status: response.status,
          contentType
        },
        ...observedValues
      });
    }
  };
}

export function createObservationExecutorRegistry() {
  const executors = new Map();
  return {
    register(executor) {
      if (!executor?.executionMode) {
        throw new Error('Observation executors must define executionMode');
      }
      executors.set(executor.executionMode, executor);
      return this;
    },
    resolve(executionMode) {
      return executors.get(executionMode) ?? null;
    }
  };
}

export async function recordExecutorHeartbeat(application, {
  tenantId,
  executionMode = EXECUTION_MODES.AUTHENTICATED_BROWSER,
  executorId = 'authenticated-browser'
}) {
  const heartbeatAt = new Date().toISOString();
  const id = `${tenantId}:${executorId}`;
  await collection(application).insert({
    id,
    tenantId,
    executionMode,
    executorId,
    heartbeatAt
  }, id);
  return { executionMode, executorId, heartbeatAt };
}

export { HEARTBEATS as EXECUTOR_HEARTBEATS_COLLECTION };
