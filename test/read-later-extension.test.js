const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const extensionDirectory = path.join(__dirname, '..', 'extensions', 'read-later-chrome');
const helpersPromise = import(pathToFileURL(path.join(extensionDirectory, 'helpers.mjs')).href);

test('URL and endpoint helpers enforce the extension contract', async () => {
  const {
    DEFAULT_NEWRSS_BASE_URL,
    buildJobEndpoint,
    buildJobsEndpoint,
    buildOriginPattern,
    buildSavePayload,
    createIdempotencyKey,
    isSupportedPageUrl,
    normalizeBaseUrl,
  } = await helpersPromise;

  assert.equal(DEFAULT_NEWRSS_BASE_URL, 'http://newrss.local:8787');
  assert.equal(normalizeBaseUrl(' https://rss.example.test:9443/admin?x=1 '), 'https://rss.example.test:9443');
  assert.equal(buildJobsEndpoint('https://rss.example.test:9443/'), 'https://rss.example.test:9443/api/read-later/jobs');
  assert.equal(buildJobEndpoint('https://rss.example.test:9443', 'job/a'), 'https://rss.example.test:9443/api/read-later/jobs/job%2Fa');
  assert.equal(buildOriginPattern('https://rss.example.test:9443/admin'), 'https://rss.example.test:9443/*');
  assert.throws(() => normalizeBaseUrl('file:///tmp/newrss'), /HTTP/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.test'), /账号信息/);

  assert.equal(isSupportedPageUrl('https://example.com/article'), true);
  assert.equal(isSupportedPageUrl('http://example.com/article'), true);
  assert.equal(isSupportedPageUrl('chrome://extensions'), false);
  assert.equal(isSupportedPageUrl('about:blank'), false);
  assert.equal(isSupportedPageUrl('not-a-url'), false);

  assert.deepEqual(
    buildSavePayload({
      url: 'https://example.com/story#comments',
      title: 'Ignored tab title',
    }),
    {
      url: 'https://example.com/story',
      mode: 'auto',
      translate: true,
    }
  );
  assert.notEqual(createIdempotencyKey(), createIdempotencyKey());
});

test('job response and article URL helpers reject invalid server data', async () => {
  const {
    parseJobStatus,
    parseJobSubmission,
    validateArticleUrl,
  } = await helpersPromise;

  assert.deepEqual(parseJobSubmission(202, { jobId: 'job-1', status: 'queued' }), {
    jobId: 'job-1',
    status: 'queued',
    result: null,
    error: '',
  });
  assert.deepEqual(parseJobSubmission(202, { jobId: 'job-existing', status: 'done' }), {
    jobId: 'job-existing',
    status: 'done',
    result: null,
    error: '',
  });
  assert.deepEqual(
    parseJobStatus(200, {
      jobId: 'job-1',
      status: 'done',
      result: { title: 'Saved' },
    }),
    {
      jobId: 'job-1',
      status: 'done',
      result: { title: 'Saved' },
      error: '',
    }
  );
  assert.throws(() => parseJobSubmission(200, { jobId: 'job-1', status: 'queued' }), /异常状态码 200/);
  assert.throws(() => parseJobStatus(200, { jobId: '', status: 'running' }), /无效的任务状态/);
  assert.throws(() => parseJobStatus(200, { jobId: 'job-1', status: 'done' }), /没有返回保存结果/);

  assert.equal(
    validateArticleUrl('http://newrss.local:8787/articles/42', 'http://newrss.local:8787'),
    'http://newrss.local:8787/articles/42'
  );
  assert.equal(validateArticleUrl('http://evil.test/articles/42', 'http://newrss.local:8787'), '');
  assert.equal(validateArticleUrl('http://user:pass@newrss.local:8787/articles/42', 'http://newrss.local:8787'), '');
  assert.equal(validateArticleUrl('http://newrss.local:8787/admin', 'http://newrss.local:8787'), '');
  assert.equal(validateArticleUrl('javascript:alert(1)', 'http://newrss.local:8787'), '');
});

test('notification and error helpers keep readable messages', async () => {
  const {
    buildSaveSuccessNotification,
    humanizeSaveError,
    unsupportedUrlMessage,
  } = await helpersPromise;

  assert.deepEqual(
    buildSaveSuccessNotification({ title: 'Fresh item', existed: false }),
    { title: 'Read Later 已保存', message: 'Fresh item' }
  );
  assert.deepEqual(
    buildSaveSuccessNotification({ title: 'Existing item', existed: true }),
    { title: 'Read Later 已更新', message: 'Existing item' }
  );
  assert.equal(unsupportedUrlMessage(''), '当前标签页没有可保存的网页地址。');
  assert.equal(unsupportedUrlMessage('chrome://extensions'), '当前页面不支持保存：chrome://extensions');
  assert.equal(
    humanizeSaveError({ name: 'AbortError', message: 'aborted' }),
    '请求 NewRSS 超时，请稍后重试。'
  );
  assert.equal(
    humanizeSaveError(new Error('NETWORK_ERROR:unreachable'), 'https://rss.example.test'),
    '无法连接到 NewRSS 服务，请检查 https://rss.example.test 是否可达。'
  );
  assert.equal(
    humanizeSaveError(new Error('API_ERROR:mode must be one of: auto, x-direct, readability')),
    'mode must be one of: auto, x-direct, readability'
  );
});

test('manifest exposes a minimal options page and optional configurable origins', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDirectory, 'manifest.json'), 'utf8'));

  assert.equal(manifest.version, '1.1.0');
  assert.ok(manifest.permissions.includes('alarms'));
  assert.deepEqual(manifest.host_permissions, ['http://newrss.local:8787/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true });
  assert.equal(fs.existsSync(path.join(extensionDirectory, 'options.html')), true);
  assert.equal(fs.existsSync(path.join(extensionDirectory, 'options.mjs')), true);
});

