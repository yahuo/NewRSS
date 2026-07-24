const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyAgent, Socks5ProxyAgent } = require('undici');

const { withProxy } = require('../src/http-client');

test('withProxy leaves request options untouched when no proxy is configured', () => {
  const init = { method: 'POST', headers: { accept: 'text/plain' } };
  assert.equal(withProxy('', init), init);
  assert.deepEqual(withProxy(null), {});
});

test('withProxy selects and caches HTTP and SOCKS5 dispatchers', async () => {
  const dispatchers = new Set();

  try {
    const httpFirst = withProxy('http://127.0.0.1:3128', { method: 'GET' });
    const httpCached = withProxy('http://127.0.0.1:3128', { method: 'POST' });
    const socks = withProxy('socks5://127.0.0.1:1080', { headers: { accept: '*/*' } });
    const httpChanged = withProxy('http://127.0.0.1:8080');

    for (const result of [httpFirst, httpCached, socks, httpChanged]) {
      dispatchers.add(result.dispatcher);
    }

    assert.ok(httpFirst.dispatcher instanceof ProxyAgent);
    assert.equal(httpFirst.dispatcher, httpCached.dispatcher);
    assert.equal(httpCached.method, 'POST');
    assert.ok(socks.dispatcher instanceof Socks5ProxyAgent);
    assert.notEqual(socks.dispatcher, httpFirst.dispatcher);
    assert.ok(httpChanged.dispatcher instanceof ProxyAgent);
    assert.notEqual(httpChanged.dispatcher, httpFirst.dispatcher);
  } finally {
    await Promise.all(Array.from(dispatchers, (dispatcher) => dispatcher.close()));
  }
});
