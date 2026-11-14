const { JSDOM } = require('jsdom');
const { stripHtml } = require('./utils');

const WRAPPER_TAGS = new Set(['div', 'article', 'section', 'main']);
// 标签密集的页面（如图集）词数不多但 HTML 很长，模型需原样输出全部标签，
// 只按词数分块会让单块请求超时，因此同时限制每块字符数。
const DEFAULT_MAX_CHARS = 12_000;
const FRAGMENT_SEPARATOR = '\n\n';

function buildHtmlTranslationPlan(html, { maxWords = 1200, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const rawHtml = String(html || '').trim();
  const limits = {
    maxWords: normalizeMaxWords(maxWords),
    maxChars: normalizeMaxChars(maxChars),
  };
  if (!rawHtml) {
    return {
      chunks: [],
      wrap: (value) => String(value || '').trim(),
    };
  }

  const dom = new JSDOM(`<body>${rawHtml}</body>`);
  const { document } = dom.window;
  let root = document.body;
  const wrappers = [];

  while (root.children.length === 1 && shouldUnwrapWrapper(root.firstElementChild) && !hasMeaningfulDirectText(root)) {
    wrappers.push(root.firstElementChild.cloneNode(false));
    root = root.firstElementChild;
  }

  const fragments = listMeaningfulFragments(root.childNodes, limits);

  if (!fragments.length) {
    return {
      chunks: [rawHtml],
      wrap: createWrapper(wrappers),
    };
  }

  return {
    chunks: groupFragments(fragments, limits),
    wrap: createWrapper(wrappers),
  };
}

module.exports = {
  buildHtmlTranslationPlan,
};

function shouldUnwrapWrapper(element) {
  return Boolean(element && WRAPPER_TAGS.has(element.tagName.toLowerCase()));
}

function hasMeaningfulDirectText(root) {
  return Array.from(root.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim());
}

function listMeaningfulNodes(nodes) {
  return Array.from(nodes).filter((node) => {
    if (node.nodeType === 1) {
      return true;
    }

    return node.nodeType === 3 && node.textContent.trim();
  });
}

function listMeaningfulFragments(nodes, limits) {
  return listMeaningfulNodes(nodes).flatMap((node) => splitMeaningfulNode(node, limits));
}

function splitMeaningfulNode(node, limits) {
  const serialized = serializeNode(node);
  if (!serialized) {
    return [];
  }

  if (node.nodeType === 3) {
    return splitText(node.textContent, limits.maxWords).map(escapeHtml);
  }

  if (node.nodeType !== 1) {
    return [serialized];
  }

  if (node.matches('pre, code')) {
    return [serialized];
  }

  const wordCount = countWords(stripHtml(serialized));
  if (wordCount <= limits.maxWords && serialized.length <= limits.maxChars) {
    return [serialized];
  }

  const childFragments = listMeaningfulFragments(node.childNodes, limits);
  if (!childFragments.length) {
    return [];
  }

  const wrapper = createWrapper([node.cloneNode(false)]);
  return groupFragments(childFragments, limits).map((chunk) => wrapper(chunk)).filter(Boolean);
}

function splitText(value, maxWords) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }

  const words = text.match(/\S+/g) || [];
  if (words.length <= maxWords) {
    return [text];
  }

  const chunks = [];
  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(' '));
  }
  return chunks;
}

function serializeNode(node) {
  if (node.nodeType === 1) {
    return node.outerHTML.trim();
  }

  if (node.nodeType === 3) {
    return escapeHtml(node.textContent);
  }

  return '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupFragments(fragments, { maxWords, maxChars }) {
  const chunks = [];
  let currentFragments = [];
  let currentWords = 0;
  let currentChars = 0;

  for (const fragment of fragments) {
    const fragmentWords = countWords(stripHtml(fragment));
    const fragmentChars = fragment.length + FRAGMENT_SEPARATOR.length;

    if (
      currentFragments.length &&
      (currentWords + fragmentWords > maxWords || currentChars + fragmentChars > maxChars)
    ) {
      chunks.push(currentFragments.join(FRAGMENT_SEPARATOR).trim());
      currentFragments = [];
      currentWords = 0;
      currentChars = 0;
    }

    currentFragments.push(fragment);
    currentWords += fragmentWords;
    currentChars += fragmentChars;
  }

  if (currentFragments.length) {
    chunks.push(currentFragments.join(FRAGMENT_SEPARATOR).trim());
  }

  return chunks.filter(Boolean);
}

function normalizeMaxWords(maxWords) {
  return Math.max(200, Number.parseInt(maxWords, 10) || 1200);
}

function normalizeMaxChars(maxChars) {
  return Math.max(2_000, Number.parseInt(maxChars, 10) || DEFAULT_MAX_CHARS);
}

function countWords(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).length;
}

function createWrapper(wrappers) {
  if (!wrappers.length) {
    return (value) => String(value || '').trim();
  }

  return (value) => {
    let innerHtml = String(value || '').trim();

    for (let index = wrappers.length - 1; index >= 0; index -= 1) {
      const wrapper = wrappers[index].cloneNode(false);
      wrapper.innerHTML = innerHtml;
      innerHtml = wrapper.outerHTML;
    }

    return innerHtml.trim();
  };
}
