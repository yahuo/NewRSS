const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('../src/db');
const TranslationService = require('../src/translation-service');
const { buildHtmlTranslationPlan } = require('../src/html-chunker');

test('codex-oauth provider uses the configured auth file and Responses API', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-codex-'));
  const authFile = path.join(temporaryDirectory, 'auth.json');
  const accessToken = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
  });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
      },
    })
  );

  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return textResponse([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"测试"}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"测试标题"}',
      '',
    ].join('\n'));
  };

  try {
    const service = new TranslationService({
      translationProvider: 'codex-oauth',
      codexAuthFile: authFile,
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      codexModel: 'openai-codex/gpt-5.5',
      codexTimeoutMs: 5000,
      translateTargetLanguage: 'Simplified Chinese',
    });

    assert.equal(service.isEnabled(), true);
    assert.equal(await service.translateTitle({ title: 'Test title', sourceUrl: 'https://example.com' }), '测试标题');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(calls[0].options.headers.authorization, `Bearer ${accessToken}`);
    assert.equal(calls[0].options.headers.originator, 'codex_cli_rs');
    assert.equal(calls[0].options.headers['ChatGPT-Account-ID'], 'acct_test');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'gpt-5.5');
    assert.match(body.instructions, /translation engine/);
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.match(body.input[0].content[0].text, /Test title/);
    assert.equal(body.stream, true);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('codex-oauth provider refreshes expiring access token and persists rotated tokens', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-codex-refresh-'));
  const authFile = path.join(temporaryDirectory, 'auth.json');
  const expiredAccessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
  const refreshedAccessToken = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_refreshed' },
  });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      tokens: {
        access_token: expiredAccessToken,
        refresh_token: 'old-refresh-token',
      },
      preserved: true,
    })
  );

  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://auth.openai.com/oauth/token') {
      assert.equal(String(options.body), 'grant_type=refresh_token&refresh_token=old-refresh-token&client_id=app_EMoamEEZ73f0CkXaXp7hrann');
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: 'new-refresh-token',
      });
    }

    return textResponse('event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"刷新后标题"}\n\n');
  };

  try {
    const service = new TranslationService({
      translationProvider: 'codex-oauth',
      codexAuthFile: authFile,
      codexModel: 'openai-codex/gpt-5.5',
      codexTimeoutMs: 5000,
      translateTargetLanguage: 'Simplified Chinese',
    });

    assert.equal(await service.translateTitle({ title: 'Refresh me', sourceUrl: '' }), '刷新后标题');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.authorization, `Bearer ${refreshedAccessToken}`);

    const persisted = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.equal(persisted.tokens.access_token, refreshedAccessToken);
    assert.equal(persisted.tokens.refresh_token, 'new-refresh-token');
    assert.equal(persisted.preserved, true);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('concurrent codex requests share one expiring-token refresh', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-codex-refresh-race-'));
  const authFile = path.join(temporaryDirectory, 'auth.json');
  const expiredAccessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
  const refreshedAccessToken = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_refreshed' },
  });
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: {
      access_token: expiredAccessToken,
      refresh_token: 'old-refresh-token',
    },
  }));

  let notifyRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => {
    notifyRefreshStarted = resolve;
  });
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshCalls = 0;
  let responseCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshCalls += 1;
      notifyRefreshStarted();
      await refreshGate;
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: 'new-refresh-token',
      });
    }

    responseCalls += 1;
    return textResponse('event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"并发标题"}\n\n');
  };

  try {
    const service = new TranslationService({
      translationProvider: 'codex-oauth',
      codexAuthFile: authFile,
      codexModel: 'openai-codex/gpt-5.5',
      codexTimeoutMs: 5000,
      translateTargetLanguage: 'Simplified Chinese',
    });

    const first = service.translateTitle({ title: 'First', sourceUrl: '' });
    await refreshStarted;
    const second = service.translateTitle({ title: 'Second', sourceUrl: '' });
    await new Promise((resolve) => setImmediate(resolve));
    releaseRefresh();

    assert.deepEqual(await Promise.all([first, second]), ['并发标题', '并发标题']);
    assert.equal(refreshCalls, 1);
    assert.equal(responseCalls, 2);
    const persisted = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.equal(persisted.tokens.access_token, refreshedAccessToken);
    assert.equal(persisted.tokens.refresh_token, 'new-refresh-token');
  } finally {
    releaseRefresh();
    global.fetch = previousFetch;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('codex-oauth JSON translation accepts fenced or prefixed JSON output', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-codex-json-'));
  const authFile = path.join(temporaryDirectory, 'auth.json');
  const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
      },
    })
  );

  const previousFetch = global.fetch;
  global.fetch = async () =>
    textResponse([
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"Here is the JSON:\\n```json\\n{\\\"translatedTitle\\\":\\\"中文标题\\\",\\\"translatedContentHtml\\\":\\\"<p>中文正文</p>\\\"}\\n```"}',
      '',
    ].join('\n'));

  try {
    const service = new TranslationService({
      translationProvider: 'codex-oauth',
      codexAuthFile: authFile,
      codexModel: 'openai-codex/gpt-5.5',
      codexTimeoutMs: 5000,
      geminiChunkMaxWords: 2000,
      translateTargetLanguage: 'Simplified Chinese',
    });

    const translated = await service.translateArticle({
      sourceTitle: 'English article title',
      contentHtml: '<p>This is a long enough English article body for the translation detector and direct JSON path.</p>',
      sourceUrl: 'https://example.com/article',
    });

    assert.equal(translated.translatedTitle, '中文标题');
    assert.equal(translated.translatedContentHtml, '<p>中文正文</p>');
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('codex-oauth provider is disabled when the auth file is missing', () => {
  const service = new TranslationService({
    translationProvider: 'codex-oauth',
    codexAuthFile: path.join(os.tmpdir(), `missing-newrss-codex-${Date.now()}.json`),
  });

  assert.equal(service.isEnabled(), false);
});

test('codex usage-limit opens a persistent circuit and blocks later requests', async (t) => {
  const fixture = createCodexFixture(t);
  let fetchCount = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    fetchCount += 1;
    return textResponse(JSON.stringify({ detail: 'The usage limit has been reached' }), 429);
  };
  t.after(() => { global.fetch = previousFetch; });

  const service = new TranslationService(fixture.config, { db: fixture.db });
  let usageError;
  await assert.rejects(
    service.translateTitle({ title: 'First title', sourceUrl: '' }),
    (error) => {
      usageError = error;
      return /usage limit/.test(error.message);
    }
  );
  await assert.rejects(service.translateTitle({ title: 'Second title', sourceUrl: '' }), /circuit is open/);

  assert.equal(fetchCount, 1);
  assert.equal(usageError.code, 'CODEX_USAGE_LIMIT');
  const circuit = fixture.db.getTranslationCircuit('codex-oauth');
  assert.equal(circuit.state, 'open');
  assert.equal(circuit.failure_count, 1);
  assert.ok(new Date(circuit.next_probe_at) > new Date(circuit.opened_at));
  const usage = fixture.db.getTranslationUsageSummary('codex-oauth');
  assert.equal(usage.totals.request_count, 1);
  assert.equal(usage.recent[0].status, 'error');
  assert.equal(usage.recent[0].input_tokens, null);
});

