const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderAdminPage } = require('../src/admin-page');

test('admin page renders the NewRSS logo beside the heading', () => {
  const html = renderAdminPage({
    feeds: [],
    folders: [],
    baseUrl: 'http://localhost:8787',
    readLaterFeedName: 'read-later',
  });
  const dom = new JSDOM(html);
  const heading = dom.window.document.querySelector('.brand-title');
  const logo = heading.querySelector('.brand-logo');

  assert.equal(heading.textContent.trim(), 'NewRSS Feed 管理');
  assert.equal(logo.getAttribute('viewBox'), '0 0 28 28');
  assert.equal(logo.getAttribute('aria-hidden'), 'true');
  assert.equal(logo.querySelectorAll('circle').length, 1);
  assert.equal(logo.querySelectorAll('path').length, 2);
});

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

test('admin page accepts a display title and renders an in-progress refresh status', async () => {
  const requests = [];
  const html = renderAdminPage({
    feeds: [
      {
        name: 'Economist',
        title: 'The Economist',
        sourceUrl: 'https://www.economist.com/latest/rss.xml',
        folder: '',
        feedUrl: 'http://localhost:8787/feeds/Economist.xml',
        translateEnabled: true,
        lastRefreshStatus: 'refreshing',
        lastRefreshedAt: '2026-07-20T00:00:00.000Z',
        entryCount: 3,
        errorCount: 0,
        recentEntryErrors: [],
        isManaged: false,
        items: [],
      },
    ],
    baseUrl: 'http://localhost:8787',
    readLaterFeedName: 'read-later',
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:8787/admin',
    beforeParse(window) {
      window.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return {
          ok: true,
          json: async () => options.method === 'POST' ? { ok: true } : { ok: true, feeds: [] },
        };
      };
    },
  });

  assert.ok(dom.window.document.querySelector('input[name="title"]'));
  assert.equal(dom.window.document.querySelector('.feed-item .pill').textContent, '刷新中');

  const form = dom.window.document.getElementById('feed-form');
  form.elements.name.value = 'Economist';
  form.elements.sourceUrl.value = 'https://www.economist.com/latest/rss.xml';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));

  const request = requests.find(({ options }) => options.method === 'POST');
  assert.ok(request);
  assert.equal(Object.hasOwn(JSON.parse(request.options.body), 'title'), false);
});

test('admin page exposes Codex status and an immediate quota probe button', () => {
  const html = renderAdminPage({
    feeds: [],
    folders: [],
    baseUrl: 'http://localhost:8787',
    readLaterFeedName: 'read-later',
  });
  assert.match(html, /立即检测 Codex 额度/);
  assert.match(html, /\/api\/codex\/status/);
  assert.match(html, /\/api\/codex\/probe/);
  assert.match(html, /input\/output\/total/);
});
