#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const options = parseArguments(process.argv.slice(2));
const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
const TranslationService = require(path.join(projectRoot, 'src/translation-service'));

async function main() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-translation-bench-'));
  const authFile = path.join(temporaryDirectory, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: {
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'benchmark-refresh-token',
    },
  }));

  const provider = new DeterministicProvider();
  const previousFetch = global.fetch;
  global.fetch = provider.fetch.bind(provider);

  try {
    const service = new TranslationService({
      translationProvider: 'codex-oauth',
      codexAuthFile: authFile,
      codexBaseUrl: 'https://benchmark.invalid/backend-api/codex',
      codexModel: 'openai-codex/benchmark-model',
      codexTimeoutMs: 5_000,
      geminiChunkMaxWords: 200,
      geminiChunkConcurrency: options.concurrency,
      translationRequestConcurrency: options.concurrency,
      translateTargetLanguage: 'Simplified Chinese',
    });

    const scenarios = [];
    scenarios.push(await benchmarkScenario({
      name: 'short-one-call',
      iterations: options.iterations,
      warmups: options.warmups,
      provider,
      operation: () => translateAndVerify(service, 1, { short: true }),
    }));
    for (const chunkCount of [2, 3, 5, 8]) {
      scenarios.push(await benchmarkScenario({
        name: `single-${chunkCount}-chunks`,
        iterations: options.iterations,
        warmups: options.warmups,
        provider,
        operation: () => translateAndVerify(service, chunkCount),
      }));
    }
    scenarios.push(await benchmarkScenario({
      name: 'mixed-six-articles',
      iterations: options.iterations,
      warmups: options.warmups,
      provider,
      operation: async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, () => service.translateArticle(articleInput(3)))
        );
        results.forEach((result) => verifyChunkedResult(result, 3));
      },
    }));

    const failure = await benchmarkFailure(service, provider);
    const output = {
      label: options.label,
      projectRoot,
      node: process.version,
      iterations: options.iterations,
      warmups: options.warmups,
      configuredConcurrency: options.concurrency,
      scenarios,
      failure,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function benchmarkScenario({ name, iterations, warmups, provider, operation }) {
  for (let index = 0; index < warmups; index += 1) {
    provider.reset();
    await operation();
  }

  const samples = [];
  let maximumInFlight = 0;
  let totalCalls = 0;
  let totalAborted = 0;
  for (let index = 0; index < iterations; index += 1) {
    provider.reset();
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
    maximumInFlight = Math.max(maximumInFlight, provider.maximumInFlight);
    totalCalls += provider.calls;
    totalAborted += provider.aborted;
    assert.equal(provider.active, 0, `${name} left an active request`);
  }

  samples.sort((left, right) => left - right);
  return {
    name,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    averageMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    averageCalls: round(totalCalls / samples.length),
    maximumInFlight,
    abortedCalls: totalAborted,
  };
}

async function benchmarkFailure(service, provider) {
  provider.reset({ failChunk: 2 });
  const startedAt = performance.now();
  await assert.rejects(service.translateArticle(articleInput(8)), /benchmark chunk failure/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.active, 0, 'failure scenario left an active request');
  return {
    failedChunk: 2,
    wallMs: round(performance.now() - startedAt),
    calls: provider.calls,
    maximumInFlight: provider.maximumInFlight,
    abortedCalls: provider.aborted,
  };
}

async function translateAndVerify(service, chunkCount, { short = false } = {}) {
  const result = await service.translateArticle(articleInput(chunkCount, { short }));
  if (short) {
    assert.equal(result.translatedTitle, '基准标题');
    assert.equal(result.translatedContentHtml, '<p>短文译文</p>');
    return;
  }
  verifyChunkedResult(result, chunkCount);
}

function verifyChunkedResult(result, chunkCount) {
  assert.equal(result.translatedTitle, '基准标题');
  const translatedChunks = Array.from(
    result.translatedContentHtml.matchAll(/data-benchmark-chunk="(\d+)"/g),
    (match) => Number(match[1])
  );
  assert.deepEqual(
    translatedChunks,
    Array.from({ length: chunkCount }, (_, index) => index + 1)
  );
}

function articleInput(chunkCount, { short = false } = {}) {
  if (short) {
    return {
      sourceTitle: 'Short benchmark article',
      contentHtml: `<p>${words('short', 80)}</p>`,
      sourceUrl: 'https://benchmark.invalid/short',
    };
  }

  return {
    sourceTitle: `Benchmark article with ${chunkCount} chunks`,
    contentHtml: Array.from(
      { length: chunkCount },
      (_, index) => `<p>${words(`chunk${index + 1}`, 190)}</p>`
    ).join(''),
    sourceUrl: `https://benchmark.invalid/${chunkCount}-chunks`,
  };
}

function words(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-word-${index + 1}`).join(' ');
}

class DeterministicProvider {
  constructor() {
    this.reset();
  }

  reset({ failChunk = null } = {}) {
    assert.equal(this?.active || 0, 0, 'cannot reset while a request is active');
    this.active = 0;
    this.maximumInFlight = 0;
    this.calls = 0;
    this.aborted = 0;
    this.failChunk = failChunk;
    this.failureReturned = false;
  }

  async fetch(url, request = {}) {
    assert.match(String(url), /\/responses$/);
    const body = JSON.parse(request.body);
    const prompt = body.input[0].content[0].text;
    const kind = classifyPrompt(prompt);

    this.calls += 1;
    this.active += 1;
    this.maximumInFlight = Math.max(this.maximumInFlight, this.active);
    try {
      await waitFor(delayFor(kind), request.signal);
      if (
        kind.type === 'chunk' &&
        kind.index === this.failChunk &&
        !this.failureReturned
      ) {
        this.failureReturned = true;
        return new Response(JSON.stringify({
          error: { message: 'benchmark chunk failure' },
        }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(sseResponse(responseText(kind)), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        this.aborted += 1;
      }
      throw error;
    } finally {
      this.active -= 1;
    }
  }
}

function classifyPrompt(prompt) {
  const chunk = String(prompt).match(/Chunk: (\d+) of (\d+)/);
  if (chunk) {
    return { type: 'chunk', index: Number(chunk[1]), count: Number(chunk[2]) };
  }
  if (/Translate the following article title into/.test(prompt)) {
    return { type: 'title' };
  }
  return { type: 'direct' };
}

function delayFor(kind) {
  if (kind.type === 'title') {
    return 25;
  }
  if (kind.type === 'chunk') {
    return 45 + kind.index * 2;
  }
  return 55;
}

function responseText(kind) {
  if (kind.type === 'title') {
    return '基准标题';
  }
  if (kind.type === 'chunk') {
    return `<p data-benchmark-chunk="${kind.index}">第 ${kind.index} 块译文</p>`;
  }
  return JSON.stringify({
    translatedTitle: '基准标题',
    translatedContentHtml: '<p>短文译文</p>',
  });
}

function sseResponse(text) {
  return [
    `event: response.output_text.done\ndata: ${JSON.stringify({
      type: 'response.output_text.done',
      text,
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      },
    })}`,
    '',
  ].join('\n\n');
}

function waitFor(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(done, delayMs);
    signal?.addEventListener('abort', aborted, { once: true });

    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }

    function aborted() {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }
  });
}

function percentile(sorted, ratio) {
  if (!sorted.length) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function round(value) {
  return Number(value.toFixed(2));
}

function parseArguments(argv) {
  const parsed = {
    label: 'candidate',
    projectRoot: '',
    iterations: 7,
    warmups: 1,
    concurrency: 6,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--label') {
      parsed.label = String(value || '');
      index += 1;
    } else if (argument === '--project-root') {
      parsed.projectRoot = String(value || '');
      index += 1;
    } else if (argument === '--iterations') {
      parsed.iterations = positiveInteger(value, '--iterations');
      index += 1;
    } else if (argument === '--warmups') {
      parsed.warmups = nonnegativeInteger(value, '--warmups');
      index += 1;
    } else if (argument === '--concurrency') {
      parsed.concurrency = positiveInteger(value, '--concurrency');
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return parsed;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function nonnegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return number;
}

function fakeJwt(payload) {
  return `${base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64Url(JSON.stringify(payload))}.signature`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
