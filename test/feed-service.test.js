const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('../src/db');
const FeedService = require('../src/feed-service');

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
