const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('../src/db');
const FeedService = require('../src/feed-service');
const { stableGuid } = require('../src/utils');

const createService = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-feed-service-'));
  const db = new Database(path.join(directory, 'newrss.db'));
  const config = {
    appBaseUrl: '',
    defaultFeedName: '',
    defaultFeedUrl: '',
    geminiApiKey: '',
    httpTimeoutMs: 5_000,
    maxItemsPerFeed: 50,
    maxItemsPerRefresh: 10,
    articleRecheckHours: 24,
    itemRefreshConcurrency: 3,
    feedRefreshConcurrency: 2,
    outboundAllowedHosts: ['example.com', 'www.nytimes.com'],
    upstreamProxyUrl: '',
    userAgent: 'NewRSS test',
  };

  return {
    db,
    directory,
    service: new FeedService({ db, config }),
  };
};

test('manual feed display title defaults to its name and survives later updates', (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.saveFeed({
    name: 'Economist',
    sourceUrl: 'https://www.economist.com/latest/rss.xml',
    folder: '',
    title: '',
    translateEnabled: true,
  });
  assert.equal(db.getFeedByName('Economist').title, 'Economist');

  service.saveFeed({
    name: 'Economist',
    sourceUrl: 'https://www.economist.com/latest/rss.xml',
    folder: '',
    title: 'The Economist',
    translateEnabled: true,
  });
  service.saveFeed({
    name: 'Economist',
    sourceUrl: 'https://www.economist.com/latest/rss.xml',
    folder: 'News',
    translateEnabled: false,
  });
  assert.equal(db.getFeedByName('Economist').title, 'The Economist');

  service.saveFeed({
    name: 'Economist',
    sourceUrl: 'https://www.economist.com/latest/rss.xml',
    folder: 'News',
    title: '',
    translateEnabled: false,
  });
  assert.equal(db.getFeedByName('Economist').title, 'The Economist');
});

test('feed metadata changes advance the RSS revision and invalidate cached XML', (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = { get: () => 'newrss.local:8787', protocol: 'http' };
  service.saveFeed({
    name: 'MetadataFeed',
    sourceUrl: 'https://example.com/feed.xml',
    title: 'Old title',
    translateEnabled: false,
  });
  const firstXml = service.renderFeedXml({ request, feedName: 'MetadataFeed' });
  const firstRevision = db.getFeedByName('MetadataFeed').content_revision;

  service.saveFeed({
    name: 'MetadataFeed',
    sourceUrl: 'https://example.com/feed.xml',
    title: 'New title',
    translateEnabled: true,
  });
  const secondXml = service.renderFeedXml({ request, feedName: 'MetadataFeed' });
  const updated = db.getFeedByName('MetadataFeed');

  assert.ok(updated.content_revision > firstRevision);
  assert.notEqual(secondXml, firstXml);
  assert.match(secondXml, /New title/);
  assert.match(secondXml, /<language><!\[CDATA\[zh-CN\]\]><\/language>/);
});

test('RSS cache applies a global byte budget and evicts the least recently used feed', (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = { get: () => 'newrss.local:8787', protocol: 'http' };
  for (const name of ['FirstCacheFeed', 'SecondCacheFeed']) {
    service.saveFeed({
      name,
      sourceUrl: `https://example.com/${name}.xml`,
      title: name,
      translateEnabled: false,
    });
  }

  const firstXml = service.renderFeedXml({ request, feedName: 'FirstCacheFeed' });
  service.invalidateFeedXmlCache('FirstCacheFeed');
  service.config.rssCacheMaxBytes = Buffer.byteLength(firstXml, 'utf8') + 128;
  service.renderFeedXml({ request, feedName: 'FirstCacheFeed' });
  service.renderFeedXml({ request, feedName: 'SecondCacheFeed' });

  assert.equal(service.feedXmlCache.size, 1);
  assert.ok(service.feedXmlCacheBytes <= service.config.rssCacheMaxBytes);
  assert.match(service.feedXmlCache.keys().next().value, /^SecondCacheFeed\n/);
});

