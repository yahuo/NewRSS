const express = require('express');
const Parser = require('rss-parser');
const config = require('./config');
const Database = require('./db');
const FeedService = require('./feed-service');
const { renderAdminPage } = require('./admin-page');

const db = new Database(config.dbPath);
const feedService = new FeedService({ db, config });
const parser = new Parser({
  customFields: {
    item: ['content:encoded', 'creator'],
  },
  timeout: config.httpTimeoutMs,
});

const app = express();
app.use(express.json());
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
      opml: '/opml.xml',
      admin: '/admin',
      feed: `/feeds/${encodeURIComponent(config.defaultFeedName)}.xml`,
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
    feeds: feedService.listFeeds(request),
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
  response.type('text/html; charset=utf-8').send(
    renderAdminPage({
      feeds: feedService.listFeeds(request),
      baseUrl: config.appBaseUrl || `${request.protocol}://${request.get('host')}`,
    })
  );
});

app.get('/opml.xml', (request, response) => {
  feedService.ensureBootstrapFeed();
  response.type('text/x-opml; charset=utf-8').send(feedService.renderOpml({ request }));
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

  const title = entry.source_title || 'Untitled';
  const contentHtml = entry.extracted_content_html || entry.source_content_html || '<p>No content available.</p>';
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
        --bg: #f8f5ef;
        --card: #fffdf8;
        --ink: #1d1b17;
        --muted: #716959;
        --line: #e4dccd;
        --link: #0e5ea8;
      }
      body {
        margin: 0;
        padding: 32px 16px;
        background: radial-gradient(circle at top, #fffaf0 0%, var(--bg) 55%);
        color: var(--ink);
        font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif;
      }
      main {
        max-width: 820px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 32px;
        box-shadow: 0 16px 48px rgba(75, 54, 18, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.08;
      }
      .meta {
        color: var(--muted);
        margin-bottom: 24px;
      }
      .meta a {
        color: var(--link);
      }
      article {
        font-size: 1.125rem;
        line-height: 1.82;
      }
      article img {
        max-width: 100%;
        height: auto;
      }
      article a {
        color: var(--link);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        原文：<a href="${escapeAttribute(entry.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(entry.source_url)}</a><br />
        正文来源：${escapeHtml(contentSource)}<br />
        状态：${escapeHtml(entry.refresh_status)}
      </div>
      <article>${contentHtml}</article>
    </main>
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

  const folder = String(body.folder || '').trim();
  const explicitName = String(body.name || '').trim();
  const name = explicitName || buildFeedNameFromUrl(parsedUrl);

  if (!name) {
    throw new Error('name is required');
  }

  return {
    name,
    sourceUrl: parsedUrl.toString(),
    folder,
  };
}

function buildFeedNameFromUrl(parsedUrl) {
  const seed = `${parsedUrl.hostname}${parsedUrl.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return seed.slice(0, 64) || 'feed';
}

function mapFeedForResponse(feed, request) {
  const baseUrl = config.appBaseUrl || `${request.protocol}://${request.get('host')}`;

  return {
    name: feed.name,
    sourceUrl: feed.source_url,
    folder: feed.folder || '',
    title: feed.title || feed.name,
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
