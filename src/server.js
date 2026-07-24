const express = require('express');
const compression = require('compression');
const fs = require('node:fs');
const path = require('node:path');
const Parser = require('rss-parser');
const config = require('./config');
const Database = require('./db');
const FeedService = require('./feed-service');
const ReadLaterService = require('./read-later-service');
const ReadLaterJobQueue = require('./read-later-jobs');
const { sanitizeHtml } = require('./html-sanitizer');
const { renderAdminPage, renderFaviconSvg } = require('./admin-page');
const { parseOpml } = require('./opml');
const { scheduleRefreshes } = require('./refresh-scheduler');
const {
  buildFeedNameFromUrl: buildFeedNameFromUrlUtil,
  hashText,
  isManagedFeedSourceUrl,
  normalizeFolderPath,
} = require('./utils');

if (require.main === module) {
  process.umask(0o077);
}

const db = new Database(config.dbPath);
const feedService = new FeedService({ db, config });
const readLaterService = new ReadLaterService({ db, config, feedService });
const readLaterJobs = new ReadLaterJobQueue({
  db,
  readLaterService,
  concurrency: config.readLaterJobConcurrency,
});
const parser = new Parser({
  customFields: {
    item: ['content:encoded', 'creator'],
  },
  timeout: config.httpTimeoutMs,
});

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(mutationGuard);
app.use(express.json({ limit: '2mb' }));
const readLaterRateLimit = createFixedWindowRateLimit(config.readLaterRateLimitPerMinute);

app.get('/', (request, response) => {
  const baseUrl = feedService.baseUrl(request);
  response.json({
    service: 'NewRSS MVP',
    mode: 'reader-view',
    appBaseUrl: baseUrl,
    endpoints: {
      refreshAll: '/refresh',
      feeds: '/api/feeds',
      readLater: '/api/read-later',
      readLaterJobs: '/api/read-later/jobs',
      readLaterItems: '/api/read-later/items',
      opml: '/opml.xml',
      admin: '/admin',
      feed: `/feeds/${encodeURIComponent(config.defaultFeedName)}.xml`,
      readLaterFeed: `/feeds/${encodeURIComponent(config.readLaterFeedName)}.xml`,
      article: '/articles/:id',
    },
  });
});

app.get('/healthz', (request, response) => {
  response.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/readyz', (request, response) => {
  try {
    db.db.prepare('SELECT 1 AS ready').get();
    fs.accessSync(path.dirname(config.dbPath), fs.constants.R_OK | fs.constants.W_OK);
    response.json({ ok: true, ready: true });
  } catch {
    response.status(503).json({ ok: false, ready: false });
  }
});

app.get('/favicon.svg', (request, response) => {
  response
    .set('Cache-Control', 'public, max-age=86400')
    .type('image/svg+xml; charset=utf-8')
    .send(renderFaviconSvg());
});

app.get('/favicon.ico', (request, response) => {
  response.redirect(302, '/favicon.svg?v=1');
});

app.get('/refresh', (request, response) => {
  response.status(405).set('Allow', 'POST').json({
    ok: false,
    error: 'refresh must be requested with POST',
  });
});

