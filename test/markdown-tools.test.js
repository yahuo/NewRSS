const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { chunkMarkdown } = require('../src/markdown-chunker');
const { renderMarkdown, renderMarkdownFile } = require('../src/markdown-renderer');
const { parseOpml } = require('../src/opml');
const { buildHtmlTranslationPlan } = require('../src/html-chunker');
const {
  buildFeedNameFromUrl,
  buildManagedFeedSourceUrl,
  extractMarkdownHeadingTitle,
  hashText,
  isManagedFeedSourceUrl,
  normalizeDerivedTitle,
  stableGuid,
} = require('../src/utils');

test('markdown rendering applies metadata precedence, escapes metadata, and hardens links', () => {
  const rendered = renderMarkdown(`---
title: "Frontmatter <Title>"
author: 'Author & Co'
url: "https://example.com/read?a=1&b=2"
description: 'Short <summary>'
ignored frontmatter line
---
# Frontmatter <Title>

[Read more](https://example.com/article)

Body **copy**.
`);

  assert.equal(rendered.title, 'Frontmatter <Title>');
  assert.equal(rendered.author, 'Author & Co');
  assert.equal(rendered.summary, 'Short <summary>');
  assert.doesNotMatch(rendered.contentHtml, /<h1>/);
  assert.match(rendered.contentHtml, /<a href="https:\/\/example\.com\/article" target="_blank" rel="noreferrer">/);
  assert.match(rendered.contentHtml, /class="md-blockquote"/);
  assert.match(rendered.html, /<title>Frontmatter &lt;Title&gt;<\/title>/);
  assert.match(rendered.html, /name="author" content="Author &amp; Co"/);
  assert.match(rendered.html, /name="description" content="Short &lt;summary&gt;"/);
  assert.match(rendered.html, /name="x-source-url" content="https:\/\/example\.com\/read\?a=1&amp;b=2"/);

  const overridden = renderMarkdown('# Original\n\nBody text', {
    title: 'Override',
    author: 'Option author',
    sourceUrl: 'https://source.example/path',
  });
  assert.equal(overridden.title, 'Override');
  assert.equal(overridden.author, 'Option author');
  assert.match(overridden.contentHtml, /<h1>Original<\/h1>/);
});

test('markdown rendering handles inferred, fallback, malformed, and empty documents', () => {
  const inferred = renderMarkdown('# Inferred title\n\nA short body');
  assert.equal(inferred.title, 'Inferred title');
  assert.doesNotMatch(inferred.contentHtml, /<h1>/);
  assert.equal(inferred.summary, 'A short body');

  const malformed = renderMarkdown('---\ntitle: Not frontmatter\nBody', { fallbackTitle: 'Fallback' });
  assert.equal(malformed.title, 'Fallback');
  assert.match(malformed.contentHtml, /title: Not frontmatter/);

  const empty = renderMarkdown(null);
  assert.equal(empty.title, 'Untitled');
  assert.equal(empty.summary, '');
  assert.doesNotMatch(empty.contentHtml, /md-blockquote/);
  assert.doesNotMatch(empty.html, /name="author"|name="description"|name="x-source-url"/);
});

test('renderMarkdownFile writes beside the source and derives a filename title', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-markdown-render-'));
  const markdownPath = path.join(temporaryDirectory, 'saved-note.MD');

  try {
    fs.writeFileSync(markdownPath, 'Saved body text', 'utf8');
    const rendered = renderMarkdownFile(markdownPath);

    assert.equal(rendered.title, 'saved-note');
    assert.equal(rendered.htmlPath, path.join(temporaryDirectory, 'saved-note.html'));
    assert.equal(fs.readFileSync(rendered.htmlPath, 'utf8'), rendered.html);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('markdown chunking normalizes input and keeps heading sections ordered', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('   '), []);

  const chunks = chunkMarkdown('\uFEFF# One\r\n\r\none two three\r\n\r\n## Two\r\n\r\nfour five six', {
    maxWords: 5,
  });

  assert.deepEqual(chunks, [
    { index: 0, words: 5, markdown: '# One\n\none two three' },
    { index: 1, words: 5, markdown: '## Two\n\nfour five six' },
  ]);
  assert.deepEqual(chunkMarkdown('one two', { maxWords: 'invalid' }), [
    { index: 0, words: 2, markdown: 'one two' },
  ]);
});

