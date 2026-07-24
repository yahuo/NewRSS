const { randomUUID } = require('node:crypto');

class ReadLaterJobQueue {
  constructor({ db, readLaterService, concurrency = 1, logger = console }) {
    this.db = db;
    this.readLaterService = readLaterService;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.logger = logger;
    this.activeJobIds = new Set();
    this.activeRuns = new Set();
    this.drainScheduled = false;
    this.stopping = false;
  }

  start() {
    this.scheduleDrain();
  }

  enqueue({ payload, baseUrl, idempotencyKey, retryFailed = false }) {
    if (this.stopping) {
      const error = new Error('read-later job queue is stopping');
      error.code = 'JOB_QUEUE_STOPPED';
      throw error;
    }
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey || randomUUID());
    const requestJson = { payload, baseUrl };
    let job = this.db.createReadLaterJob({
      id: randomUUID(),
      idempotencyKey: normalizedKey,
      requestJson,
      status: 'queued',
    });
    if (job.request_json !== JSON.stringify(requestJson)) {
      const error = new Error('Idempotency-Key was already used for a different request');
      error.code = 'IDEMPOTENCY_CONFLICT';
      throw error;
    }
    if (job.status === 'failed' && retryFailed) {
      job = this.db.updateReadLaterJob(job.id, {
        status: 'queued',
        resultJson: null,
        error: null,
        startedAt: null,
        completedAt: null,
      });
    }
    if (job.status === 'queued') {
      this.scheduleDrain();
    }
    return mapJob(job);
  }

  get(jobId) {
    const id = String(jobId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return null;
    }
    const job = this.db.getReadLaterJobById(id);
    return job ? mapJob(job) : null;
  }

  scheduleDrain() {
    if (this.stopping || this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.stopping) {
        return;
      }
      this.drain();
    });
  }

  drain() {
    if (this.stopping) {
      return;
    }
    const available = this.concurrency - this.activeJobIds.size;
    if (available <= 0) {
      return;
    }
    const queued = this.db.listReadLaterJobs({ status: 'queued', limit: available });
    for (const job of queued) {
      if (this.activeJobIds.has(job.id)) {
        continue;
      }
      this.activeJobIds.add(job.id);
      const run = this.run(job.id);
      this.activeRuns.add(run);
      void run
        .catch((error) => {
          this.logger.error(`[read-later-job] ${job.id} queue failure: ${error.stack || error.message}`);
        })
        .finally(() => {
          this.activeRuns.delete(run);
          this.activeJobIds.delete(job.id);
          this.scheduleDrain();
        });
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled(Array.from(this.activeRuns));
  }

  async run(jobId) {
    const stored = this.db.getReadLaterJobById(jobId);
    if (!stored || stored.status !== 'queued') {
      return;
    }
    this.db.updateReadLaterJob(jobId, { status: 'running', error: null });

    try {
      const request = parseJson(stored.request_json, 'read-later job request');
      const result = await this.readLaterService.saveUrl({
        ...request.payload,
        baseUrl: request.baseUrl,
      });
      this.db.updateReadLaterJob(jobId, {
        status: 'done',
        resultJson: result,
        error: null,
      });
    } catch (error) {
      this.logger.error(`[read-later-job] ${jobId} failed: ${error.stack || error.message}`);
      this.db.updateReadLaterJob(jobId, {
        status: 'failed',
        resultJson: null,
        error: publicJobError(error),
      });
    }
  }
}

module.exports = ReadLaterJobQueue;

function mapJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    result: job.result_json ? parseJson(job.result_json, 'read-later job result') : null,
    error: job.error || null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    throw new Error(`${label} is corrupt`);
  }
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new Error('Idempotency-Key must contain 1-128 safe characters');
  }
  return key;
}

function publicJobError(error) {
  if (String(error?.code || '').startsWith('OUTBOUND_')) {
    return error.message;
  }
  if (/\b(url|mode|translate)\b/i.test(String(error?.message || ''))) {
    return error.message;
  }
  return 'read-later job failed; see server logs for details';
}
