const { JSDOM } = require('jsdom');

const NEWS_NAMESPACE = 'http://www.google.com/schemas/sitemap-news/0.9';
const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const REUTERS_PATH_LANGUAGE = new Map([
  ['ar', 'ar'],
  ['de', 'de'],
  ['es', 'es'],
  ['fr', 'fr'],
  ['it', 'it'],
  ['jp', 'ja'],
  ['latam', 'es'],
  ['pt', 'pt'],
]);

const elementText = (node, namespace, localName) =>
  node?.getElementsByTagNameNS(namespace, localName)?.[0]?.textContent?.trim() || '';

const normalizedFilter = (values) => new Set(
  (values || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean)
);

const itemLanguageAndSection = (link, metadataLanguage) => {
  let parsedLink;
  try {
    parsedLink = new URL(link);
  } catch {
    return null;
  }
  const path = parsedLink.pathname.split('/').filter(Boolean).map((value) => value.toLowerCase());
  const isReuters = parsedLink.hostname === 'reuters.com' || parsedLink.hostname.endsWith('.reuters.com');
  const pathLanguage = isReuters ? REUTERS_PATH_LANGUAGE.get(path[0]) : '';
  if (pathLanguage) {
    path.shift();
  }

  const section = path[0] === 'commentary' && path[1] === 'breakingviews'
    ? 'breakingviews'
    : path[0] || '';
  return {
    language: pathLanguage || (isReuters ? 'en' : String(metadataLanguage || '').trim().toLowerCase()),
    section,
  };
};

const parseNewsSitemap = (xml, sourceUrl, options = {}) => {
  if (!String(xml || '').includes(NEWS_NAMESPACE)) {
    return null;
  }

  let dom;
  try {
    dom = new JSDOM(xml, { contentType: 'text/xml' });
  } catch {
    return null;
  }

  const root = dom.window.document.documentElement;
  if (root?.localName !== 'urlset') {
    return null;
  }

  let publicationName = '';
  const languages = normalizedFilter(options.languages);
  const sections = normalizedFilter(options.sections);
  const items = Array.from(root.children)
    .filter((node) => node.localName === 'url')
    .map((node) => {
      const news = node.getElementsByTagNameNS(NEWS_NAMESPACE, 'news')[0];
      const link = elementText(node, SITEMAP_NAMESPACE, 'loc');
      if (!news || !link) {
        return null;
      }

      publicationName ||= elementText(news, NEWS_NAMESPACE, 'name');
      const dimensions = itemLanguageAndSection(
        link,
        elementText(news, NEWS_NAMESPACE, 'language')
      );
      if (!dimensions) {
        return null;
      }
      const { language, section } = dimensions;
      if ((languages.size && !languages.has(language)) || (sections.size && !sections.has(section))) {
        return null;
      }

      return {
        guid: link,
        title: elementText(news, NEWS_NAMESPACE, 'title'),
        link,
        isoDate: elementText(news, NEWS_NAMESPACE, 'publication_date'),
      };
    })
    .filter(Boolean);
  items.sort((left, right) => {
    const leftTime = Date.parse(left.isoDate);
    const rightTime = Date.parse(right.isoDate);
    if (!Number.isFinite(leftTime)) {
      return Number.isFinite(rightTime) ? 1 : 0;
    }
    if (!Number.isFinite(rightTime)) {
      return -1;
    }
    return rightTime - leftTime;
  });

  return {
    title: publicationName || new URL(sourceUrl).hostname,
    link: new URL('/', sourceUrl).toString(),
    items,
  };
};

module.exports = {
  parseNewsSitemap,
};
