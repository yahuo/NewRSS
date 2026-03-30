const fs = require('node:fs');
const path = require('node:path');
const { resolveArticleContent } = require('./extractor');
const { renderMarkdown } = require('./markdown-renderer');
const { importXUrl } = require('./x-importer');
const TranslationService = require('./translation-service');
const {
  buildManagedFeedSourceUrl,
  hashText,
  isoNow,
  stripHtml,
  truncate,
} = require('./utils');

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const SUPPORTED_MODES = new Set(['auto', 'x-direct', 'readability']);
const LEGACY_MODE_ALIASES = new Map([['x-markdown', 'x-direct']]);

class ReadLaterService {
  constructor({ db, config, feedService }) {
    this.db = db;
    this.config = config;
    this.feedService = feedService;
    this.translationService = new TranslationService(config);
  }

  async saveUrl({ request, url, title = '', mode = 'auto', translate = true }) {
    const parsedUrl = new URL(String(url || '').trim());
    const normalizedUrl = parsedUrl.toString();
    const normalizedMode = this.normalizeMode(mode);
    const feedName = this.config.readLaterFeedName;
    const sourceGuid = hashText(normalizedUrl);
    const workspaceDir = path.join(this.config.readLaterStoragePath, sourceGuid);
    const now = isoNow();
    const existing = this.db.getEntryByFeedAndGuid(feedName, sourceGuid);
    const imported = await this.importUrl({
      mode: normalizedMode,
      url: normalizedUrl,
      workspaceDir,
      title,
    });
    const translation = await this.maybeTranslateImported({
      translate,
      imported,
      sourceUrl: normalizedUrl,
    });
    const sourceContentHtml = imported.sourceContentHtml || imported.extractedContentHtml || '';
    const displayContentHtml = translation?.translatedContentHtml || imported.extractedContentHtml || sourceContentHtml || '';
    const displayTitle = translation?.translatedTitle || imported.sourceTitle;
    const translationProvider = translation
      ? `${imported.translationProvider}+${translation.provider}`
      : imported.translationProvider;
    const archivedHtmlPath = imported.htmlPath || null;

    if (archivedHtmlPath && displayContentHtml) {
      fs.writeFileSync(
        archivedHtmlPath,
        renderArchivedHtmlPage({
          title: displayTitle || imported.sourceTitle || normalizedUrl,
          sourceUrl: normalizedUrl,
          contentHtml: displayContentHtml,
          provider: translationProvider,
        }),
        'utf8'
      );
    }

    this.feedService.ensureFeed(
      feedName,
      buildManagedFeedSourceUrl(feedName),
      this.config.readLaterFeedTitle,
      this.config.readLaterFeedFolder
    );

    const sourcePublishedAt = imported.sourcePublishedAt || existing?.source_published_at || now;

    this.db.upsertEntry({
      feedName,
      sourceGuid,
      sourceUrl: normalizedUrl,
      sourceTitle: imported.sourceTitle,
      sourceAuthor: imported.sourceAuthor || '',
      sourcePublishedAt,
      sourceContentHtml: sourceContentHtml,
      extractedContentHtml: imported.extractedContentHtml || sourceContentHtml,
      translatedTitle: translation?.translatedTitle || null,
      translatedContentHtml: translation?.translatedContentHtml || null,
      articleExcerpt: truncate(stripHtml(displayContentHtml), 240),
      translationProvider,
      refreshStatus: 'ok',
      refreshError: '',
      refreshedAt: now,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });

    this.db.setFeedRefreshResult(feedName, now, 'ok', '');
    const savedEntry = this.db.getEntryByFeedAndGuid(feedName, sourceGuid);

    if (!savedEntry) {
      throw new Error('failed to persist read-later entry');
    }

    const baseUrl = this.feedService.baseUrl(request);

    return {
      feedName,
      feedTitle: this.config.readLaterFeedTitle,
      entryId: savedEntry.id,
      articleUrl: `${baseUrl}/articles/${savedEntry.id}`,
      feedUrl: `${baseUrl}/feeds/${encodeURIComponent(feedName)}.xml`,
      sourceGuid,
      sourceUrl: normalizedUrl,
      title: savedEntry.translated_title || savedEntry.source_title || displayTitle,
      mode: normalizedMode,
      translate,
      translated: Boolean(translation),
      strategy: imported.strategy,
      storage: {
        workspaceDir,
        markdownPath: imported.markdownPath || null,
        htmlPath: archivedHtmlPath,
      },
      existed: Boolean(existing),
    };
  }

