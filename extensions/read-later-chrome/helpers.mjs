export const NEWRSS_BASE_URL = 'http://macpro.sgponte:8787';
export const READ_LATER_ENDPOINT = `${NEWRSS_BASE_URL}/api/read-later`;
export const REQUEST_TIMEOUT_MS = 30_000;
export const NOTIFICATION_ICON_PATH = 'icon-128.png';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_SAVE_MODE = 'auto';
const DEFAULT_TRANSLATE = true;

export function isSupportedPageUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return SUPPORTED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function buildSavePayload(tab = {}) {
  return {
    url: String(tab.url || '').trim(),
    mode: DEFAULT_SAVE_MODE,
    translate: DEFAULT_TRANSLATE,
  };
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

export function humanizeSaveError(error) {
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
    return `无法连接到 NewRSS 服务，请检查 ${NEWRSS_BASE_URL} 是否可达。`;
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

export function parseSaveResponse(responseStatus, data) {
  if (data?.ok === true && data?.result) {
    return data.result;
  }

  throw new Error(`API_ERROR:${extractApiError(data, responseStatus)}`);
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
