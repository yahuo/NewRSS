const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TranslationService = require('../src/translation-service');

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
