const RSS = require('rss');
const { resolveArticleContent } = require('./extractor');
const { withProxy } = require('./http-client');
const {
  buildFeedNameFromUrl,
  isoNow,
  isManagedFeedSourceUrl,
  normalizeFolderPath,
  stableGuid,
  stripHtml,
  truncate,
} = require('./utils');

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
      folder: normalizeFolderPath(this.config.defaultFeedFolder || ''),
      title: null,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return this.db.getFeedByName(this.config.defaultFeedName);
  }

  ensureFeed(feedName, sourceUrl, sourceTitle, folder = null) {
    const now = isoNow();
    const existing = this.db.getFeedByName(feedName);

    this.db.upsertFeed({
      name: feedName,
      sourceUrl,
      folder: normalizeFolderPath(folder == null ? existing?.folder || '' : folder || existing?.folder || ''),
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
      folder: normalizeFolderPath(feed.folder || ''),
      title: feed.title || feed.name,
      lastRefreshedAt: feed.last_refreshed_at,
      lastRefreshStatus: feed.last_refresh_status || 'idle',
      lastRefreshError: feed.last_refresh_error || '',
      createdAt: feed.created_at,
      updatedAt: feed.updated_at,
      isManaged: isManagedFeedSourceUrl(feed.source_url),
      entryCount: feed.entry_count,
      errorCount: feed.error_count || 0,
      recentEntryErrors: this.db.listRecentEntryErrorsByFeed(feed.name, 3).map((entry) => ({
        id: entry.id,
        title: entry.source_title || 'Untitled',
        sourceUrl: entry.source_url,
        refreshedAt: entry.refreshed_at,
        error: entry.refresh_error || '',
      })),
      feedUrl: `${baseUrl}/feeds/${encodeURIComponent(feed.name)}.xml`,
    }));
  }

  saveFeed({ name, sourceUrl, folder = '' }) {
    const now = isoNow();
    const existing = this.db.getFeedByName(name) || this.db.getFeedBySourceUrl(sourceUrl);
    const effectiveName = existing?.name || name;
    const normalizedFolder = normalizeFolderPath(folder);

    this.db.upsertFeed({
      name: effectiveName,
      sourceUrl,
      folder: normalizedFolder,
      title: existing?.title || null,
      lastRefreshedAt: existing?.last_refreshed_at || null,
      lastRefreshStatus: existing?.last_refresh_status || null,
      lastRefreshError: existing?.last_refresh_error || null,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });

    return this.db.getFeedByName(effectiveName);
  }

  importFeeds(feeds, folderOverride = '') {
    const normalizedOverride = normalizeFolderPath(folderOverride);
    const imported = [];

    for (const feed of feeds) {
      const sourceUrl = String(feed.sourceUrl || '').trim();
      if (!sourceUrl) {
        continue;
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(sourceUrl);
      } catch {
        continue;
      }

      const title = String(feed.title || '').trim();
      const name = String(feed.name || '').trim() || buildFeedNameFromUrl(parsedUrl);
      const folder = normalizedOverride || normalizeFolderPath(feed.folder || '');
      const existing = this.db.getFeedByName(name) || this.db.getFeedBySourceUrl(parsedUrl.toString());
      const saved = this.saveFeed({
        name: existing?.name || name,
        sourceUrl: parsedUrl.toString(),
        folder,
      });

      if (title && (!existing?.title || existing.title === existing.name)) {
        const now = isoNow();
        this.db.upsertFeed({
          name: saved.name,
          sourceUrl: saved.source_url,
          folder: saved.folder || '',
          title,
          lastRefreshedAt: saved.last_refreshed_at || null,
          lastRefreshStatus: saved.last_refresh_status || null,
          lastRefreshError: saved.last_refresh_error || null,
          createdAt: saved.created_at || now,
          updatedAt: now,
        });
      }

      imported.push({
        name: saved.name,
        sourceUrl: parsedUrl.toString(),
        folder,
        existed: Boolean(existing),
      });
    }

    return {
      total: imported.length,
      created: imported.filter((entry) => !entry.existed).length,
      updated: imported.filter((entry) => entry.existed).length,
      feeds: imported,
    };
  }

  deleteFeed(name) {
    return this.db.deleteFeed(name);
  }

  async refreshFeed({ parser, feedName, sourceUrl }) {
    this.ensureFeed(feedName, sourceUrl, null);

    let parsedFeed;
    try {
      parsedFeed = await this.parseSourceFeed(parser, sourceUrl);
    } catch (error) {
      const refreshedAt = isoNow();
      this.db.setFeedRefreshResult(feedName, refreshedAt, 'error', error.message);
      throw error;
    }

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

    const itemErrors = results.filter((item) => item.status === 'error');
    const feedStatus = itemErrors.length ? 'partial' : 'ok';
    const feedError = itemErrors.length
      ? itemErrors
          .slice(0, 3)
          .map((item) => `${item.title}: ${item.error}`)
          .join(' | ')
      : '';

    this.db.setFeedRefreshResult(feedName, refreshedAt, feedStatus, feedError);

    return {
      feedName,
      sourceUrl,
      sourceTitle: parsedFeed.title || feedName,
      refreshedAt,
      status: feedStatus,
      error: feedError,
      items: results,
    };
  }

  async refreshStoredFeed({ parser, feedName }) {
    const feed = this.db.getFeedByName(feedName);
    if (!feed) {
      throw new Error(`feed '${feedName}' not found`);
    }

    if (isManagedFeedSourceUrl(feed.source_url)) {
      throw new Error(`feed '${feedName}' is managed locally`);
    }

    return this.refreshFeed({
      parser,
      feedName: feed.name,
      sourceUrl: feed.source_url,
    });
  }

  async refreshAllFeeds({ parser }) {
    this.ensureBootstrapFeed();
    const feeds = this.db.listFeeds().filter((feed) => !isManagedFeedSourceUrl(feed.source_url));
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
          status: result.status,
          error: result.error,
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
    const isManaged = isManagedFeedSourceUrl(feed.source_url);
    const rss = new RSS({
      title: `${feed.title || feedName} | Reader View`,
      description: isManaged
        ? `Locally saved articles published by NewRSS in ${feed.title || feedName}`
        : `Extracted reader feed generated by NewRSS from ${feed.source_url}`,
      generator: 'NewRSS MVP',
      feed_url: `${baseUrl}/feeds/${encodeURIComponent(feedName)}.xml`,
      site_url: isManaged ? `${baseUrl}/admin` : feed.source_url,
      language: 'en',
      pubDate: feed.last_refreshed_at || isoNow(),
    });

    for (const entry of entries) {
      const articleUrl = `${baseUrl}/articles/${entry.id}`;
      const publishedAt = entry.source_published_at || entry.refreshed_at;
      const contentHtml =
        entry.translated_content_html ||
        entry.extracted_content_html ||
        entry.source_content_html ||
        '';
      const description = entry.article_excerpt || truncate(stripHtml(contentHtml), 240);

      rss.item({
        title: entry.translated_title || entry.source_title,
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

  renderOpml({ request, folder = '' }) {
    const normalizedFolder = normalizeFolderPath(folder);
    const feeds = this.listFeeds(request).filter((feed) =>
      normalizedFolder ? feed.folder === normalizedFolder : true
    );
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

    const title = normalizedFolder ? `NewRSS Exports - ${escapeXml(normalizedFolder)}` : 'NewRSS Exports';

    return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${title}</title>
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
