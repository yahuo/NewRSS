const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { resolveArticleCookieHeader } = require('./article-cookies');
const { withProxy } = require('./http-client');
const { stripHtml } = require('./utils');

const MIN_CONTENT_TEXT_LENGTH = 280;
const ARTICLE_ACCEPT_HEADER =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const ARTICLE_ACCEPT_LANGUAGE_HEADER = 'en-US,en;q=0.9';
const TRUNCATED_CONTENT_PATTERNS = [
  /\bread the full story at\b/i,
  /\bcontinue reading\b/i,
  /\bread more\b/i,
  /\bfull article\b/i,
];
const FAILURE_SHELL_PATTERNS = [
  /something went wrong, but don[’']t fret/i,
  /privacy related extensions may cause issues on x\.com/i,
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

const resolveUrl = (value, baseUrl) => {
  if (!value) {
    return '';
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const findImgSource = (element) => {
  const src =
    element.getAttribute('src') ||
    element.getAttribute('data-src') ||
    element.getAttribute('data-original') ||
    '';

  if (src) {
    return src;
  }

  const srcset = element.getAttribute('srcset') || element.getAttribute('data-srcset') || '';
  if (!srcset) {
    return '';
  }

  const [firstCandidate] = srcset.split(',');
  return firstCandidate ? firstCandidate.trim().split(/\s+/)[0] : '';
};

const buildLeadImageHtml = ({ src, alt = '', caption = '' }) => {
  if (!src) {
    return '';
  }

  const safeSrc = escapeHtml(src);
  const safeAlt = escapeHtml(alt);
  const safeCaption = escapeHtml(caption);

  return `<figure data-newrss-lead-image="true"><img src="${safeSrc}" alt="${safeAlt}" loading="eager" />${
    safeCaption ? `<figcaption>${safeCaption}</figcaption>` : ''
  }</figure>`;
};

const extractLeadImageFromHtml = (html, baseUrl) => {
  if (!html) {
    return '';
  }

  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const { document } = dom.window;
  const image = document.querySelector('img');

  if (!image) {
    return '';
  }

  const src = resolveUrl(findImgSource(image), baseUrl);
  if (!src) {
    return '';
  }

  const alt = image.getAttribute('alt') || '';
  const caption =
    image.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ||
    image.getAttribute('data-caption') ||
    '';

  return buildLeadImageHtml({ src, alt, caption });
};

const extractLeadImageFromDocument = (document, baseUrl) => {
  const metaImageSelectors = [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
  ];

  for (const selector of metaImageSelectors) {
    const node = document.querySelector(selector);
    const src = resolveUrl(node?.getAttribute('content') || '', baseUrl);

    if (src) {
      const alt =
        document.querySelector('meta[property="og:image:alt"]')?.getAttribute('content') ||
        document.querySelector('meta[name="twitter:image:alt"]')?.getAttribute('content') ||
        document.querySelector('meta[property="twitter:image:alt"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
        '';

      return buildLeadImageHtml({ src, alt });
    }
  }

  const articleImage = document.querySelector('article img, main img');
  if (!articleImage) {
    return '';
  }

  return buildLeadImageHtml({
    src: resolveUrl(findImgSource(articleImage), baseUrl),
    alt: articleImage.getAttribute('alt') || '',
  });
};

const hasMeaningfulMedia = (document) => {
  if (document.querySelector('video, iframe, picture')) {
    return true;
  }

  for (const image of document.querySelectorAll('img')) {
    const width = Number.parseInt(image.getAttribute('width') || '', 10);
    const height = Number.parseInt(image.getAttribute('height') || '', 10);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return true;
    }

    if (width >= 120 || height >= 120) {
      return true;
    }
  }

  return false;
};

const ensureLeadMedia = (html, leadMediaHtml) => {
  if (!leadMediaHtml || !html) {
    return html;
  }

  const dom = new JSDOM(`<body>${html}</body>`);
  const { document } = dom.window;

  if (hasMeaningfulMedia(document)) {
    return document.body.innerHTML.trim();
  }

  document.body.insertAdjacentHTML('afterbegin', leadMediaHtml);
  return document.body.innerHTML.trim();
};

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

const looksLikeFailureShell = (html) => {
  const text = stripHtml(html || '');
  return FAILURE_SHELL_PATTERNS.some((pattern) => pattern.test(text));
};

const fetchHtml = async (url, options) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const cookieHeader = resolveArticleCookieHeader(url, options);
  const headers = {
    'user-agent': options.userAgent,
    accept: ARTICLE_ACCEPT_HEADER,
    'accept-language': ARTICLE_ACCEPT_LANGUAGE_HEADER,
  };

  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
      ...withProxy(options.upstreamProxyUrl),
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
  const fallbackLeadImageHtml = options.fallbackLeadImageHtml || extractLeadImageFromDocument(dom.window.document, url);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('readability failed to extract article content');
  }

  const cleanedHtml = ensureLeadMedia(cleanupExtractedHtml(article.content), fallbackLeadImageHtml);
  if (looksLikeFailureShell(cleanedHtml)) {
    throw new Error('readability extracted a failure shell instead of article content');
  }

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

  const fallbackLeadImageHtml = extractLeadImageFromHtml(
    item['content:encoded'] || item.content || item.contentSnippet || '',
    item.link
  );

  return extractFromPage(item.link, {
    ...options,
    fallbackLeadImageHtml,
  });
};

module.exports = {
  resolveArticleContent,
};
