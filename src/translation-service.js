const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildHtmlTranslationPlan } = require('./html-chunker');
const { renderMarkdown } = require('./markdown-renderer');
const { chunkMarkdown } = require('./markdown-chunker');
const { extractMarkdownHeadingTitle, normalizeDerivedTitle, normalizeWhitespace, stripHtml, truncate } = require('./utils');

const ENGLISH_SAMPLE_LIMIT = 6_000;
const MAX_TRANSLATABLE_CHARS = 120_000;
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;
const CODEX_PROVIDER = 'codex-oauth';
const CODEX_PROBE_DELAYS_MINUTES = [15, 30, 60, 120];

class TranslationService {
  constructor(config, { db = null } = {}) {
    this.config = { ...config, translationStore: db };
  }

  isEnabled() {
    if (getTranslationProvider(this.config) === 'codex-oauth') {
      return fs.existsSync(resolveCodexAuthFile(this.config));
    }

    return Boolean(String(this.config.geminiApiKey || '').trim());
  }

  shouldTranslate({ title, contentHtml }) {
    if (!this.isEnabled()) {
      return false;
    }

    const sample = normalizeWhitespace(`${title || ''}\n${stripHtml(contentHtml || '')}`).slice(0, ENGLISH_SAMPLE_LIMIT);
    if (!sample) {
      return false;
    }

    const letters = countMatches(sample, /[A-Za-z]/g);
    const englishWords = countMatches(sample, /\b[A-Za-z][A-Za-z'-]{1,}\b/g);
    const cjkChars = countMatches(sample, /[\u3400-\u9FFF]/g);

    if (englishWords < 8 || letters < 40) {
      return false;
    }

    return cjkChars * 4 < letters;
  }

  async translateArticle({ sourceTitle, contentHtml, sourceUrl }) {
    if (!this.isEnabled()) {
      return null;
    }

    const title = String(sourceTitle || '').trim();
    const html = String(contentHtml || '').trim();
    if (!html) {
      return null;
    }

    const htmlPlan = buildHtmlTranslationPlan(html, {
      maxWords: this.config.geminiChunkMaxWords,
    });
    const shouldUseChunkedHtml = html.length > MAX_TRANSLATABLE_CHARS || htmlPlan.chunks.length > 1;

    if (shouldUseChunkedHtml) {
      return this.translateArticleInChunks({
        sourceTitle: title,
        sourceUrl,
        htmlPlan,
      });
    }

    try {
      const prompt = buildTranslationPrompt({
        title,
        contentHtml: html,
        sourceUrl,
        targetLanguage: this.config.translateTargetLanguage,
      });
      const response = await callTranslationJson({
        config: this.config,
        prompt,
      });

      const translatedTitle = normalizeWhitespace(response.translatedTitle || '');
      const translatedContentHtml = String(response.translatedContentHtml || '').trim();
      if (!translatedTitle || !translatedContentHtml) {
        throw new Error('Translation provider returned incomplete fields');
      }

      return {
        translatedTitle: truncate(translatedTitle, 120),
        translatedContentHtml,
        provider: getTranslationModel(this.config),
      };
    } catch (error) {
      if (isAbortLikeError(error) && htmlPlan.chunks.length > 1) {
        return this.translateArticleInChunks({
          sourceTitle: title,
          sourceUrl,
          htmlPlan,
        });
      }

      throw error;
    }
  }

  async translateMarkdown({ sourceTitle, markdown, sourceUrl, sourceAuthor = '' }) {
    if (!this.isEnabled()) {
      return null;
    }

    const rawMarkdown = String(markdown || '').trim();
    if (!rawMarkdown) {
      return null;
    }

    const chunks = chunkMarkdown(rawMarkdown, {
      maxWords: this.config.geminiChunkMaxWords,
    });
    if (!chunks.length) {
      return null;
    }

    const translatedChunks = await mapWithConcurrency(
      chunks,
      getChunkConcurrency(this.config),
      (chunk, index) =>
        this.translateMarkdownChunk({
          sourceTitle,
          sourceUrl,
          markdown: chunk.markdown,
          chunkIndex: index,
          chunkCount: chunks.length,
        })
    );
    const translatedMarkdown = translatedChunks.join('\n\n').trim();
    const translatedTitle =
      extractMarkdownHeadingTitle(translatedMarkdown) ||
      (sourceTitle
        ? await this.translateTitle({
            title: sourceTitle,
            sourceUrl,
          })
        : '') ||
      deriveTitleFromMarkdown(translatedMarkdown) ||
      normalizeDerivedTitle(sourceTitle);
    const rendered = renderMarkdown(translatedMarkdown, {
      title: translatedTitle,
      author: sourceAuthor,
      sourceUrl,
      fallbackTitle: translatedTitle || sourceTitle || 'Untitled',
    });

    return {
      translatedTitle: translatedTitle || truncate(normalizeWhitespace(sourceTitle || ''), 120),
      translatedContentHtml: rendered.contentHtml,
      provider: `${getTranslationModel(this.config)}-md-chunked`,
    };
  }

  async translateTitle({ title, sourceUrl }) {
    const text = await callTranslationText({
      config: this.config,
      prompt: [
        `Translate the following article title into ${this.config.translateTargetLanguage}.`,
        'Return only the translated title on a single line.',
        'Keep names, product names, and proper nouns when appropriate.',
        '',
        `Source URL: ${sourceUrl || ''}`,
        `Title: ${title}`,
      ].join('\n'),
    });

    return normalizeDerivedTitle(stripFenceWrapperText(text));
  }

  async translateMarkdownChunk({ sourceTitle, sourceUrl, markdown, chunkIndex, chunkCount }) {
    const translated = await callTranslationText({
      config: this.config,
      prompt: buildMarkdownChunkPrompt({
        sourceTitle,
        sourceUrl,
        markdown,
        chunkIndex,
        chunkCount,
        targetLanguage: this.config.translateTargetLanguage,
      }),
    });

    return unwrapTranslatedMarkdownChunk(translated, markdown);
  }

  async translateArticleInChunks({ sourceTitle, sourceUrl, htmlPlan }) {
    if (!htmlPlan?.chunks?.length) {
      return null;
    }

    const translatedChunks = await mapWithConcurrency(
      htmlPlan.chunks,
      getChunkConcurrency(this.config),
      (chunkHtml, index) =>
        this.translateHtmlChunk({
          sourceTitle,
          sourceUrl,
          chunkHtml,
          chunkIndex: index,
          chunkCount: htmlPlan.chunks.length,
        })
    );

    const translatedTitle =
      (sourceTitle
        ? await this.translateTitle({
            title: sourceTitle,
            sourceUrl,
          })
        : '') || normalizeDerivedTitle(sourceTitle);
    const translatedContentHtml = htmlPlan.wrap(translatedChunks.join('\n\n'));

    return {
      translatedTitle: translatedTitle || truncate(normalizeWhitespace(sourceTitle || ''), 120),
      translatedContentHtml,
      provider: `${getTranslationModel(this.config)}-html-chunked`,
    };
  }

  async translateHtmlChunk({ sourceTitle, sourceUrl, chunkHtml, chunkIndex, chunkCount }) {
    const translated = await callTranslationText({
      config: this.config,
      prompt: buildHtmlChunkPrompt({
        sourceTitle,
        sourceUrl,
        html: chunkHtml,
        chunkIndex,
        chunkCount,
        targetLanguage: this.config.translateTargetLanguage,
      }),
    });

    return unwrapTranslatedHtmlChunk(translated);
  }

  getCodexStatus() {
    if (getTranslationProvider(this.config) !== CODEX_PROVIDER || !this.config.translationStore) {
      return null;
    }

    return {
      circuit: this.config.translationStore.getTranslationCircuit(CODEX_PROVIDER),
      usage: this.config.translationStore.getTranslationUsageSummary(CODEX_PROVIDER),
    };
  }

  async probeCodex({ force = false } = {}) {
    if (getTranslationProvider(this.config) !== CODEX_PROVIDER) {
      throw new Error('Codex OAuth is not the active translation provider');
    }
    if (!this.config.translationStore) {
      throw new Error('Codex circuit persistence is unavailable');
    }

    const now = new Date().toISOString();
    const claim = this.config.translationStore.claimTranslationProbe(CODEX_PROVIDER, now, force);
    if (!claim.claimed) {
      return { probed: false, circuit: claim.circuit };
    }

    try {
      await callCodexText({ config: this.config, prompt: 'Reply OK.', probe: true });
      const circuit = this.config.translationStore.closeTranslationCircuit(CODEX_PROVIDER, new Date().toISOString());
      return { probed: true, ok: true, circuit };
    } catch (error) {
      const circuit = openCodexCircuit(this.config, error);
      return { probed: true, ok: false, error: error.message, circuit };
    }
  }
}

module.exports = TranslationService;

function getTranslationProvider(config) {
  const provider = String(config.translationProvider || 'gemini').trim().toLowerCase();
  return provider || 'gemini';
}

function getTranslationModel(config) {
  return getTranslationProvider(config) === 'codex-oauth'
    ? String(config.codexModel || 'openai-codex/gpt-5.5').trim()
    : String(config.geminiModel || 'gemini-2.5-flash').trim();
}

function getChunkConcurrency(config) {
  if (getTranslationProvider(config) === CODEX_PROVIDER) {
    return 1;
  }
  return Math.max(1, Number(config.geminiChunkConcurrency) || 3);
}

async function callTranslationJson({ config, prompt }) {
  if (getTranslationProvider(config) === 'codex-oauth') {
    const text = await callCodexText({ config, prompt });
    return parseTranslationJson(text);
  }

  return callGemini({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    timeoutMs: config.geminiTimeoutMs,
    prompt,
  });
}

async function callTranslationText({ config, prompt }) {
  if (getTranslationProvider(config) === 'codex-oauth') {
    return callCodexText({ config, prompt });
  }

  return callGeminiText({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    timeoutMs: config.geminiTimeoutMs,
    prompt,
  });
}

async function fetchGeminiContent({ apiKey, model, timeoutMs, prompt, generationConfig = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 90_000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            ...generationConfig,
          },
        }),
      }
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.error?.status ||
        `Gemini request failed with status ${response.status}`;
      throw new Error(message);
    }

    const parts = payload?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (!text) {
      throw new Error('Gemini returned no text');
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini({ apiKey, model, timeoutMs, prompt }) {
  const text = await fetchGeminiContent({
    apiKey,
    model,
    timeoutMs,
    prompt,
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          translatedTitle: {
            type: 'string',
            description: 'Translated title in the target language.',
          },
          translatedContentHtml: {
            type: 'string',
            description: 'Translated HTML body in the target language while preserving valid HTML tags and original links.',
          },
        },
        required: ['translatedTitle', 'translatedContentHtml'],
      },
    },
  });
  return JSON.parse(text);
}

