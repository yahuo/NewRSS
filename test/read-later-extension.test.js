const test = require('node:test');
const assert = require('node:assert/strict');

const helpersPromise = import('../extensions/read-later-chrome/helpers.mjs');

test('isSupportedPageUrl only accepts http and https pages', async () => {
  const { isSupportedPageUrl } = await helpersPromise;

  assert.equal(isSupportedPageUrl('https://example.com/article'), true);
  assert.equal(isSupportedPageUrl('http://example.com/article'), true);
  assert.equal(isSupportedPageUrl('chrome://extensions'), false);
  assert.equal(isSupportedPageUrl('about:blank'), false);
  assert.equal(isSupportedPageUrl('not-a-url'), false);
});

test('buildSavePayload only sends the URL plus fixed default save options', async () => {
  const { buildSavePayload } = await helpersPromise;

  assert.deepEqual(
    buildSavePayload({
      url: 'https://example.com/story',
      title: ' Example title ',
    }),
    {
      url: 'https://example.com/story',
      mode: 'auto',
      translate: true,
    }
  );
});

test('buildSaveSuccessNotification distinguishes new and existing entries', async () => {
  const { buildSaveSuccessNotification } = await helpersPromise;

  assert.deepEqual(
    buildSaveSuccessNotification({
      title: 'Fresh item',
      existed: false,
    }),
    {
      title: 'Read Later 已保存',
      message: 'Fresh item',
    }
  );

  assert.deepEqual(
    buildSaveSuccessNotification({
      title: 'Existing item',
      existed: true,
    }),
    {
      title: 'Read Later 已更新',
      message: 'Existing item',
    }
  );
});

test('humanizeSaveError maps timeout, network, and api errors to readable text', async () => {
  const { humanizeSaveError } = await helpersPromise;

  assert.equal(
    humanizeSaveError({ name: 'AbortError', message: 'aborted' }),
    '请求 NewRSS 超时，请稍后重试。'
  );
  assert.equal(
    humanizeSaveError(new Error('NETWORK_ERROR:unreachable')),
    '无法连接到 NewRSS 服务，请检查 http://macpro.sgponte:8787 是否可达。'
  );
  assert.equal(
    humanizeSaveError(new Error('API_ERROR:mode must be one of: auto, x-direct, readability')),
    'mode must be one of: auto, x-direct, readability'
  );
});
