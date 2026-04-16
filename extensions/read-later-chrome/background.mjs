import {
  READ_LATER_ENDPOINT,
  REQUEST_TIMEOUT_MS,
  NOTIFICATION_ICON_PATH,
  buildSavePayload,
  buildSaveSuccessNotification,
  humanizeSaveError,
  isSupportedPageUrl,
  parseSaveResponse,
  unsupportedUrlMessage,
} from './helpers.mjs';

const NOTIFICATION_TARGET_PREFIX = 'notificationTarget:';
const inFlightTabIds = new Set();

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  void handleNotificationClick(notificationId);
});

chrome.notifications.onClosed.addListener((notificationId) => {
  void clearNotificationTarget(notificationId);
});

async function handleActionClick(tab) {
  const tabId = Number.isInteger(tab?.id) ? tab.id : null;

  if (!isSupportedPageUrl(tab?.url)) {
    await showNotification({
      title: '无法保存当前页面',
      message: unsupportedUrlMessage(tab?.url),
    });
    return;
  }

  if (tabId !== null && inFlightTabIds.has(tabId)) {
    await showNotification({
      title: '正在保存',
      message: '这个标签页的保存请求还没完成。',
    });
    return;
  }

  try {
    if (tabId !== null) {
      inFlightTabIds.add(tabId);
      await setSavingBadge(tabId);
    }

    const result = await saveCurrentTab(tab);
    const notification = buildSaveSuccessNotification(result);
    const notificationId = await showNotification(notification);

    if (result.articleUrl) {
      await rememberNotificationTarget(notificationId, result.articleUrl);
    }
  } catch (error) {
    console.error('[read-later extension] save failed', error);
    await showNotification({
      title: '保存失败',
      message: humanizeSaveError(error),
    });
  } finally {
    if (tabId !== null) {
      inFlightTabIds.delete(tabId);
      await clearSavingBadge(tabId);
    }
  }
}

async function saveCurrentTab(tab) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(READ_LATER_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildSavePayload(tab)),
      signal: controller.signal,
    });
    const data = await readJsonSafely(response);
    return parseSaveResponse(response.status, data);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }

    if (error instanceof TypeError) {
      throw new Error('NETWORK_ERROR:unreachable');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function handleNotificationClick(notificationId) {
  const targetUrl = await getNotificationTarget(notificationId);
  await clearNotificationTarget(notificationId);
  await clearNotification(notificationId);

  if (!targetUrl) {
    return;
  }

  await createTab(targetUrl);
}

async function showNotification({ title, message }) {
  const notificationId = `read-later-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createNotification(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON_PATH),
    title,
    message,
  });
  return notificationId;
}

async function rememberNotificationTarget(notificationId, url) {
  await storageSet({
    [`${NOTIFICATION_TARGET_PREFIX}${notificationId}`]: url,
  });
}

async function getNotificationTarget(notificationId) {
  const key = `${NOTIFICATION_TARGET_PREFIX}${notificationId}`;
  const stored = await storageGet(key);
  return typeof stored[key] === 'string' ? stored[key] : '';
}

async function clearNotificationTarget(notificationId) {
  await storageRemove(`${NOTIFICATION_TARGET_PREFIX}${notificationId}`);
}

async function setSavingBadge(tabId) {
  await setBadgeBackgroundColor({
    color: '#0f5c9a',
    tabId,
  });
  await setBadgeText({
    tabId,
    text: '...',
  });
}

async function clearSavingBadge(tabId) {
  await setBadgeText({
    tabId,
    text: '',
  });
}

function createNotification(notificationId, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(notificationId, options, (createdId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(createdId);
    });
  });
}

function clearNotification(notificationId) {
  return new Promise((resolve, reject) => {
    chrome.notifications.clear(notificationId, (wasCleared) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(wasCleared);
    });
  });
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(result);
    });
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function storageRemove(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tab);
    });
  });
}

function setBadgeText(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeText(details, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function setBadgeBackgroundColor(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeBackgroundColor(details, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}
