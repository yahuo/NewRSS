const test = require('node:test');
const assert = require('node:assert/strict');

const { renderAdminPage } = require('../src/admin-page');

test('admin feed list renders a per-feed translation switch', () => {
  const html = renderAdminPage({
    feeds: [
      {
        name: 'wired',
        title: 'Wired',
        sourceUrl: 'https://example.com/rss.xml',
        folder: 'TECH',
        feedUrl: 'http://localhost:8787/feeds/wired.xml',
        translateEnabled: true,
        lastRefreshStatus: 'ok',
        lastRefreshedAt: '',
        entryCount: 3,
        errorCount: 0,
        recentEntryErrors: [],
        isManaged: false,
        items: [],
      },
    ],
    folders: ['TECH'],
    baseUrl: 'http://localhost:8787',
    readLaterFeedName: 'read-later',
  });

  assert.match(html, /data-action="toggle-translate"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /"name":"wired"/);
  assert.match(html, /"sourceUrl":"https:\/\/example\.com\/rss\.xml"/);
  assert.match(html, /"folder":"TECH"/);
  assert.match(html, /"translateEnabled":true/);
  assert.ok(html.includes('aria-checked="${feed.translateEnabled ? \'true\' : \'false\'}"'));
  assert.ok(html.includes('data-name="${escapeHtml(feed.name)}"'));
  assert.ok(html.includes('data-source-url="${escapeHtml(feed.sourceUrl)}"'));
  assert.ok(html.includes('data-folder="${escapeHtml(feed.folder || \'\')}"'));
  assert.ok(html.includes('data-translate-enabled="${feed.translateEnabled ? \'true\' : \'false\'}"'));
  assert.ok(html.includes("${feed.translateEnabled ? '关闭' : '开启'}</button>"));
  assert.match(html, /fetch\('\/api\/feeds'/);
  assert.match(html, /translateEnabled: nextTranslateEnabled/);
});
