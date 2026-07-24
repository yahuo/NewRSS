const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalXIdentity } = require('../src/x-importer');

test('canonicalXIdentity keeps tweet identity stable across URL aliases', () => {
  const expected = {
    identity: 'x-tweet:123456',
    url: 'https://x.com/i/web/status/123456',
  };

  assert.deepEqual(canonicalXIdentity('https://x.com/alice/status/123456'), expected);
  assert.deepEqual(canonicalXIdentity('https://twitter.com/bob/statuses/123456?ref_src=test'), expected);
  assert.deepEqual(canonicalXIdentity('123456'), expected);
});

test('canonicalXIdentity keeps article identity independent of URL host', () => {
  const expected = {
    identity: 'x-article:987654',
    url: 'https://x.com/i/article/987654',
  };

  assert.deepEqual(canonicalXIdentity('https://x.com/i/article/987654'), expected);
  assert.deepEqual(canonicalXIdentity('https://twitter.com/i/article/987654'), expected);
});
