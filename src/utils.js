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

module.exports = {
  hashText,
  isoNow,
  stableGuid,
  stripHtml,
  truncate,
};

