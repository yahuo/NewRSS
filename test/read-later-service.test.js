const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('../src/db');
const FeedService = require('../src/feed-service');
const ReadLaterService = require('../src/read-later-service');

test('read-later translation can use a provider override independent of global translation provider', () => {
  const service = new ReadLaterService({
    db: {},
    feedService: {},
    config: {
      translationProvider: 'codex-oauth',
      readLaterTranslationProvider: 'gemini',
      geminiApiKey: 'test-gemini-key',
      codexAuthFile: '/tmp/missing-codex-auth.json',
    },
  });

  assert.equal(service.translationService.config.translationProvider, 'gemini');
  assert.equal(service.config.translationProvider, 'codex-oauth');
});

test('read-later translation inherits the global provider when no override is configured', () => {
  const service = new ReadLaterService({
    db: {},
    feedService: {},
    config: {
      translationProvider: 'codex-oauth',
      readLaterTranslationProvider: '   ',
      codexAuthFile: '/tmp/missing-codex-auth.json',
    },
  });

  assert.equal(service.translationService.config.translationProvider, 'codex-oauth');
});

test('read-later uses stable X identity, strips fragments, and preserves an unchanged translation', async (t) => {
  const fixture = createFixture(t);
  fixture.service.importUrl = async ({ url, workspaceDir }) => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    return {
      strategy: 'x-direct',
      sourceTitle: 'Same X post',
      sourceAuthor: '@author',
      sourcePublishedAt: '2026-07-23T00:00:00.000Z',
      sourceContentHtml: '<p>English source content.</p>',
      extractedContentHtml: '<p>English source content.</p>',
      translationProvider: 'newrss-x-direct',
    };
  };
  fixture.service.translationService.shouldTranslate = () => true;
  fixture.service.translationService.translateArticle = async () => ({
    translatedTitle: '中文标题',
    translatedContentHtml: '<p>中文译文</p>',
    provider: 'test-model',
  });

  const first = await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787',
    url: 'https://twitter.com/first/status/123456#private-fragment',
    translate: true,
  });
  fixture.service.translationService.translateArticle = async () => {
    throw new Error('translation should not run for unchanged content');
  };
  const second = await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787',
    url: 'https://x.com/another/status/123456#other-fragment',
    translate: false,
  });

  assert.equal(second.entryId, first.entryId);
  assert.equal(second.existed, true);
  assert.equal(second.translated, true);
  assert.doesNotMatch(second.sourceUrl, /#/);
  const entry = fixture.db.getEntryById(first.entryId);
  assert.equal(entry.translated_content_html, '<p>中文译文</p>');
  assert.equal(fixture.db.listEntriesByFeed(fixture.config.readLaterFeedName, 10).length, 1);
});

test('read-later translation failure is partial and does not publish a stale translation for changed content', async (t) => {
  const fixture = createFixture(t);
  let body = '<p>Original English content.</p>';
  fixture.service.importUrl = async ({ workspaceDir }) => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    return {
      strategy: 'readability', sourceTitle: 'Article', sourceAuthor: '', sourcePublishedAt: null,
      sourceContentHtml: body, extractedContentHtml: body, translationProvider: 'readability',
    };
  };
  fixture.service.translationService.shouldTranslate = () => true;
  fixture.service.translationService.translateArticle = async () => ({
    translatedTitle: '旧译文', translatedContentHtml: '<p>旧中文</p>', provider: 'test-model',
  });
  const first = await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787', url: 'https://example.com/article', translate: true,
  });

  body = '<p>Changed English content.</p>';
  fixture.service.translationService.translateArticle = async () => { throw new Error('provider unavailable'); };
  const second = await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787', url: 'https://example.com/article', translate: true,
  });
  const entry = fixture.db.getEntryById(first.entryId);
  assert.equal(second.translationError, 'provider unavailable');
  assert.equal(entry.refresh_status, 'partial');
  assert.equal(entry.translated_content_html, null);
  assert.equal(entry.extracted_content_html, null);
  assert.equal(entry.source_content_html, body);
  assert.ok(entry.translation_retry_after > entry.translation_last_failed_at);

  fixture.db.db.prepare(`
    UPDATE entries SET translation_retry_after = ? WHERE id = ?
  `).run('2020-01-01T00:00:00.000Z', entry.id);
  fixture.service.translationService.translateArticle = async () => ({
    translatedTitle: '新译文', translatedContentHtml: '<p>新中文</p>', provider: 'test-model',
  });
  const retry = await fixture.service.retryDueTranslations();
  const translated = fixture.db.getEntryById(entry.id);
  assert.deepEqual(retry, [{ entryId: entry.id, status: 'ok' }]);
  assert.equal(translated.refresh_status, 'ok');
  assert.equal(translated.translated_content_html, '<p>新中文</p>');
  assert.equal(translated.translation_retry_after, null);
});

