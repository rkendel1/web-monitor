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
  const value = observation.observation?.numericValue != null
    ? `$${observation.observation.numericValue}`
    : observation.observation?.valueText || 'No value';
  const evaluation = observation.evaluation?.triggered ? 'Triggered' : '';
  return `<li>${new Date(observation.observedAt).toLocaleString()} · ${value} ${evaluation}</li>`;
}

async function loadMonitors() {
  const result = await sendMessage({ type: 'APPPORT_LIST_MONITORS' });
  const items = result.items ?? [];

  listElement.innerHTML = items.length
    ? items.map((monitor) => `
        <article class="card" data-monitor-id="${monitor.id}">
          <div class="row between">
            <div>
              <strong>${monitor.pageTitle}</strong>
              <div>${conditionLabel(monitor.condition)}</div>
              <div class="muted">${intervalLabel(monitor.scheduleInterval)} · ${monitor.status}</div>
            </div>
            <div class="row">
              <button class="secondary" data-action="${monitor.status === 'paused' ? 'resume' : 'pause'}" data-monitor-id="${monitor.id}" type="button">${monitor.status === 'paused' ? 'Resume' : 'Pause'}</button>
              <button data-action="delete" data-monitor-id="${monitor.id}" type="button">Delete</button>
            </div>
          </div>
        </article>
      `).join('')
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
  detailElement.innerHTML = `
    <div class="stack">
      <strong>${monitor.pageTitle}</strong>
      <div>${monitor.url}</div>
      <div><strong>Condition:</strong> ${conditionLabel(monitor.condition)}</div>
      <div><strong>Status:</strong> ${monitor.status}</div>
      <div><strong>Schedule:</strong> ${intervalLabel(monitor.scheduleInterval)}</div>
      <div><strong>Last checked:</strong> ${monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleString() : 'Not yet checked'}</div>
      <div><strong>Current:</strong> ${monitor.lastObservation?.numericValue != null ? `$${monitor.lastObservation.numericValue}` : monitor.lastObservation?.valueText || 'No observation yet'}</div>
      <div><strong>History</strong></div>
      <ul>${(observations ?? []).map(formatObservation).join('') || '<li>No observations yet.</li>'}</ul>
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
