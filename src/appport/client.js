const CONFIG_KEY = 'appportConfig';

export async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return stored[CONFIG_KEY] ?? null;
}

export async function setConfig(config) {
  const trimmed = {
    baseUrl: String(config.baseUrl ?? '').trim().replace(/\/$/, ''),
    tenantId: String(config.tenantId ?? '').trim(),
    apiKey: String(config.apiKey ?? '').trim()
  };

  if (!trimmed.baseUrl || !trimmed.tenantId || !trimmed.apiKey) {
    throw new Error('Service URL, tenant ID, and API key are required');
  }

  await chrome.storage.local.set({ [CONFIG_KEY]: trimmed });
  return trimmed;
}

async function request(path, init = {}) {
  const config = await getConfig();
  if (!config) {
    throw new Error('Configure the AppPort service URL, tenant ID, and API key first');
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + config.apiKey,
      'x-appport-tenant': config.tenantId,
      ...(init.headers ?? {})
    }
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `Request failed with ${response.status}`);
  }

  return payload;
}

export const appPortClient = {
  getConfig,
  setConfig,
  getSession() {
    return request('/api/session');
  },
  listMonitors() {
    return request('/api/monitors');
  },
  getMonitor(id) {
    return request(`/api/monitor?id=${encodeURIComponent(id)}`);
  },
  createMonitor(body) {
    return request('/api/monitors', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },
  pauseMonitor(id) {
    return request('/api/monitors/pause', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
  },
  resumeMonitor(id) {
    return request('/api/monitors/resume', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
  },
  deleteMonitor(id) {
    return request('/api/monitors/delete', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
  },
  getPendingObservations() {
    return request('/api/observations/pending');
  },
  submitObservation(body) {
    return request('/api/observations/submit', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },
  listUnreadNotifications() {
    return request('/_appport/notifications?unread=true&limit=25');
  },
  markNotificationRead(id) {
    return request(`/_appport/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }
};
