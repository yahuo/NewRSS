const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const Database = require('../src/db');

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-db-'));
  const dbPath = path.join(directory, 'newrss.db');
  let db = new Database(dbPath);

  t.after(() => {
    try {
      db.db.close();
    } catch {
      // A test may close the connection before reopening the database.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    get db() {
      return db;
    },
    reopen() {
      db.db.close();
      db = new Database(dbPath);
      return db;
    },
  };
}

function insertFeed(db, name, { translateEnabled = false } = {}) {
  const now = '2026-07-23T00:00:00.000Z';
  db.upsertFeed({
    name,
    sourceUrl: `https://example.com/${name}.xml`,
    folder: '',
    title: name,
    translateEnabled,
    lastRefreshedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

function insertEntry(db, {
  feedName,
  guid,
  title = guid,
  sourceUrl = `https://example.com/${guid}`,
  publishedAt = null,
  refreshedAt = '2026-07-23T00:00:00.000Z',
  translatedContentHtml = null,
  refreshStatus = 'ok',
  refreshError = '',
} = {}) {
  db.upsertEntry({
    feedName,
    sourceGuid: guid,
    sourceUrl,
    sourceTitle: title,
    sourceAuthor: '',
    sourcePublishedAt: publishedAt,
    sourceContentHtml: '<p>source</p>',
    extractedContentHtml: '<p>extracted</p>',
    translatedTitle: translatedContentHtml ? `translated ${title}` : null,
    translatedContentHtml,
    articleExcerpt: title,
    translationProvider: 'test',
    refreshStatus,
    refreshError,
    refreshedAt,
    createdAt: refreshedAt,
    updatedAt: refreshedAt,
  });
}

test('database configures contention handling, query indexes, hasFeeds, and transactions', (t) => {
  const fixture = createFixture(t);
  const { db } = fixture;

  assert.equal(db.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  const indexes = new Set(
    db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => row.name)
  );
  for (const name of [
    'feeds_source_url_idx',
    'entries_feed_sort_idx',
    'entries_feed_errors_idx',
    'entries_translation_retry_due_idx',
    'read_later_jobs_status_created_idx',
  ]) {
    assert.equal(indexes.has(name), true, `${name} should exist`);
  }

  assert.equal(db.hasFeeds(), false);
  assert.throws(() => db.transaction(() => {
    insertFeed(db, 'rolled-back');
    throw new Error('stop');
  }), /stop/);
  assert.equal(db.hasFeeds(), false);

  const result = db.transaction(() => {
    insertFeed(db, 'committed');
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(db.hasFeeds(), true);
  assert.throws(() => db.transaction(() => Promise.resolve()), /must be synchronous/);

  assert.equal(db.bumpFeedContentRevision('committed', '2026-07-23T01:00:00.000Z').content_revision, 1);
  const bumped = db.bumpFeedContentRevision('committed', '2026-07-23T02:00:00.000Z');
  assert.equal(bumped.content_revision, 2);
  assert.equal(bumped.content_updated_at, '2026-07-23T02:00:00.000Z');

  insertEntry(db, { feedName: 'committed', guid: 'touch' });
  const beforeTouch = db.getEntryByFeedAndGuid('committed', 'touch');
  assert.equal(beforeTouch.source_fetched_at, beforeTouch.refreshed_at);
  assert.equal(beforeTouch.content_updated_at, beforeTouch.refreshed_at);
  db.touchEntryRefresh('committed', 'touch', {
    refreshStatus: 'ok',
    refreshedAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:01.000Z',
  });
  const touched = db.getEntryByFeedAndGuid('committed', 'touch');
  assert.equal(touched.source_fetched_at, '2026-07-24T00:00:00.000Z');
  assert.equal(touched.content_updated_at, beforeTouch.content_updated_at);
  assert.equal(touched.extracted_content_html, beforeTouch.extracted_content_html);
});

test('database migrates legacy feeds and entries without deleting their data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-db-legacy-'));
  const dbPath = path.join(directory, 'legacy.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE feeds (
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
    CREATE TABLE entries (
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
    INSERT INTO feeds (
      name, source_url, title, translate_enabled, created_at, updated_at
    ) VALUES (
      'legacy', 'https://example.com/legacy.xml', 'Legacy', 0,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
    );
    INSERT INTO entries (
      feed_name, source_guid, source_url, source_title, source_content_html,
      extracted_content_html, translation_provider, refresh_status,
      refreshed_at, created_at, updated_at
    ) VALUES (
      'legacy', 'legacy-entry', 'https://example.com/legacy', 'Legacy entry',
      '<p>source</p>', '<p>content</p>', 'test', 'ok',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
    );
  `);
  legacy.close();

  const db = new Database(dbPath);
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(db.getFeedByName('legacy').content_revision, 0);
  const entry = db.getEntryByFeedAndGuid('legacy', 'legacy-entry');
  assert.equal(entry.extracted_content_html, '<p>content</p>');
  assert.equal(entry.source_fetched_at, null);
  assert.equal(entry.content_updated_at, null);
  assert.equal(
    db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'read_later_jobs'`).get().name,
    'read_later_jobs'
  );
});

test('database restart recovers interrupted feeds and jobs without deleting durable history', (t) => {
  const fixture = createFixture(t);
  let db = fixture.db;
  insertFeed(db, 'feed', { translateEnabled: true });
  db.setFeedRefreshResult('feed', '2026-07-23T01:00:00.000Z', 'refreshing', '');
  insertEntry(db, { feedName: 'feed', guid: 'entry' });
  db.recordTranslationUsage({
    provider: 'test',
    model: 'test-model',
    requestKind: 'translation',
    status: 'ok',
    usage: { totalTokens: 3 },
    createdAt: '2026-07-23T01:00:00.000Z',
  });
  db.createReadLaterJob({
    id: 'running-job',
    idempotencyKey: 'running-key',
    requestJson: { url: 'https://example.com/running' },
    status: 'running',
    startedAt: '2026-07-23T01:00:00.000Z',
  });
  db.createReadLaterJob({
    id: 'queued-job',
    idempotencyKey: 'queued-key',
    requestJson: { url: 'https://example.com/queued' },
  });

  db = fixture.reopen();
  const feed = db.getFeedByName('feed');
  assert.equal(feed.last_refresh_status, 'error');
  assert.equal(feed.last_refresh_error, 'refresh interrupted by process restart');
  const recovered = db.getReadLaterJobById('running-job');
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.started_at, null);
  assert.equal(recovered.completed_at, null);
  assert.equal(db.getReadLaterJobById('queued-job').status, 'queued');
  assert.equal(db.listEntriesByFeed('feed', 10).length, 1);
  assert.equal(db.getTranslationUsageSummary('test').totals.request_count, 1);
});

test('read-later jobs are idempotent and support whitelisted lifecycle updates', (t) => {
  const { db } = createFixture(t);
  const first = db.createReadLaterJob({
    id: 'job-1',
    idempotencyKey: 'same-request',
    requestJson: { url: 'https://example.com/first' },
    createdAt: '2026-07-23T01:00:00.000Z',
  });
  const duplicate = db.createReadLaterJob({
    id: 'job-2',
    idempotencyKey: 'same-request',
    requestJson: { url: 'https://example.com/second' },
    createdAt: '2026-07-23T02:00:00.000Z',
  });

  assert.equal(duplicate.id, first.id);
  assert.deepEqual(JSON.parse(duplicate.request_json), { url: 'https://example.com/first' });
  assert.equal(db.listReadLaterJobs().length, 1);

  const running = db.updateReadLaterJob(first.id, { status: 'running' });
  assert.equal(running.status, 'running');
  assert.ok(running.started_at);
  const done = db.updateReadLaterJob(first.id, {
    status: 'done',
    resultJson: { entryId: 42 },
    error: null,
  });
  assert.equal(done.status, 'done');
  assert.deepEqual(JSON.parse(done.result_json), { entryId: 42 });
  assert.ok(done.completed_at);
  assert.deepEqual(db.listReadLaterJobs({ status: 'done' }).map((job) => job.id), ['job-1']);
  assert.throws(() => db.updateReadLaterJob(first.id, { requestJson: '{}' }), /unsupported/);
  assert.throws(() => db.updateReadLaterJob(first.id, { status: 'unknown' }), /invalid/);
});

test('read-later projection paginates and searches without loading article bodies', (t) => {
  const { db } = createFixture(t);
  insertFeed(db, 'read-later');
  insertEntry(db, {
    feedName: 'read-later',
    guid: 'old',
    title: 'Old item',
    publishedAt: '2026-07-21T00:00:00.000Z',
  });
  insertEntry(db, {
    feedName: 'read-later',
    guid: 'percent',
    title: '100% coverage',
    publishedAt: '2026-07-22T00:00:00.000Z',
    translatedContentHtml: `<p>${'large translated body '.repeat(100)}</p>`,
  });
  insertEntry(db, {
    feedName: 'read-later',
    guid: 'new',
    title: 'Ｎｅｗｅｓｔ item',
    publishedAt: '2026-07-23T00:00:00.000Z',
  });

  assert.equal(db.countReadLaterEntries('read-later'), 3);
  assert.deepEqual(
    db.listReadLaterEntries('read-later', { limit: 2, offset: 1 }).map((entry) => entry.source_guid),
    ['percent', 'old']
  );
  const matches = db.listReadLaterEntries('read-later', { search: '%' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source_guid, 'percent');
  assert.equal(matches[0].is_translated, 1);
  assert.equal(Object.hasOwn(matches[0], 'translated_content_html'), false);
  assert.equal(Object.hasOwn(matches[0], 'extracted_content_html'), false);
  assert.equal(db.listReadLaterEntries('read-later', { search: 'Newest' })[0].source_guid, 'new');
  assert.equal(db.countReadLaterEntries('read-later', { search: 'missing' }), 0);
});

test('due translation retries and batched recent errors return only eligible rows', (t) => {
  const { db } = createFixture(t);
  insertFeed(db, 'enabled', { translateEnabled: true });
  insertFeed(db, 'disabled', { translateEnabled: false });

  insertEntry(db, {
    feedName: 'enabled',
    guid: 'due',
    refreshedAt: '2026-07-23T01:00:00.000Z',
    refreshStatus: 'error',
    refreshError: 'due failed',
  });
  db.recordEntryTranslationFailure(
    'enabled',
    'due',
    'due translation',
    '2026-07-23T01:00:00.000Z',
    '2026-07-23T02:00:00.000Z'
  );
  insertEntry(db, {
    feedName: 'enabled',
    guid: 'future',
    refreshedAt: '2026-07-23T02:00:00.000Z',
    refreshStatus: 'error',
    refreshError: 'future failed',
  });
  db.recordEntryTranslationFailure(
    'enabled',
    'future',
    'future translation',
    '2026-07-23T02:00:00.000Z',
    '2026-07-24T00:00:00.000Z'
  );
  insertEntry(db, {
    feedName: 'disabled',
    guid: 'disabled-due',
    refreshedAt: '2026-07-23T03:00:00.000Z',
    refreshStatus: 'error',
    refreshError: 'disabled failed',
  });
  db.recordEntryTranslationFailure(
    'disabled',
    'disabled-due',
    'disabled translation',
    '2026-07-23T03:00:00.000Z',
    '2026-07-23T03:30:00.000Z'
  );

  assert.deepEqual(
    db.listDueTranslationRetries('2026-07-23T12:00:00.000Z').map((entry) => entry.source_guid),
    ['due']
  );
  const batched = db.listRecentEntryErrorsByFeeds(['enabled', 'disabled'], 1);
  assert.deepEqual(
    batched.map((entry) => [entry.feed_name, entry.source_url]),
    [
      ['disabled', 'https://example.com/disabled-due'],
      ['enabled', 'https://example.com/future'],
    ]
  );
  assert.equal(db.listRecentEntryErrorsByFeed('enabled', 1)[0].source_url, 'https://example.com/future');
});