test('codex probe uses escalating intervals and a successful probe closes the circuit', async (t) => {
  const fixture = createCodexFixture(t);
  const service = new TranslationService(fixture.config, { db: fixture.db });
  const previousFetch = global.fetch;
  let fail = true;
  let successfulProbeBody = null;
  global.fetch = async (url, options) => {
    if (fail) {
      return textResponse(JSON.stringify({ detail: 'The usage limit has been reached' }), 429);
    }
    successfulProbeBody = JSON.parse(options.body);
    return textResponse('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n');
  };
  t.after(() => { global.fetch = previousFetch; });

  await assert.rejects(service.translateTitle({ title: 'Open circuit', sourceUrl: '' }), /usage limit/);
  let circuit = fixture.db.getTranslationCircuit('codex-oauth');
  const firstDelayMinutes = (new Date(circuit.next_probe_at) - new Date(circuit.updated_at)) / 60_000;
  assert.ok(firstDelayMinutes >= 14.9 && firstDelayMinutes <= 15.1);

  fixture.db.db.prepare(`UPDATE translation_circuits SET next_probe_at = ? WHERE provider = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    'codex-oauth'
  );
  const failedProbe = await service.probeCodex();
  assert.equal(failedProbe.ok, false);
  circuit = fixture.db.getTranslationCircuit('codex-oauth');
  const secondDelayMinutes = (new Date(circuit.next_probe_at) - new Date(circuit.updated_at)) / 60_000;
  assert.ok(secondDelayMinutes >= 29.9 && secondDelayMinutes <= 30.1);

  fixture.db.db.prepare(`UPDATE translation_circuits SET next_probe_at = ? WHERE provider = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    'codex-oauth'
  );
  fail = false;
  const successfulProbe = await service.probeCodex();
  assert.equal(successfulProbe.ok, true);
  assert.equal(fixture.db.getTranslationCircuit('codex-oauth').state, 'closed');
  assert.equal(successfulProbeBody.input[0].content[0].text, 'Reply OK.');
  assert.equal(Object.hasOwn(successfulProbeBody, 'max_output_tokens'), false);
});

