const path = require('node:path');

const toInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const appRoot = process.cwd();

const config = {
  port: toInteger(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH || path.join(appRoot, 'data', 'newrss.db'),
  readLaterStoragePath: process.env.READ_LATER_STORAGE_PATH || path.join(appRoot, 'data', 'read-later'),
  host: process.env.HOST || '0.0.0.0',
  defaultFeedName: process.env.DEFAULT_FEED_NAME || 'wired',
  defaultFeedUrl: process.env.DEFAULT_FEED_URL || 'https://www.wired.com/feed/rss',
  defaultFeedFolder: process.env.DEFAULT_FEED_FOLDER || '',
  readLaterFeedName: process.env.READ_LATER_FEED_NAME || 'read-later',
  readLaterFeedTitle: process.env.READ_LATER_FEED_TITLE || 'Read Later',
  readLaterFeedFolder: process.env.READ_LATER_FEED_FOLDER || 'Read Later',
  appBaseUrl: process.env.APP_BASE_URL || null,
  maxItemsPerRefresh: toInteger(process.env.MAX_ITEMS_PER_REFRESH, 10),
  maxItemsPerFeed: toInteger(process.env.MAX_ITEMS_PER_FEED, 50),
  refreshIntervalMinutes: toInteger(process.env.REFRESH_INTERVAL_MINUTES, 30),
  httpTimeoutMs: toInteger(process.env.HTTP_TIMEOUT_MS, 15000),
  refreshOnBoot: process.env.REFRESH_ON_BOOT !== 'false',
  userAgent: process.env.USER_AGENT || 'NewRSS/0.1 (+https://tailscale.local)',
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
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiTimeoutMs: toInteger(process.env.GEMINI_TIMEOUT_MS, 90000),
  geminiChunkMaxWords: toInteger(process.env.GEMINI_CHUNK_MAX_WORDS, 1200),
  geminiChunkConcurrency: toInteger(process.env.GEMINI_CHUNK_CONCURRENCY, 3),
  translateTargetLanguage: process.env.TRANSLATE_TARGET_LANGUAGE || 'Simplified Chinese',
};

module.exports = config;
