import { conditionLabel, intervalLabel } from '../shared/conditions.js';

const listElement = document.querySelector('#monitor-list');
const detailElement = document.querySelector('#monitor-detail');
const statusElement = document.querySelector('#status');
let selectedMonitorId = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) {
      throw new Error(response?.error || 'Operation failed');
    }
    return response.data;
  });
}

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? '#b42318' : '#0b6e4f';
}

function formatObservation(observation) {
  const dateStr = new Date(observation.observedAt).toLocaleString();
  const authState = observation.observation?.authentication;
  const isAuthFailure = authState === 'authentication_required';
  const executionText = observation.observation?.execution === 'authenticated_browser' ? ' [Auth Browser]' : '';

  if (isAuthFailure) {
    return `<li style="color: #b42318; background-color: #fcf1f1; border-left: 3px solid #fecdca; padding: 4px 8px; margin-bottom: 4px; list-style-type: none;">
              ${dateStr} · <strong>Authentication Failure (Sign-in required)</strong>${executionText}
            </li>`;
  }

  const value = observation.observation?.numericValue != null
    ? `$${observation.observation.numericValue}`
    : observation.observation?.valueText || 'No value';

  if (observation.evaluation?.triggered) {
    return `<li style="color: #0b6e4f; background-color: #e6f4ea; border-left: 3px solid #34a853; padding: 4px 8px; margin-bottom: 4px; list-style-type: none;">
              ${dateStr} · <strong>Condition Match</strong> (Value: ${value})${executionText} · Notification Sent
            </li>`;
  }

  return `<li style="padding: 4px 8px; margin-bottom: 4px; list-style-type: none;">
            ${dateStr} · Target-page observation (Value: ${value})${executionText}
          </li>`;
}

async function loadMonitors() {
  const result = await sendMessage({ type: 'APPPORT_LIST_MONITORS' });
  const items = result.items ?? [];

  listElement.innerHTML = items.length
    ? items.map((monitor) => {
        const isAuthRequired = monitor.status === 'AUTHENTICATION_REQUIRED';
        const statusText = isAuthRequired ? 'Sign-in required' : monitor.status;
        const warningBox = isAuthRequired
          ? `<div class="auth-required-box" style="margin-top: 6px; padding: 6px 8px; background-color: #fef0c7; border: 1px solid #fec84b; border-radius: 4px; font-size: 11px; color: #b54708;">
               <strong>Sign-in required</strong><br>Open the page, sign in, and this monitor will continue automatically.
             </div>`
          : '';
        return `
        <article class="card" data-monitor-id="${monitor.id}">
          <div class="row between">
            <div>
              <strong>${monitor.pageTitle}</strong>
              <div>${conditionLabel(monitor.condition)}</div>
              <div class="muted">${intervalLabel(monitor.scheduleInterval)} · ${statusText} · Notifications: ${(monitor.notificationPolicy?.channels ?? ['browser']).join(', ')}</div>
              ${warningBox}
            </div>
            <div class="row">
              <button class="secondary" data-action="${monitor.status === 'paused' ? 'resume' : 'pause'}" data-monitor-id="${monitor.id}" type="button">${monitor.status === 'paused' ? 'Resume' : 'Pause'}</button>
              <button data-action="delete" data-monitor-id="${monitor.id}" type="button">Delete</button>
            </div>
          </div>
        </article>
      `}).join('')
    : '<p class="muted">No monitors yet.</p>';

  if (!selectedMonitorId && items[0]) {
    selectedMonitorId = items[0].id;
  }

  if (selectedMonitorId) {
    await loadMonitorDetail(selectedMonitorId);
  } else {
    detailElement.textContent = 'No monitor selected.';
  }
}

async function loadMonitorDetail(id) {
  selectedMonitorId = id;
  const result = await sendMessage({ type: 'APPPORT_GET_MONITOR', id });
  const { monitor, observations } = result;

  const isAuthRequired = monitor.status === 'AUTHENTICATION_REQUIRED';
  const statusText = isAuthRequired ? 'Sign-in required' : monitor.status;
  const warningBox = isAuthRequired
    ? `<div style="padding: 10px; background-color: #fef0c7; border: 1px solid #fec84b; border-radius: 6px; color: #b54708; margin-bottom: 10px;">
         <strong>Sign-in required</strong>
         <p style="margin: 4px 0 0 0; font-size: 13px;">Open the page, sign in, and this monitor will continue automatically.</p>
       </div>`
    : '';

  detailElement.innerHTML = `
    <div class="stack">
      ${warningBox}
      <strong>${monitor.pageTitle}</strong>
      <div>${monitor.url}</div>
      <div><strong>Condition:</strong> ${conditionLabel(monitor.condition)}</div>
      <div><strong>Status:</strong> ${statusText}</div>
      <div><strong>Schedule:</strong> ${intervalLabel(monitor.scheduleInterval)}</div>
      <div><strong>Notifications:</strong> ${(monitor.notificationPolicy?.channels ?? ['browser']).join(', ')}</div>
      <div><strong>Last checked:</strong> ${monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleString() : 'Not yet checked'}</div>
      <div><strong>Current:</strong> ${monitor.lastObservation?.numericValue != null ? `$${monitor.lastObservation.numericValue}` : monitor.lastObservation?.valueText || 'No observation yet'}</div>
      <div><strong>History</strong></div>
      <ul style="padding-left: 0;">${(observations ?? []).map(formatObservation).join('') || '<li>No observations yet.</li>'}</ul>
    </div>
  `;
}

document.querySelector('#refresh').addEventListener('click', async () => {
  try {
    await loadMonitors();
    setStatus('Refreshed monitor state.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

listElement.addEventListener('click', async (event) => {
  const monitorId = event.target.dataset.monitorId || event.target.closest('[data-monitor-id]')?.dataset.monitorId;
  const action = event.target.dataset.action;

  try {
    if (action === 'pause') {
      await sendMessage({ type: 'APPPORT_PAUSE_MONITOR', id: monitorId });
      setStatus('Monitor paused.');
      await loadMonitors();
      return;
    }

    if (action === 'resume') {
      await sendMessage({ type: 'APPPORT_RESUME_MONITOR', id: monitorId });
      setStatus('Monitor resumed.');
      await loadMonitors();
      return;
    }

    if (action === 'delete') {
      await sendMessage({ type: 'APPPORT_DELETE_MONITOR', id: monitorId });
      setStatus('Monitor deleted.');
      selectedMonitorId = null;
      await loadMonitors();
      return;
    }

    if (monitorId) {
      await loadMonitorDetail(monitorId);
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

try {
  await loadMonitors();
} catch (error) {
  setStatus(error.message, true);
}