test('markdown chunking splits prose by line, sentence, word, and CJK weight', () => {
  assert.deepEqual(chunkMarkdown('line one two\nline three four\nline five six', { maxWords: 4 }), [
    { index: 0, words: 3, markdown: 'line one two' },
    { index: 1, words: 3, markdown: 'line three four' },
    { index: 2, words: 3, markdown: 'line five six' },
  ]);
  assert.deepEqual(chunkMarkdown('one two. three four. five six.', { maxWords: 4 }), [
    { index: 0, words: 4, markdown: 'one two. three four.' },
    { index: 1, words: 2, markdown: 'five six.' },
  ]);
  assert.deepEqual(chunkMarkdown('one two three four five six seven eight nine', { maxWords: 4 }), [
    { index: 0, words: 4, markdown: 'one two three four' },
    { index: 1, words: 4, markdown: 'five six seven eight' },
    { index: 2, words: 1, markdown: 'nine' },
  ]);
  assert.deepEqual(chunkMarkdown('甲乙丙丁戊己庚辛壬癸', { maxWords: 5 }), [
    { index: 0, words: 5, markdown: '甲乙丙丁戊己庚辛壬癸' },
  ]);
});

test('markdown chunking preserves fenced and indented code boundaries', () => {
  const fenced = chunkMarkdown('```js\nconst a = 1\nconst b = 2\n```', { maxWords: 8 });
  assert.deepEqual(fenced, [
    { index: 0, words: 6, markdown: '```js\nconst a = 1\n```' },
    { index: 1, words: 6, markdown: '```js\nconst b = 2\n```' },
  ]);
  for (const chunk of fenced) {
    assert.match(chunk.markdown, /^```js\n/);
    assert.match(chunk.markdown, /\n```$/);
  }

  const indented = chunkMarkdown('    one two three\n    four five six\n    seven eight nine', { maxWords: 5 });
  assert.deepEqual(indented.map((chunk) => chunk.markdown), [
    '    one two three',
    '    four five six',
    '    seven eight nine',
  ]);

  const structural = chunkMarkdown('---\n\n<div>one two three four five six</div>', { maxWords: 4 });
  assert.equal(structural.map((chunk) => chunk.markdown).join('\n\n'), '---\n\n<div>one two three four\n\nfive six</div>');

  assert.deepEqual(chunkMarkdown('    one two three four five six', { maxWords: 3 }), [
    { index: 0, words: 6, markdown: '    one two three four five six' },
  ]);
  assert.deepEqual(chunkMarkdown('```\n```', { maxWords: 1 }), [
    { index: 0, words: 2, markdown: '```\n\n```' },
  ]);
});

test('HTML chunking handles empty and markup-only inputs without inventing content', () => {
  const empty = buildHtmlTranslationPlan(null, { maxWords: 'invalid' });
  assert.deepEqual(empty.chunks, []);
  assert.equal(empty.wrap('  translated  '), 'translated');

  const markupOnly = buildHtmlTranslationPlan('<!-- preserved marker -->');
  assert.deepEqual(markupOnly.chunks, ['<!-- preserved marker -->']);
  assert.equal(markupOnly.wrap(markupOnly.chunks[0]), '<!-- preserved marker -->');
});

test('HTML chunking preserves nested wrappers around split text', () => {
  const words = Array.from({ length: 230 }, (_, index) => `word-${index}`).join(' ');
  const plan = buildHtmlTranslationPlan(`<article data-kind="story"><section><p>${words}</p></section></article>`, {
    maxWords: 200,
  });

  assert.equal(plan.chunks.length, 2);
  assert.ok(plan.chunks.every((chunk) => chunk.startsWith('<p>') && chunk.endsWith('</p>')));
  const wrapped = plan.wrap(plan.chunks.join('\n'));
  assert.match(wrapped, /^<article data-kind="story"><section>/);
  assert.match(wrapped, /<\/section><\/article>$/);
  assert.match(wrapped, /word-0/);
  assert.match(wrapped, /word-229/);
});

