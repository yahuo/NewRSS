const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { sanitizeHtml } = require('../src/html-sanitizer');

const parseFragment = (html) => new JSDOM(`<body>${html}</body>`).window.document.body;

test('sanitizer removes dangerous subtrees and unwraps unknown ordinary elements', () => {
  const sanitized = sanitizeHtml(`
    <article data-track="article">
      <h2>Safe title</h2>
      <newsletter-card>Before <em>kept</em> after</newsletter-card>
      <script><p>script child</p></script>
      <style><p>style child</p></style>
      <iframe src="https://evil.example/"><p>frame child</p></iframe>
      <object data="https://evil.example/"><p>object child</p></object>
      <svg><text>svg child</text></svg>
      <!-- comment -->
    </article>
  `);
  const body = parseFragment(sanitized);

  assert.equal(body.querySelector('article').getAttribute('data-track'), null);
  assert.equal(body.querySelector('newsletter-card'), null);
  assert.equal(body.querySelector('em').textContent, 'kept');
  assert.match(body.textContent, /Before kept after/);
  assert.doesNotMatch(body.textContent, /script child|style child|frame child|object child|svg child/);
  assert.equal(body.querySelector('script, style, iframe, object, svg'), null);
  assert.equal(sanitized.includes('<!--'), false);
});

test('sanitizer keeps only allowlisted attributes and hardens anchors', () => {
  const sanitized = sanitizeHtml(`
    <p class="summary" title="Summary" id="intro" style="color:red" onclick="alert(1)" srcdoc="bad">
      <a href="/stories/1" target="_blank" rel="ugc opener" onfocus="alert(1)">Story</a>
    </p>
  `, { baseUrl: 'https://news.example/section/index.html' });
  const body = parseFragment(sanitized);
  const paragraph = body.querySelector('p');
  const anchor = body.querySelector('a');

  assert.equal(paragraph.getAttribute('class'), 'summary');
  assert.equal(paragraph.getAttribute('title'), 'Summary');
  assert.equal(paragraph.hasAttribute('id'), false);
  assert.equal(paragraph.hasAttribute('style'), false);
  assert.equal(paragraph.hasAttribute('onclick'), false);
  assert.equal(paragraph.hasAttribute('srcdoc'), false);
  assert.equal(anchor.getAttribute('href'), 'https://news.example/stories/1');
  assert.equal(anchor.getAttribute('target'), '_blank');
  assert.equal(anchor.getAttribute('rel'), 'ugc noopener noreferrer');
  assert.equal(anchor.hasAttribute('onfocus'), false);
});

test('sanitizer normalizes safe URLs and removes unsafe URL protocols', () => {
  const sanitized = sanitizeHtml(`
    <a id="relative" href="../article?q=1#part">Relative</a>
    <a id="email" href="mailto:reader@example.com">Email</a>
    <a id="phone" href="tel:+123456789">Phone</a>
    <a id="script" href="java&#x73;cript:alert(1)">Script</a>
    <a id="data" href="data:text/html,bad">Data</a>
    <img id="image" src="./cover.jpg" srcset="/small.jpg 1x, https://cdn.example/large.jpg 2x, javascript:alert(1) 3x" alt="Cover" onerror="alert(1)">
    <img id="unsafe-image" src="data:image/svg+xml,bad">
  `, { baseUrl: 'https://news.example/section/index.html' });
  const body = parseFragment(sanitized);
  const anchors = body.querySelectorAll('a');
  const images = body.querySelectorAll('img');

  assert.equal(anchors[0].getAttribute('href'), 'https://news.example/article?q=1#part');
  assert.equal(anchors[1].getAttribute('href'), 'mailto:reader@example.com');
  assert.equal(anchors[2].getAttribute('href'), 'tel:+123456789');
  assert.equal(anchors[3].hasAttribute('href'), false);
  assert.equal(anchors[4].hasAttribute('href'), false);
  for (const anchor of anchors) {
    assert.equal(anchor.getAttribute('rel'), 'noopener noreferrer');
  }

  assert.equal(images[0].getAttribute('src'), 'https://news.example/section/cover.jpg');
  assert.equal(
    images[0].getAttribute('srcset'),
    'https://news.example/small.jpg 1x, https://cdn.example/large.jpg 2x'
  );
  assert.equal(images[0].hasAttribute('onerror'), false);
  assert.equal(images[1].hasAttribute('src'), false);
});

test('sanitizer drops relative URLs when no usable base URL is available', () => {
  const sanitized = sanitizeHtml('<a href="/story">Story</a><img src="cover.jpg">');
  const body = parseFragment(sanitized);

  assert.equal(body.querySelector('a').hasAttribute('href'), false);
  assert.equal(body.querySelector('img').hasAttribute('src'), false);
});

test('sanitizer output is idempotent', () => {
  const input = `
    <custom-wrapper>
      <a href="/story" rel="nofollow noopener">Story</a>
      <img src="/cover.jpg" srcset="/small.jpg 1x, /large.jpg 2x">
      <p style="display:none" onmouseover="alert(1)">Body</p>
    </custom-wrapper>
  `;
  const options = { baseUrl: 'https://news.example/articles/index.html' };
  const once = sanitizeHtml(input, options);
  const twice = sanitizeHtml(once, options);

  assert.equal(twice, once);
});