test('same-identity saves are serialized even when request options differ', async (t) => {
  const fixture = createFixture(t);
  let activeImports = 0;
  let maximumActiveImports = 0;
  let importCalls = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  fixture.service.importUrl = async ({ workspaceDir, title }) => {
    importCalls += 1;
    activeImports += 1;
    maximumActiveImports = Math.max(maximumActiveImports, activeImports);
    if (title === 'First title') {
      await firstBlocked;
    }
    fs.mkdirSync(workspaceDir, { recursive: true });
    activeImports -= 1;
    return {
      strategy: 'readability',
      sourceTitle: title,
      sourceAuthor: '',
      sourcePublishedAt: null,
      sourceContentHtml: `<p>${title} English content.</p>`,
      extractedContentHtml: `<p>${title} English content.</p>`,
      translationProvider: 'readability',
    };
  };

  const first = fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787',
    url: 'https://example.com/serialized',
    title: 'First title',
    translate: false,
  });
  await waitFor(() => importCalls === 1);
  const second = fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787',
    url: 'https://example.com/serialized',
    title: 'Second title',
    translate: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(importCalls, 1);

  releaseFirst();
  await Promise.all([first, second]);
  const entries = fixture.db.listEntriesByFeed(fixture.config.readLaterFeedName, 10);
  assert.equal(importCalls, 2);
  assert.equal(maximumActiveImports, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source_title, 'Second title');
  assert.match(
    fs.readFileSync(path.join(fixture.config.readLaterStoragePath, entries[0].source_guid, 'article.html'), 'utf8'),
    /Second title/
  );
});

test('an in-flight translation retry cannot overwrite a newer save', async (t) => {
  const fixture = createFixture(t);
  let body = '<p>Old English content for retry.</p>';
  fixture.service.importUrl = async ({ workspaceDir }) => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    return {
      strategy: 'readability', sourceTitle: 'Retry race', sourceAuthor: '', sourcePublishedAt: null,
      sourceContentHtml: body, extractedContentHtml: body, translationProvider: 'readability',
    };
  };
  fixture.service.translationService.shouldTranslate = () => true;
  fixture.service.translationService.translateArticle = async () => {
    throw new Error('initial translation failure');
  };
  const initial = await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787', url: 'https://example.com/retry-race', translate: true,
  });
  fixture.db.db.prepare(`UPDATE entries SET translation_retry_after = ? WHERE id = ?`).run(
    '2020-01-01T00:00:00.000Z', initial.entryId
  );

  let markRetryStarted;
  const retryStarted = new Promise((resolve) => {
    markRetryStarted = resolve;
  });
  let releaseRetry;
  fixture.service.translationService.translateArticle = async ({ contentHtml }) => {
    if (contentHtml.includes('Old English')) {
      markRetryStarted();
      return new Promise((resolve) => {
        releaseRetry = () => resolve({
          translatedTitle: '旧重试译文', translatedContentHtml: '<p>旧重试中文</p>', provider: 'test-model',
        });
      });
    }
    return {
      translatedTitle: '最新译文', translatedContentHtml: '<p>最新中文</p>', provider: 'test-model',
    };
  };

  const retrying = fixture.service.retryDueTranslations();
  await retryStarted;
  body = '<p>Fresh English content saved by the user.</p>';
  await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787', url: 'https://example.com/retry-race', translate: true,
  });
  releaseRetry();
  const retryResult = await retrying;
  const current = fixture.db.getEntryById(initial.entryId);

  assert.deepEqual(retryResult, [{ entryId: initial.entryId, status: 'superseded' }]);
  assert.equal(current.source_content_html, body);
  assert.equal(current.translated_title, '最新译文');
  assert.equal(current.translated_content_html, '<p>最新中文</p>');
  assert.equal(current.translation_retry_after, null);
});

