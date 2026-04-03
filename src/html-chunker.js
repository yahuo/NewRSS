const { JSDOM } = require('jsdom');
const { stripHtml } = require('./utils');

const WRAPPER_TAGS = new Set(['div', 'article', 'section', 'main']);

function buildHtmlTranslationPlan(html, { maxWords = 1200 } = {}) {
  const rawHtml = String(html || '').trim();
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

  const fragments = listMeaningfulNodes(root.childNodes)
    .map(serializeNode)
    .filter(Boolean);

  if (!fragments.length) {
    return {
      chunks: [rawHtml],
      wrap: createWrapper(wrappers),
    };
  }

  return {
    chunks: groupFragments(fragments, maxWords),
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

function groupFragments(fragments, maxWords) {
  const normalizedMaxWords = Math.max(200, Number.parseInt(maxWords, 10) || 1200);
  const chunks = [];
  let currentFragments = [];
  let currentWords = 0;

  for (const fragment of fragments) {
    const fragmentWords = countWords(stripHtml(fragment));

    if (currentFragments.length && currentWords + fragmentWords > normalizedMaxWords) {
      chunks.push(currentFragments.join('\n\n').trim());
      currentFragments = [];
      currentWords = 0;
    }

    currentFragments.push(fragment);
    currentWords += fragmentWords;
  }

  if (currentFragments.length) {
    chunks.push(currentFragments.join('\n\n').trim());
  }

  return chunks.filter(Boolean);
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
