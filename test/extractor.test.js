const test = require('node:test');
const assert = require('node:assert/strict');

const { extractEmbeddedContent, looksLikeStandaloneEmbeddedArticle } = require('../src/extractor');

test('looksLikeStandaloneEmbeddedArticle rejects single-paragraph summary snippets', () => {
  const html =
    '<p>The shift from conductor to orchestrator: how to coordinate teams of AI coding agents in real-world software workflows. From subagents to Agent Teams to purpose-built orchestration tools, this talk covers the patterns, tools, and discipline needed to thrive.</p>';

  assert.equal(looksLikeStandaloneEmbeddedArticle(html, 294), false);
});

test('looksLikeStandaloneEmbeddedArticle accepts rich multi-block embedded articles', () => {
  const html = [
    '<p>First paragraph with enough content to describe the article in detail.</p>',
    '<p>Second paragraph that continues the thought and shows this is not just a feed summary.</p>',
  ].join('');

  assert.equal(looksLikeStandaloneEmbeddedArticle(html, 180), true);
});

test('extractEmbeddedContent skips short single-block RSS summaries so readability can fetch the full page', () => {
  const item = {
    content:
      '<p>Cognitive offloading is delegating to the AI and still owning the answer. Cognitive surrender is when the AI output quietly becomes your output and there is nothing left to check.</p>',
  };

  assert.equal(extractEmbeddedContent(item), null);
});
