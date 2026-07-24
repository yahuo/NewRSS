const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderAdminPage, renderFaviconSvg } = require('../src/admin-page');

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
  const favicon = dom.window.document.querySelector('link[rel="icon"]');
  assert.equal(favicon.getAttribute('type'), 'image/svg+xml');
  assert.equal(favicon.getAttribute('href'), '/favicon.svg?v=1');
});

test('favicon reuses the NewRSS RSS mark', () => {
  const dom = new JSDOM(renderFaviconSvg(), { contentType: 'image/svg+xml' });
  const svg = dom.window.document.documentElement;
  assert.equal(svg.getAttribute('viewBox'), '0 0 28 28');
  assert.equal(svg.querySelectorAll('circle').length, 1);
  assert.equal(svg.querySelectorAll('path').length, 2);
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

test('admin page exposes live status regions and catches the initial Codex request failure', async () => {
  const dom = createAdminDom({
    feeds: [],
    fetch: async (url) => {
      if (url === '/api/codex/status') {
        throw new Error('codex offline');
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  for (const id of ['codex-status', 'status', 'read-later-status', 'opml-status']) {
    const element = dom.window.document.getElementById(id);
    assert.equal(element.getAttribute('role'), 'status');
    assert.equal(element.getAttribute('aria-live'), 'polite');
  }
  await waitFor(() => dom.window.document.getElementById('codex-status').textContent === 'codex offline');
  assert.equal(dom.window.document.getElementById('codex-probe').disabled, true);
});

test('Read Later form submits one async job and prevents duplicate submissions', async () => {
  const requests = [];
  let resolveSubmission;
  const submissionResponse = new Promise((resolve) => {
    resolveSubmission = resolve;
  });
  const feed = managedReadLaterFeed();
  const dom = createAdminDom({
    feeds: [feed],
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (url === '/api/codex/status') {
        return jsonResponse({ ok: false, error: 'inactive' }, 404);
      }
      if (url === '/api/read-later/jobs') {
        return submissionResponse;
      }
      if (url === '/api/read-later/jobs/job-1') {
        return jsonResponse({
          jobId: 'job-1',
          status: 'done',
          result: { title: 'Saved', strategy: 'readability', translated: false },
        });
      }
      if (url === '/api/feeds') {
        return jsonResponse({ ok: true, feeds: [feed] });
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
  const form = dom.window.document.getElementById('read-later-form');
  form.elements.url.value = 'https://example.com/story';

  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(form.querySelector('button[type="submit"]').disabled, true);
  assert.equal(requests.filter(({ url }) => url === '/api/read-later/jobs').length, 1);

  resolveSubmission(jsonResponse({ jobId: 'job-1', status: 'queued' }, 202));
  await waitFor(() => dom.window.document.getElementById('read-later-status').textContent.startsWith('已保存：Saved'));

  const submissions = requests.filter(({ url }) => url === '/api/read-later/jobs');
  assert.equal(submissions.length, 1);
  assert.ok(submissions[0].options.headers['Idempotency-Key']);
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
  assert.equal(form.elements.url.value, '');
});

test('Read Later list uses server pagination and normalizes search queries with NFKC', async () => {
  const itemRequests = [];
  const feed = managedReadLaterFeed({ entryCount: 21 });
  const firstPage = Array.from({ length: 20 }, (_, index) => readLaterItem(index + 1));
  const dom = createAdminDom({
    feeds: [feed],
    fetch: async (url) => {
      if (url === '/api/codex/status') {
        return jsonResponse({ ok: false, error: 'inactive' }, 404);
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        const parsed = new URL(String(url), 'http://localhost:8787');
        itemRequests.push(parsed);
        const query = parsed.searchParams.get('q') || '';
        const offset = Number(parsed.searchParams.get('offset') || 0);
        if (query) {
          return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
        }
        return offset === 20
          ? jsonResponse({ items: [readLaterItem(21)], total: 21, limit: 20, offset: 20 })
          : jsonResponse({ items: firstPage, total: 21, limit: 20, offset: 0 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await waitFor(() => dom.window.document.querySelectorAll('[data-role="read-later-entry-item"]').length === 20);
  dom.window.document.querySelector('[data-action="read-later-page-next"]').click();
  await waitFor(() => dom.window.document.querySelector('.pagination-summary')?.textContent === '21-21 / 21');
  assert.equal(itemRequests.at(-1).searchParams.get('offset'), '20');

  const searchForm = dom.window.document.querySelector('[data-role="read-later-search-form"]');
  searchForm.querySelector('[data-role="read-later-search"]').value = 'Ａ';
  searchForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => itemRequests.at(-1).searchParams.get('q') === 'A');
  assert.equal(itemRequests.at(-1).searchParams.get('offset'), '0');
  await waitFor(() => dom.window.document.querySelector('.empty')?.textContent.includes('没有匹配'));
});

test('Read Later deletion errors stay in the Read Later status region', async () => {
  const feed = managedReadLaterFeed({ entryCount: 1 });
  const dom = createAdminDom({
    feeds: [feed],
    confirm: () => true,
    fetch: async (url, options = {}) => {
      if (url === '/api/codex/status') {
        return jsonResponse({ ok: false, error: 'inactive' }, 404);
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        return jsonResponse({ items: [readLaterItem(1)], total: 1, limit: 20, offset: 0 });
      }
      if (url === '/api/read-later/items/1' && options.method === 'DELETE') {
        return jsonResponse({ ok: false, error: 'forced delete failure' }, 500);
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await waitFor(() => Boolean(dom.window.document.querySelector('[data-action="delete-read-later-entry"]')));
  dom.window.document.querySelector('[data-action="delete-read-later-entry"]').click();
  await waitFor(() => dom.window.document.getElementById('read-later-status').textContent === 'forced delete failure');
  assert.equal(dom.window.document.getElementById('status').textContent, '');
});

test('reloading feeds keeps the OPML folder selector in sync', async () => {
  const initialFeed = sourceFeed('a', 'A');
  const nextFeeds = [initialFeed, sourceFeed('b', 'B')];
  const dom = createAdminDom({
    feeds: [initialFeed],
    folders: ['A'],
    fetch: async (url, options = {}) => {
      if (url === '/api/codex/status') {
        return jsonResponse({ ok: false, error: 'inactive' }, 404);
      }
      if (url === '/api/feeds' && options.method === 'POST') {
        return jsonResponse({ ok: true }, 201);
      }
      if (url === '/api/feeds') {
        return jsonResponse({ ok: true, feeds: nextFeeds });
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
  const form = dom.window.document.getElementById('feed-form');
  form.elements.name.value = 'b';
  form.elements.sourceUrl.value = 'https://example.com/b.xml';
  form.elements.folder.value = 'B';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(() => Array.from(dom.window.document.querySelectorAll('#export-form option')).some((option) => option.value === 'B'));
  assert.deepEqual(
    Array.from(dom.window.document.querySelectorAll('#export-form option')).map((option) => option.value),
    ['', 'A', 'B']
  );
});

test('OPML import rejects files over 2 MiB before reading or uploading', async () => {
  const requests = [];
  const dom = createAdminDom({
    feeds: [],
    fetch: async (url) => {
      requests.push(String(url));
      if (url === '/api/codex/status') {
        return jsonResponse({ ok: false, error: 'inactive' }, 404);
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
  const form = dom.window.document.getElementById('opml-form');
  const file = new dom.window.File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.opml');
  installOpmlFormData(dom.window, file);
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(() => dom.window.document.getElementById('opml-status').textContent.includes('2 MiB'));
  assert.equal(requests.includes('/api/opml/import'), false);
});

test('OPML import reports a readable error for a non-JSON server response', async () => {
  const dom = createAdminDom({
    feeds: [],
    fetch: async (url) => {
      if (url === '/api/codex/status') {
        return jsonResponse({ ok: false, error: 'inactive' }, 404);
      }
      if (String(url).startsWith('/api/read-later/items?')) {
        return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      }
      if (url === '/api/opml/import') {
        return {
          ok: false,
          status: 413,
          json: async () => {
            throw new SyntaxError('HTML response');
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
  const form = dom.window.document.getElementById('opml-form');
  const file = new dom.window.File(['<opml version="2.0"></opml>'], 'small.opml');
  installOpmlFormData(dom.window, file);
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(() => dom.window.document.getElementById('opml-status').textContent === '导入失败（HTTP 413）');
});

function createAdminDom({ feeds, folders = [], fetch, confirm = () => false }) {
  return new JSDOM(renderAdminPage({
    feeds,
    folders,
    baseUrl: 'http://localhost:8787',
    readLaterFeedName: 'read-later',
  }), {
    runScripts: 'dangerously',
    url: 'http://localhost:8787/admin',
    beforeParse(window) {
      window.fetch = fetch;
      window.confirm = confirm;
    },
  });
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function installOpmlFormData(window, file) {
  window.FormData = class {
    constructor(form) {
      this.form = form;
    }

    get(name) {
      if (name === 'opmlFile') {
        return file;
      }
      return this.form.elements[name]?.value || '';
    }
  };
}

function managedReadLaterFeed(overrides = {}) {
  return {
    name: 'read-later',
    title: 'Read Later',
    sourceUrl: 'newrss-managed://read-later',
    folder: 'Read Later',
    feedUrl: 'http://localhost:8787/feeds/read-later.xml',
    translateEnabled: false,
    lastRefreshStatus: 'ok',
    lastRefreshedAt: '',
    entryCount: 0,
    errorCount: 0,
    recentEntryErrors: [],
    isManaged: true,
    items: [],
    ...overrides,
  };
}

function sourceFeed(name, folder) {
  return {
    name,
    title: name.toUpperCase(),
    sourceUrl: `https://example.com/${name}.xml`,
    folder,
    feedUrl: `http://localhost:8787/feeds/${name}.xml`,
    translateEnabled: false,
    lastRefreshStatus: 'ok',
    lastRefreshedAt: '',
    entryCount: 0,
    errorCount: 0,
    recentEntryErrors: [],
    isManaged: false,
    items: [],
  };
}

function readLaterItem(id) {
  return {
    id,
    title: `Item ${id}`,
    sourceUrl: `https://example.com/items/${id}`,
    articleUrl: `http://localhost:8787/articles/${id}`,
    sourcePublishedAt: '2026-07-23T00:00:00.000Z',
    translated: false,
  };
}

async function waitFor(predicate, message = 'timed out waiting for admin page state') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
