const fs = require('node:fs');
const path = require('node:path');

let cachedSignature = '';
let cachedRules = [];

function resolveArticleCookieHeader(targetUrl, config = {}) {
  const rules = loadArticleCookieRules(config);
  if (!rules.length) {
    return '';
  }

  let hostname = '';
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return '';
  }

  const matchedRule = rules.find((rule) => hostname === rule.domain || hostname.endsWith(`.${rule.domain}`));
  return matchedRule?.header || '';
}

function loadArticleCookieRules(config) {
  const fileSignature = buildFileSignature(config.articleCookieFile);
  const signature = JSON.stringify({
    file: fileSignature,
    domain: config.articleCookieDomain || '',
    header: config.articleCookieHeader || '',
  });

  if (signature === cachedSignature) {
    return cachedRules;
  }

  const rules = [];
  if (config.articleCookieHeader && !config.articleCookieDomain) {
    throw new Error('ARTICLE_COOKIE_DOMAIN is required when ARTICLE_COOKIE_HEADER is set');
  }

  if (config.articleCookieFile) {
    rules.push(...loadArticleCookieRulesFromFile(config.articleCookieFile));
  }

  const directRule = buildRule(config.articleCookieDomain, config.articleCookieHeader);
  if (directRule) {
    rules.push(directRule);
  }

  cachedSignature = signature;
  cachedRules = dedupeRules(rules).sort((left, right) => right.domain.length - left.domain.length);
  return cachedRules;
}

function loadArticleCookieRulesFromFile(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`article cookie file not found: ${resolvedPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse article cookie file: ${error.message}`);
  }

  const rules = normalizeRuleCollection(parsed);
  if (!rules.length) {
    throw new Error(`article cookie file has unsupported or empty shape: ${resolvedPath}`);
  }

  return rules;
}

function buildFileSignature(filePath) {
  if (!filePath) {
    return '';
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    return `missing:${resolvedPath}`;
  }

  const stats = fs.statSync(resolvedPath);
  return `${resolvedPath}:${stats.mtimeMs}:${stats.size}`;
}

function normalizeRuleCollection(input) {
  if (Array.isArray(input)) {
    return normalizeBrowserCookieArray(input);
  }

  if (!input || typeof input !== 'object') {
    return [];
  }

  if (input.domain && (input.cookieHeader || input.cookieMap || input.cookies)) {
    return [buildRule(input.domain, input.cookieHeader || input.cookieMap || input.cookies)].filter(Boolean);
  }

  if (input.domains && typeof input.domains === 'object') {
    return normalizeDomainMap(input.domains);
  }

  return normalizeDomainMap(input);
}

function normalizeBrowserCookieArray(cookies) {
  const grouped = new Map();

  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') {
      continue;
    }

    const domain = normalizeDomain(cookie.domain);
    const name = String(cookie.name || '').trim();
    if (!domain || !name) {
      continue;
    }

    if (!grouped.has(domain)) {
      grouped.set(domain, {});
    }

    grouped.get(domain)[name] = String(cookie.value ?? '');
  }

  return Array.from(grouped.entries())
    .map(([domain, cookieMap]) => buildRule(domain, cookieMap))
    .filter(Boolean);
}

function normalizeDomainMap(domainMap) {
  return Object.entries(domainMap)
    .map(([domain, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return buildRule(domain, value.cookieHeader || value.cookieMap || value.cookies || value);
      }

      return buildRule(domain, value);
    })
    .filter(Boolean);
}

function buildRule(domain, value) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    return null;
  }

  const header = normalizeCookieHeader(value);
  if (!header) {
    return null;
  }

  return {
    domain: normalizedDomain,
    header,
  };
}

function normalizeCookieHeader(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue != null && String(entryValue).trim() !== '')
    .map(([name, entryValue]) => `${name}=${String(entryValue).trim()}`);

  return entries.join('; ');
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
}

function dedupeRules(rules) {
  const deduped = new Map();
  for (const rule of rules) {
    deduped.set(rule.domain, rule);
  }

  return Array.from(deduped.values());
}

module.exports = {
  resolveArticleCookieHeader,
};
