import { appPortClient } from '../appport/client.js';
import { ExtensionAuth } from '../appport/auth.js';
import { evaluateCondition, parseConditionInput } from '../shared/conditions.js';

const NOTIFICATION_ALARM = 'appport-notifications-sync';
const NOTIFICATION_CACHE_KEY = 'shownNotifications';
const NOTIFICATION_LINKS_KEY = 'notificationLinks';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('Open a webpage before creating a monitor');
  }
  return tab;
}

async function captureMonitorDraft(condition) {
  const tab = await getActiveTab();
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'APPPORT_CAPTURE_MONITOR_DRAFT',
    condition
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Unable to inspect this page');
  }

  return response.data;
}

async function getOrCreateTabForUrl(url) {
  const tabs = await chrome.tabs.query({});
  const existingTab = tabs.find(t => t.url === url);
  if (existingTab) {
    await chrome.tabs.update(existingTab.id, { active: true });
    if (existingTab.windowId) {
      try {
        await chrome.windows.update(existingTab.windowId, { focused: true });
      } catch (err) {
        // window focus might fail
      }
    }
    return existingTab;
  } else {
    const newTab = await chrome.tabs.create({ url, active: false });
    return newTab;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function executePendingObservation(item) {
  const tab = await getOrCreateTabForUrl(item.url);
  await waitForTabComplete(tab.id);
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'APPPORT_OBSERVE_PAGE',
    condition: item.condition,
    target: item.target
  });
  
  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to observe page in content script');
  }
  
  await appPortClient.submitObservation({
    pendingId: item.id,
    observation: response.data
  });
}

async function pollPendingObservations() {
  const config = await appPortClient.getConfig();
  if (!config) {
    return;
  }
  
  try {
    const pending = await appPortClient.getPendingObservations();
    if (!pending?.items || pending.items.length === 0) {
      return;
    }
    
    for (const item of pending.items) {
      try {
        await executePendingObservation(item);
      } catch (err) {
        console.error('Pending observation failed:', err);
        await appPortClient.submitObservation({
          pendingId: item.id,
          observation: {
            authentication: 'unknown',
            observedAt: new Date().toISOString(),
            url: item.url,
            execution: 'authenticated_browser',
            error: err.message
          }
        });
      }
    }
  } catch (err) {
    console.warn('Pending observation poll failed', err);
  }
}

async function syncNotifications() {
  const config = await appPortClient.getConfig();
  if (!config) {
    return { items: [] };
  }

  const [page, shown, links] = await Promise.all([
    appPortClient.listUnreadNotifications(),
    chrome.storage.local.get(NOTIFICATION_CACHE_KEY),
    chrome.storage.local.get(NOTIFICATION_LINKS_KEY)
  ]);

  const shownNotifications = shown[NOTIFICATION_CACHE_KEY] ?? {};
  const notificationLinks = links[NOTIFICATION_LINKS_KEY] ?? {};
  let changed = false;

  for (const notification of page.items ?? []) {
    if (shownNotifications[notification.id]) {
      continue;
    }

    shownNotifications[notification.id] = new Date().toISOString();
    notificationLinks[notification.id] = notification.data?.url || notification.source?.url || null;
    changed = true;

    await chrome.notifications.create(notification.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: notification.title,
      message: notification.body || 'A monitor changed.',
      contextMessage: notification.data?.condition ? String(notification.data.condition) : 'AppPort Web Monitor'
    });
  }

  if (changed) {
    await chrome.storage.local.set({
      [NOTIFICATION_CACHE_KEY]: shownNotifications,
      [NOTIFICATION_LINKS_KEY]: notificationLinks
    });
  }

  return page;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(NOTIFICATION_ALARM, { periodInMinutes: 1 });
  void pollPendingObservations();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(NOTIFICATION_ALARM, { periodInMinutes: 1 });
  void pollPendingObservations();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== NOTIFICATION_ALARM) {
    return;
  }

  try {
    await syncNotifications();
  } catch (error) {
    console.warn('Notification sync failed', error);
  }

  try {
    await pollPendingObservations();
  } catch (error) {
    console.warn('Pending observation poll failed', error);
  }
});

// Periodically poll for pending observations every 10 seconds while service worker is active
setInterval(pollPendingObservations, 10000);

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const stored = await chrome.storage.local.get(NOTIFICATION_LINKS_KEY);
  const url = stored[NOTIFICATION_LINKS_KEY]?.[notificationId];
  if (url) {
    await chrome.tabs.create({ url });
  }

  try {
    await appPortClient.markNotificationRead(notificationId);
  } catch (error) {
    console.warn('Failed to mark notification as read', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message?.type) {
        case 'APPPORT_GET_CONFIG':
          sendResponse({ ok: true, data: await appPortClient.getConfig() });
          return;
        case 'APPPORT_SET_CONFIG':
          sendResponse({ ok: true, data: await ExtensionAuth.authenticate(message.config) });
          return;
        case 'APPPORT_DETECT_AUTH': {
          try {
            const tab = await getActiveTab();
            const response = await chrome.tabs.sendMessage(tab.id, {
              type: 'APPPORT_DETECT_AUTH'
            }).catch(() => ({ ok: true, data: { state: 'unknown' } }));
            sendResponse(response);
          } catch (error) {
            sendResponse({ ok: true, data: { state: 'unknown' } });
          }
          return;
        }
        case 'APPPORT_GET_CURRENT_PAGE': {
          const tab = await getActiveTab();
          sendResponse({ ok: true, data: { url: tab.url, title: tab.title } });
          return;
        }
        case 'APPPORT_LIST_MONITORS':
          sendResponse({ ok: true, data: await appPortClient.listMonitors() });
          return;
        case 'APPPORT_GET_MONITOR':
          sendResponse({ ok: true, data: await appPortClient.getMonitor(message.id) });
          return;
        case 'APPPORT_CREATE_MONITOR': {
          const condition = parseConditionInput(message.conditionInput);
          const draft = await captureMonitorDraft(condition);
          const initialEvaluation = evaluateCondition(condition, draft.initialObservation, null);
          
          const authState = draft.authentication ?? 'public';
          const observationMode = (authState === 'authenticated' || authState === 'required')
            ? 'authenticated_browser'
            : 'public';

          const created = await appPortClient.createMonitor({
            url: draft.url,
            title: draft.title,
            conditionInput: message.conditionInput,
            condition,
            schedule: message.schedule,
            target: draft.target,
            initialObservation: draft.initialObservation,
            initialEvaluation,
            notes: draft.notes || '',
            observationMode,
            authenticationState: authState
          });
          sendResponse({ ok: true, data: created });
          return;
        }
        case 'APPPORT_PAUSE_MONITOR':
          sendResponse({ ok: true, data: await appPortClient.pauseMonitor(message.id) });
          return;
        case 'APPPORT_RESUME_MONITOR':
          sendResponse({ ok: true, data: await appPortClient.resumeMonitor(message.id) });
          return;
        case 'APPPORT_DELETE_MONITOR':
          sendResponse({ ok: true, data: await appPortClient.deleteMonitor(message.id) });
          return;
        case 'APPPORT_SYNC_NOTIFICATIONS':
          sendResponse({ ok: true, data: await syncNotifications() });
          return;
        default:
          sendResponse({ ok: false, error: 'Unsupported message type' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
