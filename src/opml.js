const { JSDOM } = require('jsdom');

const normalizeFolderSegment = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

const joinFolderPath = (parts) => parts.map(normalizeFolderSegment).filter(Boolean).join('/');

const parseOpml = (xml) => {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const { document } = dom.window;
  const parserError = document.querySelector('parsererror');

  if (parserError) {
    throw new Error('invalid OPML');
  }

  const body = document.querySelector('body');
  if (!body) {
    throw new Error('OPML body missing');
  }

  const entries = [];

  const walk = (node, folderParts) => {
    const xmlUrl = node.getAttribute('xmlUrl') || node.getAttribute('xmlurl') || '';
    const text = node.getAttribute('text') || node.getAttribute('title') || '';
    const nextParts = xmlUrl ? folderParts : [...folderParts, normalizeFolderSegment(text)];

    if (xmlUrl) {
      entries.push({
        sourceUrl: xmlUrl.trim(),
        title: normalizeFolderSegment(text),
        folder: joinFolderPath(folderParts),
      });
    }

    for (const child of node.children) {
      if (child.tagName === 'outline') {
        walk(child, nextParts);
      }
    }
  };

  for (const outline of body.children) {
    if (outline.tagName === 'outline') {
      walk(outline, []);
    }
  }

  return entries;
};

module.exports = {
  parseOpml,
};
