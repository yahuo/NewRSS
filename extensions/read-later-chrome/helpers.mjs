export const DEFAULT_NEWRSS_BASE_URL = 'http://newrss.local:8787';
export const BASE_URL_STORAGE_KEY = 'newrssBaseUrl';
export const PENDING_JOB_STORAGE_PREFIX = 'pendingReadLaterJob:';
export const REQUEST_TIMEOUT_MS = 10_000;
export const SUBMISSION_MAX_ATTEMPTS = 2;
export const JOB_MAX_POLL_ATTEMPTS = 20;
export const JOB_RECOVERY_ALARM_NAME = 'readLaterJobRecovery';
export const JOB_RECOVERY_DELAY_MINUTES = 0.5;
export const NOTIFICATION_ICON_PATH = 'icon-128.png';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const JOB_STATUSES = new Set(['queued', 'running', 'done', 'failed']);
const DEFAULT_SAVE_MODE = 'auto';
const DEFAULT_TRANSLATE = true;

export function normalizeBaseUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || '').trim());
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('NewRSS 地址必须是无账号信息的 HTTP 或 HTTPS 地址。');
  }

  return parsed.origin;
}

export function buildJobsEndpoint(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/api/read-later/jobs`;
}

export function buildJobEndpoint(baseUrl, jobId) {
  return `${buildJobsEndpoint(baseUrl)}/${encodeURIComponent(String(jobId || '').trim())}`;
}

export function buildOriginPattern(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/*`;
}

export function normalizePageUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
      return '';
    }

    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function isSupportedPageUrl(rawUrl) {
  return Boolean(normalizePageUrl(rawUrl));
}

export function buildSavePayload(tab = {}) {
  return {
    url: normalizePageUrl(tab.url),
    mode: DEFAULT_SAVE_MODE,
    translate: DEFAULT_TRANSLATE,
  };
}

export function createIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `read-later-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export function parseJobSubmission(responseStatus, data) {
  if (responseStatus !== 202) {
    throw new Error(`API_ERROR:${extractApiError(data, responseStatus)}`);
  }

  return parseJobPayload(data, responseStatus, false);
}

export function parseJobStatus(responseStatus, data) {
  if (responseStatus < 200 || responseStatus >= 300) {
    throw new Error(`API_ERROR:${extractApiError(data, responseStatus)}`);
  }

  return parseJobPayload(data, responseStatus, true);
}

export function validateArticleUrl(rawUrl, baseUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const expectedOrigin = normalizeBaseUrl(baseUrl);
    if (
      parsed.origin !== expectedOrigin ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.startsWith('/articles/') ||
      parsed.pathname === '/articles/'
    ) {
      return '';
    }

    return parsed.toString();
  } catch {
    return '';
  }
}

export function pendingJobStorageKey(jobId) {
  return `${PENDING_JOB_STORAGE_PREFIX}${String(jobId || '').trim()}`;
}

export function buildSaveSuccessNotification(result = {}) {
  const subject = truncateText(String(result.title || '').trim() || '当前页面', 120);
  return {
    title: result.existed ? 'Read Later 已更新' : 'Read Later 已保存',
    message: subject,
  };
}

export function unsupportedUrlMessage(rawUrl) {
  if (!rawUrl) {
    return '当前标签页没有可保存的网页地址。';
  }

  return `当前页面不支持保存：${rawUrl}`;
}

export function humanizeSaveError(error, baseUrl = DEFAULT_NEWRSS_BASE_URL) {
  if (!error) {
    return '保存失败，请稍后重试。';
  }

  if (error.name === 'AbortError') {
    return '请求 NewRSS 超时，请稍后重试。';
  }

  const message = String(error.message || '').trim();

  if (!message) {
    return '保存失败，请稍后重试。';
  }

  if (message.startsWith('NETWORK_ERROR:')) {
    return `无法连接到 NewRSS 服务，请检查 ${baseUrl} 是否可达。`;
  }

  if (message.startsWith('API_ERROR:')) {
    return message.slice('API_ERROR:'.length).trim() || '保存失败，请稍后重试。';
  }

  return message;
}

export function extractApiError(data, responseStatus) {
  const bodyMessage = String(data?.error || '').trim();
  if (bodyMessage) {
    return bodyMessage;
  }

  if (responseStatus === 400) {
    return '请求参数无效。';
  }

  if (responseStatus === 404) {
    return 'NewRSS 接口不存在。';
  }

  if (responseStatus >= 500) {
    return 'NewRSS 服务内部错误。';
  }

  return `NewRSS 返回了异常状态码 ${responseStatus}。`;
}

function parseJobPayload(data, responseStatus, requireDoneResult) {
  const jobId = String(data?.jobId || '').trim();
  const status = String(data?.status || '').trim().toLowerCase();

  if (!jobId || !JOB_STATUSES.has(status)) {
    throw new Error(`API_ERROR:NewRSS 返回了无效的任务状态（HTTP ${responseStatus}）。`);
  }

  if (requireDoneResult && status === 'done' && (!data.result || typeof data.result !== 'object')) {
    throw new Error('API_ERROR:NewRSS 已完成任务，但没有返回保存结果。');
  }

  return {
    jobId,
    status,
    result: data.result && typeof data.result === 'object' ? data.result : null,
    error: String(data.error || '').trim(),
  };
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
