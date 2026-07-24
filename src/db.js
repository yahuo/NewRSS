const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { normalizeFolderPath, normalizeWhitespace } = require('./utils');

const READ_LATER_JOB_STATUSES = new Set(['queued', 'running', 'done', 'failed']);
const READ_LATER_JOB_PATCH_FIELDS = new Map([
  ['status', 'status'],
  ['resultJson', 'result_json'],
  ['result_json', 'result_json'],
  ['error', 'error'],
  ['updatedAt', 'updated_at'],
  ['updated_at', 'updated_at'],
  ['startedAt', 'started_at'],
  ['started_at', 'started_at'],
  ['completedAt', 'completed_at'],
  ['completed_at', 'completed_at'],
]);

class Database {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS feeds (
        name TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        folder TEXT,
        title TEXT,
        translate_enabled INTEGER NOT NULL DEFAULT 0,
        content_updated_at TEXT,
        content_revision INTEGER NOT NULL DEFAULT 0,
        last_refreshed_at TEXT,
        last_refresh_status TEXT,
        last_refresh_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_name TEXT NOT NULL,
        source_guid TEXT NOT NULL,
        source_url TEXT NOT NULL,
        search_text TEXT,
        source_title TEXT,
        source_author TEXT,
        source_published_at TEXT,
        source_content_html TEXT,
        extracted_content_html TEXT,
        source_fetched_at TEXT,
        content_updated_at TEXT,
        translated_title TEXT,
        translated_content_html TEXT,
        article_excerpt TEXT,
        translation_provider TEXT NOT NULL,
        refresh_status TEXT NOT NULL,
        refresh_error TEXT,
        refreshed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(feed_name, source_guid),
        FOREIGN KEY(feed_name) REFERENCES feeds(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS translation_circuits (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT,
        next_probe_at TEXT,
        last_probe_at TEXT,
        last_error TEXT,
        probe_in_progress INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS translation_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS translation_usage_totals (
        provider TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS read_later_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS translation_usage_provider_id_idx
      ON translation_usage(provider, id DESC);
    `);

    this.ensureFeedSchema();
    this.ensureEntrySchema();
    this.ensureTranslationCircuitSchema();
    this.ensureTranslationUsageTotals();
    this.ensureIndexes();
    this.recoverInterruptedTranslationProbes();
    this.recoverInterruptedFeedRefreshes();
    this.recoverInterruptedReadLaterJobs();

    this.setFeedRefreshResultStmt = this.db.prepare(`
      UPDATE feeds
      SET last_refreshed_at = ?, last_refresh_status = ?, last_refresh_error = ?, updated_at = ?
      WHERE name = ?
    `);

    this.bumpFeedContentRevisionStmt = this.db.prepare(`
      UPDATE feeds
      SET content_updated_at = ?,
          content_revision = content_revision + 1,
          updated_at = ?
      WHERE name = ?
    `);

    this.getFeedByNameStmt = this.db.prepare(`
      SELECT *
      FROM feeds
      WHERE name = ?
    `);

    this.getFeedBySourceUrlStmt = this.db.prepare(`
      SELECT *
      FROM feeds
      WHERE source_url = ?
      LIMIT 1
    `);

    this.hasFeedsStmt = this.db.prepare(`
      SELECT EXISTS(SELECT 1 FROM feeds LIMIT 1) AS has_feeds
    `);

    this.listFeedsStmt = this.db.prepare(`
      SELECT
        feeds.*,
        (
          SELECT COUNT(*)
          FROM entries
          WHERE entries.feed_name = feeds.name
        ) AS entry_count,
        (
          SELECT COUNT(*)
          FROM entries
          WHERE entries.feed_name = feeds.name
            AND (entries.refresh_status = 'error' OR entries.translation_retry_after IS NOT NULL)
        ) AS error_count
      FROM feeds
      ORDER BY COALESCE(feeds.folder, '') ASC, feeds.created_at ASC, feeds.name ASC
    `);

    this.deleteFeedStmt = this.db.prepare(`
      DELETE FROM feeds
      WHERE name = ?
    `);

    this.upsertEntryStmt = this.db.prepare(`
      INSERT INTO entries (
        feed_name,
        source_guid,
        source_url,
        search_text,
        source_title,
        source_author,
        source_published_at,
        source_content_html,
        extracted_content_html,
        source_fetched_at,
        content_updated_at,
        translated_title,
        translated_content_html,
        article_excerpt,
        translation_provider,
        refresh_status,
        refresh_error,
        refreshed_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_name, source_guid) DO UPDATE SET
        source_url = excluded.source_url,
        search_text = excluded.search_text,
        source_title = excluded.source_title,
        source_author = excluded.source_author,
        source_published_at = excluded.source_published_at,
        source_content_html = excluded.source_content_html,
        extracted_content_html = excluded.extracted_content_html,
        source_fetched_at = excluded.source_fetched_at,
        content_updated_at = excluded.content_updated_at,
        translated_title = excluded.translated_title,
        translated_content_html = excluded.translated_content_html,
        article_excerpt = excluded.article_excerpt,
        translation_provider = excluded.translation_provider,
        refresh_status = excluded.refresh_status,
        refresh_error = excluded.refresh_error,
        refreshed_at = excluded.refreshed_at,
        updated_at = excluded.updated_at
    `);

    this.touchEntryRefreshStmt = this.db.prepare(`
      UPDATE entries
      SET refresh_status = ?,
          refresh_error = ?,
          refreshed_at = ?,
          source_fetched_at = COALESCE(?, source_fetched_at),
          updated_at = ?
      WHERE feed_name = ? AND source_guid = ?
    `);

    this.listEntriesByFeedStmt = this.db.prepare(`
      SELECT *
      FROM entries
      WHERE feed_name = ?
      ORDER BY COALESCE(source_published_at, refreshed_at) DESC, id DESC
      LIMIT ?
    `);

    this.listFeedEntriesForRenderStmt = this.db.prepare(`
      SELECT id,
             source_guid,
             source_url,
             source_title,
             source_author,
             source_published_at,
             source_content_html,
             extracted_content_html,
             translated_title,
             translated_content_html,
             article_excerpt,
             translation_provider,
             refresh_status,
             refreshed_at
      FROM entries
      WHERE feed_name = ?
      ORDER BY COALESCE(source_published_at, refreshed_at) DESC, id DESC
      LIMIT ?
    `);

    this.listReadLaterEntriesStmt = this.db.prepare(`
      SELECT id,
             source_guid,
             source_url,
             source_title,
             translated_title,
             source_published_at,
             refreshed_at,
             created_at,
             updated_at,
             CASE
               WHEN translated_content_html IS NOT NULL AND translated_content_html <> '' THEN 1
               ELSE 0
             END AS is_translated
      FROM entries
      WHERE feed_name = ?
        AND (
          ? = ''
          OR COALESCE(search_text, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
      ORDER BY COALESCE(source_published_at, refreshed_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    this.countReadLaterEntriesStmt = this.db.prepare(`
      SELECT COUNT(*) AS entry_count
      FROM entries
      WHERE feed_name = ?
        AND (
          ? = ''
          OR COALESCE(search_text, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
    `);

    this.listDueTranslationRetriesStmt = this.db.prepare(`
      SELECT entries.*
      FROM entries
      JOIN feeds ON feeds.name = entries.feed_name
      WHERE feeds.translate_enabled = 1
        AND entries.translation_retry_after IS NOT NULL
        AND entries.translation_retry_after <= ?
      ORDER BY entries.translation_retry_after ASC, entries.id ASC
      LIMIT ?
    `);

    this.listDueReadLaterTranslationRetriesStmt = this.db.prepare(`
      SELECT *
      FROM entries
      WHERE feed_name = ?
        AND translation_retry_after IS NOT NULL
        AND translation_retry_after <= ?
      ORDER BY translation_retry_after ASC, id ASC
      LIMIT ?
    `);

    this.getEntryByIdStmt = this.db.prepare(`
      SELECT *
      FROM entries
      WHERE id = ?
    `);

    this.getEntryByFeedAndGuidStmt = this.db.prepare(`
      SELECT *
      FROM entries
      WHERE feed_name = ? AND source_guid = ?
      LIMIT 1
    `);

    this.deleteEntryByFeedAndIdStmt = this.db.prepare(`
      DELETE FROM entries
      WHERE feed_name = ? AND id = ?
    `);

    this.listRecentEntryErrorsByFeedStmt = this.db.prepare(`
      SELECT id, source_title, source_url,
             COALESCE(translation_last_error, refresh_error) AS refresh_error,
             COALESCE(translation_last_failed_at, refreshed_at) AS refreshed_at
      FROM entries
      WHERE feed_name = ? AND (refresh_status = 'error' OR translation_retry_after IS NOT NULL)
      ORDER BY refreshed_at DESC, id DESC
      LIMIT ?
    `);

    this.clearEntryTranslationFailureStmt = this.db.prepare(`
      UPDATE entries
      SET translation_failure_count = 0,
          translation_last_error = NULL,
          translation_last_failed_at = NULL,
          translation_retry_after = NULL
      WHERE feed_name = ? AND source_guid = ?
    `);

    this.recordEntryTranslationFailureStmt = this.db.prepare(`
      UPDATE entries
      SET translation_failure_count = ?,
          translation_last_error = ?,
          translation_last_failed_at = ?,
          translation_retry_after = ?
      WHERE feed_name = ? AND source_guid = ?
    `);

    this.createReadLaterJobStmt = this.db.prepare(`
      INSERT INTO read_later_jobs (
        id,
        idempotency_key,
        request_json,
        status,
        result_json,
        error,
        created_at,
        updated_at,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `);

    this.getReadLaterJobByIdStmt = this.db.prepare(`
      SELECT *
      FROM read_later_jobs
      WHERE id = ?
    `);

    this.getReadLaterJobByIdempotencyKeyStmt = this.db.prepare(`
      SELECT *
      FROM read_later_jobs
      WHERE idempotency_key = ?
    `);

    this.listReadLaterJobsStmt = this.db.prepare(`
      SELECT *
      FROM read_later_jobs
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    this.listReadLaterJobsByStatusStmt = this.db.prepare(`
      SELECT *
      FROM read_later_jobs
      WHERE status = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ? OFFSET ?
    `);

    this.upsertFeedStmt = this.db.prepare(`
      INSERT INTO feeds (name, source_url, folder, title, translate_enabled, last_refreshed_at, last_refresh_status, last_refresh_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        source_url = excluded.source_url,
        folder = excluded.folder,
        title = COALESCE(excluded.title, feeds.title),
        translate_enabled = excluded.translate_enabled,
        last_refreshed_at = COALESCE(excluded.last_refreshed_at, feeds.last_refreshed_at),
        last_refresh_status = COALESCE(excluded.last_refresh_status, feeds.last_refresh_status),
        last_refresh_error = COALESCE(excluded.last_refresh_error, feeds.last_refresh_error),
        updated_at = excluded.updated_at
    `);

    this.normalizeFeedFolderStmt = this.db.prepare(`
      UPDATE feeds
      SET folder = ?, updated_at = ?
      WHERE name = ?
    `);

    this.normalizeStoredFolders();
  }

  ensureFeedSchema() {
    const columns = this.db.prepare(`PRAGMA table_info(feeds)`).all();
    const hasFolder = columns.some((column) => column.name === 'folder');
    const hasTranslateEnabled = columns.some((column) => column.name === 'translate_enabled');
    const hasContentUpdatedAt = columns.some((column) => column.name === 'content_updated_at');
    const hasContentRevision = columns.some((column) => column.name === 'content_revision');
    const hasLastRefreshStatus = columns.some((column) => column.name === 'last_refresh_status');
    const hasLastRefreshError = columns.some((column) => column.name === 'last_refresh_error');

    if (!hasFolder) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN folder TEXT;`);
    }

    if (!hasTranslateEnabled) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0;`);
    }

    if (!hasContentUpdatedAt) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN content_updated_at TEXT;`);
    }

    if (!hasContentRevision) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;`);
    }

    if (!hasLastRefreshStatus) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN last_refresh_status TEXT;`);
    }

    if (!hasLastRefreshError) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN last_refresh_error TEXT;`);
    }
  }

  ensureEntrySchema() {
    const columns = this.db.prepare(`PRAGMA table_info(entries)`).all();
    const names = new Set(columns.map((column) => column.name));
    const additions = [
      ['translation_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['translation_last_error', 'TEXT'],
      ['translation_last_failed_at', 'TEXT'],
      ['translation_retry_after', 'TEXT'],
      ['source_fetched_at', 'TEXT'],
      ['content_updated_at', 'TEXT'],
      ['search_text', 'TEXT'],
    ];

    for (const [name, definition] of additions) {
      if (!names.has(name)) {
        this.db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${definition};`);
      }
    }

