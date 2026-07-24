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