test('options page normalizes and persists a user-approved base URL', async () => {
  const html = fs.readFileSync(path.join(extensionDirectory, 'options.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://extension.test/options.html' });
  const store = {};
  const requestedOrigins = [];
  const chromeMock = {
    runtime: {
      get lastError() {
        return null;
      },
    },
    permissions: {
      contains(permission, callback) {
        callback(false);
      },
      request(permission, callback) {
        requestedOrigins.push(...permission.origins);
        callback(true);
      },
    },
    storage: {
      local: {
        get(key, callback) {
          callback(key in store ? { [key]: store[key] } : {});
        },
        set(data, callback) {
          Object.assign(store, data);
          callback();
        },
      },
    },
  };
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  global.chrome = chromeMock;
  global.document = dom.window.document;

  try {
    const optionsUrl = pathToFileURL(path.join(extensionDirectory, 'options.mjs'));
    optionsUrl.searchParams.set('test', `${Date.now()}-${Math.random()}`);
    await import(optionsUrl.href);
    await waitFor(() => dom.window.document.getElementById('base-url').value === 'http://newrss.local:8787');

    const input = dom.window.document.getElementById('base-url');
    input.value = 'https://rss.example.test:9443/admin?ignored=1';
    dom.window.document.getElementById('options-form').dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => dom.window.document.getElementById('status').textContent === '已保存');

    assert.equal(store.newrssBaseUrl, 'https://rss.example.test:9443');
    assert.deepEqual(requestedOrigins, ['https://rss.example.test:9443/*']);
    assert.equal(input.value, 'https://rss.example.test:9443');
  } finally {
    global.chrome = originalChrome;
    global.document = originalDocument;
  }
});

