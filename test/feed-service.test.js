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
    throw new Error('database lookup failed');
  };

  await assert.rejects(
    service.refreshStoredFeed({ parser: {}, feedName: 'Economist' }),
    /database lookup failed/
  );

  const feed = db.getFeedByName('Economist');
  assert.equal(feed.last_refresh_status, 'error');
  assert.equal(feed.last_refresh_error, 'database lookup failed');
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
  const third = await service.refreshStoredFeed({ parser: {}, feedName: 'BackoffFeed' });
  assert.equal(third.items[0].status, 'ok');
  assert.equal(translationCalls, 1);
  entry = db.getEntryByFeedAndGuid('BackoffFeed', sourceGuid);
  assert.equal(entry.translation_failure_count, 0);
  assert.equal(entry.translation_retry_after, null);
});
