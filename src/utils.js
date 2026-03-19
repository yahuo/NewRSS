const { createHash } = require('node:crypto');

const stripHtml = (html) => {
  if (!html) {
    return '';
  }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
};

const truncate = (value, maxLength) => {
  if (!value || value.length <= maxLength) {
    return value || '';
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
};

const hashText = (value) => createHash('sha256').update(value).digest('hex');

const isoNow = () => new Date().toISOString();

const stableGuid = (item) => {
  const rawGuid = item.guid || item.id || item.link || `${item.title || ''}:${item.pubDate || ''}`;
  return hashText(String(rawGuid));
};

const normalizeWhitespace = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/[\s\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/g, ' ')
    .trim();

const normalizeFolderPath = (value) => {
  const normalized = normalizeWhitespace(value).replace(/[\\/]+/g, '/');

  if (!normalized) {
    return '';
  }

  return normalized
    .split('/')
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean)
    .join('/');
};

const buildFeedNameFromUrl = (input) => {
  const parsedUrl = input instanceof URL ? input : new URL(String(input));
  const seed = `${parsedUrl.hostname}${parsedUrl.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return seed.slice(0, 64) || 'feed';
};

module.exports = {
  buildFeedNameFromUrl,
  hashText,
  isoNow,
  normalizeFolderPath,
  normalizeWhitespace,
  stableGuid,
  stripHtml,
  truncate,
};
