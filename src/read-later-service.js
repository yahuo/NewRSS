const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resolveArticleContent } = require('./extractor');
const { sanitizeHtml } = require('./html-sanitizer');
const { renderMarkdown } = require('./markdown-renderer');
const { canonicalXIdentity, importXUrl } = require('./x-importer');
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
    this.translationService = new TranslationService(buildReadLaterTranslationConfig(config), { db });
    this.activeSaves = new Map();
    this.saveChains = new Map();
    this.activeTranslationRetry = null;
    if (this.config.readLaterStoragePath) {
      cleanupStaleWorkspaces(this.config.readLaterStoragePath);
    }
  }

  async saveUrl({ request, baseUrl = '', url, title = '', mode = 'auto', translate = true }) {
    const normalized = normalizeReadLaterUrl(url);
    const normalizedUrl = normalized.url;
    const normalizedMode = this.normalizeMode(mode);
    const saveKey = JSON.stringify([normalized.identity, normalizedMode, Boolean(translate), String(title || '').trim()]);
    if (this.activeSaves.has(saveKey)) {
      return this.activeSaves.get(saveKey);
    }

    const previousSave = this.saveChains.get(normalized.identity) || Promise.resolve();
    const operation = previousSave.catch(() => {}).then(() => this.saveUrlUnlocked({
      request,
      baseUrl,
      normalized,
      title,
      normalizedMode,
      translate: Boolean(translate),
    }));
    const cleanup = () => {
      if (this.activeSaves.get(saveKey) === operation) {
        this.activeSaves.delete(saveKey);
      }
      if (this.saveChains.get(normalized.identity) === operation) {
        this.saveChains.delete(normalized.identity);
      }
    };
    operation.then(cleanup, cleanup);
    this.saveChains.set(normalized.identity, operation);
    this.activeSaves.set(saveKey, operation);
    return operation;
  }

  async saveUrlUnlocked({ request, baseUrl, normalized, title, normalizedMode, translate }) {
    const normalizedUrl = normalized.url;
    const feedName = this.config.readLaterFeedName;
    const sourceGuid = hashText(normalized.identity);
    const workspaceDir = path.join(this.config.readLaterStoragePath, sourceGuid);
    const temporaryWorkspaceDir = path.join(
      this.config.readLaterStoragePath,
      `.${sourceGuid}.${randomUUID()}.tmp`
    );
    const now = isoNow();
    const existing = this.db.getEntryByFeedAndGuid(feedName, sourceGuid);
    let workspaceSwap = null;

    try {
      const imported = await this.importUrl({
        mode: normalizedMode,
        url: normalizedUrl,
        workspaceDir: temporaryWorkspaceDir,
        title,
      });
      const sourceContentHtml = sanitizeHtml(
        imported.sourceContentHtml || imported.extractedContentHtml || '',
        { baseUrl: normalizedUrl }
      );
      const extractedCandidate = sanitizeHtml(
        imported.extractedContentHtml || sourceContentHtml,
        { baseUrl: normalizedUrl }
      );
      const existingExtracted = existing?.extracted_content_html || existing?.source_content_html || '';
      const contentUnchanged = Boolean(existing) &&
        (existing.source_title || '') === (imported.sourceTitle || '') &&
        existingExtracted === extractedCandidate;
      const preservedTranslation = contentUnchanged && existing?.translated_content_html
        ? {
            translatedTitle: existing.translated_title || null,
            translatedContentHtml: existing.translated_content_html,
            provider: existing.translation_provider || imported.translationProvider,
          }
        : null;
      const translationResult = preservedTranslation
        ? { translation: preservedTranslation, error: null, preserved: true }
        : await this.maybeTranslateImported({
            translate,
            imported: { ...imported, sourceContentHtml, extractedContentHtml: extractedCandidate },
            sourceUrl: normalizedUrl,
          });
      const translation = translationResult.translation
        ? {
            ...translationResult.translation,
            translatedContentHtml: sanitizeHtml(translationResult.translation.translatedContentHtml, {
              baseUrl: normalizedUrl,
            }),
          }
        : null;
      const displayContentHtml = translation?.translatedContentHtml || extractedCandidate || sourceContentHtml || '';
      const displayTitle = translation?.translatedTitle || imported.sourceTitle;
      const translationProvider = translationResult.preserved
        ? translation.provider
        : translation
          ? `${imported.translationProvider}+${translation.provider}`
          : imported.translationProvider;
      const archivedHtmlPath = path.join(temporaryWorkspaceDir, 'article.html');
      fs.writeFileSync(
        archivedHtmlPath,
        renderArchivedHtmlPage({
          title: displayTitle || imported.sourceTitle || normalizedUrl,
          sourceUrl: normalizedUrl,
          contentHtml: displayContentHtml,
          provider: translationProvider,
          language: translation ? 'zh-CN' : 'en',
        }),
        { encoding: 'utf8', mode: 0o600 }
      );

      this.feedService.ensureFeed(
        feedName,
        buildManagedFeedSourceUrl(feedName),
        this.config.readLaterFeedTitle,
        this.config.readLaterFeedFolder
      );

      workspaceSwap = replaceWorkspace(temporaryWorkspaceDir, workspaceDir);
      const sourcePublishedAt = imported.sourcePublishedAt || existing?.source_published_at || now;
      const translatedTitle = translation?.translatedTitle || null;
      const translatedContentHtml = translation?.translatedContentHtml || null;
      const displayChanged = !existing ||
        (existing.source_title || '') !== (imported.sourceTitle || '') ||
        existingExtracted !== extractedCandidate ||
        (existing.translated_title || '') !== (translatedTitle || '') ||
        (existing.translated_content_html || '') !== (translatedContentHtml || '');
      const refreshStatus = translationResult.error ? 'partial' : 'ok';
      const refreshError = publicReadLaterError(translationResult.error);

      this.db.upsertEntry({
        feedName,
        sourceGuid,
        sourceUrl: normalizedUrl,
        sourceTitle: imported.sourceTitle,
        sourceAuthor: imported.sourceAuthor || '',
        sourcePublishedAt,
        sourceContentHtml,
        extractedContentHtml: extractedCandidate === sourceContentHtml ? null : extractedCandidate,
        sourceFetchedAt: now,
        contentUpdatedAt: contentUnchanged ? existing.content_updated_at || now : now,
        translatedTitle,
        translatedContentHtml,
        articleExcerpt: truncate(stripHtml(displayContentHtml), 240),
        translationProvider,
        refreshStatus,
        refreshError,
        refreshedAt: now,
        createdAt: existing?.created_at || now,
        updatedAt: now,
      });
      if (!contentUnchanged) {
        this.db.clearEntryTranslationFailure(feedName, sourceGuid);
      }
      if (translationResult.error) {
        this.db.recordEntryTranslationFailure(
          feedName,
          sourceGuid,
          refreshError,
          now,
          nextReadLaterTranslationRetryAt(
            contentUnchanged ? existing : null,
            now,
            translationResult.error.retryAfter
          )
        );
      } else {
        this.db.clearEntryTranslationFailure(feedName, sourceGuid);
      }
      if (displayChanged) {
        this.db.bumpFeedContentRevision(feedName, now);
      }
      this.db.setFeedRefreshResult(feedName, now, refreshStatus, refreshError);
      const savedEntry = this.db.getEntryByFeedAndGuid(feedName, sourceGuid);
      if (!savedEntry) {
        throw new Error('failed to persist read-later entry');
      }
      workspaceSwap.commit();
      workspaceSwap = null;

      const resolvedBaseUrl = String(baseUrl || this.feedService.baseUrl(request)).replace(/\/$/, '');
      return {
        feedName,
        feedTitle: this.config.readLaterFeedTitle,
        entryId: savedEntry.id,
        articleUrl: `${resolvedBaseUrl}/articles/${savedEntry.id}`,
        feedUrl: `${resolvedBaseUrl}/feeds/${encodeURIComponent(feedName)}.xml`,
        sourceGuid,
        sourceUrl: normalizedUrl,
        title: savedEntry.translated_title || savedEntry.source_title || displayTitle,
        mode: normalizedMode,
        translate,
        translated: Boolean(translatedContentHtml),
        translationError: refreshError || null,
        strategy: imported.strategy,
        storage: {
          workspaceDir,
          markdownPath: imported.markdownPath ? path.join(workspaceDir, path.basename(imported.markdownPath)) : null,
          htmlPath: path.join(workspaceDir, 'article.html'),
        },
        existed: Boolean(existing),
      };
    } catch (error) {
      workspaceSwap?.rollback();
      fs.rmSync(temporaryWorkspaceDir, { recursive: true, force: true });
      throw error;
    }
  }

  async maybeTranslateImported({ translate, imported, sourceUrl }) {
    if (!translate) {
      return { translation: null, error: null, preserved: false };
    }

    if (!this.translationService.shouldTranslate({
      title: imported.sourceTitle,
      contentHtml: imported.extractedContentHtml || imported.sourceContentHtml || '',
    })) {
      return { translation: null, error: null, preserved: false };
    }

    try {
      if (imported.sourceMarkdown) {
        const translation = await this.translationService.translateMarkdown({
          sourceTitle: imported.sourceTitle,
          markdown: imported.sourceMarkdown,
          sourceUrl,
          sourceAuthor: imported.sourceAuthor || '',
        });
        return { translation, error: null, preserved: false };
      }

      const translation = await this.translationService.translateArticle({
        sourceTitle: imported.sourceTitle,
        contentHtml: imported.extractedContentHtml || imported.sourceContentHtml || '',
        sourceUrl,
      });
      return { translation, error: null, preserved: false };
    } catch (error) {
      console.error(`[translate] skipped for ${sourceUrl}: ${error.message}`);
      return { translation: null, error, preserved: false };
    }
  }

  retryDueTranslations(limit = 50) {
    if (this.activeTranslationRetry) {
      return this.activeTranslationRetry;
    }
    const operation = this.retryDueTranslationsUnlocked(limit);
    this.activeTranslationRetry = operation;
    const cleanup = () => {
      if (this.activeTranslationRetry === operation) {
        this.activeTranslationRetry = null;
      }
    };
    operation.then(cleanup, cleanup);
    return operation;
  }

  async retryDueTranslationsUnlocked(limit) {
    const feedName = this.config.readLaterFeedName;
    const entries = this.db.listDueReadLaterTranslationRetries(feedName, isoNow(), limit);
    const results = [];
    for (const entry of entries) {
      const contentHtml = entry.extracted_content_html || entry.source_content_html || '';
      if (!this.translationService.isEnabled()) {
        results.push({ entryId: entry.id, status: 'deferred' });
        continue;
      }
      if (!this.translationService.shouldTranslate({ title: entry.source_title, contentHtml })) {
        this.db.clearEntryTranslationFailure(feedName, entry.source_guid);
        results.push({ entryId: entry.id, status: 'skipped' });
        continue;
      }

      try {
        const translation = await this.translationService.translateArticle({
          sourceTitle: entry.source_title || '',
          contentHtml,
          sourceUrl: entry.source_url,
        });
        if (!translation) {
          results.push({ entryId: entry.id, status: 'deferred' });
          continue;
        }
        const current = this.db.getEntryByFeedAndGuid(feedName, entry.source_guid);
        if (!isSameReadLaterEntryVersion(entry, current)) {
          results.push({ entryId: entry.id, status: 'superseded' });
          continue;
        }
        const now = isoNow();
        const translatedContentHtml = sanitizeHtml(translation.translatedContentHtml, {
          baseUrl: entry.source_url,
        });
        this.db.upsertEntry({
          feedName,
          sourceGuid: entry.source_guid,
          sourceUrl: entry.source_url,
          sourceTitle: entry.source_title,
          sourceAuthor: entry.source_author,
          sourcePublishedAt: entry.source_published_at,
          sourceContentHtml: entry.source_content_html,
          extractedContentHtml: entry.extracted_content_html,
          sourceFetchedAt: entry.source_fetched_at || entry.refreshed_at,
          contentUpdatedAt: now,
          translatedTitle: translation.translatedTitle,
          translatedContentHtml,
          articleExcerpt: truncate(stripHtml(translatedContentHtml || contentHtml), 240),
          translationProvider: `${baseTranslationProvider(entry.translation_provider)}+${translation.provider}`,
          refreshStatus: 'ok',
          refreshError: '',
          refreshedAt: now,
          createdAt: entry.created_at,
          updatedAt: now,
        });
        this.db.clearEntryTranslationFailure(feedName, entry.source_guid);
        this.db.bumpFeedContentRevision(feedName, now);
        this.db.setFeedRefreshResult(feedName, now, 'ok', '');
        results.push({ entryId: entry.id, status: 'ok' });
      } catch (error) {
        const current = this.db.getEntryByFeedAndGuid(feedName, entry.source_guid);
        if (!isSameReadLaterEntryVersion(entry, current)) {
          results.push({ entryId: entry.id, status: 'superseded' });
          continue;
        }
        const failedAt = isoNow();
        const publicError = publicReadLaterError(error);
        this.db.recordEntryTranslationFailure(
          feedName,
          entry.source_guid,
          publicError,
          failedAt,
          nextReadLaterTranslationRetryAt(entry, failedAt, error.retryAfter)
        );
        this.db.setFeedRefreshResult(feedName, failedAt, 'partial', publicError);
        results.push({ entryId: entry.id, status: 'error', error: publicError });
      }
    }
    return results;
  }

  listItems({ request, limit = 50 }) {
    return this.listItemsPage({ request, limit }).items;
  }

  listItemsPage({ request, limit = 50, offset = 0, search = '' }) {
    const baseUrl = this.feedService.baseUrl(request);
    const items = this.db.listReadLaterEntries(this.config.readLaterFeedName, {
      limit,
      offset,
      search: String(search || '').normalize('NFKC'),
    }).map((entry) => ({
      id: entry.id,
      title: entry.translated_title || entry.source_title || 'Untitled',
      sourceUrl: entry.source_url,
      articleUrl: `${baseUrl}/articles/${entry.id}`,
      sourcePublishedAt: entry.source_published_at || null,
      refreshedAt: entry.refreshed_at,
      translated: Boolean(entry.is_translated),
    }));
    return {
      items,
      total: this.db.countReadLaterEntries(this.config.readLaterFeedName, {
        search: String(search || '').normalize('NFKC'),
      }),
      limit,
      offset,
      search: String(search || ''),
    };
  }

  deleteItem(entryId) {
    const rawId = String(entryId || '');
    if (!/^[1-9]\d*$/.test(rawId)) {
      throw new Error('invalid read-later entry id');
    }
    const normalizedId = Number(rawId);
    if (!Number.isSafeInteger(normalizedId)) {
      throw new Error('invalid read-later entry id');
    }

    const existing = this.db.getEntryById(normalizedId);
    if (!existing || existing.feed_name !== this.config.readLaterFeedName) {
      return {
        changes: 0,
      };
    }

    const workspaceDir = path.join(this.config.readLaterStoragePath, existing.source_guid);
    const pendingDeleteDir = path.join(
      this.config.readLaterStoragePath,
      `.${existing.source_guid}.${randomUUID()}.delete`
    );
    let moved = false;
    if (fs.existsSync(workspaceDir)) {
      fs.renameSync(workspaceDir, pendingDeleteDir);
      moved = true;
    }

    let deleted;
    try {
      deleted = this.db.deleteEntryByFeedAndId(this.config.readLaterFeedName, normalizedId);
    } catch (error) {
      if (moved) {
        fs.renameSync(pendingDeleteDir, workspaceDir);
      }
      throw error;
    }
    if (deleted.changes) {
      fs.rmSync(pendingDeleteDir, { recursive: true, force: true });
      this.db.bumpFeedContentRevision(this.config.readLaterFeedName);
    } else if (moved) {
      fs.renameSync(pendingDeleteDir, workspaceDir);
    }

    return {
      changes: deleted.changes,
      id: normalizedId,
      sourceGuid: existing.source_guid,
    };
  }

  getCodexStatus() {
    return this.translationService.getCodexStatus();
  }

  isCodexProvider() {
    return this.translationService.isCodexProvider();
  }

  probeCodex(options) {
    return this.translationService.probeCodex(options);
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
        articleCookieFile: this.config.articleCookieFile,
        articleCookieDomain: this.config.articleCookieDomain,
        articleCookieHeader: this.config.articleCookieHeader,
        maxBytes: this.config.articleMaxBytes,
        maxRedirects: this.config.outboundMaxRedirects,
        allowedHosts: this.config.outboundAllowedHosts,
      }
    );

    const sourceTitle = title || resolved.title || url;
    const contentHtml = resolved.html || '';
    if (!contentHtml) {
      throw new Error('readability extraction returned empty content');
    }

    const archivedHtmlPath = path.join(workspaceDir, 'article.html');

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

