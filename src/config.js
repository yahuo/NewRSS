const path = require('node:path');

const boundedInteger = (name, fallback, { min, max }) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') {
    return fallback;
  }

  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }

  return parsed;
};

const optionalHttpUrl = (name) => {
  const raw = String(process.env[name] || '').trim();
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }

  return parsed.toString().replace(/\/$/, '');
};

const DEFAULT_ARTICLE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const appRoot = process.cwd();

const config = {
  port: boundedInteger('PORT', 8787, { min: 1, max: 65535 }),
  dbPath: process.env.DB_PATH || path.join(appRoot, 'data', 'newrss.db'),
  readLaterStoragePath: process.env.READ_LATER_STORAGE_PATH || path.join(appRoot, 'data', 'read-later'),
  host: process.env.HOST || '0.0.0.0',
  defaultFeedName: process.env.DEFAULT_FEED_NAME || 'wired',
  defaultFeedUrl: process.env.DEFAULT_FEED_URL || 'https://www.wired.com/feed/rss',
  defaultFeedFolder: process.env.DEFAULT_FEED_FOLDER || '',
  readLaterFeedName: process.env.READ_LATER_FEED_NAME || 'read-later',
  readLaterFeedTitle: process.env.READ_LATER_FEED_TITLE || 'Read Later',
  readLaterFeedFolder: process.env.READ_LATER_FEED_FOLDER || 'Read Later',
  appBaseUrl: optionalHttpUrl('APP_BASE_URL'),
  maxItemsPerRefresh: boundedInteger('MAX_ITEMS_PER_REFRESH', 10, { min: 1, max: 500 }),
  maxItemsPerFeed: boundedInteger('MAX_ITEMS_PER_FEED', 50, { min: 1, max: 5000 }),
  refreshIntervalMinutes: boundedInteger('REFRESH_INTERVAL_MINUTES', 30, { min: 0, max: 10080 }),
  httpTimeoutMs: boundedInteger('HTTP_TIMEOUT_MS', 15000, { min: 1000, max: 300000 }),
  rssMaxBytes: boundedInteger('RSS_MAX_BYTES', 10 * 1024 * 1024, { min: 64 * 1024, max: 100 * 1024 * 1024 }),
  rssCacheMaxBytes: boundedInteger('RSS_CACHE_MAX_BYTES', 64 * 1024 * 1024, { min: 1024 * 1024, max: 1024 * 1024 * 1024 }),
  articleMaxBytes: boundedInteger('ARTICLE_MAX_BYTES', 15 * 1024 * 1024, { min: 64 * 1024, max: 100 * 1024 * 1024 }),
  xMaxBytes: boundedInteger('X_MAX_BYTES', 10 * 1024 * 1024, { min: 64 * 1024, max: 100 * 1024 * 1024 }),
  outboundMaxRedirects: boundedInteger('OUTBOUND_MAX_REDIRECTS', 5, { min: 0, max: 10 }),
  outboundAllowedHosts: String(process.env.OUTBOUND_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  outboundAllowFakeIp: process.env.OUTBOUND_ALLOW_FAKE_IP === 'true',
  feedRefreshConcurrency: boundedInteger('FEED_REFRESH_CONCURRENCY', 2, { min: 1, max: 8 }),
  itemRefreshConcurrency: boundedInteger('ITEM_REFRESH_CONCURRENCY', 3, { min: 1, max: 8 }),
  articleRecheckHours: boundedInteger('ARTICLE_RECHECK_HOURS', 24, { min: 1, max: 720 }),
  readLaterJobConcurrency: boundedInteger('READ_LATER_JOB_CONCURRENCY', 1, { min: 1, max: 4 }),
  readLaterRateLimitPerMinute: boundedInteger('READ_LATER_RATE_LIMIT_PER_MINUTE', 20, { min: 1, max: 600 }),
  refreshOnBoot: process.env.REFRESH_ON_BOOT !== 'false',
  userAgent: process.env.USER_AGENT || DEFAULT_ARTICLE_USER_AGENT,
  upstreamProxyUrl: process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
  articleCookieFile: process.env.ARTICLE_COOKIE_FILE || '',
  articleCookieDomain: process.env.ARTICLE_COOKIE_DOMAIN || '',
  articleCookieHeader: process.env.ARTICLE_COOKIE_HEADER || '',
  xCookieFile: process.env.X_COOKIE_FILE || '',
  xAuthToken: process.env.X_AUTH_TOKEN || '',
  xCt0: process.env.X_CT0 || '',
  xGuestToken: process.env.X_GUEST_TOKEN || '',
  xTwid: process.env.X_TWID || '',
  xUserAgent: process.env.X_USER_AGENT || '',
  xBearerToken: process.env.X_BEARER_TOKEN || '',
  xClientTransactionId: process.env.X_CLIENT_TRANSACTION_ID || '',
  translationProvider: process.env.TRANSLATION_PROVIDER || 'gemini',
  readLaterTranslationProvider: process.env.READ_LATER_TRANSLATION_PROVIDER || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiTimeoutMs: boundedInteger('GEMINI_TIMEOUT_MS', 90000, { min: 1000, max: 600000 }),
  geminiChunkMaxWords: boundedInteger('GEMINI_CHUNK_MAX_WORDS', 1200, { min: 200, max: 10000 }),
  geminiChunkConcurrency: boundedInteger('GEMINI_CHUNK_CONCURRENCY', 3, { min: 1, max: 8 }),
  codexAuthFile: process.env.CODEX_AUTH_FILE || '',
  codexModel: process.env.CODEX_MODEL || 'openai-codex/gpt-5.5',
  codexBaseUrl: process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex',
  codexTimeoutMs: boundedInteger('CODEX_TIMEOUT_MS', boundedInteger('GEMINI_TIMEOUT_MS', 90000, { min: 1000, max: 600000 }), { min: 1000, max: 600000 }),
  translateTargetLanguage: process.env.TRANSLATE_TARGET_LANGUAGE || 'Simplified Chinese',
};

module.exports = config;
