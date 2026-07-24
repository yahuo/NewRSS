import {
  BASE_URL_STORAGE_KEY,
  DEFAULT_NEWRSS_BASE_URL,
  JOB_MAX_POLL_ATTEMPTS,
  JOB_RECOVERY_ALARM_NAME,
  JOB_RECOVERY_DELAY_MINUTES,
  NOTIFICATION_ICON_PATH,
  PENDING_JOB_STORAGE_PREFIX,
  REQUEST_TIMEOUT_MS,
  SUBMISSION_MAX_ATTEMPTS,
  buildJobEndpoint,
  buildJobsEndpoint,
  buildSavePayload,
  buildSaveSuccessNotification,
  createIdempotencyKey,
  humanizeSaveError,
  isSupportedPageUrl,
  normalizeBaseUrl,
  parseJobStatus,
  parseJobSubmission,
  pendingJobStorageKey,
  unsupportedUrlMessage,
  validateArticleUrl,
} from './helpers.mjs';

const chromeApi = chrome;
const NOTIFICATION_TARGET_PREFIX = 'notificationTarget:';
const inFlightTabIds = new Set();
const reportedJobIds = new Set();
const badgeClearTimeouts = new Map();
const BADGE_CLEAR_DELAY_MS = 3500;

chromeApi.action.onClicked.addListener((tab) => {
  void handleActionClick(tab);
});

chromeApi.notifications.onClicked.addListener((notificationId) => {
  void handleNotificationClick(notificationId);
});

chromeApi.notifications.onClosed.addListener((notificationId) => {
  void runBestEffort('clear notification target', () => clearNotificationTarget(notificationId));
});

chromeApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === JOB_RECOVERY_ALARM_NAME) {
    void recoverPendingJobs();
  }
});

chromeApi.runtime.onStartup.addListener(() => {
  void recoverPendingJobs();
});

chromeApi.runtime.onInstalled.addListener(() => {
  void recoverPendingJobs();
});