function buildReadLaterTranslationConfig(config) {
  const provider = String(config.readLaterTranslationProvider || '').trim();
  if (!provider) {
    return config;
  }

  return {
    ...config,
    translationProvider: provider,
  };
}

function cleanupStructuredContent(html) {
  return String(html || '')
    .replace(/\sdata-local-path="[^"]*"/g, '')
    .trim();
}

function baseTranslationProvider(value) {
  return String(value || 'readability').split('+')[0] || 'readability';
}

function nextReadLaterTranslationRetryAt(existingEntry, failedAt, providerRetryAfter) {
  const delaysHours = [2, 6, 12, 24];
  const failureCount = Number(existingEntry?.translation_failure_count || 0) + 1;
  const localRetryAt = new Date(
    new Date(failedAt).getTime() + delaysHours[Math.min(failureCount - 1, delaysHours.length - 1)] * 60 * 60 * 1000
  );
  const providerRetryAt = providerRetryAfter ? new Date(providerRetryAfter) : null;
  return providerRetryAt && Number.isFinite(providerRetryAt.getTime()) && providerRetryAt > localRetryAt
    ? providerRetryAt.toISOString()
    : localRetryAt.toISOString();
}

function publicReadLaterError(error) {
  if (!error) {
    return '';
  }
  const message = String(error.message || 'translation failed');
  if (/\/(?:Users|home|app)\/|[A-Za-z]:\\|auth file|\.codex/i.test(message)) {
    return 'translation failed; see server logs for details';
  }
  return truncate(message, 500);
}