test('HTML chunking keeps ordinary elements, loose text, and preformatted blocks intact', () => {
  const plan = buildHtmlTranslationPlan('lead &amp; tail <p>small body</p><img src="cover.jpg"><pre>one   two</pre>', {
    maxWords: 200,
  });

  assert.equal(plan.chunks.length, 1);
  assert.match(plan.chunks[0], /^lead &amp; tail/);
  assert.match(plan.chunks[0], /<p>small body<\/p>/);
  assert.match(plan.chunks[0], /<img src="cover\.jpg">/);
  assert.match(plan.chunks[0], /<pre>one   two<\/pre>/);
});

test('feed utility helpers keep generated names, managed URLs, and GUIDs stable', () => {
  assert.equal(buildFeedNameFromUrl('https://Example.COM/path/to/feed.xml'), 'example-com-path-to-feed-xml');
  assert.equal(buildFeedNameFromUrl(new URL('https://example.com/news')), 'example-com-news');
  assert.equal(buildFeedNameFromUrl(new URL('file:///')), 'feed');
  assert.equal(buildFeedNameFromUrl(`https://example.com/${'segment/'.repeat(20)}`).length, 64);

  assert.equal(buildManagedFeedSourceUrl(' Read Later '), 'newrss://Read%20Later');
  assert.equal(buildManagedFeedSourceUrl(''), 'newrss://feed');
  assert.equal(isManagedFeedSourceUrl('newrss://Read%20Later'), true);
  assert.equal(isManagedFeedSourceUrl('https://example.com/feed'), false);

  assert.equal(stableGuid({ guid: 'guid' }), hashText('guid'));
  assert.equal(stableGuid({ id: 'id' }), hashText('id'));
  assert.equal(stableGuid({ link: 'https://example.com/item' }), hashText('https://example.com/item'));
  assert.equal(stableGuid({ title: 'Title', pubDate: '2026-07-24' }), hashText('Title:2026-07-24'));
});

test('derived markdown titles normalize whitespace, truncate, and handle missing headings', () => {
  assert.equal(extractMarkdownHeadingTitle('intro\n#  A   title  \nbody'), 'A title');
  assert.equal(extractMarkdownHeadingTitle('# abcdef', 5), 'abcd…');
  assert.equal(extractMarkdownHeadingTitle('no heading'), '');
  assert.equal(normalizeDerivedTitle('  full\u3000width  '), 'full width');
  assert.equal(normalizeDerivedTitle(''), '');
});

test('OPML parsing imports nested folders and supported attribute fallbacks', () => {
  const parsed = parseOpml(`<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="  Tech  ">
      <outline title=" Daily   News ">
        <outline text=" Feed A " xmlUrl=" https://a.example/feed.xml " />
        <ignored text="not a feed" />
      </outline>
    </outline>
    <outline title="Root Feed" xmlurl="https://root.example/rss" />
  </body>
</opml>`);

  assert.deepEqual(parsed, [
    { sourceUrl: 'https://a.example/feed.xml', title: 'Feed A', folder: 'Tech/Daily News' },
    { sourceUrl: 'https://root.example/rss', title: 'Root Feed', folder: '' },
  ]);
});

test('OPML parsing rejects malformed XML and documents without a body', () => {
  assert.throws(() => parseOpml('<opml><body>'), /unclosed tag|invalid OPML/);
  assert.throws(
    () => parseOpml('<opml><body><parsererror>bad XML</parsererror></body></opml>'),
    /invalid OPML/
  );
  assert.throws(() => parseOpml('<opml version="2.0"></opml>'), /OPML body missing/);
});
