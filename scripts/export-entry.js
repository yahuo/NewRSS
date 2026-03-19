const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function main() {
  const entryId = Number.parseInt(process.argv[2] || '', 10);
  const outputPathArg = process.argv[3] || '';

  if (!Number.isInteger(entryId)) {
    throw new Error('usage: node scripts/export-entry.js <entryId> [outputPath]');
  }

  const db = new DatabaseSync(path.join(process.cwd(), 'data', 'newrss.db'));
  const row = db
    .prepare(`
      SELECT id, source_title, source_url, extracted_content_html, source_content_html, translation_provider
      FROM entries
      WHERE id = ?
    `)
    .get(entryId);

  if (!row) {
    throw new Error(`entry ${entryId} not found`);
  }

  const sourceTitle = row.source_title || 'Untitled';
  const sourceHtml = row.extracted_content_html || row.source_content_html || '<p>No content available.</p>';

  const outputPath =
    outputPathArg ||
    path.join(process.cwd(), 'outputs', `entry-${entryId}-${slugify(sourceTitle)}.html`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    renderHtml({
      title: sourceTitle,
      sourceUrl: row.source_url,
      contentHtml: sourceHtml,
      provider: row.translation_provider || 'source-feed',
    })
  );

  console.log(outputPath);
}

function renderHtml({ title, sourceUrl, contentHtml, provider }) {
  return `<!doctype html>
<html lang="en" translate="yes">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f4ed;
        --card: #fffdf8;
        --ink: #1c1a16;
        --muted: #72695a;
        --line: #e6decd;
        --link: #0f5c9a;
      }
      body {
        margin: 0;
        padding: 32px 16px;
        background: linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
        color: var(--ink);
        font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif;
      }
      main {
        max-width: 860px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 32px;
        box-shadow: 0 18px 50px rgba(84, 62, 20, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.08;
      }
      .meta {
        margin-bottom: 24px;
        color: var(--muted);
      }
      .meta a {
        color: var(--link);
      }
      article {
        font-size: 1.125rem;
        line-height: 1.82;
      }
      article img {
        max-width: 100%;
        height: auto;
      }
      article a {
        color: var(--link);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        原文：<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(sourceUrl)}</a><br />
        正文来源：${escapeHtml(provider)}
      </div>
      <article>${contentHtml}</article>
    </main>
  </body>
</html>
`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
