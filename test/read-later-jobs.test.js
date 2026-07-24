const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('../src/db');
const ReadLaterJobQueue = require('../src/read-later-jobs');

test('persistent read-later jobs run once and expose their result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-jobs-'));
  const db = new Database(path.join(directory, 'newrss.db'));
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let calls = 0;
  const queue = new ReadLaterJobQueue({
    db,
    readLaterService: {
      async saveUrl(payload) {
        calls += 1;
        return { articleUrl: `${payload.baseUrl}/articles/7`, title: 'Saved' };
      },
    },
  });

  const first = queue.enqueue({
    payload: { url: 'https://example.com/article' },
    baseUrl: 'http://newrss.local:8787',
    idempotencyKey: 'same-request',
  });
  const duplicate = queue.enqueue({
    payload: { url: 'https://example.com/article' },
    baseUrl: 'http://newrss.local:8787',
    idempotencyKey: 'same-request',
  });
  assert.equal(first.jobId, duplicate.jobId);
  assert.throws(
    () => queue.enqueue({
      payload: { url: 'https://example.com/different' },
      baseUrl: 'http://newrss.local:8787',
      idempotencyKey: 'same-request',
    }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );

  const completed = await waitFor(() => queue.get(first.jobId)?.status === 'done' && queue.get(first.jobId));
  assert.equal(calls, 1);
  assert.equal(completed.result.articleUrl, 'http://newrss.local:8787/articles/7');
});

test('failed jobs persist a safe public error while logging details', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-jobs-error-'));
  const db = new Database(path.join(directory, 'newrss.db'));
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const logs = [];
  const queue = new ReadLaterJobQueue({
    db,
    logger: { error: (value) => logs.push(value) },
    readLaterService: {
      async saveUrl() {
        throw new Error('Unable to read Codex auth file /private/auth.json');
      },
    },
  });

  const job = queue.enqueue({ payload: { url: 'https://example.com' }, baseUrl: 'http://newrss.local:8787' });
  const failed = await waitFor(() => queue.get(job.jobId)?.status === 'failed' && queue.get(job.jobId));
  assert.equal(failed.error, 'read-later job failed; see server logs for details');
  assert.doesNotMatch(failed.error, /private/);
  assert.match(logs[0], /private\/auth\.json/);
});

test('automatic idempotency keys requeue a failed job while explicit keys preserve its result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-jobs-auto-retry-'));
  const db = new Database(path.join(directory, 'newrss.db'));
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let shouldFail = true;
  let calls = 0;
  const queue = new ReadLaterJobQueue({
    db,
    logger: { error() {} },
    readLaterService: {
      async saveUrl() {
        calls += 1;
        if (shouldFail) throw new Error('temporary failure');
        return { entryId: 9 };
      },
    },
  });
  const payload = { url: 'https://example.com/retry' };
  const automatic = queue.enqueue({
    payload,
    baseUrl: 'http://newrss.local:8787',
    idempotencyKey: 'auto:retry',
    retryFailed: true,
  });
  await waitFor(() => queue.get(automatic.jobId)?.status === 'failed');
  shouldFail = false;
  const retried = queue.enqueue({
    payload,
    baseUrl: 'http://newrss.local:8787',
    idempotencyKey: 'auto:retry',
    retryFailed: true,
  });
  assert.equal(retried.jobId, automatic.jobId);
  const completed = await waitFor(() => queue.get(automatic.jobId)?.status === 'done' && queue.get(automatic.jobId));
  assert.equal(completed.result.entryId, 9);
  assert.equal(calls, 2);

  shouldFail = true;
  const explicit = queue.enqueue({ payload, baseUrl: 'http://newrss.local:8787', idempotencyKey: 'auto:explicit-retry' });
  await waitFor(() => queue.get(explicit.jobId)?.status === 'failed');
  shouldFail = false;
  const duplicate = queue.enqueue({ payload, baseUrl: 'http://newrss.local:8787', idempotencyKey: 'auto:explicit-retry' });
  assert.equal(duplicate.status, 'failed');
  assert.equal(calls, 3);
});

test('queue shutdown waits for active jobs and leaves queued work durable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-jobs-stop-'));
  const db = new Database(path.join(directory, 'newrss.db'));
  t.after(() => {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let finishSave;
  const queue = new ReadLaterJobQueue({
    db,
    readLaterService: {
      saveUrl() {
        return new Promise((resolve) => {
          finishSave = resolve;
        });
      },
    },
  });
  const active = queue.enqueue({
    payload: { url: 'https://example.com/active' },
    baseUrl: 'http://newrss.local:8787',
  });
  await waitFor(() => queue.get(active.jobId)?.status === 'running');

  let stopped = false;
  const stopping = queue.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.throws(
    () => queue.enqueue({ payload: { url: 'https://example.com/new' }, baseUrl: 'http://newrss.local:8787' }),
    (error) => error.code === 'JOB_QUEUE_STOPPED'
  );

  finishSave({ entryId: 8 });
  await stopping;
  assert.equal(queue.get(active.jobId).status, 'done');
});

async function waitFor(readValue) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = readValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for job');
}
