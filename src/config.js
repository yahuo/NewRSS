const path = require('node:path');

const toInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const appRoot = process.cwd();

const config = {
  port: toInteger(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH || path.join(appRoot, 'data', 'newrss.db'),
  host: process.env.HOST || '0.0.0.0',
  defaultFeedName: process.env.DEFAULT_FEED_NAME || 'wired',
  defaultFeedUrl: process.env.DEFAULT_FEED_URL || 'https://www.wired.com/feed/rss',
  defaultFeedFolder: process.env.DEFAULT_FEED_FOLDER || '',
  appBaseUrl: process.env.APP_BASE_URL || null,
  maxItemsPerRefresh: toInteger(process.env.MAX_ITEMS_PER_REFRESH, 10),
  maxItemsPerFeed: toInteger(process.env.MAX_ITEMS_PER_FEED, 50),
  refreshIntervalMinutes: toInteger(process.env.REFRESH_INTERVAL_MINUTES, 30),
  httpTimeoutMs: toInteger(process.env.HTTP_TIMEOUT_MS, 15000),
  refreshOnBoot: process.env.REFRESH_ON_BOOT !== 'false',
  userAgent: process.env.USER_AGENT || 'NewRSS/0.1 (+https://tailscale.local)',
  upstreamProxyUrl: process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
};

module.exports = config;
