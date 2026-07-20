const test = require('node:test');
const assert = require('node:assert/strict');

const ReadLaterService = require('../src/read-later-service');

test('read-later translation can use a provider override independent of global translation provider', () => {
  const service = new ReadLaterService({
    db: {},
    feedService: {},
    config: {
      translationProvider: 'codex-oauth',
      readLaterTranslationProvider: 'gemini',
      geminiApiKey: 'test-gemini-key',
      codexAuthFile: '/tmp/missing-codex-auth.json',
    },
  });

  assert.equal(service.translationService.config.translationProvider, 'gemini');
  assert.equal(service.config.translationProvider, 'codex-oauth');
});
