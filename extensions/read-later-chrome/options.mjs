import {
  BASE_URL_STORAGE_KEY,
  DEFAULT_NEWRSS_BASE_URL,
  buildOriginPattern,
  normalizeBaseUrl,
} from './helpers.mjs';

const form = document.getElementById('options-form');
const baseUrlInput = document.getElementById('base-url');
const resetButton = document.getElementById('reset-button');
const status = document.getElementById('status');

void loadOptions();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveBaseUrl(baseUrlInput.value);
});

resetButton.addEventListener('click', async () => {
  baseUrlInput.value = DEFAULT_NEWRSS_BASE_URL;
  await saveBaseUrl(DEFAULT_NEWRSS_BASE_URL);
});

async function loadOptions() {
  try {
    const stored = await storageGet(BASE_URL_STORAGE_KEY);
    baseUrlInput.value = normalizeBaseUrl(stored[BASE_URL_STORAGE_KEY] || DEFAULT_NEWRSS_BASE_URL);
  } catch (error) {
    baseUrlInput.value = DEFAULT_NEWRSS_BASE_URL;
    setStatus(error.message);
  }
}

async function saveBaseUrl(rawUrl) {
  try {
    setStatus('正在保存…');
    const baseUrl = normalizeBaseUrl(rawUrl);
    const granted = await requestOriginPermission(buildOriginPattern(baseUrl));
    if (!granted) {
      throw new Error('未授予访问这个 NewRSS 地址的权限。');
    }

    await storageSet({ [BASE_URL_STORAGE_KEY]: baseUrl });
    baseUrlInput.value = baseUrl;
    setStatus('已保存');
  } catch (error) {
    setStatus(error.message);
  }
}

function setStatus(message) {
  status.textContent = message || '';
}

function requestOriginPermission(origin) {
  return new Promise((resolve, reject) => {
    chrome.permissions.contains({ origins: [origin] }, (alreadyGranted) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (alreadyGranted) {
        resolve(true);
        return;
      }

      chrome.permissions.request({ origins: [origin] }, (granted) => {
        const requestError = chrome.runtime.lastError;
        if (requestError) {
          reject(new Error(requestError.message));
          return;
        }
        resolve(Boolean(granted));
      });
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
