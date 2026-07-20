const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  ECONOMIST_USER_AGENT,
  getArticleStrategy,
} = require('../src/article-strategies');
const { resolveArticleContent } = require('../src/extractor');

test('article strategies only match the three supported domains', () => {
  assert.equal(getArticleStrategy('https://www.economist.com/test').name, 'economist');
  assert.equal(getArticleStrategy('https://www.newyorker.com/test').name, 'new-yorker');
  assert.equal(getArticleStrategy('https://foreignpolicy.com/test').name, 'foreign-policy');
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
      { timeoutMs: 5_000, userAgent: 'NewRSS default user agent' }
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
      { timeoutMs: 5_000, userAgent: 'NewRSS default user agent' }
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
    requestHeaders = options.headers;
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
      }
    );

    assert.equal(result.source, 'readability');
    assert.equal(requestHeaders['user-agent'], ECONOMIST_USER_AGENT);
    assert.match(result.html, /Second fetched paragraph/);
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
