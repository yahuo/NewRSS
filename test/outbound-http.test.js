const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { assertSafeOutboundUrl, fetchText } = require('../src/outbound-http');

const PUBLIC_IP = '8.8.8.8';
const publicLookup = async () => [{ address: PUBLIC_IP, family: 4 }];

test('assertSafeOutboundUrl only permits HTTP(S) without URL credentials', async () => {
  for (const url of ['data:text/plain,hello', 'file:///etc/passwd', 'ftp://example.com/file']) {
    await assert.rejects(assertSafeOutboundUrl(url, { lookup: publicLookup }), { code: 'OUTBOUND_URL_PROTOCOL' });
  }
  await assert.rejects(assertSafeOutboundUrl('https://user:secret@example.com/', { lookup: publicLookup }), {
    code: 'OUTBOUND_URL_CREDENTIALS',
  });
  assert.equal(
    (await assertSafeOutboundUrl('https://example.com/article', { lookup: publicLookup })).toString(),
    'https://example.com/article'
  );
});

test('assertSafeOutboundUrl rejects private, metadata, CGNAT, IPv6 and mapped addresses', async () => {
  const blockedUrls = [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:127.0.0.1]/',
  ];

  for (const url of blockedUrls) {
    await assert.rejects(assertSafeOutboundUrl(url), { code: 'OUTBOUND_ADDRESS_BLOCKED' }, url);
  }

  await assert.rejects(
    assertSafeOutboundUrl('https://mixed.example/', {
      lookup: async () => [
        { address: PUBLIC_IP, family: 4 },
        { address: '10.0.0.8', family: 4 },
      ],
    }),
    { code: 'OUTBOUND_ADDRESS_BLOCKED' }
  );
});

test('allowedHosts is an exact private-host exception', async () => {
  const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  assert.equal(
    (await assertSafeOutboundUrl('http://internal.example/path', {
      allowedHosts: ['INTERNAL.EXAMPLE'],
      lookup: privateLookup,
    })).hostname,
    'internal.example'
  );
  await assert.rejects(
    assertSafeOutboundUrl('http://sub.internal.example/path', {
      allowedHosts: ['internal.example'],
      lookup: privateLookup,
    }),
    { code: 'OUTBOUND_ADDRESS_BLOCKED' }
  );
});

test('fetchText revalidates every redirect and never fetches a blocked target', async () => {
  const fetched = [];
  const lookup = async (hostname) => [{
    address: hostname === 'private.example' ? '192.168.1.20' : PUBLIC_IP,
    family: 4,
  }];
  const fetch = async (url) => {
    fetched.push(url.toString());
    return new Response(null, {
      status: 302,
      headers: { location: 'http://private.example/secret' },
    });
  };

  await assert.rejects(fetchText('https://public.example/start', { fetch, lookup }), {
    code: 'OUTBOUND_ADDRESS_BLOCKED',
  });
  assert.deepEqual(fetched, ['https://public.example/start']);
});

test('fetchText revalidates the address selected by the real socket lookup', async (t) => {
  let requestCount = 0;
  let lookupCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.end('must not be reached');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const lookup = async () => {
    lookupCount += 1;
    return [{
      address: lookupCount === 1 ? PUBLIC_IP : '127.0.0.1',
      family: 4,
    }];
  };

  await assert.rejects(
    fetchText(`http://rebind.example:${server.address().port}/secret`, {
      lookup,
      timeoutMs: 2_000,
    }),
    { code: 'OUTBOUND_ADDRESS_BLOCKED' }
  );
  assert.equal(lookupCount, 2);
  assert.equal(requestCount, 0);
});

test('fetchText strips credentials on a cross-origin redirect', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({
      url: url.toString(),
      authorization: init.headers.get('authorization'),
      cookie: init.headers.get('cookie'),
    });
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/final' },
      });
    }
    return new Response('done', { status: 200 });
  };

  const text = await fetchText('https://first.example/start', {
    fetch,
    lookup: publicLookup,
    headers: {
      authorization: 'Bearer sentinel',
      cookie: 'session=sentinel',
    },
  });

  assert.equal(text, 'done');
  assert.deepEqual(requests, [
    { url: 'https://first.example/start', authorization: 'Bearer sentinel', cookie: 'session=sentinel' },
    { url: 'https://other.example/final', authorization: null, cookie: null },
  ]);
});

test('fetchText enforces declared and streamed response byte limits', async () => {
  await assert.rejects(
    fetchText('https://example.com/declared', {
      fetch: async () => new Response('small', {
        status: 200,
        headers: { 'content-length': '100' },
      }),
      lookup: publicLookup,
      maxBytes: 10,
    }),
    { code: 'OUTBOUND_RESPONSE_TOO_LARGE' }
  );

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('1234'));
      controller.enqueue(new TextEncoder().encode('5678'));
      controller.close();
    },
  });
  await assert.rejects(
    fetchText('https://example.com/streamed', {
      fetch: async () => new Response(body, { status: 200 }),
      lookup: publicLookup,
      maxBytes: 7,
    }),
    { code: 'OUTBOUND_RESPONSE_TOO_LARGE' }
  );
});

test('fetchText applies a total timeout', async () => {
  const fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await assert.rejects(
    fetchText('https://example.com/slow', {
      fetch,
      lookup: publicLookup,
      timeoutMs: 20,
    }),
    { code: 'OUTBOUND_TIMEOUT' }
  );

  await assert.rejects(
    fetchText('https://lookup-never-finishes.example/', {
      lookup: () => new Promise(() => {}),
      timeoutMs: 20,
    }),
    { code: 'OUTBOUND_TIMEOUT' }
  );
});

test('fetchText returns bounded successful text and rejects HTTP failures', async () => {
  assert.equal(
    await fetchText('https://example.com/ok', {
      fetch: async () => new Response('hello', { status: 200 }),
      lookup: publicLookup,
      maxBytes: 5,
    }),
    'hello'
  );

  await assert.rejects(
    fetchText('https://example.com/not-found', {
      fetch: async () => new Response('not found', { status: 404 }),
      lookup: publicLookup,
    }),
    { code: 'OUTBOUND_HTTP_STATUS' }
  );
});