    const updateSearchText = this.db.prepare(`UPDATE entries SET search_text = ? WHERE id = ?`);
    for (const entry of this.db.prepare(`
      SELECT id, source_url, source_title, translated_title
      FROM entries
      WHERE search_text IS NULL
    `).all()) {
      updateSearchText.run(buildEntrySearchText(entry), entry.id);
    }
  }

  ensureTranslationCircuitSchema() {
    const columns = this.db.prepare(`PRAGMA table_info(translation_circuits)`).all();
    if (!columns.some((column) => column.name === 'probe_in_progress')) {
      this.db.exec(`ALTER TABLE translation_circuits ADD COLUMN probe_in_progress INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  ensureTranslationUsageTotals() {
    this.db.exec(`
      INSERT INTO translation_usage_totals (
        provider, request_count, input_tokens, output_tokens, total_tokens, updated_at
      )
      SELECT provider,
             COUNT(*),
             COALESCE(SUM(input_tokens), 0),
             COALESCE(SUM(output_tokens), 0),
             COALESCE(SUM(total_tokens), 0),
             COALESCE(MAX(created_at), CURRENT_TIMESTAMP)
      FROM translation_usage
      GROUP BY provider
      ON CONFLICT(provider) DO NOTHING;
    `);
  }

  ensureIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS feeds_source_url_idx
      ON feeds(source_url);

      CREATE INDEX IF NOT EXISTS entries_feed_sort_idx
      ON entries(feed_name, COALESCE(source_published_at, refreshed_at) DESC, id DESC);

      CREATE INDEX IF NOT EXISTS entries_feed_errors_idx
      ON entries(
        feed_name,
        COALESCE(translation_last_failed_at, refreshed_at) DESC,
        id DESC
      )
      WHERE refresh_status = 'error' OR translation_retry_after IS NOT NULL;

      CREATE INDEX IF NOT EXISTS entries_translation_retry_due_idx
      ON entries(translation_retry_after, feed_name, id)
      WHERE translation_retry_after IS NOT NULL;

      CREATE INDEX IF NOT EXISTS entries_feed_search_idx
      ON entries(feed_name, search_text);

      CREATE INDEX IF NOT EXISTS read_later_jobs_status_created_idx
      ON read_later_jobs(status, created_at, id);
    `);
  }

  recoverInterruptedTranslationProbes() {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE translation_circuits
      SET state = CASE WHEN state = 'half-open' THEN 'open' ELSE state END,
          next_probe_at = CASE WHEN state = 'half-open' THEN ? ELSE next_probe_at END,
          probe_in_progress = 0,
          updated_at = ?
      WHERE state = 'half-open' OR probe_in_progress = 1
    `).run(now, now);
  }

  recoverInterruptedFeedRefreshes() {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE feeds
      SET last_refresh_status = 'error',
          last_refresh_error = 'refresh interrupted by process restart',
          updated_at = ?
      WHERE last_refresh_status = 'refreshing'
    `).run(now);
  }

  recoverInterruptedReadLaterJobs() {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE read_later_jobs
      SET status = 'queued',
          updated_at = ?,
          started_at = NULL,
          completed_at = NULL
      WHERE status = 'running'
    `).run(now);
  }

  normalizeStoredFolders() {
    const now = new Date().toISOString();
    const feeds = this.db.prepare(`SELECT name, folder FROM feeds`).all();

    for (const feed of feeds) {
      const normalized = normalizeFolderPath(feed.folder || '');
      const current = feed.folder || '';

      if (normalized !== current) {
        this.normalizeFeedFolderStmt.run(normalized || null, now, feed.name);
      }
    }
  }

  upsertFeed(feed) {
    this.upsertFeedStmt.run(
      feed.name,
      feed.sourceUrl,
      feed.folder || null,
      feed.title || null,
      feed.translateEnabled ? 1 : 0,
      feed.lastRefreshedAt || null,
      feed.lastRefreshStatus || null,
      feed.lastRefreshError || null,
      feed.createdAt,
      feed.updatedAt
    );
  }

  setFeedRefreshResult(name, refreshedAt, status, error) {
    this.setFeedRefreshResultStmt.run(refreshedAt, status || null, error || null, refreshedAt, name);
  }

  bumpFeedContentRevision(name, at = new Date().toISOString()) {
    this.bumpFeedContentRevisionStmt.run(at, at, name);
    return this.getFeedByName(name);
  }

  getFeedByName(name) {
    return this.getFeedByNameStmt.get(name);
  }

  getFeedBySourceUrl(sourceUrl) {
    return this.getFeedBySourceUrlStmt.get(sourceUrl);
  }

  hasFeeds() {
    return Boolean(this.hasFeedsStmt.get().has_feeds);
  }

  listFeeds() {
    return this.listFeedsStmt.all();
  }

  deleteFeed(name) {
    return this.deleteFeedStmt.run(name);
  }

  upsertEntry(entry) {
    this.upsertEntryStmt.run(
      entry.feedName,
      entry.sourceGuid,
      entry.sourceUrl,
      buildEntrySearchText({
        source_url: entry.sourceUrl,
        source_title: entry.sourceTitle,
        translated_title: entry.translatedTitle,
      }),
      entry.sourceTitle || null,
      entry.sourceAuthor || null,
      entry.sourcePublishedAt || null,
      entry.sourceContentHtml || null,
      entry.extractedContentHtml || null,
      entry.sourceFetchedAt || entry.refreshedAt,
      entry.contentUpdatedAt || entry.refreshedAt,
      entry.translatedTitle || null,
      entry.translatedContentHtml || null,
      entry.articleExcerpt || null,
      entry.translationProvider,
      entry.refreshStatus,
      entry.refreshError || null,
      entry.refreshedAt,
      entry.createdAt,
      entry.updatedAt
    );
  }

  touchEntryRefresh(feedName, sourceGuid, {
    refreshStatus,
    refreshError = '',
    refreshedAt,
    sourceFetchedAt = refreshedAt,
    updatedAt = refreshedAt,
  }) {
    return this.touchEntryRefreshStmt.run(
      refreshStatus,
      refreshError || null,
      refreshedAt,
      sourceFetchedAt,
      updatedAt,
      feedName,
      sourceGuid
    );
  }

  listEntriesByFeed(feedName, limit = 20) {
    return this.listEntriesByFeedStmt.all(feedName, limit);
  }

  listFeedEntriesForRender(feedName, limit = 20) {
    return this.listFeedEntriesForRenderStmt.all(feedName, limit);
  }

  listReadLaterEntries(feedName, { limit = 50, offset = 0, search = '' } = {}) {
    const normalizedLimit = normalizeLimit(limit, 50, 200);
    const normalizedOffset = normalizeOffset(offset);
    const normalizedSearch = String(search || '').trim();
    const pattern = normalizedSearch ? `%${escapeLikePattern(normalizedSearch)}%` : '';
    return this.listReadLaterEntriesStmt.all(
      feedName,
      normalizedSearch,
      pattern,
      normalizedLimit,
      normalizedOffset
    );
  }

  countReadLaterEntries(feedName, { search = '' } = {}) {
    const normalizedSearch = String(search || '').trim();
    const pattern = normalizedSearch ? `%${escapeLikePattern(normalizedSearch)}%` : '';
    return Number(
      this.countReadLaterEntriesStmt.get(feedName, normalizedSearch, pattern).entry_count || 0
    );
  }

  listDueTranslationRetries(now = new Date().toISOString(), limit = 50) {
    return this.listDueTranslationRetriesStmt.all(String(now), normalizeLimit(limit, 50, 200));
  }

  listDueReadLaterTranslationRetries(feedName, now = new Date().toISOString(), limit = 50) {
    return this.listDueReadLaterTranslationRetriesStmt.all(
      String(feedName),
      String(now),
      normalizeLimit(limit, 50, 200)
    );
  }

  getEntryById(id) {
    return this.getEntryByIdStmt.get(id);
  }

  getEntryByFeedAndGuid(feedName, sourceGuid) {
    return this.getEntryByFeedAndGuidStmt.get(feedName, sourceGuid);
  }

  deleteEntryByFeedAndId(feedName, entryId) {
    return this.deleteEntryByFeedAndIdStmt.run(feedName, entryId);
  }

  listRecentEntryErrorsByFeed(feedName, limit = 3) {
    return this.listRecentEntryErrorsByFeedStmt.all(feedName, limit);
  }

  listRecentEntryErrorsByFeeds(feedNames, limitPerFeed = 3) {
    const names = Array.from(new Set((feedNames || []).map((name) => String(name)).filter(Boolean)));
    if (!names.length) {
      return [];
    }

    const placeholders = names.map(() => '?').join(', ');
    const limit = normalizeLimit(limitPerFeed, 3, 100);
    return this.db.prepare(`
      WITH ranked_errors AS (
        SELECT feed_name,
               id,
               source_title,
               source_url,
               COALESCE(translation_last_error, refresh_error) AS refresh_error,
               COALESCE(translation_last_failed_at, refreshed_at) AS refreshed_at,
               ROW_NUMBER() OVER (
                 PARTITION BY feed_name
                 ORDER BY COALESCE(translation_last_failed_at, refreshed_at) DESC, id DESC
               ) AS error_rank
        FROM entries
        WHERE feed_name IN (${placeholders})
          AND (refresh_status = 'error' OR translation_retry_after IS NOT NULL)
      )
      SELECT feed_name, id, source_title, source_url, refresh_error, refreshed_at
      FROM ranked_errors
      WHERE error_rank <= ?
      ORDER BY feed_name ASC, refreshed_at DESC, id DESC
    `).all(...names, limit);
  }

  clearEntryTranslationFailure(feedName, sourceGuid) {
    this.clearEntryTranslationFailureStmt.run(feedName, sourceGuid);
  }

  recordEntryTranslationFailure(feedName, sourceGuid, error, failedAt, retryAfter) {
    const entry = this.getEntryByFeedAndGuid(feedName, sourceGuid);
    const failureCount = Number(entry?.translation_failure_count || 0) + 1;
    this.recordEntryTranslationFailureStmt.run(
      failureCount,
      String(error || ''),
      failedAt,
      retryAfter,
      feedName,
      sourceGuid
    );
    return failureCount;
  }

  createReadLaterJob(job = {}) {
    const id = String(job.id || randomUUID()).trim();
    const idempotencyKey = String(job.idempotencyKey || job.idempotency_key || id).trim();
    const status = String(job.status || 'queued').trim();
    validateReadLaterJobStatus(status);
    if (!id) {
      throw new Error('read-later job id is required');
    }
    if (!idempotencyKey) {
      throw new Error('read-later job idempotency key is required');
    }

    const now = new Date().toISOString();
    const createdAt = String(job.createdAt || job.created_at || now);
    const updatedAt = String(job.updatedAt || job.updated_at || createdAt);
    const startedAt = job.startedAt ?? job.started_at ?? (status === 'running' ? updatedAt : null);
    const completedAt = job.completedAt ?? job.completed_at ?? (
      status === 'done' || status === 'failed' ? updatedAt : null
    );
    const requestJson = serializeJsonColumn(job.requestJson ?? job.request_json ?? {});
    const resultJson = serializeJsonColumn(job.resultJson ?? job.result_json ?? null);
    const error = job.error == null ? null : String(job.error);

    this.createReadLaterJobStmt.run(
      id,
      idempotencyKey,
      requestJson,
      status,
      resultJson,
      error,
      createdAt,
      updatedAt,
      startedAt,
      completedAt
    );
    return this.getReadLaterJobByIdempotencyKeyStmt.get(idempotencyKey);
  }

  getReadLaterJobById(id) {
    return this.getReadLaterJobByIdStmt.get(String(id));
  }

  updateReadLaterJob(id, patch = {}) {
    const updates = new Map();
    for (const [key, value] of Object.entries(patch)) {
      const column = READ_LATER_JOB_PATCH_FIELDS.get(key);
      if (!column) {
        throw new Error(`unsupported read-later job patch field: ${key}`);
      }
      updates.set(column, value);
    }

    if (!updates.size) {
      return this.getReadLaterJobById(id);
    }

    const now = new Date().toISOString();
    if (updates.has('status')) {
      const status = String(updates.get('status')).trim();
      validateReadLaterJobStatus(status);
      updates.set('status', status);
      if (status === 'running' && !updates.has('started_at')) {
        updates.set('started_at', now);
      }
      if ((status === 'done' || status === 'failed') && !updates.has('completed_at')) {
        updates.set('completed_at', now);
      }
    }

    if (updates.has('result_json')) {
      updates.set('result_json', serializeJsonColumn(updates.get('result_json')));
    }
    if (updates.has('error')) {
      updates.set('error', updates.get('error') == null ? null : String(updates.get('error')));
    }
    for (const column of ['started_at', 'completed_at', 'updated_at']) {
      if (updates.has(column) && updates.get(column) != null) {
        updates.set(column, String(updates.get(column)));
      }
    }
    if (!updates.has('updated_at')) {
      updates.set('updated_at', now);
    }

    const assignments = Array.from(updates.keys(), (column) => `${column} = ?`).join(', ');
    this.db.prepare(`UPDATE read_later_jobs SET ${assignments} WHERE id = ?`).run(
      ...updates.values(),
      String(id)
    );
    return this.getReadLaterJobById(id);
  }

  listReadLaterJobs({ status = '', limit = 50, offset = 0 } = {}) {
    const normalizedLimit = normalizeLimit(limit, 50, 200);
    const normalizedOffset = normalizeOffset(offset);
    const normalizedStatus = String(status || '').trim();
    if (!normalizedStatus) {
      return this.listReadLaterJobsStmt.all(normalizedLimit, normalizedOffset);
    }

    validateReadLaterJobStatus(normalizedStatus);
    return this.listReadLaterJobsByStatusStmt.all(normalizedStatus, normalizedLimit, normalizedOffset);
  }

  transaction(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('transaction operation must be a function');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      if (result && typeof result.then === 'function') {
        throw new TypeError('transaction operation must be synchronous');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the operation error when SQLite has already aborted the transaction.
      }
      throw error;
    }
  }

  getTranslationCircuit(provider) {
    return this.db.prepare(`SELECT * FROM translation_circuits WHERE provider = ?`).get(provider) || {
      provider,
      state: 'closed',
      failure_count: 0,
      opened_at: null,
      next_probe_at: null,
      last_probe_at: null,
      last_error: null,
      probe_in_progress: 0,
      updated_at: null,
    };
  }

  openTranslationCircuit(provider, error, now, nextProbeAt) {
    const current = this.getTranslationCircuit(provider);
    const failureCount = Number(current.failure_count || 0) + 1;
    this.db.prepare(`
      INSERT INTO translation_circuits (
        provider, state, failure_count, opened_at, next_probe_at, last_probe_at, last_error, updated_at
      ) VALUES (?, 'open', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = 'open',
        failure_count = excluded.failure_count,
        opened_at = COALESCE(translation_circuits.opened_at, excluded.opened_at),
        next_probe_at = excluded.next_probe_at,
        last_probe_at = excluded.last_probe_at,
        last_error = excluded.last_error,
        probe_in_progress = 0,
        updated_at = excluded.updated_at
    `).run(provider, failureCount, now, nextProbeAt, current.last_probe_at, String(error || ''), now);
    return this.getTranslationCircuit(provider);
  }

  closeTranslationCircuit(provider, now) {
    this.db.prepare(`
      INSERT INTO translation_circuits (provider, state, failure_count, updated_at)
      VALUES (?, 'closed', 0, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = 'closed', failure_count = 0, opened_at = NULL, next_probe_at = NULL,
        last_error = NULL, probe_in_progress = 0, updated_at = excluded.updated_at
    `).run(provider, now);
    return this.getTranslationCircuit(provider);
  }

  claimTranslationProbe(provider, now, force = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const circuit = this.getTranslationCircuit(provider);
      const due = force || (circuit.state === 'open' && circuit.next_probe_at && circuit.next_probe_at <= now);
      if (circuit.probe_in_progress || (!force && circuit.state === 'closed') || !due) {
        this.db.exec('COMMIT');
        return { claimed: false, circuit };
      }

      const probeState = circuit.state === 'closed' ? 'closed' : 'half-open';
      this.db.prepare(`
        INSERT INTO translation_circuits (provider, state, failure_count, last_probe_at, probe_in_progress, updated_at)
        VALUES (?, ?, 0, ?, 1, ?)
        ON CONFLICT(provider) DO UPDATE SET
          state = excluded.state,
          last_probe_at = excluded.last_probe_at,
          probe_in_progress = 1,
          updated_at = excluded.updated_at
      `).run(provider, probeState, now, now);
      this.db.exec('COMMIT');
      return { claimed: true, circuit };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseTranslationProbe(provider, now) {
    this.db.prepare(`
      UPDATE translation_circuits
      SET probe_in_progress = 0, updated_at = ?
      WHERE provider = ?
    `).run(now, provider);
  }

  recordTranslationUsage({ provider, model, requestKind, status, usage, error, createdAt }) {
    const inputTokens = integerOrNull(usage?.inputTokens);
    const outputTokens = integerOrNull(usage?.outputTokens);
    const totalTokens = integerOrNull(usage?.totalTokens);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO translation_usage (
          provider, model, request_kind, status, input_tokens, output_tokens, total_tokens, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        provider,
        model,
        requestKind,
        status,
        inputTokens,
        outputTokens,
        totalTokens,
        error ? String(error) : null,
        createdAt
      );
      this.db.prepare(`
        INSERT INTO translation_usage_totals (
          provider, request_count, input_tokens, output_tokens, total_tokens, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          request_count = translation_usage_totals.request_count + 1,
          input_tokens = translation_usage_totals.input_tokens + excluded.input_tokens,
          output_tokens = translation_usage_totals.output_tokens + excluded.output_tokens,
          total_tokens = translation_usage_totals.total_tokens + excluded.total_tokens,
          updated_at = excluded.updated_at
      `).run(provider, inputTokens || 0, outputTokens || 0, totalTokens || 0, createdAt);
    });
  }

  getTranslationUsageSummary(provider, limit = 20) {
    const totals = this.db.prepare(`
      SELECT request_count, input_tokens, output_tokens, total_tokens
      FROM translation_usage_totals
      WHERE provider = ?
    `).get(provider) || {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    const recent = this.db.prepare(`
      SELECT * FROM translation_usage
      WHERE provider = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(provider, limit);
    return { totals, recent };
  }
}

module.exports = Database;

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validateReadLaterJobStatus(status) {
  if (!READ_LATER_JOB_STATUSES.has(status)) {
    throw new Error(`invalid read-later job status: ${status}`);
  }
}

function serializeJsonColumn(value) {
  if (value == null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function normalizeOffset(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

function buildEntrySearchText(entry) {
  return normalizeWhitespace([
    entry.translated_title || '',
    entry.source_title || '',
    entry.source_url || '',
  ].join(' ')).toLowerCase();
}