  async maybeTranslateImported({ translate, imported, sourceUrl }) {
    if (!translate) {
      return null;
    }

    if (!this.translationService.shouldTranslate({
      title: imported.sourceTitle,
      contentHtml: imported.extractedContentHtml || imported.sourceContentHtml || '',
    })) {
      return null;
    }

    try {
      if (imported.sourceMarkdown) {
        return await this.translationService.translateMarkdown({
          sourceTitle: imported.sourceTitle,
          markdown: imported.sourceMarkdown,
          sourceUrl,
          sourceAuthor: imported.sourceAuthor || '',
        });
      }

      return await this.translationService.translateArticle({
        sourceTitle: imported.sourceTitle,
        contentHtml: imported.extractedContentHtml || imported.sourceContentHtml || '',
        sourceUrl,
      });
    } catch (error) {
      console.error(`[translate] skipped for ${sourceUrl}: ${error.message}`);
      return null;
    }
  }

  listItems({ request, limit = 50 }) {
    const existingFeed = this.db.getFeedByName(this.config.readLaterFeedName);
    if (existingFeed) {
      this.feedService.ensureFeed(
        this.config.readLaterFeedName,
        buildManagedFeedSourceUrl(this.config.readLaterFeedName),
        this.config.readLaterFeedTitle,
        this.config.readLaterFeedFolder
      );
    }

    const baseUrl = this.feedService.baseUrl(request);
    return this.db.listEntriesByFeed(this.config.readLaterFeedName, limit).map((entry) => ({
      id: entry.id,
      title: entry.translated_title || entry.source_title || 'Untitled',
      sourceUrl: entry.source_url,
      articleUrl: `${baseUrl}/articles/${entry.id}`,
      sourcePublishedAt: entry.source_published_at || null,
      refreshedAt: entry.refreshed_at,
      translated: Boolean(entry.translated_content_html),
    }));
  }

  deleteItem(entryId) {
    const normalizedId = Number.parseInt(String(entryId), 10);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
      throw new Error('invalid read-later entry id');
    }

    const existing = this.db.getEntryById(normalizedId);
    if (!existing || existing.feed_name !== this.config.readLaterFeedName) {
      return {
        changes: 0,
      };
    }

    const deleted = this.db.deleteEntryByFeedAndId(this.config.readLaterFeedName, normalizedId);
    if (deleted.changes) {
      const workspaceDir = path.join(this.config.readLaterStoragePath, existing.source_guid);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }

