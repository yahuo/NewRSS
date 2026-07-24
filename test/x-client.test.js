const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchXTweet, resetXClientCaches } = require('../src/x-client');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function config(overrides = {}) {
  return {
    httpTimeoutMs: 1_000,
    xMaxBytes: 1024 * 1024,
    outboundMaxRedirects: 2,
    outboundAllowedHosts: [],
    upstreamProxyUrl: '',
    xUserAgent: 'NewRSS X test',
    xBearerToken: 'Bearer test',
    xLookup: publicLookup,
    ...overrides,
  };
}

function tweetResult(id) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      conversation_id_str: id,
      user_id_str: 'user-1',
      full_text: `tweet ${id}`,
    },
  };
}

test('X client caches home and GraphQL query metadata in process', async (t) => {
  resetXClientCaches();
  t.after(resetXClientCaches);
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.toString());
    if (parsed.hostname === 'x.com' && parsed.pathname === '/') {
      return new Response('<script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script>');
    }
    if (parsed.hostname === 'abs.twimg.com') {
      return new Response(
        'queryId:"tweet-query-id",operationName:"TweetResultByRestId",featureSwitches:[],fieldToggles:[]'
      );
    }
    if (parsed.pathname.includes('/TweetResultByRestId')) {
      const variables = JSON.parse(parsed.searchParams.get('variables'));
      return Response.json({ data: { tweetResult: { result: tweetResult(variables.tweetId) } } });
    }
    return new Response('not found', { status: 404 });
  };
  const clientConfig = config({ xFetchImpl: fetchImpl });

  const [first, second] = await Promise.all([
    fetchXTweet('100', {}, clientConfig),
    fetchXTweet('101', {}, clientConfig),
  ]);

  assert.equal(first.rest_id, '100');
  assert.equal(second.rest_id, '101');
  assert.equal(requests.filter((url) => url === 'https://x.com/').length, 1);
  assert.equal(requests.filter((url) => url.includes('abs.twimg.com')).length, 1);
  assert.equal(requests.filter((url) => url.includes('/TweetResultByRestId')).length, 2);
  assert.ok(requests.every((url) => !url.includes('/id8pHQbQi7eZ6P9mA1th1Q/')));
});

test('X client applies outbound response byte limits', async (t) => {
  resetXClientCaches();
  t.after(resetXClientCaches);
  let requestCount = 0;

  await assert.rejects(
    fetchXTweet('100', {}, config({
      xMaxBytes: 8,
      xFetchImpl: async () => {
        requestCount += 1;
        return new Response('main.abc123.js');
      },
    })),
    { code: 'OUTBOUND_RESPONSE_TOO_LARGE' }
  );
  assert.equal(requestCount, 1);
});

test('X client applies the configured HTTP timeout', async (t) => {
  resetXClientCaches();
  t.after(resetXClientCaches);
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await assert.rejects(
    fetchXTweet('100', {}, config({ httpTimeoutMs: 20, xFetchImpl: fetchImpl })),
    { code: 'OUTBOUND_TIMEOUT' }
  );
});

test('fixed X hosts still reject private DNS results', async (t) => {
  resetXClientCaches();
  t.after(resetXClientCaches);
  let requestCount = 0;

  await assert.rejects(
    fetchXTweet('100', {}, config({
      outboundAllowedHosts: ['x.com', 'abs.twimg.com'],
      xLookup: async () => [{ address: '127.0.0.1', family: 4 }],
      xFetchImpl: async () => {
        requestCount += 1;
        return new Response('must not be reached');
      },
    })),
    { code: 'OUTBOUND_ADDRESS_BLOCKED' }
  );
  assert.equal(requestCount, 0);
});
