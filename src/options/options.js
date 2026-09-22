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

function executionLabel(mode) {
  if (mode === 'authenticated_browser') {
    return 'Browser';
  }
  if (mode === 'service') {
    return 'Service';
  }
  return mode || 'Unknown';
}

function availabilityLabel(state) {
  if (state === 'authentication_required') {
    return 'Sign-in required';
  }
  if (state === 'available') {
    return 'Available';
  }
  if (state === 'unavailable') {
    return 'Unavailable';
  }
  if (state === 'error') {
    return 'Error';
  }
  return state || 'Unknown';
}

function lastObservedLabel(monitor) {
  return monitor.lastObservation?.observedAt || monitor.lastCheckedAt;
}

function formatObservation(observation) {
  const dateStr = new Date(observation.observedAt).toLocaleString();
  const authState = observation.observation?.authentication;
  const isAuthFailure = authState === 'authentication_required';
  const executionText = ` [${executionLabel(observation.observation?.executionMode ?? observation.observation?.execution)}]`;

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
        const isAuthRequired = monitor.executionState === 'authentication_required' || monitor.status === 'AUTHENTICATION_REQUIRED';
      const warningBox = isAuthRequired
        ? `<div class="auth-required-box" style="margin-top: 6px; padding: 6px 8px; background-color: #fef0c7; border: 1px solid #fec84b; border-radius: 4px; font-size: 11px; color: #b54708;">
             <strong>Sign-in required</strong><br>Open the page, sign in, and this monitor will continue automatically.
           </div>`
        : monitor.executionState === 'unavailable'
          ? `<div class="auth-required-box" style="margin-top: 6px; padding: 6px 8px; background-color: #eff6ff; border: 1px solid #93c5fd; border-radius: 4px; font-size: 11px; color: #1d4ed8;">
               <strong>${executionLabel(monitor.execution?.mode ?? monitor.executionMode)} unavailable</strong><br>Monitoring remains active and will resume automatically when the executor becomes available.
             </div>`
        : '';
      return `
      <article class="card" data-monitor-id="${monitor.id}">
        <div class="row between">
          <div>
            <strong>${monitor.pageTitle}</strong>
            <div>${conditionLabel(monitor.condition)}</div>
            <div class="muted">Status: ${monitor.status} · Execution: ${executionLabel(monitor.execution?.mode ?? monitor.executionMode)} · Availability: ${availabilityLabel(monitor.executionState)} · ${intervalLabel(monitor.scheduleInterval)}</div>
            <div class="muted">Last observed: ${lastObservedLabel(monitor) ? new Date(lastObservedLabel(monitor)).toLocaleString() : 'Not yet observed'} · Notifications: ${(monitor.notificationPolicy?.channels ?? ['browser']).join(', ')}</div>
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

  const isAuthRequired = monitor.executionState === 'authentication_required' || monitor.status === 'AUTHENTICATION_REQUIRED';
  const warningBox = isAuthRequired
    ? `<div style="padding: 10px; background-color: #fef0c7; border: 1px solid #fec84b; border-radius: 6px; color: #b54708; margin-bottom: 10px;">
         <strong>Sign-in required</strong>
         <p style="margin: 4px 0 0 0; font-size: 13px;">Open the page, sign in, and this monitor will continue automatically.</p>
       </div>`
    : monitor.executionState === 'unavailable'
      ? `<div style="padding: 10px; background-color: #eff6ff; border: 1px solid #93c5fd; border-radius: 6px; color: #1d4ed8; margin-bottom: 10px;">
           <strong>${executionLabel(monitor.execution?.mode ?? monitor.executionMode)} executor unavailable</strong>
           <p style="margin: 4px 0 0 0; font-size: 13px;">Monitoring remains active and the existing schedule stays intact until the executor becomes available again.</p>
         </div>`
    : '';

  detailElement.innerHTML = `
    <div class="stack">
      ${warningBox}
      <strong>${monitor.pageTitle}</strong>
      <div>${monitor.url}</div>
      <div><strong>Condition:</strong> ${conditionLabel(monitor.condition)}</div>
      <div><strong>Status:</strong> ${monitor.status}</div>
      <div><strong>Execution:</strong> ${executionLabel(monitor.execution?.mode ?? monitor.executionMode)}</div>
      <div><strong>Availability:</strong> ${availabilityLabel(monitor.executionState)}</div>
      <div><strong>Schedule:</strong> ${intervalLabel(monitor.scheduleInterval)}</div>
      <div><strong>Notifications:</strong> ${(monitor.notificationPolicy?.channels ?? ['browser']).join(', ')}</div>
      <div><strong>Last observed:</strong> ${lastObservedLabel(monitor) ? new Date(lastObservedLabel(monitor)).toLocaleString() : 'Not yet observed'}</div>
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