test('background job flow', async (t) => {
  await t.test('submits a hash-free URL, completes the job, and opens only the saved article', async () => {
    const fixture = await loadBackgroundFixture({
      responses: [
        { status: 202, data: { jobId: 'job-1', status: 'queued' } },
        {
          status: 200,
          data: {
            jobId: 'job-1',
            status: 'done',
            result: {
              title: 'Saved story',
              articleUrl: 'http://newrss.local:8787/articles/42',
              existed: false,
            },
          },
        },
      ],
    });

    try {
      fixture.listeners.actionClicked({ id: 7, url: 'https://example.com/story#comments' });
      await waitFor(() => fixture.notifications.length === 1);

      assert.equal(fixture.fetchCalls.length, 2);
      assert.equal(fixture.fetchCalls[0].url, 'http://newrss.local:8787/api/read-later/jobs');
      assert.equal(fixture.fetchCalls[1].url, 'http://newrss.local:8787/api/read-later/jobs/job-1');
      assert.deepEqual(JSON.parse(fixture.fetchCalls[0].options.body), {
        url: 'https://example.com/story',
        mode: 'auto',
        translate: true,
      });
      const idempotencyKey = fixture.fetchCalls[0].options.headers['Idempotency-Key'];
      assert.equal(typeof idempotencyKey, 'string');
      assert.ok(idempotencyKey.length >= 16);
      const pendingWrite = fixture.storageSetCalls.find((data) => data['pendingReadLaterJob:job-1']);
      assert.equal(pendingWrite['pendingReadLaterJob:job-1'].idempotencyKey, idempotencyKey);
      assert.equal(fixture.notifications[0].options.title, 'Read Later 已保存');
      assert.ok(fixture.badgeTexts.some(({ text }) => text === 'OK'));
      assert.equal(fixture.badgeTexts.some(({ text }) => text === '!'), false);
      assert.equal(fixture.store['pendingReadLaterJob:job-1'], undefined);

      const targetEntry = Object.entries(fixture.store).find(([key]) => key.startsWith('notificationTarget:'));
      assert.ok(targetEntry);
      assert.deepEqual(targetEntry[1], {
        url: 'http://newrss.local:8787/articles/42',
        baseUrl: 'http://newrss.local:8787',
      });

      fixture.listeners.notificationClicked(targetEntry[0].slice('notificationTarget:'.length));
      await waitFor(() => fixture.createdTabs.length === 1);
      assert.equal(fixture.createdTabs[0].url, 'http://newrss.local:8787/articles/42');
      assert.equal(fixture.store[targetEntry[0]], undefined);
    } finally {
      fixture.restore();
    }
  });

  await t.test('retries a lost submission response with the same idempotency key', async () => {
    const fixture = await loadBackgroundFixture({
      responses: [
        new TypeError('connection closed after submit'),
        { status: 202, data: { jobId: 'job-retry', status: 'queued' } },
        {
          status: 200,
          data: {
            jobId: 'job-retry',
            status: 'done',
            result: {
              title: 'Deduplicated story',
              articleUrl: 'http://newrss.local:8787/articles/77',
              existed: false,
            },
          },
        },
      ],
    });

    try {
      fixture.listeners.actionClicked({ id: 14, url: 'https://example.com/retry' });
      await waitFor(() => fixture.notifications.some(({ options }) => options.title === 'Read Later 已保存'));

      const submissions = fixture.fetchCalls.filter(({ options }) => options.method === 'POST');
      assert.equal(submissions.length, 2);
      assert.equal(
        submissions[0].options.headers['Idempotency-Key'],
        submissions[1].options.headers['Idempotency-Key']
      );
      assert.ok(submissions[0].options.headers['Idempotency-Key']);
    } finally {
      fixture.restore();
    }
  });

  await t.test('persists a running job, deduplicates another click, and resumes it from an alarm', async () => {
    const fixture = await loadBackgroundFixture({
      responses: [
        { status: 202, data: { jobId: 'job-2', status: 'queued' } },
        { status: 200, data: { jobId: 'job-2', status: 'running' } },
        { status: 200, data: { jobId: 'job-2', status: 'running' } },
        {
          status: 200,
          data: {
            jobId: 'job-2',
            status: 'done',
            result: {
              title: 'Recovered story',
              articleUrl: 'http://newrss.local:8787/articles/9',
              existed: false,
            },
          },
        },
      ],
    });

    try {
      fixture.listeners.actionClicked({ id: 8, url: 'https://example.com/recover#one' });
      await waitFor(() => fixture.store['pendingReadLaterJob:job-2']?.attempts === 1);
      assert.ok(fixture.alarmsCreated.some(({ name }) => name === 'readLaterJobRecovery'));

      fixture.listeners.actionClicked({ id: 8, url: 'https://example.com/recover#two' });
      await waitFor(() => fixture.store['pendingReadLaterJob:job-2']?.attempts === 2);
      assert.equal(fixture.fetchCalls.filter(({ options }) => options.method === 'POST').length, 1);

      fixture.listeners.alarm({ name: 'readLaterJobRecovery' });
      await waitFor(() => fixture.store['pendingReadLaterJob:job-2'] === undefined);
      assert.ok(fixture.notifications.some(({ options }) => options.title === 'Read Later 已保存'));
      assert.equal(fixture.fetchCalls.filter(({ options }) => !options.method).length, 3);
    } finally {
      fixture.restore();
    }
  });

  await t.test('does not turn notification target storage failure into a save failure', async () => {
    const fixture = await loadBackgroundFixture({
      responses: successfulJobResponses('job-3'),
      failStorageSet(data) {
        return Object.keys(data).some((key) => key.startsWith('notificationTarget:'));
      },
    });

    try {
      fixture.listeners.actionClicked({ id: 9, url: 'https://example.com/storage' });
      await waitFor(() => fixture.badgeTexts.some(({ text }) => text === 'OK'));

      assert.ok(fixture.notifications.some(({ options }) => options.title === 'Read Later 已保存'));
      assert.equal(fixture.notifications.some(({ options }) => options.title === '保存失败'), false);
      assert.equal(fixture.badgeTexts.some(({ text }) => text === '!'), false);
    } finally {
      fixture.restore();
    }
  });

  await t.test('does not call an accepted job failed when pending-job storage is unavailable', async () => {
    const fixture = await loadBackgroundFixture({
      responses: [
        { status: 202, data: { jobId: 'job-local-storage', status: 'queued' } },
        { status: 200, data: { jobId: 'job-local-storage', status: 'running' } },
      ],
      failStorageSet(data) {
        return Object.keys(data).some((key) => key.startsWith('pendingReadLaterJob:'));
      },
    });

    try {
      fixture.listeners.actionClicked({ id: 13, url: 'https://example.com/local-storage' });
      await waitFor(() => fixture.notifications.some(({ options }) => options.title === '保存任务已提交'));

      assert.ok(fixture.badgeTexts.some(({ text }) => text === '?'));
      assert.equal(fixture.badgeTexts.some(({ text }) => text === '!'), false);
      assert.equal(fixture.notifications.some(({ options }) => options.title === '保存失败'), false);
    } finally {
      fixture.restore();
    }
  });

  await t.test('does not turn notification creation failure into a save failure', async () => {
    const fixture = await loadBackgroundFixture({
      responses: successfulJobResponses('job-4'),
      failNotificationCreate: true,
    });

    try {
      fixture.listeners.actionClicked({ id: 10, url: 'https://example.com/notification' });
      await waitFor(() => fixture.badgeTexts.some(({ text }) => text === 'OK'));

      assert.equal(fixture.badgeTexts.some(({ text }) => text === '!'), false);
      assert.equal(fixture.notifications.length, 0);
    } finally {
      fixture.restore();
    }
  });

  await t.test('ignores cross-origin article URLs and revalidates stored notification targets', async () => {
    const fixture = await loadBackgroundFixture({
      seed: {
        'notificationTarget:unsafe': {
          url: 'http://evil.test/articles/1',
          baseUrl: 'http://newrss.local:8787',
        },
      },
      responses: [
        { status: 202, data: { jobId: 'job-5', status: 'queued' } },
        {
          status: 200,
          data: {
            jobId: 'job-5',
            status: 'done',
            result: {
              title: 'Unsafe target',
              articleUrl: 'http://evil.test/articles/5',
              existed: false,
            },
          },
        },
      ],
    });

    try {
      fixture.listeners.actionClicked({ id: 11, url: 'https://example.com/unsafe' });
      await waitFor(() => fixture.notifications.length === 1);
      assert.equal(
        Object.keys(fixture.store).filter((key) => key.startsWith('notificationTarget:')).length,
        1
      );

      fixture.listeners.notificationClicked('unsafe');
      await waitFor(() => fixture.store['notificationTarget:unsafe'] === undefined);
      assert.equal(fixture.createdTabs.length, 0);
    } finally {
      fixture.restore();
    }
  });

  await t.test('stops polling after the persisted attempt bound without claiming server failure', async () => {
    const fixture = await loadBackgroundFixture({
      seed: {
        'pendingReadLaterJob:job-limit': {
          jobId: 'job-limit',
          status: 'running',
          baseUrl: 'http://newrss.local:8787',
          sourceUrl: 'https://example.com/slow',
          tabId: 12,
          attempts: 20,
          createdAt: '2026-07-23T00:00:00.000Z',
        },
      },
      responses: [],
    });

    try {
      fixture.listeners.alarm({ name: 'readLaterJobRecovery' });
      await waitFor(() => fixture.store['pendingReadLaterJob:job-limit'] === undefined);

      assert.equal(fixture.fetchCalls.length, 0);
      assert.ok(fixture.badgeTexts.some(({ text }) => text === '?'));
      assert.ok(fixture.notifications.some(({ options }) => options.title === '保存任务仍在处理'));
      assert.equal(fixture.notifications.some(({ options }) => options.title === '保存失败'), false);
    } finally {
      fixture.restore();
    }
  });
});