test('codex streaming completion usage is persisted and missing usage stays null', async (t) => {
  const fixture = createCodexFixture(t);
  const responses = [
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"标题一"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"标题二"}\n\n',
  ];
  const previousFetch = global.fetch;
  global.fetch = async () => textResponse(responses.shift());
  t.after(() => { global.fetch = previousFetch; });

  const service = new TranslationService(fixture.config, { db: fixture.db });
  await service.translateTitle({ title: 'One', sourceUrl: '' });
  await service.translateTitle({ title: 'Two', sourceUrl: '' });
  const recent = fixture.db.getTranslationUsageSummary('codex-oauth').recent;
  assert.equal(recent[1].input_tokens, 12);
  assert.equal(recent[1].output_tokens, 3);
  assert.equal(recent[1].total_tokens, 15);
  assert.equal(recent[0].input_tokens, null);
  assert.equal(recent[0].total_tokens, null);
});

test('codex chunk translation is serial and stops after the first failed chunk', async (t) => {
  const fixture = createCodexFixture(t, { geminiChunkMaxWords: 5, geminiChunkConcurrency: 3 });
  let fetchCount = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    fetchCount += 1;
    return textResponse(JSON.stringify({ error: { message: 'temporary failure' } }), 500);
  };
  t.after(() => { global.fetch = previousFetch; });

  const service = new TranslationService(fixture.config, { db: fixture.db });
  await assert.rejects(service.translateArticle({
    sourceTitle: 'A long English title for testing',
    contentHtml: Array.from({ length: 8 }, (_, index) => `<p>Paragraph ${index} contains enough English words to require another chunk.</p>`).join(''),
    sourceUrl: 'https://example.com/chunked',
  }), /temporary failure/);
  assert.equal(fetchCount, 1);
});

test('manual probe from closed does not block translations and a transient failure restores closed', async (t) => {
  const fixture = createCodexFixture(t);
  let releaseFetch;
  const previousFetch = global.fetch;
  global.fetch = () => new Promise((resolve) => { releaseFetch = resolve; });
  t.after(() => { global.fetch = previousFetch; });
  const service = new TranslationService(fixture.config, { db: fixture.db });

  const probe = service.probeCodex({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.db.getTranslationCircuit('codex-oauth').state, 'closed');
  releaseFetch(textResponse(JSON.stringify({ error: { message: 'temporary network failure' } }), 500));
  const result = await probe;
  assert.equal(result.ok, false);
  assert.equal(fixture.db.getTranslationCircuit('codex-oauth').state, 'closed');
});

test('interrupted half-open probe is recoverable immediately after database restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-codex-restart-'));
  const dbPath = path.join(directory, 'newrss.db');
  let db = new Database(dbPath);
  db.openTranslationCircuit('codex-oauth', 'usage limit', new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
  const claim = db.claimTranslationProbe('codex-oauth', new Date().toISOString());
  assert.equal(claim.claimed, true);
  assert.equal(db.getTranslationCircuit('codex-oauth').state, 'half-open');
  db.db.close();

  db = new Database(dbPath);
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const recovered = db.getTranslationCircuit('codex-oauth');
  assert.equal(recovered.state, 'open');
  assert.ok(recovered.next_probe_at <= new Date().toISOString());
});