test('auto-derived feed name collisions get a stable URL hash and missing folder updates preserve the folder', (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = service.saveFeed({
    name: 'example-com-feed', sourceUrl: 'https://example.com/feed?edition=one', folder: 'News', autoName: true,
  });
  const second = service.saveFeed({
    name: 'example-com-feed', sourceUrl: 'https://example.com/feed?edition=two', folder: 'Other', autoName: true,
  });
  assert.equal(first.name, 'example-com-feed');
  assert.match(second.name, /^example-com-feed-[0-9a-f]{8}$/);
  assert.notEqual(second.name, first.name);

  service.saveFeed({ name: first.name, sourceUrl: first.source_url, title: 'Updated' });
  assert.equal(db.getFeedByName(first.name).folder, 'News');
});

test('generic feed operations cannot overwrite or delete the managed Read Later feed', (t) => {
  const { db, directory, service } = createService();
  service.config.readLaterFeedName = 'read-later';
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(
    () => service.saveFeed({ name: 'read-later', sourceUrl: 'https://example.com/feed.xml' }),
    (error) => error.code === 'FEED_CONFLICT'
  );
  assert.throws(
    () => service.deleteFeed('read-later'),
    (error) => error.code === 'FEED_CONFLICT'
  );
});

test('refresh exposes an in-progress status and does not replace the display title', async (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.saveFeed({
    name: 'Economist',
    sourceUrl: 'https://www.economist.com/latest/rss.xml',
    folder: '',
    title: 'The Economist',
    translateEnabled: false,
  });
  db.setFeedRefreshResult('Economist', '2026-07-20T00:00:00.000Z', 'error', 'fetch failed');

  let finishParsing;
  service.parseSourceFeed = () => new Promise((resolve) => {
    finishParsing = resolve;
  });

  const refresh = service.refreshStoredFeed({ parser: {}, feedName: 'Economist' });
  const refreshingFeed = db.getFeedByName('Economist');
  assert.equal(refreshingFeed.last_refresh_status, 'refreshing');
  assert.equal(refreshingFeed.last_refresh_error, null);

  finishParsing({
    title: 'Latest Updates',
    items: [],
  });
  const result = await refresh;
  const refreshedFeed = db.getFeedByName('Economist');

  assert.equal(result.status, 'ok');
  assert.equal(refreshedFeed.last_refresh_status, 'ok');
  assert.equal(refreshedFeed.title, 'The Economist');
});

test('unexpected refresh failures replace the in-progress status with an error', async (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.saveFeed({
    name: 'Economist',
    sourceUrl: 'https://www.economist.com/latest/rss.xml',
    folder: '',
    title: 'The Economist',
    translateEnabled: false,
  });
  service.parseSourceFeed = async () => ({
    title: 'Latest Updates',
    items: [{ guid: 'article-1', link: 'https://www.economist.com/article-1' }],
  });
  db.getEntryByFeedAndGuid = () => {
    throw new Error('Unable to read Codex auth file /Users/example/.codex/auth.json');
  };

  await assert.rejects(
    service.refreshStoredFeed({ parser: {}, feedName: 'Economist' }),
    /Codex auth file/
  );

  const feed = db.getFeedByName('Economist');
  assert.equal(feed.last_refresh_status, 'error');
  assert.equal(feed.last_refresh_error, 'operation failed; see server logs for details');
});

