const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

test('numeric configuration rejects partial and out-of-range values', () => {
  for (const [name, value] of [
    ['MAX_ITEMS_PER_FEED', '-1'],
    ['MAX_ITEMS_PER_REFRESH', '10items'],
    ['TRANSLATION_CHUNK_MAX_WORDS', '0'],
    ['OPENAI_TIMEOUT_MS', '999999'],
    ['ANTHROPIC_MAX_TOKENS', '0'],
    ['TRANSLATION_REQUEST_CONCURRENCY', '0'],
    ['RSS_CACHE_MAX_BYTES', '1024'],
    ['REFRESH_INTERVAL_MINUTES', '999999'],
  ]) {
    const result = spawnSync(process.execPath, ['-e', "require('./src/config')"], {
      cwd: projectRoot,
      env: { ...process.env, [name]: value },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, `${name}=${value} should fail`);
    assert.match(result.stderr, new RegExp(name));
  }
});

test('translation API configuration uses provider defaults', () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(TRANSLATION_|READ_LATER_TRANSLATION_|OPENAI_|ANTHROPIC_|GEMINI_|CODEX_TIMEOUT_MS$)/.test(name)) {
      delete env[name];
    }
  }
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const c=require('./src/config');process.stdout.write(JSON.stringify({provider:c.translationProvider,readLaterProvider:c.readLaterTranslationProvider,readLaterModel:c.readLaterTranslationModel,chunkMaxWords:c.translationChunkMaxWords,openai:[c.openaiApiKey,c.openaiBaseUrl,c.openaiModel,c.openaiTimeoutMs,c.openaiExtraBody],anthropic:[c.anthropicApiKey,c.anthropicBaseUrl,c.anthropicModel,c.anthropicMaxTokens,c.anthropicTimeoutMs,c.anthropicExtraBody],codexTimeoutMs:c.codexTimeoutMs}))",
    ],
    { cwd: projectRoot, env, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    provider: 'openai',
    readLaterProvider: '',
    readLaterModel: '',
    chunkMaxWords: 1200,
    openai: ['', 'https://api.openai.com/v1', '', 90_000, null],
    anthropic: ['', 'https://api.anthropic.com', 'claude-opus-5-5', 16_000, 90_000, null],
    codexTimeoutMs: 90_000,
  });
});

test('translation configuration parses extra body JSON and legacy chunk size', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const c=require('./src/config');process.stdout.write(JSON.stringify({provider:c.translationProvider,extra:c.openaiExtraBody,chunk:c.translationChunkMaxWords,baseUrl:c.openaiBaseUrl}))",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        TRANSLATION_PROVIDER: ' Anthropic ',
        OPENAI_EXTRA_BODY: '{"thinking":{"type":"disabled"},"max_tokens":384000}',
        OPENAI_BASE_URL: 'http://host.docker.internal:8317/v1/',
        TRANSLATION_CHUNK_MAX_WORDS: '',
        GEMINI_CHUNK_MAX_WORDS: '2000',
      },
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    provider: 'anthropic',
    extra: { thinking: { type: 'disabled' }, max_tokens: 384_000 },
    chunk: 2000,
    baseUrl: 'http://host.docker.internal:8317/v1',
  });
});

test('translation configuration rejects removed providers and invalid extra body', () => {
  for (const [name, value, pattern] of [
    ['TRANSLATION_PROVIDER', 'gemini', /TRANSLATION_PROVIDER must be one of openai, anthropic, codex-oauth/],
    ['TRANSLATION_PROVIDER', 'deepseek', /OpenAI-compatible base URL/],
    ['READ_LATER_TRANSLATION_PROVIDER', 'gemini', /READ_LATER_TRANSLATION_PROVIDER must be one of/],
    ['OPENAI_EXTRA_BODY', '[1]', /OPENAI_EXTRA_BODY must be a JSON object/],
    ['ANTHROPIC_EXTRA_BODY', '{bad', /ANTHROPIC_EXTRA_BODY must be a JSON object/],
    ['ANTHROPIC_BASE_URL', 'ftp://example.com', /ANTHROPIC_BASE_URL must be an HTTP\(S\) URL/],
  ]) {
    const result = spawnSync(process.execPath, ['-e', "require('./src/config')"], {
      cwd: projectRoot,
      env: { ...process.env, [name]: value },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, `${name}=${value} should fail`);
    assert.match(result.stderr, pattern);
  }
});

test('translation request concurrency defaults to six and accepts an explicit bound', () => {
  for (const [value, expected] of [
    [undefined, '6'],
    ['4', '4'],
  ]) {
    const env = { ...process.env };
    if (value == null) {
      delete env.TRANSLATION_REQUEST_CONCURRENCY;
    } else {
      env.TRANSLATION_REQUEST_CONCURRENCY = value;
    }
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./src/config').translationRequestConcurrency))"],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test('refresh interval explicitly accepts zero as the disabled value', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./src/config').refreshIntervalMinutes))"],
    {
      cwd: projectRoot,
      env: { ...process.env, REFRESH_INTERVAL_MINUTES: '0' },
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '0');
});

test('fake-IP compatibility is opt-in and only exact true enables it', () => {
  for (const [value, expected] of [
    ['true', 'true'],
    ['false', 'false'],
    ['1', 'false'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./src/config').outboundAllowFakeIp))"],
      {
        cwd: projectRoot,
        env: { ...process.env, OUTBOUND_ALLOW_FAKE_IP: value },
        encoding: 'utf8',
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test('News Sitemap filters normalize comma-separated languages and sections', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "const c=require('./src/config'); process.stdout.write(JSON.stringify([c.newsSitemapLanguages,c.newsSitemapSections]))"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NEWS_SITEMAP_LANGUAGES: ' EN, pt ',
        NEWS_SITEMAP_SECTIONS: ' world, BUSINESS, technology, markets ',
      },
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    ['en', 'pt'],
    ['world', 'business', 'technology', 'markets'],
  ]);

  const defaultEnv = { ...process.env };
  delete defaultEnv.NEWS_SITEMAP_LANGUAGES;
  delete defaultEnv.NEWS_SITEMAP_SECTIONS;
  const defaults = spawnSync(
    process.execPath,
    ['-e', "const c=require('./src/config'); process.stdout.write(JSON.stringify([c.newsSitemapLanguages,c.newsSitemapSections]))"],
    { cwd: projectRoot, env: defaultEnv, encoding: 'utf8' }
  );

  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), [[], []]);
});
