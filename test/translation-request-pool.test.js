const test = require('node:test');
const assert = require('node:assert/strict');

const TranslationRequestPool = require('../src/translation-request-pool');

test('translation request pool is FIFO, bounded, and removes aborted queued work', async () => {
  const pool = new TranslationRequestPool(2);
  const started = [];
  const releases = new Map();
  let active = 0;
  let maximumActive = 0;

  const run = (name, signal) =>
    pool.run('codex-oauth', () => {
      started.push(name);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise((resolve) => {
        releases.set(name, () => {
          active -= 1;
          resolve(name);
        });
      });
    }, { signal });

  const first = run('first');
  const second = run('second');
  const third = run('third');
  const controller = new AbortController();
  const fourth = run('fourth', controller.signal);
  const fourthRejected = assert.rejects(fourth, /aborted/);

  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['first', 'second']);
  controller.abort();
  await fourthRejected;

  releases.get('first')();
  assert.equal(await first, 'first');
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ['first', 'second', 'third']);

  releases.get('second')();
  releases.get('third')();
  assert.deepEqual(await Promise.all([second, third]), ['second', 'third']);
  assert.equal(maximumActive, 2);
  assert.equal(active, 0);
});

test('translation request pool applies its limit independently per provider', async () => {
  const pool = new TranslationRequestPool(1);
  const started = [];
  let releaseCodex;
  let releaseGemini;

  const codex = pool.run('codex-oauth', () => {
    started.push('codex');
    return new Promise((resolve) => {
      releaseCodex = resolve;
    });
  });
  const gemini = pool.run('gemini', () => {
    started.push('gemini');
    return new Promise((resolve) => {
      releaseGemini = resolve;
    });
  });

  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['codex', 'gemini']);
  releaseCodex();
  releaseGemini();
  await Promise.all([codex, gemini]);
});

test('translation request pool shares slots fairly between request groups', async () => {
  const pool = new TranslationRequestPool(2);
  const firstGroup = {};
  const secondGroup = {};
  const started = [];
  const releases = new Map();
  const run = (name, group) =>
    pool.run('codex-oauth', () => {
      started.push(name);
      return new Promise((resolve) => {
        releases.set(name, resolve);
      });
    }, { group });

  const first = run('first-1', firstGroup);
  const second = run('first-2', firstGroup);
  const third = run('second-1', secondGroup);

  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['first-1', 'second-1']);
  releases.get('first-1')();
  await first;
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ['first-1', 'second-1', 'first-2']);
  releases.get('second-1')();
  releases.get('first-2')();
  await Promise.all([second, third]);
});

test('translation request pool rotates groups when concurrency is one', async () => {
  const pool = new TranslationRequestPool(1);
  const firstGroup = {};
  const secondGroup = {};
  const started = [];
  const run = (name, group) =>
    pool.run('gemini', async () => {
      started.push(name);
      await new Promise((resolve) => setImmediate(resolve));
    }, { group });

  await Promise.all([
    run('first-1', firstGroup),
    run('first-2', firstGroup),
    run('first-3', firstGroup),
    run('second-1', secondGroup),
    run('second-2', secondGroup),
    run('second-3', secondGroup),
  ]);

  assert.deepEqual(started, [
    'first-1',
    'second-1',
    'first-2',
    'second-2',
    'first-3',
    'second-3',
  ]);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for condition');
}
