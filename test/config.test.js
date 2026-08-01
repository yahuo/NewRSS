const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

test('numeric configuration rejects partial and out-of-range values', () => {
  for (const [name, value] of [
    ['MAX_ITEMS_PER_FEED', '-1'],
    ['MAX_ITEMS_PER_REFRESH', '10items'],
    ['GEMINI_CHUNK_MAX_WORDS', '0'],
    ['DEEPSEEK_TIMEOUT_MS', '999999'],
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

test('DeepSeek API configuration uses the official defaults', () => {
  const env = { ...process.env };
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_TIMEOUT_MS']) {
    delete env[name];
  }
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const config=require('./src/config');process.stdout.write(JSON.stringify({apiKey:config.deepseekApiKey,model:config.deepseekModel,baseUrl:config.deepseekBaseUrl,timeoutMs:config.deepseekTimeoutMs}))",
    ],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    apiKey: '',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    timeoutMs: 90_000,
  });
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