async function callGeminiText({ apiKey, model, timeoutMs, prompt }) {
  return fetchGeminiContent({ apiKey, model, timeoutMs, prompt });
}

async function callCodexText({ config, prompt, probe = false }) {
  const store = config.translationStore;
  if (!probe && store) {
    const circuit = store.getTranslationCircuit(CODEX_PROVIDER);
    if (circuit.state !== 'closed') {
      const error = new Error(`Codex circuit is ${circuit.state}${circuit.next_probe_at ? ` until ${circuit.next_probe_at}` : ''}`);
      error.code = 'CODEX_CIRCUIT_OPEN';
      error.retryAfter = circuit.next_probe_at || null;
      throw error;
    }
  }

  const auth = await resolveCodexAuth(config);
  const baseUrl = String(config.codexBaseUrl || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
  const timeoutMs = Number(config.codexTimeoutMs) || Number(config.geminiTimeoutMs) || 90_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestKind = probe ? 'probe' : 'translation';
  const createdAt = new Date().toISOString();
  let responseRaw = '';
  try {
    const body = {
      model: getCodexApiModel(getTranslationModel(config)),
      instructions: probe
        ? 'Return only OK.'
        : 'You are a precise translation engine. Follow the user prompt exactly and return only the requested translation output.',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: prompt,
            },
          ],
        },
      ],
      store: false,
      stream: true,
    };
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.accessToken}`,
        ...buildCodexHeaders(auth.accessToken),
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    responseRaw = raw;
    if (!response.ok) {
      const payload = parseJson(raw);
      const message =
        payload?.detail ||
        payload?.error?.message ||
        payload?.error?.code ||
        `Codex request failed with status ${response.status}`;
      const error = new Error(message);
      error.retryAfter = readRetryAfter(response, payload);
      throw error;
    }

    const streamError = extractCodexStreamError(raw);
    if (streamError) {
      throw new Error(streamError);
    }

    const text = extractCodexStreamText(raw) || extractCodexResponseText(parseJson(raw));
    if (!text && !probe) {
      throw new Error('Codex returned no text');
    }

    store?.recordTranslationUsage({
      provider: CODEX_PROVIDER,
      model: getTranslationModel(config),
      requestKind,
      status: 'ok',
      usage: extractCodexUsage(raw),
      error: null,
      createdAt,
    });

    return text || 'OK';
  } catch (error) {
    store?.recordTranslationUsage({
      provider: CODEX_PROVIDER,
      model: getTranslationModel(config),
      requestKind,
      status: 'error',
      usage: extractCodexUsage(responseRaw),
      error: error.message,
      createdAt,
    });
    if (!probe && isCodexUsageLimitError(error)) {
      const circuit = openCodexCircuit(config, error);
      error.retryAfter = circuit.next_probe_at;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openCodexCircuit(config, error) {
  const store = config.translationStore;
  if (!store) {
    return null;
  }
  const current = store.getTranslationCircuit(CODEX_PROVIDER);
  const delayIndex = Math.min(Number(current.failure_count || 0), CODEX_PROBE_DELAYS_MINUTES.length - 1);
  const now = new Date();
  const scheduledProbeAt = new Date(now.getTime() + CODEX_PROBE_DELAYS_MINUTES[delayIndex] * 60_000);
  const responseRetryAt = parseRetryAfter(error.retryAfter, now);
  const nextProbeAt = responseRetryAt && responseRetryAt > scheduledProbeAt
    ? responseRetryAt.toISOString()
    : scheduledProbeAt.toISOString();
  return store.openTranslationCircuit(CODEX_PROVIDER, error.message, now.toISOString(), nextProbeAt);
}

function isCodexUsageLimitError(error) {
  return /usage limit has been reached|usage[_ -]?limit|quota.*(exceeded|reached)|insufficient_quota/i.test(
    String(error?.message || '')
  );
}

function readRetryAfter(response, payload) {
  const headerValue = response?.headers?.get?.('retry-after') || response?.headers?.get?.('x-ratelimit-reset-requests');
  return headerValue || payload?.retry_after || payload?.error?.retry_after || payload?.reset_at || null;
}

function parseRetryAfter(value, now) {
  if (value == null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric > 1_000_000_000
      ? new Date(numeric * 1000)
      : new Date(now.getTime() + numeric * 1000);
  }
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function resolveCodexAuth(config) {
  const authFile = resolveCodexAuthFile(config);
  const payload = readCodexAuthFile(authFile);
  const tokens = payload.tokens;
  const accessToken = String(tokens.access_token || '').trim();
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!accessToken || !refreshToken) {
    throw new Error(`Codex auth file is missing tokens: ${authFile}`);
  }

  if (!isJwtExpiring(accessToken, CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
    return { accessToken, authFile };
  }

  const refreshed = await refreshCodexToken({
    refreshToken,
    timeoutMs: Number(config.codexTimeoutMs) || Number(config.geminiTimeoutMs) || 90_000,
  });
  payload.tokens = {
    ...tokens,
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken || refreshToken,
  };
  writeCodexAuthFile(authFile, payload);
  return { accessToken: payload.tokens.access_token, authFile };
}

function resolveCodexAuthFile(config) {
  const configured = String(config.codexAuthFile || '').trim();
  if (configured) {
    return expandHome(configured);
  }

  const codexHome = process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

function readCodexAuthFile(authFile) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Codex auth file ${authFile}: ${error.message}`);
  }

  if (!payload || typeof payload !== 'object' || !payload.tokens || typeof payload.tokens !== 'object') {
    throw new Error(`Codex auth file has an unsupported shape: ${authFile}`);
  }

  return payload;
}