app.post('/refresh', async (request, response) => {
  try {
    let result;
    if (request.body?.name) {
      const feedName = String(request.body.name);
      const sourceUrl = request.body.url ? normalizeHttpUrl(request.body.url, 'url') : null;
      result = sourceUrl
        ? await feedService.refreshFeed({ parser, feedName, sourceUrl })
        : await feedService.refreshStoredFeed({ parser, feedName });
    } else {
      result = await feedService.refreshAllFeeds({ parser });
    }

    response.json({
      ok: true,
      result,
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({
      ok: false,
      error: publicApiError(error),
    });
  }
});

app.get('/api/feeds', (request, response) => {
  response.json({
    ok: true,
    feeds: listAdminFeeds(request),
  });
});

app.post('/api/feeds', (request, response) => {
  try {
    const payload = normalizeFeedPayload(request.body);
    const saved = feedService.saveFeed(payload);

    response.status(201).json({
      ok: true,
      feed: mapFeedForResponse(saved, request),
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({
      ok: false,
      error: publicApiError(error),
    });
  }
});

app.post('/api/read-later', readLaterRateLimit, async (request, response) => {
  try {
    const payload = normalizeReadLaterPayload(request.body);
    const result = await readLaterService.saveUrl({
      request,
      url: payload.url,
      title: payload.title,
      mode: payload.mode,
      translate: payload.translate,
    });

    response.status(201).json({
      ok: true,
      result,
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({
      ok: false,
      error: publicApiError(error),
    });
  }
});

app.post('/api/read-later/jobs', readLaterRateLimit, (request, response) => {
  try {
    const payload = normalizeReadLaterPayload(request.body);
    const explicitKey = String(request.get('idempotency-key') || '').trim();
    const idempotencyKey = explicitKey || buildAutomaticIdempotencyKey(payload);
    const job = readLaterJobs.enqueue({
      payload,
      baseUrl: feedService.baseUrl(request),
      idempotencyKey,
      retryFailed: !explicitKey,
    });
    response.status(202).json(job);
  } catch (error) {
    response.status(httpStatusForError(error)).json({ ok: false, error: publicApiError(error) });
  }
});

app.get('/api/read-later/jobs/:id', (request, response) => {
  const job = readLaterJobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ ok: false, error: 'read-later job not found' });
    return;
  }
  response.json(job);
});

app.get('/api/read-later/items', (request, response) => {
  try {
    const limit = normalizeQueryInteger(request.query.limit, 50, { min: 1, max: 100 });
    const offset = normalizeQueryInteger(request.query.offset, 0, { min: 0, max: 10_000_000 });
    response.json({
      ok: true,
      ...readLaterService.listItemsPage({
        request,
        limit,
        offset,
        search: String(request.query.q || ''),
      }),
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({ ok: false, error: publicApiError(error) });
  }
});

app.delete('/api/read-later/items/:id', (request, response) => {
  try {
    const deleted = readLaterService.deleteItem(request.params.id);
    if (!deleted.changes) {
      response.status(404).json({
        ok: false,
        error: 'read-later item not found',
      });
      return;
    }

    response.json({
      ok: true,
      deleted,
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({
      ok: false,
      error: publicApiError(error),
    });
  }
});

app.post('/api/opml/import', (request, response) => {
  try {
    const opmlXml = String(request.body.opmlXml || '').trim();
    const folderOverride = normalizeFolderPath(request.body.folder || '');

    if (!opmlXml) {
      throw new Error('opmlXml is required');
    }

    const outlines = parseOpml(opmlXml);
    if (!outlines.length) {
      throw new Error('OPML contains no feeds');
    }
    if (outlines.length > 2000) {
      throw validationError('OPML contains too many feeds (maximum 2000)');
    }

    const result = feedService.importFeeds(outlines, folderOverride);
    if (!result.total) {
      throw new Error('OPML contains no valid feed URLs');
    }

    response.status(201).json({
      ok: true,
      result,
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({
      ok: false,
      error: publicApiError(error),
    });
  }
});

app.delete('/api/feeds/:name', (request, response) => {
  try {
    const name = request.params.name;
    const deleted = feedService.deleteFeed(name);

    if (!deleted.changes) {
      response.status(404).json({
        ok: false,
        error: 'feed not found',
      });
      return;
    }

    response.json({
      ok: true,
      deleted: name,
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({ ok: false, error: publicApiError(error) });
  }
});

app.post('/api/feeds/:name/refresh', async (request, response) => {
  try {
    const result = await feedService.refreshStoredFeed({
      parser,
      feedName: request.params.name,
    });

    response.json({
      ok: true,
      result,
    });
  } catch (error) {
    response.status(httpStatusForError(error)).json({
      ok: false,
      error: publicApiError(error),
    });
  }
});

app.get('/api/codex/status', (request, response) => {
  const status = activeCodexService()?.getCodexStatus();
  if (!status) {
    response.status(404).json({ ok: false, error: 'Codex OAuth is not the active translation provider' });
    return;
  }
  response.json({ ok: true, ...status });
});

app.post('/api/codex/probe', async (request, response) => {
  try {
    const service = activeCodexService();
    if (!service) {
      response.status(404).json({ ok: false, error: 'Codex OAuth is not an active translation provider' });
      return;
    }
    const result = await service.probeCodex({ force: true });
    response.status(result.ok === false ? 503 : 200).json({ ok: result.ok !== false, result });
  } catch (error) {
    response.status(httpStatusForError(error)).json({ ok: false, error: publicApiError(error) });
  }
});

app.get('/admin', (request, response) => {
  const feeds = listAdminFeeds(request);
  response
    .set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
    .type('text/html; charset=utf-8').send(
    renderAdminPage({
      feeds,
      folders: Array.from(new Set(feeds.map((feed) => feed.folder).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      baseUrl: feedService.baseUrl(request),
      readLaterFeedName: config.readLaterFeedName,
    })
  );
});

app.get('/opml.xml', (request, response) => {
  response
    .type('text/x-opml; charset=utf-8')
    .send(feedService.renderOpml({ request, folder: request.query.folder || '' }));
});

app.get('/feeds/:name.xml', (request, response) => {
  const xml = feedService.renderFeedXml({
    request,
    feedName: request.params.name,
  });

  if (!xml) {
    response.status(404).type('text/plain').send('feed not found');
    return;
  }

  const feed = db.getFeedByName(request.params.name);
  const etag = `"${hashText(xml)}"`;
  response
    .set('Cache-Control', 'public, max-age=300, must-revalidate')
    .set('Last-Modified', new Date(feed?.content_updated_at || feed?.created_at || 0).toUTCString())
    .set('ETag', etag)
    .type('application/rss+xml; charset=utf-8');
  if (etagMatches(request.get('if-none-match'), etag)) {
    response.status(304).end();
    return;
  }
  response.send(xml);
});

app.get('/articles/:id', (request, response) => {
  const entryId = parsePositiveSafeInteger(request.params.id);
  const entry = entryId ? db.getEntryById(entryId) : null;

  if (!entry) {
    response.status(404).type('text/plain').send('article not found');
    return;
  }

  const title = entry.translated_title || entry.source_title || 'Untitled';
  const contentHtml = sanitizeHtml(
    entry.translated_content_html ||
    entry.extracted_content_html ||
    entry.source_content_html ||
    '<p>No content available.</p>',
    { baseUrl: safeHttpUrl(entry.source_url) }
  );
  const contentSource = entry.translation_provider || 'source-feed';
  const language = entry.translated_content_html ? 'zh-CN' : 'en';
  const sourceLink = safeHttpUrl(entry.source_url);

  response
    .set({
      'Content-Language': language,
      'Content-Security-Policy': "default-src 'none'; img-src http: https:; media-src http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    .type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="${language}" translate="yes">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #fbf8f1;
        --ink: #1d1b17;
        --muted: #7a715f;
        --line: rgba(115, 104, 84, 0.18);
        --link: #0e5ea8;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: linear-gradient(180deg, #fdfaf4 0%, var(--bg) 18%, #f7f2e8 100%);
        color: var(--ink);
        font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif;
      }
      .page {
        width: min(920px, calc(100vw - 28px));
        margin: 0 auto;
        padding: 24px 0 56px;
      }
      header {
        padding: 0 0 20px;
        margin-bottom: 22px;
        border-bottom: 1px solid var(--line);
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
        font: 600 0.78rem/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .eyebrow::before {
        content: "";
        width: 22px;
        height: 1px;
        background: currentColor;
      }
      main {
        max-width: 100%;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 14px;
        font-size: clamp(2.35rem, 7vw, 4.4rem);
        line-height: 0.94;
        letter-spacing: -0.03em;
        text-wrap: balance;
      }
      .meta {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font: 0.98rem/1.55 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .meta a {
        color: var(--link);
        word-break: break-word;
      }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .meta-label {
        min-width: 72px;
        color: rgba(29, 27, 23, 0.72);
      }
      article {
        font-size: clamp(1.24rem, 2vw, 1.42rem);
        line-height: 1.88;
      }
      article > :first-child {
        margin-top: 0;
      }
      article p,
      article ul,
      article ol,
      article blockquote,
      article h2,
      article h3,
      article h4,
      article figure {
        margin-top: 0;
        margin-bottom: 1.22em;
      }
      article h2,
      article h3,
      article h4 {
        line-height: 1.15;
        margin-top: 1.5em;
      }
      article figure {
        margin-left: 0;
        margin-right: 0;
      }
      article figcaption {
        margin-top: 8px;
        color: var(--muted);
        font: 0.9rem/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      article img {
        display: block;
        width: 100%;
        max-width: 100%;
        height: auto;
        border-radius: 10px;
      }
      article a {
        color: var(--link);
      }
      @media (max-width: 720px) {
        .page {
          width: min(100vw - 22px, 920px);
          padding-top: 18px;
          padding-bottom: 40px;
        }
        header {
          margin-bottom: 18px;
          padding-bottom: 18px;
        }
        h1 {
          font-size: clamp(2rem, 11vw, 3.6rem);
          line-height: 0.98;
        }
        article {
          font-size: 1.18rem;
          line-height: 1.78;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header>
        <div class="eyebrow">Reader View</div>
        <h1>${escapeHtml(title)}</h1>
        <div class="meta">
          <div class="meta-row"><span class="meta-label">原文</span>${sourceLink ? `<a href="${escapeAttribute(sourceLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.source_url)}</a>` : `<span>${escapeHtml(entry.source_url)}</span>`}</div>
          <div class="meta-row"><span class="meta-label">来源</span><span>${escapeHtml(contentSource)}</span></div>
          <div class="meta-row"><span class="meta-label">状态</span><span>${escapeHtml(entry.refresh_status)}</span></div>
        </div>
      </header>
      <main>
        <article>${contentHtml}</article>
      </main>
    </div>
  </body>
</html>`);
});

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const status = error?.type === 'entity.too.large' ? 413 : httpStatusForError(error);
  response.status(status).json({
    ok: false,
    error: error?.type === 'entity.too.large' ? 'request body is too large' : publicApiError(error),
  });
});

const scheduleDefaultRefresh = () => {
  feedService.ensureBootstrapFeed();
  readLaterJobs.start();
  return scheduleRefreshes({ feedService, readLaterService, parser, config });
};

let server = null;
let scheduler = null;
let shutdownPromise = null;

function startServer() {
  if (server) {
    return server;
  }
  server = app.listen(config.port, config.host, () => {
    console.log(`NewRSS listening on http://${config.host}:${config.port}`);
    scheduler = scheduleDefaultRefresh();
  });
  return server;
}

function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  if (!server) {
    return Promise.resolve();
  }
  console.log(`[shutdown] received ${signal}`);
  const activeServer = server;
  const serverClosed = new Promise((resolve, reject) => {
    activeServer.close((error) => error ? reject(error) : resolve());
  });
  shutdownPromise = Promise.all([
    serverClosed,
    readLaterJobs.stop(),
    scheduler?.stop?.() || Promise.resolve(),
  ])
    .then(() => {
      db.db.close();
      server = null;
    });
  return shutdownPromise;
}

if (require.main === module) {
  startServer();
  process.once('SIGTERM', () => void shutdown('SIGTERM').catch(reportShutdownError));
  process.once('SIGINT', () => void shutdown('SIGINT').catch(reportShutdownError));
}

function reportShutdownError(error) {
  console.error(`[shutdown] failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function normalizeFeedPayload(body) {
  const sourceUrl = String(body.sourceUrl || body.source_url || '').trim();
  if (!sourceUrl) {
    throw new Error('sourceUrl is required');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw validationError('sourceUrl must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw validationError('sourceUrl must be an HTTP(S) URL without credentials');
  }
  parsedUrl.hash = '';

  const folder = Object.prototype.hasOwnProperty.call(body, 'folder')
    ? normalizeFolderPath(body.folder || '')
    : undefined;
  const explicitName = String(body.name || '').trim();
  const name = explicitName || buildFeedNameFromUrl(parsedUrl);
  const title = Object.prototype.hasOwnProperty.call(body, 'title')
    ? String(body.title || '').trim()
    : undefined;

  if (!name) {
    throw new Error('name is required');
  }

  return {
    name,
    sourceUrl: parsedUrl.toString(),
    folder,
    title,
    translateEnabled: readOptionalFeedTranslate(body),
    autoName: !explicitName,
  };
}

function buildFeedNameFromUrl(parsedUrl) {
  return buildFeedNameFromUrlUtil(parsedUrl);
}

function listAdminFeeds(request) {
  const feeds = feedService.listFeeds(request);
  const readLaterItems = readLaterService.listItems({
    request,
    limit: config.maxItemsPerFeed,
  });

  return feeds.map((feed) => {
    if (feed.name === config.readLaterFeedName) {
      return {
        ...feed,
        items: readLaterItems,
      };
    }

    return {
      ...feed,
      items: [],
    };
  });
}

function mapFeedForResponse(feed, request) {
  const baseUrl = feedService.baseUrl(request);

  return {
    name: feed.name,
    sourceUrl: feed.source_url,
    folder: feed.folder || '',
    title: feed.title || feed.name,
    translateEnabled: Boolean(feed.translate_enabled),
    isManaged: isManagedFeedSourceUrl(feed.source_url),
    lastRefreshedAt: feed.last_refreshed_at,
    lastRefreshStatus: feed.last_refresh_status || 'idle',
    lastRefreshError: feed.last_refresh_error || '',
    createdAt: feed.created_at,
    updatedAt: feed.updated_at,
    entryCount: feed.entry_count || 0,
    errorCount: feed.error_count || 0,
    feedUrl: `${baseUrl}/feeds/${encodeURIComponent(feed.name)}.xml`,
  };
}

function normalizeReadLaterPayload(body) {
  const url = String(body.url || body.sourceUrl || body.source_url || '').trim();
  if (!url) {
    throw new Error('url is required');
  }

  return {
    url: normalizeHttpUrl(url, 'url'),
    title: String(body.title || '').trim(),
    mode: String(body.mode || 'auto').trim(),
    translate: normalizeReadLaterTranslate(body.translate),
  };
}

function normalizeFeedTranslate(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value == null || value === '') {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  throw new Error('translateEnabled must be a boolean');
}

function readOptionalFeedTranslate(body) {
  for (const key of ['translateEnabled', 'translate', 'translate_enabled']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return normalizeFeedTranslate(body[key]);
    }
  }

  return undefined;
}

function normalizeReadLaterTranslate(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value ?? 'true').trim().toLowerCase();
  if (!normalized || normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on' || normalized === 'auto') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  throw new Error('translate must be a boolean');
}

function mutationGuard(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    next();
    return;
  }
  if (['POST', 'PUT', 'PATCH'].includes(request.method) && !request.is('application/json')) {
    response.status(415).json({ ok: false, error: 'mutation requests must use application/json' });
    return;
  }
  const origin = String(request.get('origin') || '').trim();
  if (origin.startsWith('chrome-extension://')) {
    next();
    return;
  }
  if (String(request.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
    response.status(403).json({ ok: false, error: 'cross-site mutation requests are not allowed' });
    return;
  }
  if (!origin) {
    next();
    return;
  }
  try {
    if (new URL(origin).origin !== new URL(feedService.baseUrl(request)).origin) {
      response.status(403).json({ ok: false, error: 'cross-origin mutation requests are not allowed' });
      return;
    }
  } catch (error) {
    response.status(httpStatusForError(error)).json({ ok: false, error: publicApiError(error) });
    return;
  }
  next();
}

function createFixedWindowRateLimit(limit) {
  const buckets = new Map();
  const normalizedLimit = Math.max(1, Number(limit) || 20);
  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > normalizedLimit) {
      response
        .status(429)
        .set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))))
        .json({ ok: false, error: 'too many read-later requests' });
      return;
    }
    if (buckets.size > 1000) {
      for (const [bucketKey, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(bucketKey);
      }
    }
    next();
  };
}

function normalizeHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw validationError(`${label} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw validationError(`${label} must be an HTTP(S) URL without credentials`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeQueryInteger(value, fallback, { min, max }) {
  if (value == null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw validationError('pagination values must be integers');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw validationError(`pagination values must be between ${min} and ${max}`);
  }
  return parsed;
}

function parsePositiveSafeInteger(value) {
  const text = String(value || '');
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.toString()
      : '';
  } catch {
    return '';
  }
}

function etagMatches(headerValue, etag) {
  return String(headerValue || '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);
}

function buildAutomaticIdempotencyKey(payload) {
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  return `auto:${hashText(`${JSON.stringify(payload)}:${bucket}`)}`;
}

function activeCodexService() {
  if (feedService.isCodexProvider()) return feedService;
  if (readLaterService.isCodexProvider()) return readLaterService;
  return null;
}

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

function httpStatusForError(error) {
  const code = String(error?.code || '');
  if (code === 'REFRESH_IN_PROGRESS' || code === 'FEED_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT') return 409;
  if (code === 'JOB_QUEUE_STOPPED') return 503;
  if (code === 'OUTBOUND_TIMEOUT') return 504;
  if (code.startsWith('OUTBOUND_')) {
    return [
      'OUTBOUND_URL_INVALID',
      'OUTBOUND_URL_PROTOCOL',
      'OUTBOUND_URL_CREDENTIALS',
      'OUTBOUND_URL_HOST',
      'OUTBOUND_ADDRESS_BLOCKED',
    ].includes(code) ? 400 : 502;
  }
  if (code === 'INVALID_HOST' || code === 'VALIDATION_ERROR' || error instanceof SyntaxError) return 400;
  if (/not found/i.test(String(error?.message || ''))) return 404;
  if (/\b(required|invalid|must be|must contain|unsupported)\b/i.test(String(error?.message || ''))) return 400;
  return 500;
}

function publicApiError(error) {
  const status = httpStatusForError(error);
  if (status === 504) return 'upstream request timed out';
  if (status === 502) return 'upstream request failed';
  if (status >= 500) return 'internal server error';
  return String(error?.message || 'request failed').slice(0, 500);
}

module.exports = {
  app,
  db,
  feedService,
  readLaterJobs,
  readLaterService,
  startServer,
};