async function handleActionClick(tab) {
  const tabId = Number.isInteger(tab?.id) ? tab.id : null;

  if (!isSupportedPageUrl(tab?.url)) {
    if (tabId !== null) {
      await runBestEffort('set failure badge', () => setFailureBadge(tabId));
    }
    await showNotificationBestEffort({
      title: '无法保存当前页面',
      message: unsupportedUrlMessage(tab?.url),
    });
    return;
  }

  if (tabId !== null && inFlightTabIds.has(tabId)) {
    await showNotificationBestEffort({
      title: '正在保存',
      message: '这个标签页的保存请求还没完成。',
    });
    return;
  }

  const baseUrl = await getConfiguredBaseUrl();
  const payload = buildSavePayload(tab);

  try {
    if (tabId !== null) {
      inFlightTabIds.add(tabId);
      await runBestEffort('set saving badge', () => setSavingBadge(tabId));
    }

    const existingJob = await findPendingJob(baseUrl, payload.url);
    if (existingJob) {
      await showNotificationBestEffort({
        title: '正在保存',
        message: '这个页面已有保存任务，正在继续查询。',
      });
      const outcome = await pollPendingJob(existingJob);
      await scheduleAfterPoll(outcome);
      return;
    }

    const idempotencyKey = createIdempotencyKey();
    const submitted = await submitSaveJob(baseUrl, payload, idempotencyKey);
    const pendingJob = {
      jobId: submitted.jobId,
      status: submitted.status,
      baseUrl,
      sourceUrl: payload.url,
      idempotencyKey,
      tabId,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    const tracked = await persistPendingJobBestEffort(pendingJob);
    if (tracked) {
      await runBestEffort('schedule recovery alarm', scheduleRecoveryAlarm);
    }
    const outcome = await pollPendingJob(pendingJob);

    if (!tracked && outcome.state === 'pending' && !outcome.tracked) {
      await reportLocalTrackingFailure(tabId);
      return;
    }

    await scheduleAfterPoll(outcome);
  } catch (error) {
    console.error('[read-later extension] job submission failed', error);
    if (tabId !== null) {
      await runBestEffort('set failure badge', () => setFailureBadge(tabId));
    }
    await showNotificationBestEffort({
      title: '保存失败',
      message: humanizeSaveError(error, baseUrl),
    });
  } finally {
    if (tabId !== null) {
      inFlightTabIds.delete(tabId);
    }
  }
}

async function submitSaveJob(baseUrl, payload, idempotencyKey) {
  let lastError;

  for (let attempt = 0; attempt < SUBMISSION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await requestJson(buildJobsEndpoint(baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      if (response.status >= 500 && attempt + 1 < SUBMISSION_MAX_ATTEMPTS) {
        continue;
      }

      try {
        return parseJobSubmission(response.status, response.data);
      } catch (error) {
        if (response.status === 202 && attempt + 1 < SUBMISSION_MAX_ATTEMPTS) {
          lastError = error;
          continue;
        }
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableSubmissionError(error) || attempt + 1 >= SUBMISSION_MAX_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw lastError || new Error('NETWORK_ERROR:unreachable');
}

async function pollPendingJob(pendingJob) {
  if (Number(pendingJob.attempts || 0) >= JOB_MAX_POLL_ATTEMPTS) {
    await stopTrackingJob(pendingJob);
    return { state: 'stopped', tracked: false };
  }

  const nextJob = {
    ...pendingJob,
    attempts: Number(pendingJob.attempts || 0) + 1,
  };

  let status;
  try {
    const response = await requestJson(buildJobEndpoint(nextJob.baseUrl, nextJob.jobId));
    status = parseJobStatus(response.status, response.data);
    if (status.jobId !== nextJob.jobId) {
      throw new Error('API_ERROR:NewRSS 返回了不匹配的任务编号。');
    }
  } catch (error) {
    console.error(`[read-later extension] job poll failed for ${nextJob.jobId}`, error);
    const tracked = await persistPendingJobBestEffort(nextJob);
    if (nextJob.attempts >= JOB_MAX_POLL_ATTEMPTS) {
      await stopTrackingJob(nextJob);
      return { state: 'stopped', tracked: false };
    }
    return { state: 'pending', tracked };
  }

  nextJob.status = status.status;

  if (status.status === 'done') {
    await removePendingJobBestEffort(nextJob.jobId);
    await reportJobSuccess(nextJob, status.result);
    return { state: 'done', tracked: false };
  }

  if (status.status === 'failed') {
    await removePendingJobBestEffort(nextJob.jobId);
    await reportJobFailure(nextJob, status.error);
    return { state: 'failed', tracked: false };
  }

  const tracked = await persistPendingJobBestEffort(nextJob);
  return { state: 'pending', tracked };
}

async function recoverPendingJobs() {
  let jobs;
  try {
    jobs = await listPendingJobs();
  } catch (error) {
    console.error('[read-later extension] failed to recover pending jobs', error);
    await runBestEffort('reschedule recovery alarm', scheduleRecoveryAlarm);
    return;
  }
  if (!jobs.length) {
    await runBestEffort('clear recovery alarm', clearRecoveryAlarm);
    return;
  }

  await runBestEffort('schedule recovery alarm', scheduleRecoveryAlarm);

  for (const job of jobs) {
    await pollPendingJob(job);
  }

  let remainingJobs;
  try {
    remainingJobs = await listPendingJobs();
  } catch (error) {
    console.error('[read-later extension] failed to reload pending jobs', error);
    await runBestEffort('reschedule recovery alarm', scheduleRecoveryAlarm);
    return;
  }
  if (remainingJobs.length) {
    await runBestEffort('schedule recovery alarm', scheduleRecoveryAlarm);
  } else {
    await runBestEffort('clear recovery alarm', clearRecoveryAlarm);
  }
}

async function scheduleAfterPoll(outcome) {
  if (outcome.state === 'pending') {
    await runBestEffort('schedule recovery alarm', scheduleRecoveryAlarm);
  }
}

function scheduleRecoveryAlarm() {
  chromeApi.alarms.create(JOB_RECOVERY_ALARM_NAME, {
    delayInMinutes: JOB_RECOVERY_DELAY_MINUTES,
  });
}

async function clearRecoveryAlarm() {
  await new Promise((resolve, reject) => {
    chromeApi.alarms.clear(JOB_RECOVERY_ALARM_NAME, () => {
      const error = chromeApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

async function reportJobSuccess(job, result) {
  if (reportedJobIds.has(job.jobId)) {
    return;
  }
  reportedJobIds.add(job.jobId);

  if (job.tabId !== null) {
    await runBestEffort('set success badge', () => setSuccessBadge(job.tabId));
  }

  const notificationId = await showNotificationBestEffort(buildSaveSuccessNotification(result));
  const articleUrl = validateArticleUrl(result?.articleUrl, job.baseUrl);
  if (result?.articleUrl && !articleUrl) {
    console.warn('[read-later extension] ignored unsafe article URL', result.articleUrl);
  }

  if (notificationId && articleUrl) {
    await runBestEffort('remember notification target', () =>
      rememberNotificationTarget(notificationId, articleUrl, job.baseUrl)
    );
  }
}

async function reportJobFailure(job, errorMessage) {
  if (job.tabId !== null) {
    await runBestEffort('set failure badge', () => setFailureBadge(job.tabId));
  }
  await showNotificationBestEffort({
    title: '保存失败',
    message: humanizeSaveError(new Error(`API_ERROR:${errorMessage || '保存任务执行失败。'}`), job.baseUrl),
  });
}

async function stopTrackingJob(job) {
  await removePendingJobBestEffort(job.jobId);
  if (job.tabId !== null) {
    await runBestEffort('set pending badge', () => setPendingBadge(job.tabId));
  }
  await showNotificationBestEffort({
    title: '保存任务仍在处理',
    message: '扩展已停止自动查询，请在 NewRSS 管理页确认最终结果。',
  });
}

async function reportLocalTrackingFailure(tabId) {
  if (tabId !== null) {
    await runBestEffort('set pending badge', () => setPendingBadge(tabId));
  }
  await showNotificationBestEffort({
    title: '保存任务已提交',
    message: '本地恢复状态保存失败，请稍后在 NewRSS 管理页确认结果。',
  });
}

async function findPendingJob(baseUrl, sourceUrl) {
  try {
    const jobs = await listPendingJobs();
    return jobs.find((job) => job.baseUrl === baseUrl && job.sourceUrl === sourceUrl) || null;
  } catch (error) {
    console.error('[read-later extension] failed to inspect pending jobs', error);
    return null;
  }
}

async function listPendingJobs() {
  const stored = await storageGet(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(PENDING_JOB_STORAGE_PREFIX))
    .map(([, value]) => normalizePendingJob(value))
    .filter(Boolean);
}

function normalizePendingJob(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const jobId = String(value.jobId || '').trim();
  const sourceUrl = String(value.sourceUrl || '').trim();
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(value.baseUrl);
  } catch {
    return null;
  }

  if (!jobId || !sourceUrl) {
    return null;
  }

  return {
    jobId,
    status: String(value.status || 'queued'),
    baseUrl,
    sourceUrl,
    idempotencyKey: String(value.idempotencyKey || ''),
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    attempts: Math.max(0, Number(value.attempts) || 0),
    createdAt: String(value.createdAt || ''),
  };
}

function isRetryableSubmissionError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').startsWith('NETWORK_ERROR:');
}

async function persistPendingJobBestEffort(job) {
  try {
    await storageSet({
      [pendingJobStorageKey(job.jobId)]: job,
    });
    return true;
  } catch (error) {
    console.error(`[read-later extension] failed to persist job ${job.jobId}`, error);
    return false;
  }
}

async function removePendingJobBestEffort(jobId) {
  await runBestEffort('remove pending job', () => storageRemove(pendingJobStorageKey(jobId)));
}

async function getConfiguredBaseUrl() {
  try {
    const stored = await storageGet(BASE_URL_STORAGE_KEY);
    return normalizeBaseUrl(stored[BASE_URL_STORAGE_KEY] || DEFAULT_NEWRSS_BASE_URL);
  } catch (error) {
    console.error('[read-later extension] failed to load configured base URL', error);
    return DEFAULT_NEWRSS_BASE_URL;
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return {
      status: response.status,
      data: await readJsonSafely(response),
    };
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
  let target;
  try {
    target = await getNotificationTarget(notificationId);
  } catch (error) {
    console.error('[read-later extension] failed to load notification target', error);
  }

  await runBestEffort('clear notification target', () => clearNotificationTarget(notificationId));
  await runBestEffort('clear notification', () => clearNotification(notificationId));

  const targetUrl = validateArticleUrl(target?.url, target?.baseUrl);
  if (targetUrl) {
    await runBestEffort('open saved article', () => createTab(targetUrl));
  }
}

async function showNotificationBestEffort(notification) {
  try {
    return await showNotification(notification);
  } catch (error) {
    console.error('[read-later extension] notification failed', error);
    return '';
  }
}

async function showNotification({ title, message }) {
  const notificationId = `read-later-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createNotification(notificationId, {
    type: 'basic',
    iconUrl: chromeApi.runtime.getURL(NOTIFICATION_ICON_PATH),
    title,
    message,
  });
  return notificationId;
}

async function rememberNotificationTarget(notificationId, url, baseUrl) {
  await storageSet({
    [`${NOTIFICATION_TARGET_PREFIX}${notificationId}`]: {
      url,
      baseUrl,
    },
  });
}

async function getNotificationTarget(notificationId) {
  const key = `${NOTIFICATION_TARGET_PREFIX}${notificationId}`;
  const stored = await storageGet(key);
  return stored[key] && typeof stored[key] === 'object' ? stored[key] : null;
}

async function clearNotificationTarget(notificationId) {
  await storageRemove(`${NOTIFICATION_TARGET_PREFIX}${notificationId}`);
}

async function setSavingBadge(tabId) {
  clearBadgeResetTimeout(tabId);
  await setBadgeBackgroundColor({ color: '#0f5c9a', tabId });
  await setBadgeText({ tabId, text: '...' });
}

async function setSuccessBadge(tabId) {
  clearBadgeResetTimeout(tabId);
  await setBadgeBackgroundColor({ color: '#1f7a1f', tabId });
  await setBadgeText({ tabId, text: 'OK' });
  scheduleBadgeReset(tabId);
}

async function setFailureBadge(tabId) {
  clearBadgeResetTimeout(tabId);
  await setBadgeBackgroundColor({ color: '#b42318', tabId });
  await setBadgeText({ tabId, text: '!' });
  scheduleBadgeReset(tabId);
}

async function setPendingBadge(tabId) {
  clearBadgeResetTimeout(tabId);
  await setBadgeBackgroundColor({ color: '#a15812', tabId });
  await setBadgeText({ tabId, text: '?' });
  scheduleBadgeReset(tabId);
}

async function clearBadge(tabId) {
  clearBadgeResetTimeout(tabId);
  await setBadgeText({ tabId, text: '' });
}

function scheduleBadgeReset(tabId) {
  clearBadgeResetTimeout(tabId);
  const timeoutId = setTimeout(() => {
    badgeClearTimeouts.delete(tabId);
    void runBestEffort('clear badge', () => clearBadge(tabId));
  }, BADGE_CLEAR_DELAY_MS);
  timeoutId?.unref?.();
  badgeClearTimeouts.set(tabId, timeoutId);
}

function clearBadgeResetTimeout(tabId) {
  const timeoutId = badgeClearTimeouts.get(tabId);
  if (!timeoutId) {
    return;
  }

  clearTimeout(timeoutId);
  badgeClearTimeouts.delete(tabId);
}

async function runBestEffort(label, operation) {
  try {
    return await operation();
  } catch (error) {
    console.error(`[read-later extension] ${label} failed`, error);
    return null;
  }
}

function createNotification(notificationId, options) {
  return new Promise((resolve, reject) => {
    chromeApi.notifications.create(notificationId, options, (createdId) => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.notifications.clear(notificationId, (wasCleared) => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.storage.local.get(key, (result) => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.storage.local.set(data, () => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.storage.local.remove(key, () => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.tabs.create({ url }, (tab) => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.action.setBadgeText(details, () => {
      const error = chromeApi.runtime.lastError;
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
    chromeApi.action.setBadgeBackgroundColor(details, () => {
      const error = chromeApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}
