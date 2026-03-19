const { JSDOM } = require('jsdom');

const decodeHtmlEntities = (value) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, summary, td, th, pre, code';

const normalizeLanguageCode = (value) => {
  if (!value) {
    return '';
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh';
  }

  return normalized.split(/[-_]/)[0];
};

const collapseWhitespace = (value) => String(value).replace(/\s+/g, ' ').trim();

class PassthroughTranslator {
  constructor(targetLanguage) {
    this.provider = 'passthrough';
    this.targetLanguage = targetLanguage;
  }

  async translate({ title, html }) {
    return {
      title,
      html,
      provider: this.provider,
    };
  }
}

class LinguaSparkTranslator {
  constructor({ baseUrl, apiKey, targetLanguage, timeoutMs }) {
    this.provider = 'linguaspark';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.targetLanguage = normalizeLanguageCode(targetLanguage);
    this.timeoutMs = timeoutMs;
  }

  async request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      'content-type': 'application/json',
    };

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LinguaSpark request failed with status ${response.status}: ${errorText}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async translateBatch(texts, from = 'auto') {
    if (!texts.length) {
      return [];
    }

    const translated = [];
    const target = this.targetLanguage || 'zh';

    for (let index = 0; index < texts.length; index += 40) {
      const chunk = texts.slice(index, index + 40);
      const result = await this.request('/imme', {
        source_lang: from || 'auto',
        target_lang: target,
        text_list: chunk,
      });

      for (const item of result.translations || []) {
        translated.push(item.text || '');
      }
    }

    return translated;
  }

  isLeafBlock(element) {
    return !Array.from(element.querySelectorAll(BLOCK_SELECTOR)).some((child) => child !== element);
  }

  collectBlocks(document) {
    return Array.from(document.querySelectorAll(BLOCK_SELECTOR)).filter((element) => {
      if (!this.isLeafBlock(element)) {
        return false;
      }

      return collapseWhitespace(element.textContent).length > 0;
    });
  }

  async translateHtml(html) {
    if (!html) {
      return html;
    }

    const dom = new JSDOM(`<body>${html}</body>`);
    const { document } = dom.window;
    const blocks = this.collectBlocks(document);

    if (!blocks.length) {
      const text = collapseWhitespace(document.body.textContent);
      if (!text) {
        return html;
      }

      const [translated] = await this.translateBatch([text]);
      document.body.textContent = translated;
      return document.body.innerHTML;
    }

    const sourceTexts = blocks.map((element) => collapseWhitespace(element.textContent));
    const translatedTexts = await this.translateBatch(sourceTexts);

    blocks.forEach((element, index) => {
      const translatedText = translatedTexts[index];
      if (!translatedText) {
        return;
      }

      element.textContent = translatedText;
    });

    return document.body.innerHTML;
  }

  async translate({ title, html }) {
    const [translatedTitleList, translatedHtml] = await Promise.all([
      title ? this.translateBatch([title]) : Promise.resolve([]),
      html ? this.translateHtml(html) : Promise.resolve(html),
    ]);

    return {
      title: translatedTitleList[0] || title,
      html: translatedHtml,
      provider: this.provider,
    };
  }
}

class GoogleCloudTranslator {
  constructor({ apiKey, targetLanguage, timeoutMs }) {
    this.provider = 'google-cloud';
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
    this.timeoutMs = timeoutMs;
  }

  async request(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`translation request failed with status ${response.status}: ${errorText}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async translate({ title, html }) {
    const [titleResult, htmlResult] = await Promise.all([
      title
        ? this.request({
            q: title,
            target: this.targetLanguage,
            format: 'text',
          })
        : Promise.resolve(null),
      html
        ? this.request({
            q: html,
            target: this.targetLanguage,
            format: 'html',
          })
        : Promise.resolve(null),
    ]);

    return {
      title: titleResult ? decodeHtmlEntities(titleResult.data.translations[0].translatedText) : title,
      html: htmlResult ? htmlResult.data.translations[0].translatedText : html,
      provider: this.provider,
    };
  }
}

const createTranslator = (config) => {
  if (config.translatorMode === 'linguaspark') {
    return new LinguaSparkTranslator({
      baseUrl: config.linguaSparkUrl,
      apiKey: config.linguaSparkApiKey,
      targetLanguage: config.targetLanguage,
      timeoutMs: config.httpTimeoutMs,
    });
  }

  if (config.translatorMode === 'google-cloud') {
    if (!config.googleTranslateApiKey) {
      throw new Error('TRANSLATOR_MODE=google-cloud requires GOOGLE_TRANSLATE_API_KEY');
    }

    return new GoogleCloudTranslator({
      apiKey: config.googleTranslateApiKey,
      targetLanguage: config.targetLanguage,
      timeoutMs: config.httpTimeoutMs,
    });
  }

  return new PassthroughTranslator(config.targetLanguage);
};

module.exports = {
  createTranslator,
};
