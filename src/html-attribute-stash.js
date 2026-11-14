const { JSDOM } = require('jsdom');

const STASH_ATTRIBUTE = 'data-k';

// 翻译前把元素属性（src、srcset、href、class 等）移出 HTML，只留短编号；
// 模型只需原样保留编号，翻译后按编号还原。图片密集的页面属性常占体积九成，
// 移出后请求和输出都大幅缩短，也避免模型改写长 URL。
function stashHtmlAttributes(html) {
  const rawHtml = String(html || '');
  if (!/<[a-z][^>]*\s[^>]*>/i.test(rawHtml)) {
    return { html: rawHtml, restore: (value) => value };
  }

  const dom = new JSDOM(`<body>${rawHtml}</body>`);
  const { body } = dom.window.document;
  const stash = [];

  for (const element of body.querySelectorAll('*')) {
    if (!element.attributes.length) {
      continue;
    }

    const attributes = Array.from(element.attributes, ({ name, value }) => [name, value]);
    for (const [name] of attributes) {
      element.removeAttribute(name);
    }
    element.setAttribute(STASH_ATTRIBUTE, String(stash.length));
    stash.push(attributes);
  }

  if (!stash.length) {
    return { html: rawHtml, restore: (value) => value };
  }

  return {
    html: body.innerHTML,
    restore: (translatedHtml) => restoreHtmlAttributes(translatedHtml, stash),
  };
}

function restoreHtmlAttributes(translatedHtml, stash) {
  const dom = new JSDOM(`<body>${String(translatedHtml || '')}</body>`);
  const { body } = dom.window.document;

  for (const element of body.querySelectorAll(`[${STASH_ATTRIBUTE}]`)) {
    const attributes = stash[Number(element.getAttribute(STASH_ATTRIBUTE))];
    element.removeAttribute(STASH_ATTRIBUTE);
    for (const [name, value] of attributes || []) {
      try {
        element.setAttribute(name, value);
      } catch {
        // 解析器接受但 setAttribute 拒绝的属性名，直接丢弃
      }
    }
  }

  return body.innerHTML.trim();
}

module.exports = {
  STASH_ATTRIBUTE,
  stashHtmlAttributes,
};
