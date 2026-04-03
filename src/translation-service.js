const { buildHtmlTranslationPlan } = require('./html-chunker');
const { renderMarkdown } = require('./markdown-renderer');
const { chunkMarkdown } = require('./markdown-chunker');
const { extractMarkdownHeadingTitle, normalizeDerivedTitle, normalizeWhitespace, stripHtml, truncate } = require('./utils');

const ENGLISH_SAMPLE_LIMIT = 6_000;
const MAX_TRANSLATABLE_CHARS = 120_000;

class TranslationService {
  constructor(config) {
    this.config = config;
  }

  isEnabled() {
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
      const response = await callGemini({
        apiKey: this.config.geminiApiKey,
        model: this.config.geminiModel,
        timeoutMs: this.config.geminiTimeoutMs,
        prompt,
      });

      const translatedTitle = normalizeWhitespace(response.translatedTitle || '');
      const translatedContentHtml = String(response.translatedContentHtml || '').trim();
      if (!translatedTitle || !translatedContentHtml) {
        throw new Error('Gemini translation returned incomplete fields');
      }

      return {
        translatedTitle: truncate(translatedTitle, 120),
        translatedContentHtml,
        provider: this.config.geminiModel,
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
      Math.max(1, Number(this.config.geminiChunkConcurrency) || 3),
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
      provider: `${this.config.geminiModel}-md-chunked`,
    };
  }

  async translateTitle({ title, sourceUrl }) {
    const text = await callGeminiText({
      apiKey: this.config.geminiApiKey,
      model: this.config.geminiModel,
      timeoutMs: this.config.geminiTimeoutMs,
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
    const translated = await callGeminiText({
      apiKey: this.config.geminiApiKey,
      model: this.config.geminiModel,
      timeoutMs: this.config.geminiTimeoutMs,
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
      Math.max(1, Number(this.config.geminiChunkConcurrency) || 3),
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
      provider: `${this.config.geminiModel}-html-chunked`,
    };
  }

  async translateHtmlChunk({ sourceTitle, sourceUrl, chunkHtml, chunkIndex, chunkCount }) {
    const translated = await callGeminiText({
      apiKey: this.config.geminiApiKey,
      model: this.config.geminiModel,
      timeoutMs: this.config.geminiTimeoutMs,
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
}

module.exports = TranslationService;

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

function buildTranslationPrompt({ title, contentHtml, sourceUrl, targetLanguage }) {
  return [
    `Translate the following article title and HTML body into ${targetLanguage}.`,
    'Requirements:',
    '- Preserve the HTML structure and tags.',
    '- Preserve all href, src, and other URL attribute values unchanged.',
    '- Translate visible text naturally for readers, not literally word-by-word.',
    '- Do not add wrappers like html/body/main/section unless already present.',
    '- Keep code, URLs, proper nouns, and publication names when appropriate.',
    '- Return only valid JSON matching the schema.',
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
