const test = require('node:test');
const assert = require('node:assert/strict');

const { stashHtmlAttributes } = require('../src/html-attribute-stash');

test('stash removes attributes behind short ids and restores them after translation', () => {
  const source = [
    '<figure class="hero"><img src="https://cdn.example/a.jpg" srcset="https://cdn.example/a-1x.jpg 1x, https://cdn.example/a-2x.jpg 2x" alt="A red hat"></figure>',
    '<p>Read the <a href="https://example.com/review?a=1&amp;b=2" rel="noopener">full review</a>.</p>',
  ].join('');

  const stashed = stashHtmlAttributes(source);

  assert.doesNotMatch(stashed.html, /src|href|class|alt|rel/);
  assert.equal(stashed.html.match(/data-k="\d+"/g).length, 3);

  const translated = stashed.html
    .replace('Read the ', '阅读')
    .replace('full review', '完整评测');
  const restored = stashed.restore(translated);

  assert.equal(
    restored,
    [
      '<figure class="hero"><img src="https://cdn.example/a.jpg" srcset="https://cdn.example/a-1x.jpg 1x, https://cdn.example/a-2x.jpg 2x" alt="A red hat"></figure>',
      '<p>阅读<a href="https://example.com/review?a=1&amp;b=2" rel="noopener">完整评测</a>.</p>',
    ].join('')
  );
});

test('stash leaves attribute-free html untouched', () => {
  const source = '<p>Plain <strong>text</strong> only.</p>';
  const stashed = stashHtmlAttributes(source);

  assert.equal(stashed.html, source);
  assert.equal(stashed.restore('<p>纯文本</p>'), '<p>纯文本</p>');
});

test('stash restore keeps source values and tolerates ids the model changed or dropped', () => {
  const stashed = stashHtmlAttributes('<p><a href="https://example.com/a">one</a> <a href="https://example.com/b">two</a></p>');
  const [first] = stashed.html.match(/data-k="\d+"/g);

  const restored = stashed.restore(
    `<p><a ${first} href="https://evil.example/">一</a> <a data-k="999">二</a> <a>三</a></p>`
  );

  assert.equal(
    restored,
    '<p><a href="https://example.com/a">一</a> <a>二</a> <a>三</a></p>'
  );
});

test('stash round-trips a data-k attribute that already exists in the source', () => {
  const stashed = stashHtmlAttributes('<p data-k="original">Hello</p>');

  assert.equal(stashed.restore(stashed.html.replace('Hello', '你好')), '<p data-k="original">你好</p>');
});
