import { conditionLabel, intervalLabel } from '../shared/conditions.js';

const statusElement = document.querySelector('#status');
const pageUrlElement = document.querySelector('#page-url');
const monitorListElement = document.querySelector('#monitor-list');
const monitorCountElement = document.querySelector('#monitor-count');

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

function renderMonitors(items) {
  monitorCountElement.textContent = `${items.length} active monitor${items.length === 1 ? '' : 's'}`;
  monitorListElement.innerHTML = items.length
    ? items.map((monitor) => {
        const isAuthRequired = monitor.status === 'AUTHENTICATION_REQUIRED';
        const statusText = isAuthRequired ? 'Sign-in required' : monitor.status;
        const warningBox = isAuthRequired
          ? `<div class="auth-required-box" style="margin-top: 6px; padding: 6px 8px; background-color: #fef0c7; border: 1px solid #fec84b; border-radius: 4px; font-size: 11px; color: #b54708;">
               <strong>Sign-in required</strong><br>Open the page, sign in, and this monitor will continue automatically.
             </div>`
          : '';
        return `
          <li>
            <strong>${monitor.pageTitle}</strong>
            <div>${conditionLabel(monitor.condition)}</div>
            <div class="muted">${intervalLabel(monitor.scheduleInterval)} · ${statusText}</div>
            ${warningBox}
          </li>
        `;
      }).join('')
    : '<li class="muted">No monitors yet.</li>';
}

async function loadPage() {
  try {
    const page = await sendMessage({ type: 'APPPORT_GET_CURRENT_PAGE' });
    pageUrlElement.textContent = page?.url || 'No active page';

    const authDetection = await sendMessage({ type: 'APPPORT_DETECT_AUTH' }).catch(() => null);
    const authWarning = document.querySelector('#auth-warning');
    const authState = authDetection?.data?.state;
    if (authState === 'authenticated' || authState === 'required' || authState === 'authentication_required') {
      authWarning.style.display = 'block';
    } else {
      authWarning.style.display = 'none';
    }
  } catch (error) {
    pageUrlElement.textContent = error.message;
  }
}

async function loadConfig() {
  const config = await sendMessage({ type: 'APPPORT_GET_CONFIG' });
  if (!config) {
    return;
  }

  const form = document.querySelector('#config-form');
  form.baseUrl.value = config.baseUrl;
  form.tenantId.value = config.tenantId;
  form.apiKey.value = config.apiKey;
}

async function loadMonitors() {
  try {
    const result = await sendMessage({ type: 'APPPORT_LIST_MONITORS' });
    renderMonitors(result.items ?? []);
  } catch (error) {
    monitorCountElement.textContent = 'Connection required';
    monitorListElement.innerHTML = '<li class="muted">Save your AppPort connection to load monitors.</li>';
  }
}

document.querySelector('#config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await sendMessage({
      type: 'APPPORT_SET_CONFIG',
      config: {
        baseUrl: form.baseUrl.value,
        tenantId: form.tenantId.value,
        apiKey: form.apiKey.value
      }
    });
    setStatus('Connection saved.');
    await Promise.all([loadMonitors(), sendMessage({ type: 'APPPORT_SYNC_NOTIFICATIONS' })]);
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.querySelector('#monitor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await sendMessage({
      type: 'APPPORT_CREATE_MONITOR',
      conditionInput: form.condition.value,
      schedule: form.schedule.value
    });
    setStatus('Monitor created.');
    form.reset();
    form.schedule.value = '1h';
    await loadMonitors();
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.querySelector('#view-monitors').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

await Promise.all([loadPage(), loadConfig(), loadMonitors()]);
