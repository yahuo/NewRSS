const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { scheduleRefreshes } = require('../src/refresh-scheduler');

test('scheduler uses the non-overlapping refresh entry point', async () => {
  const callbacks = [];
  let refreshCalls = 0;
  let probeCalls = 0;
  const feedService = {
    async tryRefreshAllFeeds() {
      refreshCalls += 1;
      return { skipped: true, reason: 'refresh already running: feed:test' };
    },
    isCodexProvider() {
      return true;
    },
    getCodexStatus() {
      throw new Error('scheduler must not read the usage summary');
    },
    async probeCodex() {
      probeCalls += 1;
      return { probed: false, ok: false };
    },
  };

  scheduleRefreshes({
    feedService,
    parser: {},
    config: { refreshOnBoot: false, refreshIntervalMinutes: 30 },
    setIntervalFn(callback, delay) {
      callbacks.push({ callback, delay });
      return callbacks.length;
    },
  });

  const refreshTimer = callbacks.find(({ delay }) => delay === 30 * 60 * 1000);
  assert.ok(refreshTimer);
  await refreshTimer.callback();
  const probeTimer = callbacks.find(({ delay }) => delay === 60 * 1000);
  assert.ok(probeTimer);
  await probeTimer.callback();
  assert.equal(refreshCalls, 1);
  assert.equal(probeCalls, 2);
});

test('MAX_ITEMS_PER_REFRESH defaults to 10', () => {
  const value = execFileSync(process.execPath, ['-e', `
    delete process.env.MAX_ITEMS_PER_REFRESH;
    process.stdout.write(String(require('./src/config').maxItemsPerRefresh));
  `], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(value, '10');
});
