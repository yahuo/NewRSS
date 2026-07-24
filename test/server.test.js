const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-server-'));
process.env.DB_PATH = path.join(directory, 'newrss.db');
process.env.READ_LATER_STORAGE_PATH = path.join(directory, 'read-later');
process.env.APP_BASE_URL = 'http://127.0.0.1:8787';
process.env.DEFAULT_FEED_NAME = '';
process.env.DEFAULT_FEED_URL = '';
process.env.REFRESH_ON_BOOT = 'false';

const { app, db, feedService, readLaterService } = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('management remains open while cross-site and non-JSON mutations are rejected', async () => {
  const admin = await fetch(`${baseUrl}/admin`);
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('x-powered-by'), null);

  const form = await fetch(`${baseUrl}/api/feeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'sourceUrl=https%3A%2F%2Fexample.com%2Ffeed.xml',
  });
  assert.equal(form.status, 415);

  const crossSite = await fetch(`${baseUrl}/api/feeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ sourceUrl: 'https://example.com/feed.xml' }),
  });
  assert.equal(crossSite.status, 403);

  const legacyRefresh = await fetch(`${baseUrl}/refresh?name=anything`);
  assert.equal(legacyRefresh.status, 405);
  assert.equal(legacyRefresh.headers.get('allow'), 'POST');
});

test('malformed JSON and invalid outbound schemes return stable JSON errors without stacks', async () => {
  const malformed = await fetch(`${baseUrl}/api/feeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('content-type'), /application\/json/);
  const malformedBody = await malformed.text();
  assert.doesNotMatch(malformedBody, /SyntaxError|server\.js|node_modules/);

  const invalid = await fetch(`${baseUrl}/api/read-later/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'data:text/html,<script>alert(1)</script>' }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /HTTP\(S\)/);
});

test('Chrome extension mutations remain allowed with cross-site fetch metadata and complete a job', async () => {
  const originalSaveUrl = readLaterService.saveUrl;
  readLaterService.saveUrl = async ({ baseUrl: resultBaseUrl }) => ({
    entryId: 77,
    articleUrl: `${resultBaseUrl}/articles/77`,
    feedUrl: `${resultBaseUrl}/feeds/read-later.xml`,
  });
  try {
    const accepted = await fetch(`${baseUrl}/api/read-later/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'chrome-extension://abcdefghijklmnop',
        'sec-fetch-site': 'cross-site',
        'idempotency-key': 'extension-contract-test',
      },
      body: JSON.stringify({ url: 'https://example.com/extension', mode: 'auto', translate: true }),
    });
    assert.equal(accepted.status, 202);
    const job = await accepted.json();
    assert.match(job.jobId, /^[0-9a-f-]{36}$/);

    const completed = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/read-later/jobs/${job.jobId}`);
      const current = await response.json();
      return current.status === 'done' ? current : null;
    });
    assert.equal(completed.result.entryId, 77);
    assert.equal(completed.result.articleUrl, 'http://127.0.0.1:8787/articles/77');
  } finally {
    readLaterService.saveUrl = originalSaveUrl;
  }
});

test('POST refresh accepts the JSON body contract and validates an override URL', async () => {
  const originalRefreshFeed = feedService.refreshFeed;
  const calls = [];
  feedService.refreshFeed = async (options) => {
    calls.push(options);
    return { feedName: options.feedName, sourceUrl: options.sourceUrl, status: 'ok' };
  };
  try {
    const refreshed = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'contract', url: 'https://example.com/feed.xml#fragment' }),
    });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).result.sourceUrl, 'https://example.com/feed.xml');
    assert.equal(calls.length, 1);

    const invalid = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'contract', url: 'file:///etc/passwd' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    feedService.refreshFeed = originalRefreshFeed;
  }
});

test('article output sanitizes historical HTML, uses strict IDs, and sends a restrictive CSP', async () => {
  const now = new Date().toISOString();
  db.upsertFeed({
    name: 'security', sourceUrl: 'https://example.com/feed.xml', folder: '', title: 'Security',
    translateEnabled: true, createdAt: now, updatedAt: now,
  });
  db.upsertEntry({
    feedName: 'security', sourceGuid: 'xss', sourceUrl: 'https://example.com/article',
    sourceTitle: 'Article', sourceContentHtml: '<p>source</p>', extractedContentHtml: null,
    translatedTitle: '译文',
    translatedContentHtml: `<base href="https://evil.example"><script>alert(1)</script><img src="/image.jpg" onerror="alert(2)"><a href="javascript:alert(3)">bad</a><form action="/api/feeds/x"><button>go</button></form><p>${'safe content '.repeat(500)}</p>`,
    translationProvider: 'test', refreshStatus: 'ok', refreshedAt: now, createdAt: now, updatedAt: now,
  });
  const entry = db.getEntryByFeedAndGuid('security', 'xss');

  const response = await fetch(`${baseUrl}/articles/${entry.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('content-language'), 'zh-CN');
  const html = await response.text();
  assert.doesNotMatch(html, /<script|onerror|javascript:|<form|<base/i);
  assert.match(html, /src="https:\/\/example\.com\/image\.jpg"/);

  assert.equal((await fetch(`${baseUrl}/articles/${entry.id}junk`)).status, 404);
});

test('RSS revision stays stable across no-content refreshes and supports conditional GET', async () => {
  db.bumpFeedContentRevision('security');
  const first = await fetch(`${baseUrl}/feeds/security.xml`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-encoding'), 'gzip');
  const etag = first.headers.get('etag');
  assert.ok(etag);

  db.setFeedRefreshResult('security', new Date(Date.now() + 1000).toISOString(), 'ok', '');
  const second = await fetch(`${baseUrl}/feeds/security.xml`);
  assert.equal(second.headers.get('etag'), etag);
  assert.equal(await second.text(), await first.text());

  const conditional = await fetch(`${baseUrl}/feeds/security.xml`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(conditional.status, 304);
});

test('readiness checks both database access and the data directory', async () => {
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ready: true });
});

async function waitFor(readValue) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await readValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for server state');
}
