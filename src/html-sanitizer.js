const { JSDOM } = require('jsdom');

const ALLOWED_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

const DANGEROUS_ELEMENTS = new Set([
  'applet',
  'audio',
  'base',
  'button',
  'canvas',
  'embed',
  'fieldset',
  'form',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'optgroup',
  'option',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'track',
  'video',
]);

const GLOBAL_ATTRIBUTES = new Set(['class', 'dir', 'lang', 'title']);
const ELEMENT_ATTRIBUTES = new Map([
  ['a', new Set(['href', 'hreflang', 'rel', 'target'])],
  ['col', new Set(['span'])],
  ['colgroup', new Set(['span'])],
  ['del', new Set(['datetime'])],
  ['details', new Set(['open'])],
  ['img', new Set(['alt', 'height', 'loading', 'src', 'srcset', 'width'])],
  ['ins', new Set(['datetime'])],
  ['li', new Set(['value'])],
  ['ol', new Set(['reversed', 'start', 'type'])],
  ['source', new Set(['media', 'sizes', 'src', 'srcset', 'type'])],
  ['td', new Set(['colspan', 'headers', 'rowspan'])],
  ['th', new Set(['abbr', 'colspan', 'headers', 'rowspan', 'scope'])],
  ['time', new Set(['datetime'])],
]);

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_RESOURCE_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_REL_TOKENS = new Set(['nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc']);

function sanitizeHtml(html, { baseUrl = '' } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { document } = dom.window;
  const container = document.createElement('div');
  container.innerHTML = String(html || '');

  sanitizeChildren(container, String(baseUrl || '').trim());

  const sanitized = container.innerHTML.trim();
  dom.window.close();
  return sanitized;
}

module.exports = {
  sanitizeHtml,
};

function sanitizeChildren(parent, baseUrl) {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 8) {
      child.remove();
      continue;
    }

    if (child.nodeType !== 1) {
      continue;
    }

    const tagName = child.tagName.toLowerCase();
    if (DANGEROUS_ELEMENTS.has(tagName)) {
      child.remove();
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(tagName)) {
      sanitizeChildren(child, baseUrl);
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }

    sanitizeAttributes(child, tagName, baseUrl);
    sanitizeChildren(child, baseUrl);
  }
}

function sanitizeAttributes(element, tagName, baseUrl) {
  const allowedAttributes = ELEMENT_ATTRIBUTES.get(tagName);

  for (const attribute of Array.from(element.attributes)) {
    const attributeName = attribute.name.toLowerCase();
    const isExplicitlyUnsafe =
      attributeName === 'srcdoc' || attributeName === 'style' || attributeName.startsWith('on');
    const isAllowed = GLOBAL_ATTRIBUTES.has(attributeName) || allowedAttributes?.has(attributeName);

    if (isExplicitlyUnsafe || !isAllowed) {
      element.removeAttribute(attribute.name);
    }
  }

  if (element.hasAttribute('href')) {
    sanitizeUrlAttribute(element, 'href', baseUrl, SAFE_LINK_PROTOCOLS);
  }
  if (element.hasAttribute('src')) {
    sanitizeUrlAttribute(element, 'src', baseUrl, SAFE_RESOURCE_PROTOCOLS);
  }
  if (element.hasAttribute('srcset')) {
    const srcset = sanitizeSrcset(element.getAttribute('srcset'), baseUrl);
    if (srcset) {
      element.setAttribute('srcset', srcset);
    } else {
      element.removeAttribute('srcset');
    }
  }

  if (tagName === 'a') {
    sanitizeAnchor(element);
  }
}

function sanitizeUrlAttribute(element, attributeName, baseUrl, allowedProtocols) {
  const normalizedUrl = normalizeSafeUrl(element.getAttribute(attributeName), baseUrl, allowedProtocols);
  if (normalizedUrl) {
    element.setAttribute(attributeName, normalizedUrl);
  } else {
    element.removeAttribute(attributeName);
  }
}

function normalizeSafeUrl(value, baseUrl, allowedProtocols) {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) {
    return '';
  }

  let parsedUrl;
  try {
    parsedUrl = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    return '';
  }

  return allowedProtocols.has(parsedUrl.protocol.toLowerCase()) ? parsedUrl.href : '';
}

function sanitizeSrcset(value, baseUrl) {
  return String(value || '')
    .split(',')
    .map((candidate) => sanitizeSrcsetCandidate(candidate, baseUrl))
    .filter(Boolean)
    .join(', ');
}

function sanitizeSrcsetCandidate(candidate, baseUrl) {
  const match = String(candidate || '').trim().match(/^(\S+)(?:\s+(\S+))?$/);
  if (!match) {
    return '';
  }

  const [, rawUrl, descriptor = ''] = match;
  if (descriptor && !/^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) {
    return '';
  }

  const normalizedUrl = normalizeSafeUrl(rawUrl, baseUrl, SAFE_RESOURCE_PROTOCOLS);
  return normalizedUrl ? `${normalizedUrl}${descriptor ? ` ${descriptor}` : ''}` : '';
}

function sanitizeAnchor(anchor) {
  if (anchor.hasAttribute('target')) {
    if (anchor.getAttribute('target').toLowerCase() === '_blank') {
      anchor.setAttribute('target', '_blank');
    } else {
      anchor.removeAttribute('target');
    }
  }

  const relTokens = String(anchor.getAttribute('rel') || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((token, index, tokens) => SAFE_REL_TOKENS.has(token) && tokens.indexOf(token) === index);

  for (const requiredToken of ['noopener', 'noreferrer']) {
    if (!relTokens.includes(requiredToken)) {
      relTokens.push(requiredToken);
    }
  }

  anchor.setAttribute('rel', relTokens.join(' '));
}