test('deleting a read-later item invalidates its rendered RSS cache', async (t) => {
  const fixture = createFixture(t);
  fixture.service.importUrl = async ({ workspaceDir }) => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    return {
      strategy: 'readability', sourceTitle: 'Delete cached item', sourceAuthor: '', sourcePublishedAt: null,
      sourceContentHtml: '<p>Delete cached English content.</p>', extractedContentHtml: '<p>Delete cached English content.</p>',
      translationProvider: 'readability',
    };
  };
  const saved = await fixture.service.saveUrl({
    baseUrl: 'http://newrss.local:8787', url: 'https://example.com/delete-cached', translate: false,
  });
  const before = fixture.feedService.renderFeedXml({ feedName: fixture.config.readLaterFeedName });
  assert.match(before, /Delete cached item/);

  fixture.service.deleteItem(String(saved.entryId));
  const after = fixture.feedService.renderFeedXml({ feedName: fixture.config.readLaterFeedName });
  assert.doesNotMatch(after, /Delete cached item/);
});

test('read-later rejects non-HTTP URLs and strict deletion does not accept partial IDs', async (t) => {
  const fixture = createFixture(t);
  await assert.rejects(
    fixture.service.saveUrl({ baseUrl: 'http://newrss.local:8787', url: 'data:text/html,<p>bad</p>' }),
    /HTTP\(S\)/
  );
  assert.throws(() => fixture.service.deleteItem('1junk'), /invalid read-later entry id/);
  assert.throws(() => fixture.service.deleteItem('1.5'), /invalid read-later entry id/);
  assert.throws(() => fixture.service.deleteItem('9007199254740992'), /invalid read-later entry id/);
});

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-read-later-'));
  const db = new Database(path.join(directory, 'newrss.db'));
  const config = {
    appBaseUrl: 'http://newrss.local:8787',
    defaultFeedName: '', defaultFeedUrl: '', defaultFeedFolder: '',
    readLaterFeedName: 'read-later', readLaterFeedTitle: 'Read Later', readLaterFeedFolder: 'Read Later',
    readLaterStoragePath: path.join(directory, 'read-later'), readLaterTranslationProvider: '',
    translationProvider: 'gemini', geminiApiKey: 'test-key', geminiModel: 'test-model',
    geminiTimeoutMs: 5_000, geminiChunkMaxWords: 1_200, geminiChunkConcurrency: 1,
    translateTargetLanguage: 'Simplified Chinese', httpTimeoutMs: 5_000,
    articleMaxBytes: 1024 * 1024, outboundMaxRedirects: 3, outboundAllowedHosts: ['example.com'],
    upstreamProxyUrl: '', userAgent: 'NewRSS test', articleCookieFile: '', articleCookieDomain: '', articleCookieHeader: '',
    maxItemsPerFeed: 50,
  };
  const feedService = new FeedService({ db, config });
  const service = new ReadLaterService({ db, config, feedService });
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { config, db, feedService, service };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}