    return {
      changes: deleted.changes,
      id: normalizedId,
      sourceGuid: existing.source_guid,
    };
  }

  normalizeMode(mode) {
    const requested = String(mode || 'auto').trim().toLowerCase();
    const normalized = LEGACY_MODE_ALIASES.get(requested) || requested;
    if (!SUPPORTED_MODES.has(normalized)) {
      throw new Error(`mode must be one of: ${Array.from(SUPPORTED_MODES).join(', ')}`);
    }

    return normalized;
  }

  async importUrl({ mode, url, workspaceDir, title }) {
    const parsedUrl = new URL(url);

    if (mode === 'x-direct') {
      return this.importXDirectUrl({ url, workspaceDir, title });
    }

    if (mode === 'readability') {
      return this.importReadableUrl({ url, workspaceDir, title });
    }

    if (X_HOSTS.has(parsedUrl.hostname)) {
      try {
        return await this.importXDirectUrl({ url, workspaceDir, title });
      } catch (primaryError) {
        try {
          const fallback = await this.importReadableUrl({ url, workspaceDir, title });
          return {
            ...fallback,
            strategy: `${fallback.strategy}+fallback`,
            fallbackReason: primaryError.message,
          };
        } catch (fallbackError) {
          throw new Error(`x-direct failed: ${primaryError.message}; readability failed: ${fallbackError.message}`);
        }
      }
    }

    return this.importReadableUrl({ url, workspaceDir, title });
  }

  async importXDirectUrl({ url, workspaceDir, title }) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const xResult = await importXUrl({
      url,
      title,
      config: this.config,
    });
    const rendered = renderMarkdown(xResult.markdown, {
      title: xResult.sourceTitle,
      author: xResult.sourceAuthor,
      sourceUrl: xResult.sourceUrl || url,
      fallbackTitle: 'X Article',
    });
    const archivedHtmlPath = path.join(workspaceDir, 'article.html');
    fs.writeFileSync(archivedHtmlPath, rendered.html, 'utf8');

    const cleanedContentHtml = cleanupStructuredContent(rendered.contentHtml);
    if (!cleanedContentHtml) {
      throw new Error('x-direct generated empty content');
    }

    return {
      strategy: 'x-direct',
      sourceTitle: xResult.sourceTitle || rendered.title,
      sourceAuthor: xResult.sourceAuthor || rendered.author || '',
      sourcePublishedAt: xResult.sourcePublishedAt || null,
      sourceMarkdown: xResult.markdown,
      sourceContentHtml: cleanedContentHtml,
      extractedContentHtml: cleanedContentHtml,
      translationProvider: 'newrss-x-direct',
      markdownPath: null,
      htmlPath: archivedHtmlPath,
    };
  }

  async importReadableUrl({ url, workspaceDir, title }) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const resolved = await resolveArticleContent(
      {
        link: url,
        title,
      },
      {
        timeoutMs: this.config.httpTimeoutMs,
        userAgent: this.config.userAgent,
        upstreamProxyUrl: this.config.upstreamProxyUrl,
      }
    );

    const sourceTitle = title || resolved.title || url;
    const contentHtml = resolved.html || '';
    if (!contentHtml) {
      throw new Error('readability extraction returned empty content');
    }

    const archivedHtmlPath = path.join(workspaceDir, 'article.html');
    fs.writeFileSync(
      archivedHtmlPath,
      renderArchivedHtmlPage({
        title: sourceTitle,
        sourceUrl: url,
        contentHtml,
        provider: resolved.source,
      })
    );

    return {
      strategy: 'readability',
      sourceTitle,
      sourceAuthor: resolved.byline || '',
      sourcePublishedAt: null,
      sourceContentHtml: contentHtml,
      extractedContentHtml: contentHtml,
      translationProvider: resolved.source,
      markdownPath: null,
      htmlPath: archivedHtmlPath,
    };
  }
}

module.exports = ReadLaterService;

function cleanupStructuredContent(html) {
  return String(html || '')
    .replace(/\sdata-local-path="[^"]*"/g, '')
    .trim();
}

function renderArchivedHtmlPage({ title, sourceUrl, contentHtml, provider }) {
  return `<!doctype html>
<html lang="en" translate="yes">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f4ed;
        --card: #fffdf8;
        --ink: #1c1a16;
        --muted: #72695a;
        --line: #e6decd;
        --link: #0f5c9a;
      }
      body {
        margin: 0;
        padding: 32px 16px;
        background: linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
        color: var(--ink);
        font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif;
      }
      main {
        max-width: 860px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 32px;
        box-shadow: 0 18px 50px rgba(84, 62, 20, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.08;
      }
      .meta {
        margin-bottom: 24px;
        color: var(--muted);
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
        Original: <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(sourceUrl)}</a><br />
        Provider: ${escapeHtml(provider)}
      </div>
      <article>${contentHtml}</article>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
