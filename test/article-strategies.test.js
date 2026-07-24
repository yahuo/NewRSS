const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  ECONOMIST_USER_AGENT,
  NYTIMES_USER_AGENT,
  getArticleStrategy,
} = require('../src/article-strategies');
const { resolveArticleContent } = require('../src/extractor');
const TEST_ALLOWED_HOSTS = [
  'www.newyorker.com',
  'foreignpolicy.com',
  'www.economist.com',
  'www.nytimes.com',
  'hypebeast.com',
  'example.com',
];

test('article strategies only match the five supported domains', () => {
  assert.equal(getArticleStrategy('https://www.economist.com/test').name, 'economist');
  assert.equal(getArticleStrategy('https://www.newyorker.com/test').name, 'new-yorker');
  assert.equal(getArticleStrategy('https://foreignpolicy.com/test').name, 'foreign-policy');
  assert.equal(getArticleStrategy('https://www.nytimes.com/test').name, 'new-york-times');
  assert.equal(getArticleStrategy('https://hypebeast.com/test').name, 'hypebeast');
  assert.equal(getArticleStrategy('https://not-economist.com/test'), null);
  assert.equal(getArticleStrategy('https://example.com/test'), null);
});

test('New Yorker strategy merges split article body containers', () => {
  const dom = new JSDOM(`
    <article>
      <div class="body__inner-container"><p>First paragraph</p></div>
      <aside>Advertisement</aside>
      <div class="body__inner-container"><p>Final paragraph</p></div>
    </article>
  `);
  const strategy = getArticleStrategy('https://www.newyorker.com/magazine/test');

  strategy.prepareDocument(dom.window.document);

  const containers = dom.window.document.querySelectorAll('.body__inner-container');
  assert.equal(containers.length, 1);
  assert.deepEqual(
    Array.from(containers[0].querySelectorAll('p'), (paragraph) => paragraph.textContent),
    ['First paragraph', 'Final paragraph']
  );
});

test('Foreign Policy strategy removes the preview and exposes the full body', () => {
  const dom = new JSDOM(`
    <article>
      <div class="content-ungated"><p>Repeated preview</p></div>
      <div class="content-gated"><p>Complete article body</p></div>
    </article>
  `);
  const strategy = getArticleStrategy('https://foreignpolicy.com/2026/07/17/test/');

  strategy.prepareDocument(dom.window.document);

  assert.equal(dom.window.document.querySelector('.content-ungated'), null);
  assert.equal(dom.window.document.querySelector('.content-gated'), null);
  assert.equal(dom.window.document.querySelector('article').textContent.trim(), 'Complete article body');
});

test('New York Times strategy removes ad containers without deleting similarly named content wrappers', () => {
  const dom = new JSDOM(`
    <main>
      <div id="top-wrapper">Top advertisement</div>
      <div id="plain-ad" class="ad-wrapper extra-class">Advertisement</div>
      <div id="named-ad" class="story-ad-wrapper extra-class">Advertisement</div>
      <div id="ad-unit" class="content adunit_inline">Advertisement</div>
      <div id="standard-ad" class="css-slot"><div data-testid="StandardAd">Advertisement</div></div>
      <section id="fallback-ad"><div data-testid="StandardAd">Advertisement</div></section>
      <div id="article-lead" class="lead-wrapper"><p>Article lead must remain</p></div>
    </main>
  `);
  const strategy = getArticleStrategy('https://www.nytimes.com/2026/07/20/test.html');

  strategy.prepareDocument(dom.window.document);

  for (const id of ['top-wrapper', 'plain-ad', 'named-ad', 'ad-unit', 'standard-ad']) {
    assert.equal(dom.window.document.getElementById(id), null);
  }
  assert.equal(dom.window.document.querySelector('#fallback-ad [data-testid="StandardAd"]'), null);
  assert.equal(dom.window.document.querySelector('#article-lead').textContent.trim(), 'Article lead must remain');
});