function successfulJobResponses(jobId) {
  return [
    { status: 202, data: { jobId, status: 'queued' } },
    {
      status: 200,
      data: {
        jobId,
        status: 'done',
        result: {
          title: 'Saved',
          articleUrl: 'http://newrss.local:8787/articles/1',
          existed: false,
        },
      },
    },
  ];
}

async function loadBackgroundFixture(options = {}) {
  const listeners = {};
  const store = { ...(options.seed || {}) };
  const fetchCalls = [];
  const notifications = [];
  const badgeTexts = [];
  const badgeColors = [];
  const alarmsCreated = [];
  const alarmsCleared = [];
  const createdTabs = [];
  const storageSetCalls = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const responses = [...(options.responses || [])];
  let lastError = null;

  const chromeMock = {
    runtime: {
      get lastError() {
        return lastError;
      },
      getURL(resourcePath) {
        return `chrome-extension://newrss/${resourcePath}`;
      },
      onStartup: eventSlot(listeners, 'startup'),
      onInstalled: eventSlot(listeners, 'installed'),
    },
    action: {
      onClicked: eventSlot(listeners, 'actionClicked'),
      setBadgeText(details, callback) {
        badgeTexts.push({ ...details });
        invokeCallback(callback);
      },
      setBadgeBackgroundColor(details, callback) {
        badgeColors.push({ ...details });
        invokeCallback(callback);
      },
    },
    notifications: {
      onClicked: eventSlot(listeners, 'notificationClicked'),
      onClosed: eventSlot(listeners, 'notificationClosed'),
      create(id, notificationOptions, callback) {
        if (options.failNotificationCreate) {
          invokeCallback(callback, 'forced notification failure');
          return;
        }
        notifications.push({ id, options: notificationOptions });
        invokeCallback(callback, null, id);
      },
      clear(id, callback) {
        invokeCallback(callback, null, true);
      },
    },
    alarms: {
      onAlarm: eventSlot(listeners, 'alarm'),
      create(name, alarmInfo) {
        alarmsCreated.push({ name, alarmInfo });
      },
      clear(name, callback) {
        alarmsCleared.push(name);
        invokeCallback(callback, null, true);
      },
    },
    storage: {
      local: {
        get(key, callback) {
          let result;
          if (key == null) {
            result = { ...store };
          } else if (Array.isArray(key)) {
            result = Object.fromEntries(key.filter((item) => item in store).map((item) => [item, store[item]]));
          } else {
            result = key in store ? { [key]: store[key] } : {};
          }
          invokeCallback(callback, null, result);
        },
        set(data, callback) {
          storageSetCalls.push(structuredClone(data));
          if (options.failStorageSet?.(data)) {
            invokeCallback(callback, 'forced storage failure');
            return;
          }
          Object.assign(store, structuredClone(data));
          invokeCallback(callback);
        },
        remove(key, callback) {
          for (const item of Array.isArray(key) ? key : [key]) {
            delete store[item];
          }
          invokeCallback(callback);
        },
      },
    },
    tabs: {
      create(details, callback) {
        createdTabs.push({ ...details });
        invokeCallback(callback, null, { id: createdTabs.length, ...details });
      },
    },
  };

  function invokeCallback(callback, errorMessage = null, ...args) {
    lastError = errorMessage ? { message: errorMessage } : null;
    callback(...args);
    lastError = null;
  }

  const fetchMock = async (url, requestOptions = {}) => {
    fetchCalls.push({ url, options: { ...requestOptions } });
    if (!responses.length) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return {
      status: next.status,
      json: async () => next.data,
    };
  };

  const originalChrome = global.chrome;
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  global.chrome = chromeMock;
  global.fetch = fetchMock;
  console.error = (...args) => consoleErrors.push(args);
  console.warn = (...args) => consoleWarnings.push(args);

  const backgroundUrl = pathToFileURL(path.join(extensionDirectory, 'background.mjs'));
  backgroundUrl.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  await import(backgroundUrl.href);

  return {
    listeners,
    store,
    fetchCalls,
    notifications,
    badgeTexts,
    badgeColors,
    alarmsCreated,
    alarmsCleared,
    createdTabs,
    storageSetCalls,
    consoleErrors,
    consoleWarnings,
    restore() {
      global.chrome = originalChrome;
      global.fetch = originalFetch;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    },
  };
}

function eventSlot(listeners, name) {
  return {
    addListener(listener) {
      listeners[name] = listener;
    },
  };
}

async function waitFor(predicate, message = 'timed out waiting for extension state') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
