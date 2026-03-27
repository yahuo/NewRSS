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
    `);

    this.ensureFeedSchema();

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
          WHERE entries.feed_name = feeds.name AND entries.refresh_status = 'error'
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

    this.listRecentEntryErrorsByFeedStmt = this.db.prepare(`
      SELECT id, source_title, source_url, refresh_error, refreshed_at
      FROM entries
      WHERE feed_name = ? AND refresh_status = 'error'
      ORDER BY refreshed_at DESC, id DESC
      LIMIT ?
    `);

    this.upsertFeedStmt = this.db.prepare(`
      INSERT INTO feeds (name, source_url, folder, title, last_refreshed_at, last_refresh_status, last_refresh_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        source_url = excluded.source_url,
        folder = excluded.folder,
        title = COALESCE(excluded.title, feeds.title),
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
    const hasLastRefreshStatus = columns.some((column) => column.name === 'last_refresh_status');
    const hasLastRefreshError = columns.some((column) => column.name === 'last_refresh_error');

    if (!hasFolder) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN folder TEXT;`);
    }

    if (!hasLastRefreshStatus) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN last_refresh_status TEXT;`);
    }

    if (!hasLastRefreshError) {
      this.db.exec(`ALTER TABLE feeds ADD COLUMN last_refresh_error TEXT;`);
    }
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

  listRecentEntryErrorsByFeed(feedName, limit = 3) {
    return this.listRecentEntryErrorsByFeedStmt.all(feedName, limit);
  }
}

module.exports = Database;