test('refresh skips New York Times live items before applying the item limit', async (t) => {
  const { db, directory, service } = createService();
  const originalFetch = global.fetch;
  let fetchCount = 0;

  t.after(() => {
    global.fetch = originalFetch;
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.saveFeed({
    name: 'NYTimesWorld',
    sourceUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    folder: '',
    title: 'NYTimes World',
    translateEnabled: false,
  });
  service.config.maxItemsPerRefresh = 1;
  service.parseSourceFeed = async () => ({
    title: 'NYTimes World',
    items: [
      {
        guid: 'live-item',
        title: 'Live update',
        link: 'https://www.nytimes.com/live/2026/07/20/world/iran-war#latest',
      },
      {
        guid: 'regular-item',
        title: 'Regular article',
        link: 'https://www.nytimes.com/2026/07/20/world/regular-article.html',
      },
    ],
  });
  global.fetch = async () => {
    fetchCount += 1;
    return new Response(`
      <!doctype html>
      <html>
        <head><title>Regular article</title></head>
        <body>
          <article>
            <h1>Regular article</h1>
            <p>${'Complete article paragraph. '.repeat(40)}</p>
          </article>
        </body>
      </html>
    `, { status: 200 });
  };

  const result = await service.refreshStoredFeed({ parser: {}, feedName: 'NYTimesWorld' });
  const entries = db.listEntriesByFeed('NYTimesWorld', 10);

  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Regular article');
  assert.equal(fetchCount, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source_url, 'https://www.nytimes.com/2026/07/20/world/regular-article.html');
});

test('scheduled and manual refreshes do not overlap', async (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service.saveFeed({
    name: 'LockedFeed',
    sourceUrl: 'https://example.com/feed.xml',
    title: 'Locked Feed',
    translateEnabled: false,
  });

  let finishParsing;
  service.parseSourceFeed = () => new Promise((resolve) => { finishParsing = resolve; });
  const active = service.refreshStoredFeed({ parser: {}, feedName: 'LockedFeed' });
  const scheduled = await service.tryRefreshAllFeeds({ parser: {} });
  assert.equal(scheduled.skipped, true);
  assert.match(scheduled.reason, /feed:LockedFeed/);
  await assert.rejects(
    service.refreshStoredFeed({ parser: {}, feedName: 'LockedFeed' }),
    (error) => error.code === 'REFRESH_IN_PROGRESS'
  );

  finishParsing({ title: 'Locked Feed', items: [] });
  await active;
});

test('recent unchanged entries reuse extracted content without fetching the article again', async (t) => {
  const { db, directory, service } = createService();
  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return new Response(`<article><p>${'Complete article content. '.repeat(40)}</p></article>`, { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service.saveFeed({ name: 'ReuseFeed', sourceUrl: 'https://example.com/feed.xml', translateEnabled: false });
  service.parseSourceFeed = async () => ({
    title: 'Reuse', items: [{ guid: 'same', title: 'Same', link: 'https://example.com/same' }],
  });

  await service.refreshStoredFeed({ parser: {}, feedName: 'ReuseFeed' });
  const before = db.getEntryByFeedAndGuid('ReuseFeed', stableGuid({ guid: 'same' })).source_fetched_at;
  const second = await service.refreshStoredFeed({ parser: {}, feedName: 'ReuseFeed' });
  const after = db.getEntryByFeedAndGuid('ReuseFeed', stableGuid({ guid: 'same' })).source_fetched_at;
  assert.equal(fetchCount, 1);
  assert.equal(second.items[0].reused, true);
  assert.equal(after, before);
});

test('due translations retry from stored content even after the entry falls outside the upstream slice', async (t) => {
  const { db, directory, service } = createService();
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service.saveFeed({ name: 'DueFeed', sourceUrl: 'https://example.com/feed.xml', translateEnabled: true });
  const now = new Date().toISOString();
  db.upsertEntry({
    feedName: 'DueFeed', sourceGuid: 'old-entry', sourceUrl: 'https://example.com/old',
    sourceTitle: 'Old English title', sourceContentHtml: '<p>Old English article content.</p>',
    extractedContentHtml: null, translationProvider: 'readability', refreshStatus: 'error',
    refreshError: 'translation timeout', refreshedAt: now, createdAt: now, updatedAt: now,
  });
  db.db.prepare(`
    UPDATE entries
    SET translation_retry_after = ?, translation_failure_count = 1
    WHERE feed_name = ? AND source_guid = ?
  `).run('2020-01-01T00:00:00.000Z', 'DueFeed', 'old-entry');
  service.parseSourceFeed = async () => ({ title: 'DueFeed', items: [] });
  service.translationService.shouldTranslate = () => true;
  let calls = 0;
  service.translationService.translateArticle = async () => {
    calls += 1;
    return { translatedTitle: '旧文章', translatedContentHtml: '<p>旧文章译文</p>', provider: 'test' };
  };

  await service.refreshAllFeeds({ parser: {} });
  const entry = db.getEntryByFeedAndGuid('DueFeed', 'old-entry');
  assert.equal(calls, 1);
  assert.equal(entry.translated_content_html, '<p>旧文章译文</p>');
  assert.equal(entry.translation_retry_after, null);
});

test('translation backoff persists across service restart and content changes clear it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-feed-backoff-'));
  const dbPath = path.join(directory, 'newrss.db');
  const originalFetch = global.fetch;
  let articleBody = 'Stable English article body. '.repeat(50);
  global.fetch = async () => new Response(`<!doctype html><html><head><title>Article</title></head><body><article><p>${articleBody}</p></article></body></html>`, { status: 200 });
  let db = new Database(dbPath);
  t.after(() => {
    global.fetch = originalFetch;
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = {
    appBaseUrl: '', defaultFeedName: '', defaultFeedUrl: '', httpTimeoutMs: 5_000,
    maxItemsPerFeed: 50, maxItemsPerRefresh: 10, upstreamProxyUrl: '', userAgent: 'NewRSS test',
    articleRecheckHours: 24, itemRefreshConcurrency: 3, feedRefreshConcurrency: 2,
    outboundAllowedHosts: ['example.com'],
  };
  const item = { guid: 'article-1', title: 'English article title', link: 'https://example.com/article' };
  const sourceGuid = stableGuid(item);
  let service = new FeedService({ db, config });
  service.saveFeed({
    name: 'BackoffFeed', sourceUrl: 'https://example.com/feed.xml', title: 'Backoff', translateEnabled: true,
  });
  service.parseSourceFeed = async () => ({ title: 'Backoff', items: [item] });
  service.translationService.shouldTranslate = () => true;
  service.translationService.translateArticle = async () => { throw new Error('translation timeout'); };

  const first = await service.refreshStoredFeed({ parser: {}, feedName: 'BackoffFeed' });
  assert.equal(first.items[0].status, 'error');
  let entry = db.getEntryByFeedAndGuid('BackoffFeed', sourceGuid);
  assert.equal(entry.translation_failure_count, 1);
  assert.ok(entry.translation_retry_after > entry.translation_last_failed_at);

  db.db.close();
  db = new Database(dbPath);
  service = new FeedService({ db, config });
  service.parseSourceFeed = async () => ({ title: 'Backoff', items: [item] });
  service.translationService.shouldTranslate = () => true;
  let translationCalls = 0;
  service.translationService.translateArticle = async () => {
    translationCalls += 1;
    return { translatedTitle: '中文标题', translatedContentHtml: '<p>中文正文</p>', provider: 'test' };
  };

  const second = await service.refreshStoredFeed({ parser: {}, feedName: 'BackoffFeed' });
  assert.equal(second.items[0].status, 'backoff');
  assert.equal(translationCalls, 0);
  assert.equal(db.getEntryByFeedAndGuid('BackoffFeed', sourceGuid).translation_failure_count, 1);

  articleBody = 'Changed English article body. '.repeat(50);
  db.db.prepare(`UPDATE entries SET source_fetched_at = ? WHERE feed_name = ? AND source_guid = ?`).run(
    '2020-01-01T00:00:00.000Z', 'BackoffFeed', sourceGuid
  );
  const third = await service.refreshStoredFeed({ parser: {}, feedName: 'BackoffFeed' });
  assert.equal(third.items[0].status, 'ok');
  assert.equal(translationCalls, 1);
  entry = db.getEntryByFeedAndGuid('BackoffFeed', sourceGuid);
  assert.equal(entry.translation_failure_count, 0);
  assert.equal(entry.translation_retry_after, null);
});

test('expired translation backoff retries instead of reusing an older translation', async (t) => {
  const { db, directory, service } = createService();
  const originalFetch = global.fetch;
  let articleBody = 'Original English article body. '.repeat(50);
  global.fetch = async () => new Response(`<article><p>${articleBody}</p></article>`, { status: 200 });
  t.after(() => {
    global.fetch = originalFetch;
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service.saveFeed({
    name: 'RetryFeed', sourceUrl: 'https://example.com/feed.xml', title: 'Retry', translateEnabled: true,
  });
  const item = { guid: 'retry-article', title: 'English retry title', link: 'https://example.com/retry' };
  const sourceGuid = stableGuid(item);
  service.parseSourceFeed = async () => ({ title: 'Retry', items: [item] });
  service.translationService.shouldTranslate = () => true;
  service.translationService.translateArticle = async () => ({
    translatedTitle: '旧标题', translatedContentHtml: '<p>旧译文</p>', provider: 'test',
  });
  await service.refreshStoredFeed({ parser: {}, feedName: 'RetryFeed' });

  articleBody = 'Changed English article body. '.repeat(50);
  db.db.prepare(`UPDATE entries SET source_fetched_at = ? WHERE feed_name = ? AND source_guid = ?`).run(
    '2020-01-01T00:00:00.000Z', 'RetryFeed', sourceGuid
  );
  service.translationService.translateArticle = async () => { throw new Error('translation timeout'); };
  await service.refreshStoredFeed({ parser: {}, feedName: 'RetryFeed' });
  const duringResult = await service.refreshStoredFeed({ parser: {}, feedName: 'RetryFeed' });
  const during = db.getEntryByFeedAndGuid('RetryFeed', sourceGuid);
  assert.equal(duringResult.items[0].status, 'backoff');
  assert.equal(during.translated_content_html, null);
  assert.equal(during.translated_title, null);
  assert.match(during.extracted_content_html, /Changed English article body/);
  db.db.prepare(`UPDATE entries SET translation_retry_after = ? WHERE feed_name = ? AND source_guid = ?`).run(
    new Date(Date.now() - 1000).toISOString(), 'RetryFeed', sourceGuid
  );

  let retryCalls = 0;
  service.translationService.translateArticle = async () => {
    retryCalls += 1;
    return { translatedTitle: '新标题', translatedContentHtml: '<p>新译文</p>', provider: 'test' };
  };
  await service.refreshStoredFeed({ parser: {}, feedName: 'RetryFeed' });
  const entry = db.getEntryByFeedAndGuid('RetryFeed', sourceGuid);
  assert.equal(retryCalls, 1);
  assert.equal(entry.translated_content_html, '<p>新译文</p>');
  assert.equal(entry.translation_failure_count, 0);
});

test('open Codex circuit does not create article-level translation backoff', async (t) => {
  const { db, directory, service } = createService();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`<article><p>${'English article body. '.repeat(50)}</p></article>`, { status: 200 });
  t.after(() => {
    global.fetch = originalFetch;
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service.saveFeed({
    name: 'CircuitFeed', sourceUrl: 'https://example.com/feed.xml', title: 'Circuit', translateEnabled: true,
  });
  const item = { guid: 'circuit-article', title: 'English circuit title', link: 'https://example.com/circuit' };
  service.parseSourceFeed = async () => ({ title: 'Circuit', items: [item] });
  service.translationService.shouldTranslate = () => true;
  service.translationService.translateArticle = async () => {
    const error = new Error('Codex circuit is open');
    error.code = 'CODEX_CIRCUIT_OPEN';
    throw error;
  };

  await service.refreshStoredFeed({ parser: {}, feedName: 'CircuitFeed' });
  const entry = db.getEntryByFeedAndGuid('CircuitFeed', stableGuid(item));
  assert.equal(entry.translation_failure_count, 0);
  assert.equal(entry.translation_retry_after, null);
});

test('Codex usage-limit error does not create article-level translation backoff', async (t) => {
  const { db, directory, service } = createService();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`<article><p>${'English article body. '.repeat(50)}</p></article>`, { status: 200 });
  t.after(() => {
    global.fetch = originalFetch;
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service.saveFeed({
    name: 'LimitFeed', sourceUrl: 'https://example.com/feed.xml', title: 'Limit', translateEnabled: true,
  });
  const item = { guid: 'limit-article', title: 'English limit title', link: 'https://example.com/limit' };
  service.parseSourceFeed = async () => ({ title: 'Limit', items: [item] });
  service.translationService.shouldTranslate = () => true;
  service.translationService.translateArticle = async () => {
    const error = new Error('The usage limit has been reached');
    error.code = 'CODEX_USAGE_LIMIT';
    throw error;
  };

  await service.refreshStoredFeed({ parser: {}, feedName: 'LimitFeed' });
  const entry = db.getEntryByFeedAndGuid('LimitFeed', stableGuid(item));
  assert.equal(entry.translation_failure_count, 0);
  assert.equal(entry.translation_retry_after, null);
});
