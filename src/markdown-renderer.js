const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const { stripHtml, truncate } = require('./utils');

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
});

const originalLinkOpen =
  markdown.renderer.rules.link_open ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noreferrer');
  return originalLinkOpen(tokens, idx, options, env, self);
};

function renderMarkdown(markdownInput, options = {}) {
  const raw = String(markdownInput || '');
  const { frontmatter, body } = parseFrontmatter(raw);
  const overrideTitle = String(options.title || '').trim();
  const fallbackTitle = String(options.fallbackTitle || '').trim();
  const inferredTitle =
    overrideTitle ||
    stripWrappingQuotes(frontmatter.title || '') ||
    extractTitleFromMarkdown(body) ||
    fallbackTitle ||
    'Untitled';
  const author =
    String(options.author || '').trim() ||
    stripWrappingQuotes(frontmatter.author || '');
  const sourceUrl =
    String(options.sourceUrl || '').trim() ||
    stripWrappingQuotes(frontmatter.url || frontmatter.requestedUrl || '');
  const cleanedBody = removeLeadingTitle(body, inferredTitle);
  const plainText = collapseWhitespace(stripHtml(markdown.render(cleanedBody)));
  const readingTimeMinutes = Math.max(1, Math.round(countReadableChars(plainText) / 200));
  const summary =
    stripWrappingQuotes(frontmatter.description || frontmatter.summary || '') ||
    truncate(plainText, 120);
  const contentHtml = [
    `<section class="container">`,
    renderReadingNote(plainText, readingTimeMinutes),
    markdown.render(cleanedBody).trim(),
    `</section>`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    title: inferredTitle,
    author,
    summary,
    html: renderHtmlDocument({
      title: inferredTitle,
      author,
      summary,
      sourceUrl,
      contentHtml,
    }),
    contentHtml,
  };
}

function renderMarkdownFile(markdownPath, options = {}) {
  const raw = fs.readFileSync(markdownPath, 'utf8');
  const result = renderMarkdown(raw, {
    ...options,
    fallbackTitle: path.basename(markdownPath, path.extname(markdownPath)),
  });
  const htmlPath = markdownPath.replace(/\.md$/i, '.html');
  fs.writeFileSync(htmlPath, result.html, 'utf8');

  return {
    ...result,
    htmlPath,
  };
}

module.exports = {
  renderMarkdown,
  renderMarkdownFile,
};

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const rawFrontmatter = content.slice(4, end).split('\n');
  const frontmatter = {};
  for (const line of rawFrontmatter) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    frontmatter[key] = stripWrappingQuotes(value);
  }

  return {
    frontmatter,
    body: content.slice(end + 5),
  };
}

function extractTitleFromMarkdown(markdownBody) {
  const match = markdownBody.match(/^\s*#\s+(.+?)\s*$/m);
  return match ? collapseWhitespace(match[1]) : '';
}

function removeLeadingTitle(markdownBody, title) {
  const trimmedTitle = collapseWhitespace(title);
  const match = markdownBody.match(/^(\s*#\s+(.+?)\s*(?:\r?\n)+)/);
  if (!match) {
    return markdownBody.trim();
  }

  const headingTitle = collapseWhitespace(match[2]);
  if (trimmedTitle && headingTitle === trimmedTitle) {
    return markdownBody.slice(match[1].length).trim();
  }

  return markdownBody.trim();
}

function renderReadingNote(text, readingTimeMinutes) {
  const charCount = countReadableChars(text);
  if (!charCount) {
    return '';
  }

  return `<blockquote class="md-blockquote"><p class="md-blockquote-p">字数 ${charCount}，阅读大约需 ${readingTimeMinutes} 分钟</p></blockquote>`;
}

function renderHtmlDocument({ title, author, summary, sourceUrl, contentHtml }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${author ? `<meta name="author" content="${escapeHtml(author)}" />` : ''}
    ${summary ? `<meta name="description" content="${escapeHtml(summary)}" />` : ''}
    ${sourceUrl ? `<meta name="x-source-url" content="${escapeHtml(sourceUrl)}" />` : ''}
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --ink: #202124;
        --muted: #5f6368;
        --line: #e6e6e6;
        --link: #0f4c81;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 24px;
        background: var(--bg);
        color: var(--ink);
        max-width: 860px;
        margin-inline: auto;
        font-family: "Source Han Serif SC", "Noto Serif CJK SC", "Source Han Serif CN", STSong, SimSun, serif;
        font-size: 16px;
        line-height: 1.75;
        text-align: left;
      }
      #output {
        width: 100%;
      }
      .container > :first-child {
        margin-top: 0;
      }
      p,
      ul,
      ol,
      blockquote,
      pre,
      table {
        margin: 1.5em 8px;
        letter-spacing: 0.1em;
        color: #3f3f3f;
      }
      h1,
      h2,
      h3,
      h4 {
        margin: 1.5em 8px 0.8em;
        line-height: 1.35;
        color: #1f1f1f;
      }
      a {
        color: var(--link);
      }
      img {
        display: block;
        width: 100%;
        max-width: 100%;
        height: auto;
        margin: 1.5em auto;
      }
      blockquote {
        margin-right: 0;
        margin-left: 0;
        font-style: normal;
        padding: 1em;
        border-left: 4px solid #0F4C81;
        border-radius: 6px;
        background: #f7f7f7;
      }
      .md-blockquote {
        margin-top: 0 !important;
      }
      .md-blockquote-p {
        display: block;
        font-size: 1em;
        letter-spacing: 0.1em;
        color: #3f3f3f;
        margin: 0;
      }
      code {
        padding: 0.15em 0.35em;
        border-radius: 4px;
        background: #f5f5f5;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }
      pre {
        overflow-x: auto;
        padding: 14px 16px;
        border-radius: 10px;
        background: #f5f5f5;
      }
      pre code {
        padding: 0;
        background: transparent;
      }
      hr {
        border: 0;
        border-top: 1px solid var(--line);
        margin: 2em 0;
      }
    </style>
  </head>
  <body>
    <div id="output">
${contentHtml}
    </div>
  </body>
</html>`;
}

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countReadableChars(text) {
  return collapseWhitespace(text).replace(/\s+/g, '').length;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
