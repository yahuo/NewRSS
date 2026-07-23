const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeFolderPath } = require('./utils');

class Database {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS feeds (
        name TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        folder TEXT,
        title TEXT,
        translate_enabled INTEGER NOT NULL DEFAULT 0,
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
        source_title TEXT,
        source_author TEXT,
        source_published_at TEXT,
        source_content_html TEXT,
        extracted_content_html TEXT,
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

      CREATE INDEX IF NOT EXISTS translation_usage_provider_id_idx
      ON translation_usage(provider, id DESC);
    `);

    this.ensureFeedSchema();
    this.ensureEntrySchema();
    this.ensureTranslationCircuitSchema();
    this.recoverInterruptedTranslationProbes();

    this.setFeedRefreshResultStmt = this.db.prepare(`
      UPDATE feeds
      SET last_refreshed_at = ?, last_refresh_status = ?, last_refresh_error = ?, updated_at = ?
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
        refresh_error,
        refreshed_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_name, source_guid) DO UPDATE SET
        source_url = excluded.source_url,
        source_title = excluded.source_title,
        source_author = excluded.source_author,
        source_published_at = excluded.source_published_at,
        source_content_html = excluded.source_content_html,
        extracted_content_html = excluded.extracted_content_html,
        translated_title = excluded.translated_title,
        translated_content_html = excluded.translated_content_html,
        article_excerpt = excluded.article_excerpt,
        translation_provider = excluded.translation_provider,
        refresh_status = excluded.refresh_status,
        refresh_error = excluded.refresh_error,
        refreshed_at = excluded.refreshed_at,
        updated_at = excluded.updated_at
    `);

    this.listEntriesByFeedStmt = this.db.prepare(`
      SELECT *
      FROM entries
      WHERE feed_name = ?
      ORDER BY COALESCE(source_published_at, refreshed_at) DESC, id DESC
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
    const hasLastRefreshStatus = columns.some((column) => column.name === 'last_refresh_status');
    const hasLastRefreshError = columns.some((column) => column.name === 'last_refresh_error');

    if (!hasFolder) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN folder TEXT;`);
    }

    if (!hasTranslateEnabled) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0;`);
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
    ];

    for (const [name, definition] of additions) {
      if (!names.has(name)) {
        this.db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${definition};`);
      }
    }
  }

  ensureTranslationCircuitSchema() {
    const columns = this.db.prepare(`PRAGMA table_info(translation_circuits)`).all();
    if (!columns.some((column) => column.name === 'probe_in_progress')) {
      this.db.exec(`ALTER TABLE translation_circuits ADD COLUMN probe_in_progress INTEGER NOT NULL DEFAULT 0;`);
    }
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

  getFeedByName(name) {
    return this.getFeedByNameStmt.get(name);
  }

  getFeedBySourceUrl(sourceUrl) {
    return this.getFeedBySourceUrlStmt.get(sourceUrl);
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
      entry.sourceTitle || null,
      entry.sourceAuthor || null,
      entry.sourcePublishedAt || null,
      entry.sourceContentHtml || null,
      entry.extractedContentHtml || null,
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

  listEntriesByFeed(feedName, limit = 20) {
    return this.listEntriesByFeedStmt.all(feedName, limit);
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
    this.db.prepare(`
      INSERT INTO translation_usage (
        provider, model, request_kind, status, input_tokens, output_tokens, total_tokens, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider,
      model,
      requestKind,
      status,
      integerOrNull(usage?.inputTokens),
      integerOrNull(usage?.outputTokens),
      integerOrNull(usage?.totalTokens),
      error ? String(error) : null,
      createdAt
    );
  }

  getTranslationUsageSummary(provider, limit = 20) {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS request_count,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(total_tokens) AS total_tokens
      FROM translation_usage
      WHERE provider = ?
    `).get(provider);
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