test('New Yorker document preparation runs before Readability', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`
    <!doctype html>
    <html>
      <head><title>Split article</title></head>
      <body>
        <article>
          <h1>Split article</h1>
          <div class="body__inner-container"><p>${'Primary body sentence. '.repeat(30)}</p></div>
        </article>
        <aside><div class="body__inner-container"><p>${'Final body sentence. '.repeat(30)}</p></div></aside>
      </body>
    </html>
  `, { status: 200 });

  try {
    const result = await resolveArticleContent(
      { link: 'https://www.newyorker.com/magazine/test' },
      { timeoutMs: 5_000, userAgent: 'NewRSS default user agent', allowedHosts: TEST_ALLOWED_HOSTS }
    );

    assert.match(result.html, /Primary body sentence/);
    assert.match(result.html, /Final body sentence/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Foreign Policy document preparation removes duplicated preview before Readability', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`
    <!doctype html>
    <html>
      <head><title>Gated article</title></head>
      <body>
        <article>
          <h1>Gated article</h1>
          <div class="content-ungated"><p>${'Repeated preview sentence. '.repeat(20)}</p></div>
          <div class="content-gated"><p>${'Complete body sentence. '.repeat(30)}</p></div>
        </article>
      </body>
    </html>
  `, { status: 200 });

  try {
    const result = await resolveArticleContent(
      { link: 'https://foreignpolicy.com/2026/07/17/test/' },
      { timeoutMs: 5_000, userAgent: 'NewRSS default user agent', allowedHosts: TEST_ALLOWED_HOSTS }
    );

    assert.doesNotMatch(result.html, /Repeated preview sentence/);
    assert.match(result.html, /Complete body sentence/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Economist strategy bypasses a long RSS teaser and uses its request user agent', async () => {
  const originalFetch = global.fetch;
  let requestHeaders;
  global.fetch = async (_url, options) => {
    requestHeaders = new Headers(options.headers);
    return new Response(`
      <!doctype html>
      <html>
        <head><title>Fetched Economist article</title></head>
        <body>
          <article>
            <h1>Fetched Economist article</h1>
            <p>${'First fetched paragraph. '.repeat(30)}</p>
            <p>${'Second fetched paragraph. '.repeat(30)}</p>
          </article>
        </body>
      </html>
    `, { status: 200 });
  };

  try {
    const result = await resolveArticleContent(
      {
        link: 'https://www.economist.com/united-states/test',
        content: `<p>${'Long RSS teaser. '.repeat(30)}</p>`,
      },
      {
        timeoutMs: 5_000,
        userAgent: 'NewRSS default user agent',
        allowedHosts: TEST_ALLOWED_HOSTS,
      }
    );

    assert.equal(result.source, 'readability');
    assert.equal(requestHeaders.get('user-agent'), ECONOMIST_USER_AGENT);
    assert.match(result.html, /Second fetched paragraph/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('New York Times strategy fetches the page with its request user agent and removes ads', async () => {
  const originalFetch = global.fetch;
  let requestHeaders;
  global.fetch = async (_url, options) => {
    requestHeaders = new Headers(options.headers);
    return new Response(`
      <!doctype html>
      <html>
        <head><title>Fetched New York Times article</title></head>
        <body>
          <article>
            <h1>Fetched New York Times article</h1>
            <p>${'First fetched paragraph. '.repeat(30)}</p>
            <div data-testid="Dropzone-inarticle">Advertisement that should be removed</div>
            <p>${'Second fetched paragraph. '.repeat(30)}</p>
          </article>
        </body>
      </html>
    `, { status: 200 });
  };

  try {
    const result = await resolveArticleContent(
      {
        link: 'https://www.nytimes.com/2026/07/20/test.html',
        content: `<p>${'Long RSS summary. '.repeat(30)}</p>`,
      },
      {
        timeoutMs: 5_000,
        userAgent: 'NewRSS default user agent',
        allowedHosts: TEST_ALLOWED_HOSTS,
      }
    );

    assert.equal(result.source, 'readability');
    assert.equal(requestHeaders.get('user-agent'), NYTIMES_USER_AGENT);
    assert.match(result.html, /Second fetched paragraph/);
    assert.doesNotMatch(result.html, /Advertisement that should be removed/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unmatched sites keep using complete RSS content without fetching the page', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('unexpected page fetch');
  };

  try {
    const result = await resolveArticleContent(
      {
        link: 'https://example.com/article',
        content: `<p>${'Complete embedded article. '.repeat(30)}</p>`,
      },
      {
        timeoutMs: 5_000,
        userAgent: 'NewRSS default user agent',
      }
    );

    assert.equal(result.source, 'rss');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hypebeast strategy accepts substantial RSS content ending with its publisher footer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('unexpected page fetch');
  };

  try {
    const result = await resolveArticleContent(
      {
        link: 'https://hypebeast.com/2026/7/test-article',
        content: `
          <p>${'Complete Hypebeast article paragraph. '.repeat(20)}</p>
          <p><a href="https://hypebeast.com/2026/7/test-article">Read more at Hypebeast</a></p>
        `,
      },
      {
        timeoutMs: 5_000,
        userAgent: 'NewRSS default user agent',
        allowedHosts: TEST_ALLOWED_HOSTS,
      }
    );

    assert.equal(result.source, 'rss');
    assert.match(result.html, /Complete Hypebeast article paragraph/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hypebeast strategy still fetches the page when its RSS content is too short', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`
    <!doctype html>
    <html>
      <head><title>Fetched Hypebeast article</title></head>
      <body>
        <article>
          <h1>Fetched Hypebeast article</h1>
          <p>${'Complete fetched paragraph. '.repeat(30)}</p>
        </article>
      </body>
    </html>
  `, { status: 200 });

  try {
    const result = await resolveArticleContent(
      {
        link: 'https://hypebeast.com/2026/7/short-rss-item',
        content: '<p>Short summary.</p><p>Read more at Hypebeast</p>',
      },
      {
        timeoutMs: 5_000,
        userAgent: 'NewRSS default user agent',
        allowedHosts: TEST_ALLOWED_HOSTS,
      }
    );

    assert.equal(result.source, 'readability');
    assert.match(result.html, /Complete fetched paragraph/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('other sites still treat substantial RSS content ending with read more as truncated', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`
    <!doctype html>
    <html>
      <head><title>Fetched article</title></head>
      <body>
        <article>
          <h1>Fetched article</h1>
          <p>${'Complete fetched paragraph. '.repeat(30)}</p>
        </article>
      </body>
    </html>
  `, { status: 200 });

  try {
    const result = await resolveArticleContent(
      {
        link: 'https://example.com/article',
        content: `<p>${'Long RSS summary. '.repeat(30)}</p><p>Read more</p>`,
      },
      {
        timeoutMs: 5_000,
        userAgent: 'NewRSS default user agent',
        allowedHosts: TEST_ALLOWED_HOSTS,
      }
    );

    assert.equal(result.source, 'readability');
    assert.match(result.html, /Complete fetched paragraph/);
  } finally {
    global.fetch = originalFetch;
  }
});