function isSameReadLaterEntryVersion(expected, current) {
  if (!current || current.id !== expected.id) {
    return false;
  }
  for (const field of [
    'source_url',
    'source_title',
    'source_author',
    'source_published_at',
    'source_content_html',
    'extracted_content_html',
    'translated_title',
    'translated_content_html',
    'content_updated_at',
    'updated_at',
  ]) {
    if ((current[field] ?? null) !== (expected[field] ?? null)) {
      return false;
    }
  }
  return true;
}

function renderArchivedHtmlPage({ title, sourceUrl, contentHtml, provider, language = 'en' }) {
  return `<!doctype html>
<html lang="${escapeHtml(language)}" translate="yes">
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

function normalizeReadLaterUrl(value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(value || '').trim());
  } catch {
    throw new Error('url must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('url must be a valid HTTP(S) URL without credentials');
  }
  parsedUrl.hash = '';
  const url = parsedUrl.toString();
  const xIdentity = X_HOSTS.has(parsedUrl.hostname.toLowerCase()) ? canonicalXIdentity(url) : null;
  return {
    url,
    identity: xIdentity?.identity || url,
  };
}

function replaceWorkspace(temporaryDir, finalDir) {
  const previousDir = path.join(
    path.dirname(finalDir),
    `.${path.basename(finalDir)}.${randomUUID()}.previous`
  );
  const hadPrevious = fs.existsSync(finalDir);
  if (hadPrevious) {
    fs.renameSync(finalDir, previousDir);
  }

  try {
    fs.renameSync(temporaryDir, finalDir);
  } catch (error) {
    if (hadPrevious) {
      fs.renameSync(previousDir, finalDir);
    }
    throw error;
  }

  let settled = false;
  return {
    commit() {
      if (settled) return;
      settled = true;
      if (hadPrevious) {
        fs.rmSync(previousDir, { recursive: true, force: true });
      }
    },
    rollback() {
      if (settled) return;
      settled = true;
      fs.rmSync(finalDir, { recursive: true, force: true });
      if (hadPrevious) {
        fs.renameSync(previousDir, finalDir);
      }
    },
  };
}

function cleanupStaleWorkspaces(storagePath) {
  fs.mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pattern = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.(?:tmp|previous|delete)$/i;
  for (const entry of fs.readdirSync(storagePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !pattern.test(entry.name)) {
      continue;
    }
    const target = path.join(storagePath, entry.name);
    if (fs.statSync(target).mtimeMs < cutoff) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
