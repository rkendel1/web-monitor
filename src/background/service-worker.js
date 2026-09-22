import { appPortClient } from '../appport/client.js';
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
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(NOTIFICATION_ALARM, { periodInMinutes: 1 });
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
});

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
          sendResponse({ ok: true, data: await appPortClient.setConfig(message.config) });
          return;
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
          const created = await appPortClient.createMonitor({
            url: draft.url,
            title: draft.title,
            conditionInput: message.conditionInput,
            condition,
            schedule: message.schedule,
            target: draft.target,
            initialObservation: draft.initialObservation,
            initialEvaluation,
            notes: draft.notes || ''
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