test('concurrent manual probe reports that no probe was started', async (t) => {
  const fixture = createCodexFixture(t);
  fixture.db.openTranslationCircuit(
    'codex-oauth', 'usage limit', new Date().toISOString(), new Date(Date.now() - 1000).toISOString()
  );
  const firstClaim = fixture.db.claimTranslationProbe('codex-oauth', new Date().toISOString(), true);
  assert.equal(firstClaim.claimed, true);
  const service = new TranslationService(fixture.config, { db: fixture.db });
  const result = await service.probeCodex({ force: true });
  assert.equal(result.probed, false);
  assert.equal(result.ok, false);
});

test('probe claim is released when circuit state persistence fails', async (t) => {
  const fixture = createCodexFixture(t);
  const previousFetch = global.fetch;
  global.fetch = async () => textResponse('event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"OK"}\n\n');
  t.after(() => { global.fetch = previousFetch; });
  fixture.db.closeTranslationCircuit = () => { throw new Error('state write failed'); };
  const service = new TranslationService(fixture.config, { db: fixture.db });

  await assert.rejects(service.probeCodex({ force: true }), /state write failed/);
  assert.equal(fixture.db.getTranslationCircuit('codex-oauth').probe_in_progress, 0);
});

test('HTML translation plan splits a very large leaf element without dropping its wrapper', () => {
  const words = Array.from({ length: 5_000 }, (_, index) => `word${index}`).join(' ');
  const plan = buildHtmlTranslationPlan(`<p class="article-copy">${words}</p>`, { maxWords: 200 });

  assert.equal(plan.chunks.length, 25);
  for (const chunk of plan.chunks) {
    assert.match(chunk, /^<p class="article-copy">/);
    assert.match(chunk, /<\/p>$/);
    const count = chunk.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length;
    assert.ok(count <= 200, `expected at most 200 words, received ${count}`);
  }
});

test('HTML translation plan preserves whitespace inside large preformatted blocks', () => {
  const code = Array.from(
    { length: 120 },
    (_, index) => `  const value${index} = call(\n    argument${index},\n    option${index}\n  );`
  ).join('\n');
  const plan = buildHtmlTranslationPlan(`<pre><code>${code}</code></pre>`, { maxWords: 200 });

  assert.equal(plan.chunks.length, 1);
  assert.match(plan.chunks[0], /<pre><code>  const value0 = call\(\n    argument0,/);
  assert.match(plan.chunks[0], /\n    option119\n  \);<\/code><\/pre>$/);
});

test('Gemini chunk workers stop taking new work after the first failure', async (t) => {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'first chunk failed' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '<p>translated</p>' }] } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = previousFetch; });

  const service = new TranslationService({
    translationProvider: 'gemini',
    geminiApiKey: 'test-key',
    geminiModel: 'test-model',
    geminiTimeoutMs: 5_000,
    geminiChunkMaxWords: 200,
    geminiChunkConcurrency: 3,
    translateTargetLanguage: 'Simplified Chinese',
  });
  const paragraph = Array.from({ length: 210 }, (_, index) => `word${index}`).join(' ');
  const html = Array.from({ length: 8 }, () => `<p>${paragraph}</p>`).join('');

  await assert.rejects(
    service.translateArticle({ sourceTitle: 'English title', contentHtml: html, sourceUrl: 'https://example.com' }),
    /first chunk failed/
  );
  assert.equal(calls, 3);
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

function fakeJwt(payload) {
  return ['header', base64Url(JSON.stringify(payload)), 'signature'].join('.');
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createCodexFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-codex-state-'));
  const authFile = path.join(directory, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: {
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'refresh-token',
    },
  }));
  const db = new Database(path.join(directory, 'newrss.db'));
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    config: {
      translationProvider: 'codex-oauth',
      codexAuthFile: authFile,
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      codexModel: 'openai-codex/gpt-5.5',
      codexTimeoutMs: 5000,
      geminiChunkMaxWords: 2000,
      geminiChunkConcurrency: 3,
      translateTargetLanguage: 'Simplified Chinese',
      ...overrides,
    },
  };
}
