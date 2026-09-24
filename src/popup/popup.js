import { CreateExtensionServiceWorkerMLCEngine } from '@mlc-ai/web-llm';
import { conditionLabel, intervalLabel } from '../shared/conditions.js';
import { createMonitorIntentCompiler } from '../shared/monitor-intent.js';

const LOCAL_MODEL = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

const statusElement = document.querySelector('#status');
const pageUrlElement = document.querySelector('#page-url');
const monitorListElement = document.querySelector('#monitor-list');
const monitorCountElement = document.querySelector('#monitor-count');
let currentPage = null;
let compilerPromise = null;

function localCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      if (!navigator.gpu) {
        throw new Error('WebGPU is required to run the local WebLLM model.');
      }
      const engine = await CreateExtensionServiceWorkerMLCEngine(LOCAL_MODEL, {
        initProgressCallback(report) {
          setStatus(`Local AI: ${report.text}`);
        }
      });
      return createMonitorIntentCompiler({
        model: {
          async generate(input) {
            const completion = await engine.chat.completions.create({
              messages: [
                {
                  role: 'system',
                  content: `${input.instructions} You compile webpage monitoring requests. Produce JSON only.`
                },
                {
                  role: 'user',
                  content: JSON.stringify(input.request)
                }
              ],
              response_format: {
                type: 'json_object',
                schema: JSON.stringify(input.schema)
              },
              temperature: 0,
              max_tokens: 700
            });
            return completion.choices[0]?.message?.content;
          }
        }
      });
    })().catch((error) => {
      compilerPromise = null;
      throw error;
    });
  }
  return compilerPromise;
}

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

function renderMonitors(items) {
  monitorCountElement.textContent = `${items.length} active monitor${items.length === 1 ? '' : 's'}`;
  monitorListElement.innerHTML = items.length
    ? items.map((monitor) => {
        const isAuthRequired = monitor.executionState === 'authentication_required' || monitor.status === 'AUTHENTICATION_REQUIRED';
        const warningBox = isAuthRequired
          ? `<div class="auth-required-box" style="margin-top: 6px; padding: 6px 8px; background-color: #fef0c7; border: 1px solid #fec84b; border-radius: 4px; font-size: 11px; color: #b54708;">
               <strong>Sign-in required</strong><br>Open the page, sign in, and this monitor will continue automatically.
             </div>`
          : monitor.executionState === 'unavailable'
            ? `<div class="auth-required-box" style="margin-top: 6px; padding: 6px 8px; background-color: #eff6ff; border: 1px solid #93c5fd; border-radius: 4px; font-size: 11px; color: #1d4ed8;">
                 <strong>${executionLabel(monitor.execution?.mode ?? monitor.executionMode)} unavailable</strong><br>Monitoring stays active and will resume automatically.
               </div>`
          : '';
        return `
          <li>
            <strong>${monitor.pageTitle}</strong>
            <div>${conditionLabel(monitor.condition)}</div>
            <div class="muted">Status: ${monitor.status} · Execution: ${executionLabel(monitor.execution?.mode ?? monitor.executionMode)} · Availability: ${availabilityLabel(monitor.executionState)}</div>
            <div class="muted">${intervalLabel(monitor.scheduleInterval)} · Notifications: ${(monitor.notificationPolicy?.channels ?? ['browser']).join(', ')}</div>
            ${warningBox}
          </li>
        `;
      }).join('')
    : '<li class="muted">No monitors yet.</li>';
}

async function loadPage() {
  try {
    const page = await sendMessage({ type: 'APPPORT_GET_CURRENT_PAGE' });
    currentPage = page;
    pageUrlElement.textContent = page?.url || 'No active page';

    const authDetection = await sendMessage({ type: 'APPPORT_DETECT_AUTH' }).catch(() => null);
    const authWarning = document.querySelector('#auth-warning');
    const authState = authDetection?.data?.state;
    if (authState === 'authenticated' || authState === 'authentication_required') {
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
    setStatus('Loading the local AI model. The first run downloads and caches it…');
    const compiler = await localCompiler();
    setStatus('Local AI is interpreting the request…');
    const draft = await compiler.compile({
      text: form.condition.value,
      context: {
        currentPage: {
          url: currentPage?.url,
          title: currentPage?.title
        }
      }
    });
    await sendMessage({
      type: 'APPPORT_CREATE_MONITOR',
      conditionInput: form.condition.value,
      schedule: form.schedule.value,
      draft
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
