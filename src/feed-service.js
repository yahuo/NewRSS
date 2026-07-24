const RSS = require('rss');
const { isNewYorkTimesLiveUrl } = require('./article-strategies');
const { resolveArticleContent } = require('./extractor');
const { sanitizeHtml } = require('./html-sanitizer');
const { fetchText } = require('./outbound-http');
const TranslationService = require('./translation-service');
const DEFAULT_RSS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const {
  buildFeedNameFromUrl,
  hashText,
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
    this.translationService = new TranslationService(config, { db });
    this.activeRefresh = null;
    this.feedXmlCache = new Map();
    this.feedXmlCacheBytes = 0;
  }

  baseUrl(request) {
    if (this.config.appBaseUrl) {
      return this.config.appBaseUrl.replace(/\/$/, '');
    }

    if (!request) {
      throw new Error('request is required when APP_BASE_URL is not configured');
    }
    const host = String(request.get('host') || '').trim();
    if (!isSafeHostHeader(host)) {
      const error = new Error('invalid Host header');
      error.code = 'INVALID_HOST';
      throw error;
    }
    return `${request.protocol}://${host}`;
  }

  async fetchSourceFeed(sourceUrl) {
    return fetchText(sourceUrl, {
      headers: {
        'user-agent': this.config.userAgent,
        accept: 'application/rss+xml, application/xml, text/xml',
      },
      timeoutMs: this.config.httpTimeoutMs,
      maxBytes: this.config.rssMaxBytes,
      maxRedirects: this.config.outboundMaxRedirects,
      upstreamProxyUrl: this.config.upstreamProxyUrl,
      allowedHosts: this.config.outboundAllowedHosts,
      allowFakeIp: this.config.outboundAllowFakeIp,
    });
  }

  async parseSourceFeed(parser, sourceUrl) {
    const xml = await this.fetchSourceFeed(sourceUrl);
    return parser.parseString(xml);
  }

  ensureBootstrapFeed() {
    if (!this.config.defaultFeedName || !this.config.defaultFeedUrl) {
      return null;
    }

    if (this.db.hasFeeds()) {
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
      translateEnabled: false,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return this.db.getFeedByName(this.config.defaultFeedName);
  }

  ensureFeed(feedName, sourceUrl, sourceTitle, folder = null, translateEnabled = null) {
    const now = isoNow();
    const existing = this.db.getFeedByName(feedName);
    const normalizedSourceTitle = String(sourceTitle || '').trim();
    const effectiveTranslateEnabled =
      typeof translateEnabled === 'boolean' ? translateEnabled : Boolean(existing?.translate_enabled);
    const effectiveTitle = existing?.title || normalizedSourceTitle || null;
    const metadataChanged = hasFeedMetadataChanged(existing, {
      sourceUrl,
      title: effectiveTitle,
      translateEnabled: effectiveTranslateEnabled,
    });

    this.db.upsertFeed({
      name: feedName,
      sourceUrl,
      folder: normalizeFolderPath(folder == null ? existing?.folder || '' : folder || existing?.folder || ''),
      title: effectiveTitle,
      translateEnabled: effectiveTranslateEnabled,
      lastRefreshedAt: existing?.last_refreshed_at || null,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });
    if (metadataChanged) {
      this.db.bumpFeedContentRevision(feedName, now);
    }
  }

  listFeeds(request) {
    const baseUrl = this.baseUrl(request);
    const feeds = this.db.listFeeds();
    const errorsByFeed = new Map();
    for (const entry of this.db.listRecentEntryErrorsByFeeds(feeds.map((feed) => feed.name), 3)) {
      if (!errorsByFeed.has(entry.feed_name)) {
        errorsByFeed.set(entry.feed_name, []);
      }
      errorsByFeed.get(entry.feed_name).push(entry);
    }

    return feeds.map((feed) => ({
      name: feed.name,
      sourceUrl: feed.source_url,
      folder: normalizeFolderPath(feed.folder || ''),
      title: feed.title || feed.name,
      translateEnabled: Boolean(feed.translate_enabled),
      lastRefreshedAt: feed.last_refreshed_at,
      lastRefreshStatus: feed.last_refresh_status || 'idle',
      lastRefreshError: feed.last_refresh_error || '',
      createdAt: feed.created_at,
      updatedAt: feed.updated_at,
      isManaged: isManagedFeedSourceUrl(feed.source_url),
      entryCount: feed.entry_count,
      errorCount: feed.error_count || 0,
      recentEntryErrors: (errorsByFeed.get(feed.name) || []).map((entry) => ({
        id: entry.id,
        title: entry.source_title || 'Untitled',
        sourceUrl: entry.source_url,
        refreshedAt: entry.refreshed_at,
        error: entry.refresh_error || '',
      })),
      feedUrl: `${baseUrl}/feeds/${encodeURIComponent(feed.name)}.xml`,
    }));
  }

  saveFeed({ name, sourceUrl, folder, title, translateEnabled, autoName = false }) {
    const now = isoNow();
    const existingByUrl = this.db.getFeedBySourceUrl(sourceUrl);
    const existingByName = this.db.getFeedByName(name);
    const effectiveName = existingByUrl?.name || resolveAvailableFeedName({
      db: this.db,
      requestedName: name,
      sourceUrl,
      autoName,
      existingByName,
    });
    const existing = existingByUrl || this.db.getFeedByName(effectiveName);
    if (effectiveName === this.config.readLaterFeedName && !isManagedFeedSourceUrl(sourceUrl)) {
      const error = new Error(`feed name '${effectiveName}' is reserved for Read Later`);
      error.code = 'FEED_CONFLICT';
      throw error;
    }
    const normalizedFolder = folder === undefined
      ? normalizeFolderPath(existing?.folder || '')
      : normalizeFolderPath(folder);
    const normalizedTitle = typeof title === 'string' ? title.trim() : '';
    const effectiveTitle = normalizedTitle || existing?.title || effectiveName;
    const effectiveTranslateEnabled =
      typeof translateEnabled === 'boolean' ? translateEnabled : Boolean(existing?.translate_enabled);
    const metadataChanged = hasFeedMetadataChanged(existing, {
      sourceUrl,
      title: effectiveTitle,
      translateEnabled: effectiveTranslateEnabled,
    });

    this.db.upsertFeed({
      name: effectiveName,
      sourceUrl,
      folder: normalizedFolder,
      title: effectiveTitle,
      translateEnabled: effectiveTranslateEnabled,
      lastRefreshedAt: existing?.last_refreshed_at || null,
      lastRefreshStatus: existing?.last_refresh_status || null,
      lastRefreshError: existing?.last_refresh_error || null,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });
    if (metadataChanged) {
      this.db.bumpFeedContentRevision(effectiveName, now);
    }

    return this.db.getFeedByName(effectiveName);
  }

  importFeeds(feeds, folderOverride = '') {
    const normalizedOverride = normalizeFolderPath(folderOverride);
    const imported = [];

    const operation = () => {
      for (const feed of feeds) {
        const sourceUrl = String(feed.sourceUrl || '').trim();
        if (!sourceUrl) {
          continue;
        }

        const parsedUrl = parseHttpUrl(sourceUrl);
        if (!parsedUrl) {
          continue;
        }

        const title = String(feed.title || '').trim();
        const name = String(feed.name || '').trim() || buildFeedNameFromUrl(parsedUrl);
        const folder = normalizedOverride || normalizeFolderPath(feed.folder || '');
        const existing = this.db.getFeedBySourceUrl(parsedUrl.toString());
        const saved = this.saveFeed({
          name,
          sourceUrl: parsedUrl.toString(),
          folder,
          autoName: !String(feed.name || '').trim(),
        });

        if (title && (!existing?.title || existing.title === existing.name)) {
          const now = isoNow();
          this.db.upsertFeed({
            name: saved.name,
            sourceUrl: saved.source_url,
            folder: saved.folder || '',
            title,
            translateEnabled: Boolean(saved.translate_enabled),
            lastRefreshedAt: saved.last_refreshed_at || null,
            lastRefreshStatus: saved.last_refresh_status || null,
            lastRefreshError: saved.last_refresh_error || null,
            createdAt: saved.created_at || now,
            updatedAt: now,
          });
          this.db.bumpFeedContentRevision(saved.name, now);
        }

        imported.push({
          name: saved.name,
          sourceUrl: parsedUrl.toString(),
          folder,
          existed: Boolean(existing),
        });
      }
    };

    if (typeof this.db.transaction === 'function') {
      this.db.transaction(operation);
    } else {
      operation();
    }

    return {
      total: imported.length,
      created: imported.filter((entry) => !entry.existed).length,
      updated: imported.filter((entry) => entry.existed).length,
      feeds: imported,
    };
  }

  deleteFeed(name) {
    if (name === this.config.readLaterFeedName) {
      const error = new Error(`feed '${name}' is managed by Read Later and cannot be deleted`);
      error.code = 'FEED_CONFLICT';
      throw error;
    }
    const deleted = this.db.deleteFeed(name);
    if (deleted.changes) {
      this.invalidateFeedXmlCache(name);
    }
    return deleted;
  }

  async refreshFeed({ parser, feedName, sourceUrl, lockHeld = false }) {
    if (feedName === this.config.readLaterFeedName && !isManagedFeedSourceUrl(sourceUrl)) {
      const error = new Error(`feed name '${feedName}' is reserved for Read Later`);
      error.code = 'FEED_CONFLICT';
      throw error;
    }
    if (!lockHeld) {
      return this.withRefreshLock(`feed:${feedName}`, false, () =>
        this.refreshFeed({ parser, feedName, sourceUrl, lockHeld: true })
      );
    }

    const refreshedAt = isoNow();

    try {
      return await this.runFeedRefresh({ parser, feedName, sourceUrl, refreshedAt });
    } catch (error) {
      this.db.setFeedRefreshResult(feedName, refreshedAt, 'error', publicErrorMessage(error));
      throw error;
    }
  }

  async runFeedRefresh({ parser, feedName, sourceUrl, refreshedAt }) {
    this.ensureFeed(feedName, sourceUrl, null);
    const storedFeed = this.db.getFeedByName(feedName);
    const translateEnabled = Boolean(storedFeed?.translate_enabled);
    this.db.setFeedRefreshResult(feedName, refreshedAt, 'refreshing', '');

    const parsedFeed = await this.parseSourceFeed(parser, sourceUrl);
    const sourceTitle = String(parsedFeed.title || '').trim() || feedName;
    this.ensureFeed(feedName, sourceUrl, sourceTitle);

    const items = parsedFeed.items
      .filter((item) => !isNewYorkTimesLiveUrl(item.link))
      .slice(0, this.config.maxItemsPerRefresh);
    const results = await mapWithConcurrency(
      items,
      this.config.itemRefreshConcurrency || 1,
      (item) => this.processFeedItem({ item, feedName, sourceUrl, translateEnabled, refreshedAt })
    );

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
      sourceTitle,
      translateEnabled,
      refreshedAt,
      status: feedStatus,
      error: feedError,
      items: results,
    };
  }

  async processFeedItem({ item, feedName, sourceUrl, translateEnabled, refreshedAt }) {
    const normalizedItem = normalizeFeedItem(item, sourceUrl);
    const sourceGuid = stableGuid(normalizedItem);
    const existingEntry = this.db.getEntryByFeedAndGuid(feedName, sourceGuid);
    const itemUrl = normalizedItem.link || sourceUrl;
    const rawSourceContentHtml = sanitizeHtml(
      normalizedItem['content:encoded'] || normalizedItem.content || normalizedItem.contentSnippet || '',
      { baseUrl: itemUrl }
    );
    let resolvedSourceTitle = '';
    let resolvedExtractedContentHtml = '';
    let translationStateReset = false;
    let fetchedSource = false;

    try {
      const reuseFetchedSource = shouldReuseFetchedSource({
        existingEntry,
        item: normalizedItem,
        sourceContentHtml: rawSourceContentHtml,
        refreshedAt,
        recheckHours: this.config.articleRecheckHours || 24,
      });
      const resolved = reuseFetchedSource
        ? {
            html: existingEntry.extracted_content_html || existingEntry.source_content_html || '',
            title: existingEntry.source_title || '',
            byline: existingEntry.source_author || '',
            source: baseTranslationProvider(existingEntry.translation_provider),
          }
        : await resolveArticleContent(normalizedItem, {
            timeoutMs: this.config.httpTimeoutMs,
            userAgent: this.config.userAgent,
            upstreamProxyUrl: this.config.upstreamProxyUrl,
            articleCookieFile: this.config.articleCookieFile,
            articleCookieDomain: this.config.articleCookieDomain,
            articleCookieHeader: this.config.articleCookieHeader,
            maxBytes: this.config.articleMaxBytes,
            maxRedirects: this.config.outboundMaxRedirects,
            allowedHosts: this.config.outboundAllowedHosts,
            allowFakeIp: this.config.outboundAllowFakeIp,
          });
      fetchedSource = !reuseFetchedSource;

      const sourceTitle = normalizedItem.title || resolved.title || itemUrl || 'Untitled';
      const sourceContentHtml = rawSourceContentHtml;
      const extractedContentHtml = sanitizeHtml(resolved.html || sourceContentHtml || '', { baseUrl: itemUrl });
      resolvedSourceTitle = sourceTitle;
      resolvedExtractedContentHtml = extractedContentHtml;
      const existingExtractedContentHtml = existingEntry?.extracted_content_html || existingEntry?.source_content_html || '';
      const contentChanged = Boolean(existingEntry) && (
        (existingEntry.source_title || '') !== sourceTitle ||
        existingExtractedContentHtml !== extractedContentHtml
      );
      if (contentChanged) {
        this.db.clearEntryTranslationFailure(feedName, sourceGuid);
        translationStateReset = true;
      }
      const translationBackoffActive =
        translateEnabled &&
        !contentChanged &&
        Boolean(existingEntry?.translation_retry_after) &&
        existingEntry.translation_retry_after > refreshedAt;
      const translationBackoffExpired =
        Boolean(existingEntry?.translation_retry_after) &&
        existingEntry.translation_retry_after <= refreshedAt;
      const reuseExistingTranslation =
        translateEnabled &&
        Boolean(existingEntry?.translated_content_html) &&
        !translationBackoffExpired &&
        !contentChanged;
      const translation = reuseExistingTranslation || translationBackoffActive
        ? null
        : await this.maybeTranslateFeedEntry({
            feedName,
            translateEnabled,
            sourceTitle,
            contentHtml: extractedContentHtml,
            sourceUrl: itemUrl,
          });
      const translatedTitle = translation?.translatedTitle ||
        (reuseExistingTranslation ? existingEntry?.translated_title || null : null);
      const translatedContentHtml = translation?.translatedContentHtml
        ? sanitizeHtml(translation.translatedContentHtml, { baseUrl: itemUrl })
        : reuseExistingTranslation
          ? existingEntry?.translated_content_html || null
          : null;
      const translationProvider = translation
        ? `${resolved.source}+${translation.provider}`
        : reuseExistingTranslation
          ? existingEntry?.translation_provider || resolved.source
          : resolved.source;
      const displayContentHtml = translatedContentHtml || extractedContentHtml;
      const displayTitle = translatedTitle || sourceTitle;
      const previousDisplayContentHtml = existingEntry?.translated_content_html || existingExtractedContentHtml;
      const previousDisplayTitle = existingEntry?.translated_title || existingEntry?.source_title || '';
      const displayChanged = !existingEntry ||
        previousDisplayTitle !== displayTitle ||
        previousDisplayContentHtml !== displayContentHtml;
      const sourceAuthor = normalizedItem.creator || normalizedItem.author || resolved.byline || '';
      const sourcePublishedAt = normalizedItem.isoDate || normalizedItem.pubDate || null;
      const storedExtractedContentHtml = extractedContentHtml === sourceContentHtml ? null : extractedContentHtml;
      const metadataUnchanged = Boolean(existingEntry) &&
        existingEntry.source_url === itemUrl &&
        (existingEntry.source_author || '') === sourceAuthor &&
        (existingEntry.source_published_at || null) === sourcePublishedAt &&
        (existingEntry.source_content_html || '') === sourceContentHtml &&
        (existingEntry.extracted_content_html || null) === storedExtractedContentHtml &&
        (existingEntry.translation_provider || '') === translationProvider;

      if (!displayChanged && metadataUnchanged) {
        this.db.touchEntryRefresh(feedName, sourceGuid, {
          refreshStatus: 'ok',
          refreshError: '',
          refreshedAt,
          sourceFetchedAt: fetchedSource ? refreshedAt : null,
        });
      } else {
        this.db.upsertEntry({
          feedName,
          sourceGuid,
          sourceUrl: itemUrl,
          sourceTitle,
          sourceAuthor,
          sourcePublishedAt,
          sourceContentHtml,
          extractedContentHtml: storedExtractedContentHtml,
          sourceFetchedAt: fetchedSource ? refreshedAt : existingEntry?.source_fetched_at || refreshedAt,
          contentUpdatedAt: displayChanged ? refreshedAt : existingEntry?.content_updated_at || refreshedAt,
          translatedTitle,
          translatedContentHtml,
          articleExcerpt: truncate(stripHtml(displayContentHtml), 240),
          translationProvider,
          refreshStatus: 'ok',
          refreshError: '',
          refreshedAt,
          createdAt: existingEntry?.created_at || refreshedAt,
          updatedAt: refreshedAt,
        });
      }
      if (displayChanged) {
        this.db.bumpFeedContentRevision(feedName, refreshedAt);
      }
      if (!translationBackoffActive) {
        this.db.clearEntryTranslationFailure(feedName, sourceGuid);
      }

      return {
        guid: sourceGuid,
        status: translationBackoffActive ? 'backoff' : 'ok',
        title: displayTitle,
        retryAfter: translationBackoffActive ? existingEntry.translation_retry_after : null,
        reused: reuseFetchedSource,
      };
    } catch (error) {
      console.error(`[refresh] ${feedName} ${itemUrl} failed: ${error.stack || error.message}`);
      const publicError = publicErrorMessage(error);
      const sourceContentHtml = rawSourceContentHtml || existingEntry?.source_content_html || '';
      const extractedContentHtml = resolvedExtractedContentHtml || existingEntry?.extracted_content_html || '';
      const translatedTitle = translationStateReset ? null : existingEntry?.translated_title || null;
      const translatedContentHtml = translationStateReset ? null : existingEntry?.translated_content_html || null;
      const displayContentHtml = translatedContentHtml || extractedContentHtml || sourceContentHtml;

      this.db.upsertEntry({
        feedName,
        sourceGuid,
        sourceUrl: itemUrl,
        sourceTitle: resolvedSourceTitle || normalizedItem.title || existingEntry?.source_title || itemUrl || 'Untitled',
        sourceAuthor: normalizedItem.creator || normalizedItem.author || existingEntry?.source_author || '',
        sourcePublishedAt: normalizedItem.isoDate || normalizedItem.pubDate || existingEntry?.source_published_at || null,
        sourceContentHtml,
        extractedContentHtml,
        sourceFetchedAt: fetchedSource ? refreshedAt : existingEntry?.source_fetched_at || refreshedAt,
        contentUpdatedAt: existingEntry?.content_updated_at || refreshedAt,
        translatedTitle,
        translatedContentHtml,
        articleExcerpt: truncate(stripHtml(displayContentHtml), 240),
        translationProvider: translationStateReset
          ? baseTranslationProvider(existingEntry?.translation_provider)
          : existingEntry?.translation_provider || 'source-feed',
        refreshStatus: 'error',
        refreshError: publicError,
        refreshedAt,
        createdAt: existingEntry?.created_at || refreshedAt,
        updatedAt: refreshedAt,
      });
      if (!existingEntry || translationStateReset) {
        this.db.bumpFeedContentRevision(feedName, refreshedAt);
      }

      if (
        error.translationFailure &&
        error.code !== 'CODEX_CIRCUIT_OPEN' &&
        error.code !== 'CODEX_USAGE_LIMIT'
      ) {
        const retryAfter = nextTranslationRetryAt(translationStateReset ? null : existingEntry, refreshedAt, error.retryAfter);
        this.db.recordEntryTranslationFailure(feedName, sourceGuid, publicError, refreshedAt, retryAfter);
      }

      return {
        guid: sourceGuid,
        status: 'error',
        title: normalizedItem.title || itemUrl || 'Untitled',
        error: publicError,
      };
    }
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
    return this.withRefreshLock('all-feeds', false, () => this.refreshAllFeedsUnlocked({ parser }));
  }

  async tryRefreshAllFeeds({ parser }) {
    return this.withRefreshLock('scheduled-all-feeds', true, () => this.refreshAllFeedsUnlocked({ parser }));
  }

  async refreshAllFeedsUnlocked({ parser }) {
    this.ensureBootstrapFeed();
    const feeds = this.db.listFeeds().filter((feed) => !isManagedFeedSourceUrl(feed.source_url));
    const results = await mapWithConcurrency(feeds, this.config.feedRefreshConcurrency || 1, async (feed) => {
      try {
        const result = await this.refreshFeed({
          parser,
          feedName: feed.name,
          sourceUrl: feed.source_url,
          lockHeld: true,
        });
        return {
          feedName: feed.name,
          ok: true,
          refreshedAt: result.refreshedAt,
          status: result.status,
          error: result.error,
          itemCount: result.items.length,
        };
      } catch (error) {
        return {
          feedName: feed.name,
          ok: false,
          error: publicErrorMessage(error),
        };
      }
    });

    this.lastTranslationRetryResults = await this.retryDueTranslations();
    return results;
  }

  async retryDueTranslations(limit = 50) {
    const dueEntries = this.db.listDueTranslationRetries(isoNow(), limit);
    return mapWithConcurrency(dueEntries, Math.min(this.config.itemRefreshConcurrency || 1, 3), async (entry) => {
      const contentHtml = entry.extracted_content_html || entry.source_content_html || '';
      try {
        const translation = await this.maybeTranslateFeedEntry({
          feedName: entry.feed_name,
          translateEnabled: true,
          sourceTitle: entry.source_title || '',
          contentHtml,
          sourceUrl: entry.source_url,
        });
        if (!translation) {
          this.db.clearEntryTranslationFailure(entry.feed_name, entry.source_guid);
          return { entryId: entry.id, status: 'skipped' };
        }
        const translatedContentHtml = sanitizeHtml(translation.translatedContentHtml, {
          baseUrl: entry.source_url,
        });
        const now = isoNow();
        this.db.upsertEntry({
          feedName: entry.feed_name,
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
        this.db.clearEntryTranslationFailure(entry.feed_name, entry.source_guid);
        this.db.bumpFeedContentRevision(entry.feed_name, now);
        return { entryId: entry.id, status: 'ok' };
      } catch (error) {
        if (error.code !== 'CODEX_CIRCUIT_OPEN' && error.code !== 'CODEX_USAGE_LIMIT') {
          const failedAt = isoNow();
          this.db.recordEntryTranslationFailure(
            entry.feed_name,
            entry.source_guid,
            publicErrorMessage(error),
            failedAt,
            nextTranslationRetryAt(entry, failedAt, error.retryAfter)
          );
        }
        return { entryId: entry.id, status: 'error', error: publicErrorMessage(error) };
      }
    });
  }

  async withRefreshLock(label, skipIfBusy, operation) {
    if (this.activeRefresh) {
      if (skipIfBusy) {
        return {
          skipped: true,
          reason: `refresh already running: ${this.activeRefresh.label}`,
          startedAt: this.activeRefresh.startedAt,
        };
      }
      const error = new Error(`refresh already running: ${this.activeRefresh.label}`);
      error.code = 'REFRESH_IN_PROGRESS';
      throw error;
    }

    this.activeRefresh = { label, startedAt: isoNow() };
    try {
      return await operation();
    } finally {
      this.activeRefresh = null;
    }
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

  async maybeTranslateFeedEntry({ feedName, translateEnabled, sourceTitle, contentHtml, sourceUrl }) {
    if (!translateEnabled) {
      return null;
    }

    if (!this.translationService.shouldTranslate({ title: sourceTitle, contentHtml })) {
      return null;
    }

    try {
      return await this.translationService.translateArticle({
        sourceTitle,
        contentHtml,
        sourceUrl,
      });
    } catch (error) {
      console.error(`[translate] skipped for feed ${feedName} ${sourceUrl}: ${error.message}`);
      error.translationFailure = true;
      throw error;
    }
  }

  renderFeedXml({ request, feedName }) {
    const feed = this.db.getFeedByName(feedName);
    if (!feed) {
      return null;
    }

    const baseUrl = this.baseUrl(request);
    const revision = Number(feed.content_revision || 0);
    const cacheKey = `${feedName}\n${baseUrl}\n${this.config.maxItemsPerFeed}\n${revision}`;
    const cached = this.feedXmlCache.get(cacheKey);
    if (cached) {
      this.feedXmlCache.delete(cacheKey);
      this.feedXmlCache.set(cacheKey, cached);
      return cached.xml;
    }
    const entries = this.db.listFeedEntriesForRender(feedName, this.config.maxItemsPerFeed);
    const isManaged = isManagedFeedSourceUrl(feed.source_url);
    const rss = new RSS({
      title: `${feed.title || feedName} | Reader View`,
      description: isManaged
        ? `Locally saved articles published by NewRSS in ${feed.title || feedName}`
        : `Extracted reader feed generated by NewRSS from ${feed.source_url}`,
      generator: 'NewRSS MVP',
      feed_url: `${baseUrl}/feeds/${encodeURIComponent(feedName)}.xml`,
      site_url: isManaged ? `${baseUrl}/admin` : feed.source_url,
      language: feed.translate_enabled ? 'zh-CN' : 'en',
      pubDate: feed.content_updated_at || feed.created_at,
    });

    for (const entry of entries) {
      const articleUrl = `${baseUrl}/articles/${entry.id}`;
      const publishedAt = entry.source_published_at || entry.refreshed_at;
      const contentHtml = sanitizeHtml(
        entry.translated_content_html ||
        entry.extracted_content_html ||
        entry.source_content_html ||
        '',
        { baseUrl: entry.source_url }
      );
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

    const xml = rss.xml({ indent: true });
    this.cacheFeedXml(feedName, cacheKey, xml);
    return xml;
  }

  invalidateFeedXmlCache(feedName) {
    for (const key of Array.from(this.feedXmlCache.keys())) {
      if (key.startsWith(`${feedName}\n`)) {
        this.removeFeedXmlCacheEntry(key);
      }
    }
  }

  cacheFeedXml(feedName, cacheKey, xml) {
    this.invalidateFeedXmlCache(feedName);
    const bytes = Buffer.byteLength(xml, 'utf8');
    const maxBytes = Math.max(1, Number(this.config.rssCacheMaxBytes) || DEFAULT_RSS_CACHE_MAX_BYTES);
    if (bytes > maxBytes) {
      return;
    }
    while (this.feedXmlCache.size && this.feedXmlCacheBytes + bytes > maxBytes) {
      this.removeFeedXmlCacheEntry(this.feedXmlCache.keys().next().value);
    }
    this.feedXmlCache.set(cacheKey, { xml, bytes });
    this.feedXmlCacheBytes += bytes;
  }

  removeFeedXmlCacheEntry(cacheKey) {
    const cached = this.feedXmlCache.get(cacheKey);
    if (!cached) {
      return;
    }
    this.feedXmlCache.delete(cacheKey);
    this.feedXmlCacheBytes = Math.max(0, this.feedXmlCacheBytes - cached.bytes);
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

function nextTranslationRetryAt(existingEntry, failedAt, providerRetryAfter) {
  const delaysHours = [2, 6, 12, 24];
  const failureCount = Number(existingEntry?.translation_failure_count || 0) + 1;
  const delay = delaysHours[Math.min(failureCount - 1, delaysHours.length - 1)] * 60 * 60 * 1000;
  const localRetryAt = new Date(new Date(failedAt).getTime() + delay);
  const providerRetryAt = providerRetryAfter ? new Date(providerRetryAfter) : null;
  const retryAt = providerRetryAt && Number.isFinite(providerRetryAt.getTime()) && providerRetryAt > localRetryAt
    ? providerRetryAt
    : localRetryAt;
  return retryAt.toISOString();
}

function resolveAvailableFeedName({ db, requestedName, sourceUrl, autoName, existingByName }) {
  if (!existingByName || existingByName.source_url === sourceUrl || !autoName) {
    return requestedName;
  }

  for (const hashLength of [8, 12, 16]) {
    const suffix = hashText(sourceUrl).slice(0, hashLength);
    const candidate = `${String(requestedName).slice(0, 63 - hashLength)}-${suffix}`;
    const existing = db.getFeedByName(candidate);
    if (!existing || existing.source_url === sourceUrl) {
      return candidate;
    }
  }

  throw new Error('unable to derive a unique feed name');
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function normalizeFeedItem(item, sourceUrl) {
  const normalized = { ...item };
  if (item?.link) {
    try {
      normalized.link = new URL(item.link, sourceUrl).toString();
    } catch {
      normalized.link = item.link;
    }
  }
  return normalized;
}

function shouldReuseFetchedSource({ existingEntry, item, sourceContentHtml, refreshedAt, recheckHours }) {
  if (!existingEntry || existingEntry.refresh_status === 'error') {
    return false;
  }
  const fetchedAt = Date.parse(existingEntry.source_fetched_at || existingEntry.refreshed_at || '');
  const now = Date.parse(refreshedAt);
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(now) || now - fetchedAt >= recheckHours * 60 * 60 * 1000) {
    return false;
  }
  if (item.title && (existingEntry.source_title || '') !== item.title) {
    return false;
  }
  if ((existingEntry.source_content_html || '') !== sourceContentHtml) {
    return false;
  }
  return Boolean(existingEntry.extracted_content_html || existingEntry.source_content_html);
}

function baseTranslationProvider(value) {
  return String(value || 'source-feed').split('+')[0] || 'source-feed';
}

function hasFeedMetadataChanged(existing, { sourceUrl, title, translateEnabled }) {
  return Boolean(existing) && (
    existing.source_url !== sourceUrl ||
    (existing.title || null) !== (title || null) ||
    Boolean(existing.translate_enabled) !== Boolean(translateEnabled)
  );
}

function isSafeHostHeader(value) {
  const host = String(value || '').trim();
  if (!host || /[\s\\/?#@]/.test(host)) {
    return false;
  }
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || !parsed.hostname) {
      return false;
    }
    if (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65535)) {
      return false;
    }
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function publicErrorMessage(error) {
  const message = String(error?.message || 'operation failed');
  if (/\/(?:Users|home|app)\/|[A-Za-z]:\\|auth file|\.codex/i.test(message)) {
    return 'operation failed; see server logs for details';
  }
  return truncate(message, 500);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) {
    return [];
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 1), items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