function writeCodexAuthFile(authFile, payload) {
  const directory = path.dirname(authFile);
  const temporary = path.join(directory, `.auth.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, authFile);
}

async function refreshCodexToken({ refreshToken, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.error_description ||
        payload?.error ||
        `Codex token refresh failed with status ${response.status}`;
      throw new Error(message);
    }

    const accessToken = String(payload?.access_token || '').trim();
    if (!accessToken) {
      throw new Error('Codex token refresh returned no access_token');
    }

    return {
      accessToken,
      refreshToken: String(payload?.refresh_token || '').trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildCodexHeaders(accessToken) {
  const headers = {
    'user-agent': 'codex_cli_rs/0.0.0 (NewRSS)',
    originator: 'codex_cli_rs',
  };
  const claims = decodeJwtPayload(accessToken);
  const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof accountId === 'string' && accountId.trim()) {
    headers['ChatGPT-Account-ID'] = accountId.trim();
  }

  return headers;
}

function getCodexApiModel(model) {
  const value = String(model || '').trim();
  return value.startsWith('openai-codex/') ? value.slice('openai-codex/'.length) : value;
}

function extractCodexStreamText(raw) {
  const events = parseServerSentEvents(raw);
  const deltas = [];
  let doneText = '';

  for (const event of events) {
    const payload = parseJson(event.data);
    if (!payload) {
      continue;
    }

    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      deltas.push(payload.delta);
    }

    if (payload.type === 'response.output_text.done' && typeof payload.text === 'string') {
      doneText = payload.text;
    }
  }

  return (doneText || deltas.join('')).trim();
}

function extractCodexUsage(raw) {
  const direct = parseJson(raw);
  const payloads = direct ? [direct] : parseServerSentEvents(raw).map((event) => parseJson(event.data)).filter(Boolean);
  let usage = null;
  for (const payload of payloads) {
    usage = payload?.response?.usage || payload?.usage || usage;
  }
  if (!usage) {
    return null;
  }

  return {
    inputTokens: integerUsage(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: integerUsage(usage.output_tokens ?? usage.completion_tokens),
    totalTokens: integerUsage(usage.total_tokens),
  };
}

function extractCodexStreamError(raw) {
  for (const event of parseServerSentEvents(raw)) {
    const payload = parseJson(event.data);
    const message = payload?.error?.message || payload?.response?.error?.message ||
      (payload?.type === 'error' ? payload?.message : null);
    if (message) {
      return String(message);
    }
  }
  return '';
}

function integerUsage(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function parseServerSentEvents(raw) {
  return String(raw || '')
    .split(/\n\n+/)
    .map((block) => {
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      return { data: dataLines.join('\n') };
    })
    .filter((event) => event.data);
}

function extractCodexResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = part?.text || part?.content;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }

  return parts.join('').trim();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseTranslationJson(text) {
  const stripped = stripFenceWrapperText(text);
  const direct = parseJson(stripped);
  if (direct) {
    return direct;
  }

  const objectText = extractFirstJsonObject(stripped);
  const extracted = objectText ? parseJson(objectText) : null;
  if (extracted) {
    return extracted;
  }

  throw new Error('Translation provider returned invalid JSON');
}

function extractFirstJsonObject(text) {
  const value = String(text || '');
  const start = value.indexOf('{');
  if (start === -1) {
    return '';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return '';
}

function isJwtExpiring(token, skewSeconds) {
  const claims = decodeJwtPayload(token);
  const exp = Number(claims?.exp);
  if (!Number.isFinite(exp) || exp <= 0) {
    return false;
  }

  return Date.now() / 1000 >= exp - Number(skewSeconds || 0);
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') {
    return os.homedir();
  }
  if (text.startsWith('~/')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function buildTranslationPrompt({ title, contentHtml, sourceUrl, targetLanguage }) {
  return [
    `Translate the following article title and HTML body into ${targetLanguage}.`,
    'Requirements:',
    '- Preserve the HTML structure and tags.',
    '- Preserve all href, src, and other URL attribute values unchanged.',
    '- Translate visible text naturally for readers, not literally word-by-word.',
    '- Do not add wrappers like html/body/main/section unless already present.',
    '- Keep code, URLs, proper nouns, and publication names when appropriate.',
    '- Return only valid JSON. Do not use markdown fences or add explanations.',
    '- The JSON schema is exactly: {"translatedTitle":"...","translatedContentHtml":"..."}',
    '- The translatedContentHtml value must contain the translated HTML fragment string.',
    '',
    `Source URL: ${sourceUrl || ''}`,
    `Title: ${title || ''}`,
    'HTML:',
    contentHtml,
  ].join('\n');
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function buildMarkdownChunkPrompt({ sourceTitle, sourceUrl, markdown, chunkIndex, chunkCount, targetLanguage }) {
  return [
    `Translate this markdown chunk into ${targetLanguage}.`,
    'Rules:',
    '- Preserve markdown syntax, headings, lists, blockquotes, code fences, links, and images.',
    '- Preserve all URLs unchanged.',
    '- Translate prose naturally for readers; do not explain your work.',
    '- Return only the translated markdown for this chunk.',
    '',
    `Article title: ${sourceTitle || ''}`,
    `Source URL: ${sourceUrl || ''}`,
    `Chunk: ${chunkIndex + 1} of ${chunkCount}`,
    '',
    markdown,
  ].join('\n');
}

function buildHtmlChunkPrompt({ sourceTitle, sourceUrl, html, chunkIndex, chunkCount, targetLanguage }) {
  return [
    `Translate this HTML fragment into ${targetLanguage}.`,
    'Rules:',
    '- Preserve valid HTML tags and the overall fragment structure.',
    '- Preserve every href, src, and other URL attribute value unchanged.',
    '- Translate visible prose naturally for readers; do not explain your work.',
    '- Do not add markdown fences or extra wrapper elements.',
    '- Keep code, URLs, proper nouns, and publication names when appropriate.',
    '- Return only the translated HTML fragment.',
    '',
    `Article title: ${sourceTitle || ''}`,
    `Source URL: ${sourceUrl || ''}`,
    `Chunk: ${chunkIndex + 1} of ${chunkCount}`,
    '',
    html,
  ].join('\n');
}

function stripFenceWrapperText(text) {
  const value = String(text || '').trim();
  const fenced = parseFenceWrapper(value);
  return fenced ? fenced.inner.trim() : value;
}

function unwrapTranslatedMarkdownChunk(text, originalMarkdown) {
  const value = String(text || '').trim();
  const fenced = parseFenceWrapper(value);
  if (!fenced) {
    return value;
  }

  const normalizedLang = fenced.lang.toLowerCase();
  const originalIsCodeFence = isSingleFencedCodeBlock(originalMarkdown);
  if (originalIsCodeFence) {
    if (normalizedLang === 'markdown' || normalizedLang === 'md' || normalizedLang === 'text' || normalizedLang === 'txt') {
      return fenced.inner.trim();
    }

    return value;
  }

  if (!normalizedLang || normalizedLang === 'markdown' || normalizedLang === 'md' || normalizedLang === 'text' || normalizedLang === 'txt') {
    return fenced.inner.trim();
  }

  return value;
}

function unwrapTranslatedHtmlChunk(text) {
  const value = String(text || '').trim();
  const fenced = parseFenceWrapper(value);
  if (!fenced) {
    return value;
  }

  const normalizedLang = fenced.lang.toLowerCase();
  if (!normalizedLang || normalizedLang === 'html' || normalizedLang === 'htm' || normalizedLang === 'xml' || normalizedLang === 'markup' || normalizedLang === 'text' || normalizedLang === 'txt') {
    return fenced.inner.trim();
  }

  return value;
}

function parseFenceWrapper(text) {
  const value = String(text || '').trim();
  const match = value.match(/^(```+|~~~+)([^\n]*)\n([\s\S]*?)\n\1$/);
  if (!match) {
    return null;
  }

  return {
    marker: match[1],
    lang: match[2].trim(),
    inner: match[3],
  };
}

function isSingleFencedCodeBlock(markdown) {
  const value = String(markdown || '').trim();
  if (!value) {
    return false;
  }

  return Boolean(value.match(/^(```+|~~~+)[^\n]*\n[\s\S]*?\n\1$/));
}

function deriveTitleFromMarkdown(markdown) {
  const lines = String(markdown || '')
    .split(/\r?\n+/)
    .map((line) => normalizeWhitespace(line.replace(/^#{1,6}\s+/, '')))
    .filter(Boolean);

  return lines[0] || '';
}

function isAbortLikeError(error) {
  return error?.name === 'AbortError' || /aborted/i.test(String(error?.message || ''));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
