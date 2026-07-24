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

test('scheduler probes Codex when only Read Later uses that provider', async () => {
  const callbacks = [];
  let readLaterProbes = 0;
  scheduleRefreshes({
    feedService: {
      isCodexProvider: () => false,
      tryRefreshAllFeeds: async () => [],
    },
    readLaterService: {
      isCodexProvider: () => true,
      async probeCodex() {
        readLaterProbes += 1;
      },
    },
    parser: {},
    config: { refreshOnBoot: false, refreshIntervalMinutes: 0 },
    setIntervalFn(callback, delay) {
      callbacks.push({ callback, delay });
      return callbacks.length;
    },
  });

  await callbacks.find(({ delay }) => delay === 60_000).callback();
  assert.equal(readLaterProbes, 2);
});

test('successful scheduled feed refresh also retries due read-later translations', async () => {
  const callbacks = [];
  let retries = 0;
  scheduleRefreshes({
    feedService: {
      isCodexProvider: () => false,
      tryRefreshAllFeeds: async () => [],
    },
    readLaterService: {
      isCodexProvider: () => false,
      async retryDueTranslations() {
        retries += 1;
      },
    },
    parser: {},
    config: { refreshOnBoot: false, refreshIntervalMinutes: 30 },
    setIntervalFn(callback, delay) {
      callbacks.push({ callback, delay });
      return callbacks.length;
    },
  });

  await callbacks.find(({ delay }) => delay === 30 * 60 * 1000).callback();
  assert.equal(retries, 1);
});

test('scheduler shutdown clears timers and waits for active background work', async () => {
  const timers = [];
  const cleared = [];
  let finishRefresh;
  const scheduler = scheduleRefreshes({
    feedService: {
      isCodexProvider: () => false,
      tryRefreshAllFeeds() {
        return new Promise((resolve) => {
          finishRefresh = resolve;
        });
      },
    },
    parser: {},
    config: { refreshOnBoot: false, refreshIntervalMinutes: 30 },
    setIntervalFn(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      cleared.push(timer);
    },
  });
  const refreshTimer = timers.find(({ delay }) => delay === 30 * 60 * 1000);
  const activeRefresh = refreshTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(cleared.length, timers.length);

  finishRefresh([]);
  await activeRefresh;
  await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(await scheduler.runRefresh(), { skipped: true, reason: 'scheduler is stopping' });
});
