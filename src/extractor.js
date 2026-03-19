const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { stripHtml } = require('./utils');

const MIN_CONTENT_TEXT_LENGTH = 280;
const TRUNCATED_CONTENT_PATTERNS = [
  /\bread the full story at\b/i,
  /\bcontinue reading\b/i,
  /\bread more\b/i,
  /\bfull article\b/i,
];

const looksLikeTruncatedContent = (html, text) => {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const normalizedHtml = html.replace(/\s+/g, ' ').trim();
  const tailText = normalizedText.slice(-240);
  const tailHtml = normalizedHtml.slice(-400);

  if (TRUNCATED_CONTENT_PATTERNS.some((pattern) => pattern.test(tailText) || pattern.test(tailHtml))) {
    return true;
  }

  return /(?:\u2026|\.{3})\s*$/.test(normalizedText);
};

const extractEmbeddedContent = (item) => {
  const embedded = item['content:encoded'] || item.content || item.contentSnippet || '';
  const text = stripHtml(embedded);
  const textLength = text.length;

  if (textLength >= MIN_CONTENT_TEXT_LENGTH && !looksLikeTruncatedContent(embedded, text)) {
    return {
      html: embedded,
      textLength,
      source: 'rss',
    };
  }

  return null;
};

const sanitizeHtmlForReadability = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '');

const cleanupExtractedHtml = (html) => {
  const dom = new JSDOM(`<body>${html}</body>`);
  const { document } = dom.window;

  for (const element of document.querySelectorAll('script, style, noscript, figure')) {
    const hasUsefulContent =
      element.querySelector('img, video, iframe, audio, source') ||
      stripHtml(element.innerHTML || '').length > 0;

    if (!hasUsefulContent) {
      element.remove();
    }
  }

  for (const element of document.querySelectorAll('div, section')) {
    const hasUsefulContent =
      element.querySelector('img, video, iframe, audio, source, p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote') ||
      stripHtml(element.innerHTML || '').length > 0;

    if (!hasUsefulContent) {
      element.remove();
    }
  }

  return document.body.innerHTML.trim();
};

const fetchHtml = async (url, options) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': options.userAgent,
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`fetch failed with status ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
};

const extractFromPage = async (url, options) => {
  const html = await fetchHtml(url, options);
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(sanitizeHtmlForReadability(html), {
    url,
    virtualConsole,
  });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('readability failed to extract article content');
  }

  const cleanedHtml = cleanupExtractedHtml(article.content);

  return {
    html: cleanedHtml,
    textLength: stripHtml(cleanedHtml).length,
    title: article.title || '',
    excerpt: article.excerpt || '',
    byline: article.byline || '',
    source: 'readability',
  };
};

const resolveArticleContent = async (item, options) => {
  const embedded = extractEmbeddedContent(item);
  if (embedded) {
    return embedded;
  }

  if (!item.link) {
    throw new Error('item link missing, cannot fetch article page');
  }

  return extractFromPage(item.link, options);
};

module.exports = {
  resolveArticleContent,
};
