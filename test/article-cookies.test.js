const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveArticleCookieHeader } = require('../src/article-cookies');

test('article cookies only match an exact configured domain or its subdomains', () => {
  const config = {
    articleCookieDomain: '.Example.COM',
    articleCookieHeader: ' session=one; theme=dark ',
  };

  assert.equal(resolveArticleCookieHeader('https://example.com/article', config), 'session=one; theme=dark');
  assert.equal(resolveArticleCookieHeader('https://www.example.com/article', config), 'session=one; theme=dark');
  assert.equal(resolveArticleCookieHeader('https://notexample.com/article', config), '');
  assert.equal(resolveArticleCookieHeader('not a URL', config), '');
  assert.equal(resolveArticleCookieHeader('https://example.com/again', config), 'session=one; theme=dark');
  assert.equal(resolveArticleCookieHeader('https://example.com/article', {}), '');

  assert.throws(
    () => resolveArticleCookieHeader('https://example.com', { articleCookieHeader: 'session=one' }),
    /ARTICLE_COOKIE_DOMAIN is required/
  );
});

test('article cookie domain maps prefer the most specific rule and inline overrides', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-article-cookies-map-'));
  const cookieFile = path.join(temporaryDirectory, 'cookies.json');

  try {
    fs.writeFileSync(cookieFile, JSON.stringify({
      domains: {
        'example.com': { base: 'one', blank: ' ' },
        '.sub.example.com': { cookieHeader: 'specific=file' },
        'empty.example.com': {},
      },
    }));

    const fileConfig = { articleCookieFile: cookieFile };
    assert.equal(resolveArticleCookieHeader('https://www.example.com/a', fileConfig), 'base=one');
    assert.equal(resolveArticleCookieHeader('https://deep.sub.example.com/a', fileConfig), 'specific=file');

    const overridden = {
      articleCookieFile: cookieFile,
      articleCookieDomain: 'sub.example.com',
      articleCookieHeader: 'specific=inline',
    };
    assert.equal(resolveArticleCookieHeader('https://deep.sub.example.com/a', overridden), 'specific=inline');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('article cookie files accept browser exports and reload after the file changes', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-article-cookies-browser-'));
  const cookieFile = path.join(temporaryDirectory, 'cookies.json');

  try {
    fs.writeFileSync(cookieFile, JSON.stringify([
      { domain: '.news.example', name: 'session', value: 'abc' },
      { domain: 'news.example', name: 'theme', value: 0 },
      { domain: 'news.example', name: '', value: 'ignored' },
      null,
    ]));
    const config = { articleCookieFile: cookieFile };
    assert.equal(resolveArticleCookieHeader('https://www.news.example/story', config), 'session=abc; theme=0');

    fs.writeFileSync(cookieFile, JSON.stringify({
      domain: 'news.example',
      cookies: { refreshed: 'a-longer-value' },
    }));
    assert.equal(resolveArticleCookieHeader('https://news.example/story', config), 'refreshed=a-longer-value');

    const plainMapFile = path.join(temporaryDirectory, 'plain-map.json');
    fs.writeFileSync(plainMapFile, JSON.stringify({ 'plain.example': 'plain=yes' }));
    assert.equal(
      resolveArticleCookieHeader('https://plain.example/story', { articleCookieFile: plainMapFile }),
      'plain=yes'
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('article cookie files report missing, malformed, and empty inputs', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-article-cookies-errors-'));
  const missingFile = path.join(temporaryDirectory, 'missing.json');
  const malformedFile = path.join(temporaryDirectory, 'malformed.json');
  const emptyFile = path.join(temporaryDirectory, 'empty.json');
  const nullFile = path.join(temporaryDirectory, 'null.json');
  const arrayValueFile = path.join(temporaryDirectory, 'array-value.json');

  try {
    assert.throws(
      () => resolveArticleCookieHeader('https://example.com', { articleCookieFile: missingFile }),
      /article cookie file not found/
    );

    fs.writeFileSync(malformedFile, '{bad json');
    assert.throws(
      () => resolveArticleCookieHeader('https://example.com', { articleCookieFile: malformedFile }),
      /failed to parse article cookie file/
    );

    fs.writeFileSync(emptyFile, JSON.stringify([]));
    assert.throws(
      () => resolveArticleCookieHeader('https://example.com', { articleCookieFile: emptyFile }),
      /unsupported or empty shape/
    );

    fs.writeFileSync(nullFile, JSON.stringify(null));
    assert.throws(
      () => resolveArticleCookieHeader('https://example.com', { articleCookieFile: nullFile }),
      /unsupported or empty shape/
    );

    fs.writeFileSync(arrayValueFile, JSON.stringify({ 'example.com': [] }));
    assert.throws(
      () => resolveArticleCookieHeader('https://example.com', { articleCookieFile: arrayValueFile }),
      /unsupported or empty shape/
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
