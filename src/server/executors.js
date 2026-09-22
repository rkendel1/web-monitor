import { randomUUID } from 'node:crypto';

export const EXECUTION_MODES = Object.freeze({
  AUTHENTICATED_BROWSER: 'authenticated_browser'
});

export const EXECUTION_STATES = Object.freeze({
  AVAILABLE: 'available',
  AUTHENTICATION_REQUIRED: 'authentication_required',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
});

export const observationResult = (observation) => ({ kind: 'observation', observation });
export const authenticationRequiredResult = (reason = 'authentication_required') => ({
  kind: 'authentication_required',
  reason
});
export const unavailableResult = (reason = 'executor_unavailable') => ({ kind: 'unavailable', reason });
export const errorResult = (error) => ({
  kind: 'error',
  reason: error instanceof Error ? error.message : String(error)
});

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
    async isAvailable(tenantId) {
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
