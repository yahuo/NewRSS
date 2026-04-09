const express = require('express');
const Parser = require('rss-parser');
const config = require('./config');
const Database = require('./db');
const FeedService = require('./feed-service');
const ReadLaterService = require('./read-later-service');
const { renderAdminPage } = require('./admin-page');
const { parseOpml } = require('./opml');
const {
  buildFeedNameFromUrl: buildFeedNameFromUrlUtil,
  isManagedFeedSourceUrl,
  normalizeFolderPath,
} = require('./utils');

const db = new Database(config.dbPath);
const feedService = new FeedService({ db, config });
const readLaterService = new ReadLaterService({ db, config, feedService });
const parser = new Parser({
  customFields: {
    item: ['content:encoded', 'creator'],
  },
  timeout: config.httpTimeoutMs,
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/', (request, response) => {
  feedService.ensureBootstrapFeed();
  const baseUrl = config.appBaseUrl || `${request.protocol}://${request.get('host')}`;
  response.json({
    service: 'NewRSS MVP',
    mode: 'reader-view',
    appBaseUrl: baseUrl,
    endpoints: {
      refreshAll: '/refresh',
      feeds: '/api/feeds',
      readLater: '/api/read-later',
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

app.get('/refresh', async (request, response) => {
  try {
    let result;
    if (request.query.name) {
      const feedName = String(request.query.name);
      const sourceUrl = request.query.url ? String(request.query.url) : null;
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
    response.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get('/api/feeds', (request, response) => {
  feedService.ensureBootstrapFeed();
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
    response.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post('/api/read-later', async (request, response) => {
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
    response.status(400).json({
      ok: false,
      error: error.message,
    });
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
    response.status(400).json({
      ok: false,
      error: error.message,
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

    const result = feedService.importFeeds(outlines, folderOverride);
    if (!result.total) {
      throw new Error('OPML contains no valid feed URLs');
    }

    response.status(201).json({
      ok: true,
      result,
    });
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete('/api/feeds/:name', (request, response) => {
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
    response.status(error.message.includes('not found') ? 404 : 500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get('/admin', (request, response) => {
  feedService.ensureBootstrapFeed();
  const feeds = listAdminFeeds(request);
  response.type('text/html; charset=utf-8').send(
    renderAdminPage({
      feeds,
      folders: Array.from(new Set(feeds.map((feed) => feed.folder).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      baseUrl: config.appBaseUrl || `${request.protocol}://${request.get('host')}`,
      readLaterFeedName: config.readLaterFeedName,
    })
  );
});

app.get('/opml.xml', (request, response) => {
  feedService.ensureBootstrapFeed();
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

  response.type('application/rss+xml; charset=utf-8').send(xml);
});

app.get('/articles/:id', (request, response) => {
  const entry = db.getEntryById(Number.parseInt(request.params.id, 10));

  if (!entry) {
    response.status(404).type('text/plain').send('article not found');
    return;
  }

  const title = entry.translated_title || entry.source_title || 'Untitled';
  const contentHtml =
    entry.translated_content_html ||
    entry.extracted_content_html ||
    entry.source_content_html ||
    '<p>No content available.</p>';
  const contentSource = entry.translation_provider || 'source-feed';

  response.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en" translate="yes">
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
          <div class="meta-row"><span class="meta-label">原文</span><a href="${escapeAttribute(entry.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(entry.source_url)}</a></div>
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

const scheduleDefaultRefresh = () => {
  feedService.ensureBootstrapFeed();

  const run = async () => {
    try {
      const results = await feedService.refreshAllFeeds({ parser });
      console.log(`[refresh] completed for ${results.length} feeds`);
    } catch (error) {
      console.error(`[refresh] failed: ${error.message}`);
    }
  };

  if (config.refreshOnBoot) {
    run();
  }

  if (config.refreshIntervalMinutes > 0) {
    setInterval(run, config.refreshIntervalMinutes * 60 * 1000);
  }
};

app.listen(config.port, config.host, () => {
  console.log(`NewRSS listening on http://${config.host}:${config.port}`);
  scheduleDefaultRefresh();
});

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
    throw new Error('sourceUrl must be a valid URL');
  }

  const folder = normalizeFolderPath(body.folder || '');
  const explicitName = String(body.name || '').trim();
  const name = explicitName || buildFeedNameFromUrl(parsedUrl);

  if (!name) {
    throw new Error('name is required');
  }

  return {
    name,
    sourceUrl: parsedUrl.toString(),
    folder,
    translateEnabled: readOptionalFeedTranslate(body),
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
  const baseUrl = config.appBaseUrl || `${request.protocol}://${request.get('host')}`;

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

  try {
    new URL(url);
  } catch {
    throw new Error('url must be a valid URL');
  }

  return {
    url,
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
