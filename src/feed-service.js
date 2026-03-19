const RSS = require('rss');
const { resolveArticleContent } = require('./extractor');
const { withProxy } = require('./http-client');
const { isoNow, stableGuid, stripHtml, truncate } = require('./utils');

class FeedService {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
  }

  baseUrl(request) {
    if (this.config.appBaseUrl) {
      return this.config.appBaseUrl.replace(/\/$/, '');
    }

    return `${request.protocol}://${request.get('host')}`;
  }

  async fetchSourceFeed(sourceUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      const response = await fetch(sourceUrl, {
        headers: {
          'user-agent': this.config.userAgent,
          accept: 'application/rss+xml, application/xml, text/xml',
        },
        signal: controller.signal,
        ...withProxy(this.config.upstreamProxyUrl),
      });

      if (!response.ok) {
        throw new Error(`rss fetch failed with status ${response.status}`);
      }

      return response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  async parseSourceFeed(parser, sourceUrl) {
    const xml = await this.fetchSourceFeed(sourceUrl);
    return parser.parseString(xml);
  }

  ensureBootstrapFeed() {
    if (!this.config.defaultFeedName || !this.config.defaultFeedUrl) {
      return null;
    }

    if (this.db.listFeeds().length > 0) {
      return this.db.getFeedByName(this.config.defaultFeedName);
    }

    const existing = this.db.getFeedByName(this.config.defaultFeedName);
    if (existing) {
      return existing;
    }

    const now = isoNow();
    this.db.upsertFeed({
      name: this.config.defaultFeedName,
      sourceUrl: this.config.defaultFeedUrl,
      folder: this.config.defaultFeedFolder || '',
      title: null,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return this.db.getFeedByName(this.config.defaultFeedName);
  }

  ensureFeed(feedName, sourceUrl, sourceTitle) {
    const now = isoNow();
    const existing = this.db.getFeedByName(feedName);

    this.db.upsertFeed({
      name: feedName,
      sourceUrl,
      folder: existing?.folder || '',
      title: sourceTitle || existing?.title || feedName,
      lastRefreshedAt: existing?.last_refreshed_at || null,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });
  }

  listFeeds(request) {
    const baseUrl = this.baseUrl(request);

    return this.db.listFeeds().map((feed) => ({
      name: feed.name,
      sourceUrl: feed.source_url,
      folder: feed.folder || '',
      title: feed.title || feed.name,
      lastRefreshedAt: feed.last_refreshed_at,
      createdAt: feed.created_at,
      updatedAt: feed.updated_at,
      entryCount: feed.entry_count,
      feedUrl: `${baseUrl}/feeds/${encodeURIComponent(feed.name)}.xml`,
    }));
  }

  saveFeed({ name, sourceUrl, folder = '' }) {
    const now = isoNow();
    const existing = this.db.getFeedByName(name);

    this.db.upsertFeed({
      name,
      sourceUrl,
      folder,
      title: existing?.title || null,
      lastRefreshedAt: existing?.last_refreshed_at || null,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });

    return this.db.getFeedByName(name);
  }

  deleteFeed(name) {
    return this.db.deleteFeed(name);
  }

  async refreshFeed({ parser, feedName, sourceUrl }) {
    const parsedFeed = await this.parseSourceFeed(parser, sourceUrl);
    this.ensureFeed(feedName, sourceUrl, parsedFeed.title || feedName);

    const refreshedAt = isoNow();
    const items = parsedFeed.items.slice(0, this.config.maxItemsPerRefresh);
    const results = [];

    for (const item of items) {
      const sourceGuid = stableGuid(item);
      const createdAt = refreshedAt;
      const updatedAt = refreshedAt;

      try {
        const resolved = await resolveArticleContent(item, {
          timeoutMs: this.config.httpTimeoutMs,
          userAgent: this.config.userAgent,
          upstreamProxyUrl: this.config.upstreamProxyUrl,
        });

        const sourceTitle = item.title || resolved.title || item.link || 'Untitled';

        this.db.upsertEntry({
          feedName,
          sourceGuid,
          sourceUrl: item.link || sourceUrl,
          sourceTitle,
          sourceAuthor: item.creator || item.author || resolved.byline || '',
          sourcePublishedAt: item.isoDate || item.pubDate || null,
          sourceContentHtml: item['content:encoded'] || item.content || item.contentSnippet || '',
          extractedContentHtml: resolved.html,
          translatedTitle: null,
          translatedContentHtml: null,
          articleExcerpt: truncate(stripHtml(resolved.html), 240),
          translationProvider: resolved.source,
          refreshStatus: 'ok',
          refreshError: '',
          refreshedAt,
          createdAt,
          updatedAt,
        });

        results.push({
          guid: sourceGuid,
          status: 'ok',
          title: sourceTitle,
        });
      } catch (error) {
        this.db.upsertEntry({
          feedName,
          sourceGuid,
          sourceUrl: item.link || sourceUrl,
          sourceTitle: item.title || item.link || 'Untitled',
          sourceAuthor: item.creator || item.author || '',
          sourcePublishedAt: item.isoDate || item.pubDate || null,
          sourceContentHtml: item['content:encoded'] || item.content || item.contentSnippet || '',
          extractedContentHtml: '',
          translatedTitle: null,
          translatedContentHtml: null,
          articleExcerpt: truncate(stripHtml(item['content:encoded'] || item.content || item.contentSnippet || ''), 240),
          translationProvider: 'source-feed',
          refreshStatus: 'error',
          refreshError: error.message,
          refreshedAt,
          createdAt,
          updatedAt,
        });

        results.push({
          guid: sourceGuid,
          status: 'error',
          title: item.title || item.link || 'Untitled',
          error: error.message,
        });
      }
    }

    this.db.touchFeedRefresh(feedName, refreshedAt);

    return {
      feedName,
      sourceUrl,
      sourceTitle: parsedFeed.title || feedName,
      refreshedAt,
      items: results,
    };
  }

  async refreshStoredFeed({ parser, feedName }) {
    const feed = this.db.getFeedByName(feedName);
    if (!feed) {
      throw new Error(`feed '${feedName}' not found`);
    }

    return this.refreshFeed({
      parser,
      feedName: feed.name,
      sourceUrl: feed.source_url,
    });
  }

  async refreshAllFeeds({ parser }) {
    this.ensureBootstrapFeed();
    const feeds = this.db.listFeeds();
    const results = [];

    for (const feed of feeds) {
      try {
        const result = await this.refreshFeed({
          parser,
          feedName: feed.name,
          sourceUrl: feed.source_url,
        });
        results.push({
          feedName: feed.name,
          ok: true,
          refreshedAt: result.refreshedAt,
          itemCount: result.items.length,
        });
      } catch (error) {
        results.push({
          feedName: feed.name,
          ok: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  renderFeedXml({ request, feedName }) {
    const feed = this.db.getFeedByName(feedName);
    if (!feed) {
      return null;
    }

    const baseUrl = this.baseUrl(request);
    const entries = this.db.listEntriesByFeed(feedName, this.config.maxItemsPerFeed);
    const rss = new RSS({
      title: `${feed.title || feedName} | Reader View`,
      description: `Extracted reader feed generated by NewRSS from ${feed.source_url}`,
      generator: 'NewRSS MVP',
      feed_url: `${baseUrl}/feeds/${encodeURIComponent(feedName)}.xml`,
      site_url: feed.source_url,
      language: 'en',
      pubDate: feed.last_refreshed_at || isoNow(),
    });

    for (const entry of entries) {
      const articleUrl = `${baseUrl}/articles/${entry.id}`;
      const publishedAt = entry.source_published_at || entry.refreshed_at;
      const contentHtml = entry.extracted_content_html || entry.source_content_html || '';
      const description = entry.article_excerpt || truncate(stripHtml(contentHtml), 240);

      rss.item({
        title: entry.source_title,
        guid: `${feedName}:${entry.source_guid}`,
        url: articleUrl,
        date: publishedAt,
        author: entry.source_author || undefined,
        description,
        custom_elements: [
          { 'content:encoded': { _cdata: contentHtml } },
          { source: entry.source_url },
          { contentSource: entry.translation_provider },
          { refreshStatus: entry.refresh_status },
        ],
      });
    }

    return rss.xml({ indent: true });
  }

  renderOpml({ request }) {
    const feeds = this.listFeeds(request);
    const grouped = new Map();

    for (const feed of feeds) {
      const folder = feed.folder || '';
      if (!grouped.has(folder)) {
        grouped.set(folder, []);
      }
      grouped.get(folder).push(feed);
    }

    const outlines = [];

    for (const [folder, items] of grouped.entries()) {
      const feedOutlines = items
        .map(
          (feed) =>
            `<outline text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" type="rss" xmlUrl="${escapeXml(feed.feedUrl)}" htmlUrl="${escapeXml(feed.sourceUrl)}" />`
        )
        .join('\n');

      if (folder) {
        outlines.push(`<outline text="${escapeXml(folder)}" title="${escapeXml(folder)}">\n${feedOutlines}\n</outline>`);
      } else {
        outlines.push(feedOutlines);
      }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>NewRSS Exports</title>
  </head>
  <body>
${outlines.join('\n')}
  </body>
</opml>`;
  }
}

module.exports = FeedService;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
