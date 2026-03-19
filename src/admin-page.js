function renderAdminPage({ feeds, baseUrl }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NewRSS 管理</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe6;
        --panel: rgba(255, 251, 244, 0.94);
        --ink: #1c1a16;
        --muted: #6f6757;
        --line: #ddd1bc;
        --accent: #0f5c9a;
        --danger: #9a2f2f;
        --shadow: 0 18px 50px rgba(75, 54, 18, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(255, 250, 239, 0.92), transparent 28%),
          linear-gradient(180deg, #f7f2e7 0%, var(--bg) 100%);
        color: var(--ink);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .shell {
        max-width: 1180px;
        margin: 0 auto;
      }
      .hero {
        display: grid;
        gap: 18px;
        margin-bottom: 20px;
      }
      .hero h1 {
        margin: 0;
        font-size: clamp(2rem, 5vw, 3.4rem);
        line-height: 0.98;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        max-width: 760px;
        line-height: 1.7;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .actions a, button, .button-like {
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--ink);
        border-radius: 999px;
        padding: 10px 16px;
        font: inherit;
        cursor: pointer;
        text-decoration: none;
        box-shadow: var(--shadow);
      }
      button.primary, .button-like.primary {
        background: var(--accent);
        color: #fff;
        border-color: transparent;
      }
      button.danger {
        color: var(--danger);
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(280px, 360px) 1fr;
        gap: 20px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 20px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }
      .card h2 {
        margin: 0 0 12px;
        font-size: 1.2rem;
      }
      .section-divider {
        margin: 18px 0;
        border: 0;
        border-top: 1px solid var(--line);
      }
      .stack {
        display: grid;
        gap: 12px;
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 0.95rem;
      }
      input {
        width: 100%;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--line);
        font: inherit;
        background: #fff;
      }
      .hint {
        color: var(--muted);
        font-size: 0.9rem;
        line-height: 1.6;
      }
      .status {
        min-height: 24px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .folder {
        margin-bottom: 18px;
      }
      .folder h3 {
        margin: 0 0 8px;
        font-size: 1rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .feed-list {
        display: grid;
        gap: 12px;
      }
      .feed-item {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        background: rgba(255, 255, 255, 0.7);
      }
      .feed-item header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 8px;
      }
      .feed-item strong {
        font-size: 1.02rem;
      }
      .pill {
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(15, 92, 154, 0.09);
        color: var(--accent);
        font-size: 0.82rem;
      }
      .pill.warn {
        background: rgba(185, 109, 22, 0.14);
        color: #a15812;
      }
      .pill.danger {
        background: rgba(154, 47, 47, 0.12);
        color: var(--danger);
      }
      .meta {
        display: grid;
        gap: 4px;
        color: var(--muted);
        font-size: 0.9rem;
        line-height: 1.5;
      }
      .meta a {
        color: var(--accent);
        word-break: break-all;
      }
      .row-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      .errors {
        display: grid;
        gap: 8px;
        margin-top: 14px;
      }
      .error-box {
        border-radius: 14px;
        padding: 12px 14px;
        background: rgba(154, 47, 47, 0.08);
        border: 1px solid rgba(154, 47, 47, 0.16);
        color: #6f2c2c;
        line-height: 1.55;
      }
      .error-box strong {
        display: block;
        margin-bottom: 4px;
        color: var(--danger);
      }
      .error-list {
        margin: 0;
        padding-left: 18px;
      }
      .error-list li + li {
        margin-top: 6px;
      }
      .empty {
        color: var(--muted);
        border: 1px dashed var(--line);
        border-radius: 18px;
        padding: 24px;
        text-align: center;
      }
      @media (max-width: 900px) {
        body { padding: 16px; }
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <h1>NewRSS Feed 管理</h1>
        <p>维护你的源列表，按目录组织输出，并导出 OPML 给 Reeder 等阅读器。每个源会生成一个 reader-view feed，文章链接会落到本服务托管的正文页。</p>
        <div class="actions">
          <a href="${escapeHtml(baseUrl)}/opml.xml">导出 OPML</a>
          <a href="${escapeHtml(baseUrl)}/healthz">健康检查</a>
        </div>
      </section>

      <section class="layout">
        <aside class="card">
          <h2>新增或更新源</h2>
          <form id="feed-form" class="stack">
            <label>
              名称
              <input name="name" placeholder="例如 wired" />
            </label>
            <label>
              RSS 地址
              <input name="sourceUrl" placeholder="https://example.com/feed.xml" required />
            </label>
            <label>
              目录
              <input name="folder" placeholder="例如 AI / News / Deals" />
            </label>
            <button class="primary" type="submit">保存源</button>
            <div class="hint">名称为空时，会根据 URL 自动生成一个 slug。同名保存会更新地址和目录。</div>
            <div class="status" id="status"></div>
          </form>
          <hr class="section-divider" />
          <h2>导入 OPML</h2>
          <form id="opml-form" class="stack">
            <label>
              OPML 文件
              <input name="opmlFile" type="file" accept=".opml,.xml,text/xml,application/xml" required />
            </label>
            <label>
              覆盖目录
              <input name="folder" placeholder="留空则使用 OPML 中的目录" />
            </label>
            <button class="primary" type="submit">导入 OPML</button>
            <div class="hint">如果填写目录，导入的所有源都会进入这个目录；如果留空，就按 OPML 自带的目录结构导入。</div>
            <div class="status" id="opml-status"></div>
          </form>
        </aside>

        <main class="card">
          <h2>源列表</h2>
          <div id="feed-root"></div>
        </main>
      </section>
    </div>

    <script>
      const initialFeeds = ${safeJson(feeds)};
      const root = document.getElementById('feed-root');
      const form = document.getElementById('feed-form');
      const status = document.getElementById('status');
      const opmlForm = document.getElementById('opml-form');
      const opmlStatus = document.getElementById('opml-status');

      render(initialFeeds);

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const payload = {
          name: String(formData.get('name') || '').trim(),
          sourceUrl: String(formData.get('sourceUrl') || '').trim(),
          folder: String(formData.get('folder') || '').trim(),
        };

        try {
          setStatus('正在保存…');
          const response = await fetch('/api/feeds', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (!response.ok || !data.ok) {
            throw new Error(data.error || '保存失败');
          }
          form.reset();
          setStatus('已保存');
          await reload();
        } catch (error) {
          setStatus(error.message);
        }
      });

      opmlForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(opmlForm);
        const file = formData.get('opmlFile');
        const folder = String(formData.get('folder') || '').trim();

        if (!(file instanceof File) || !file.size) {
          setOpmlStatus('请选择一个 OPML 文件');
          return;
        }

        try {
          setOpmlStatus('正在导入…');
          const opmlXml = await file.text();
          const response = await fetch('/api/opml/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ opmlXml, folder }),
          });
          const data = await response.json();
          if (!response.ok || !data.ok) {
            throw new Error(data.error || '导入失败');
          }

          opmlForm.reset();
          setOpmlStatus(\`已导入 \${data.result.total} 个源，新建 \${data.result.created} 个，更新 \${data.result.updated} 个\`);
          await reload();
        } catch (error) {
          setOpmlStatus(error.message);
        }
      });

      async function reload() {
        const response = await fetch('/api/feeds');
        const data = await response.json();
        render(data.feeds || []);
      }

      function render(feeds) {
        if (!feeds.length) {
          root.innerHTML = '<div class="empty">还没有配置任何源。</div>';
          return;
        }

        const groups = new Map();
        for (const feed of feeds) {
          const folder = normalizeFolder(feed.folder) || '未分类';
          if (!groups.has(folder)) groups.set(folder, []);
          groups.get(folder).push({ ...feed, folder });
        }

        root.innerHTML = Array.from(groups.entries()).map(([folder, items]) => {
          return \`<section class="folder">
            <h3>\${escapeHtml(folder)}</h3>
            <div class="feed-list">
              \${items.map((feed) => {
                const statusClass = feed.lastRefreshStatus === 'error'
                  ? 'pill danger'
                  : feed.lastRefreshStatus === 'partial'
                    ? 'pill warn'
                    : 'pill';
                const statusText = feed.lastRefreshStatus === 'error'
                  ? '源失败'
                  : feed.lastRefreshStatus === 'partial'
                    ? '部分失败'
                    : feed.lastRefreshStatus === 'ok'
                      ? '正常'
                      : '未刷新';
                return \`<article class="feed-item">
                  <header>
                    <strong>\${escapeHtml(feed.title)}</strong>
                    <span class="\${statusClass}">\${statusText}</span>
                  </header>
                  <div class="meta">
                    <div>名称：\${escapeHtml(feed.name)}</div>
                    <div>源地址：<a href="\${escapeHtml(feed.sourceUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(feed.sourceUrl)}</a></div>
                    <div>Feed：<a href="\${escapeHtml(feed.feedUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(feed.feedUrl)}</a></div>
                    <div>最近刷新：\${escapeHtml(feed.lastRefreshedAt || '未刷新')}</div>
                    <div>已抓取：\${Number(feed.entryCount || 0)} 篇，最近失败：\${Number(feed.errorCount || 0)} 篇</div>
                  </div>
                  <div class="row-actions">
                    <button type="button" data-action="refresh" data-name="\${escapeHtml(feed.name)}">刷新</button>
                    <a class="button-like" href="\${escapeHtml(feed.feedUrl)}" target="_blank" rel="noreferrer">查看 Feed</a>
                    <button class="danger" type="button" data-action="delete" data-name="\${escapeHtml(feed.name)}">删除</button>
                  </div>
                  \${renderErrors(feed)}
                </article>\`;
              }).join('')}
            </div>
          </section>\`;
        }).join('');

        root.querySelectorAll('button[data-action]').forEach((button) => {
          button.addEventListener('click', async () => {
            const action = button.dataset.action;
            const name = button.dataset.name;
            try {
              if (action === 'delete') {
                if (!window.confirm(\`确定删除源 "\${name}" 吗？\`)) return;
                setStatus('正在删除…');
                const response = await fetch(\`/api/feeds/\${encodeURIComponent(name)}\`, { method: 'DELETE' });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.error || '删除失败');
              } else if (action === 'refresh') {
                setStatus('正在刷新…');
                const response = await fetch(\`/api/feeds/\${encodeURIComponent(name)}/refresh\`, { method: 'POST' });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.error || '刷新失败');
              }
              setStatus('完成');
              await reload();
            } catch (error) {
              setStatus(error.message);
            }
          });
        });
      }

      function setStatus(message) {
        status.textContent = message || '';
      }

      function setOpmlStatus(message) {
        opmlStatus.textContent = message || '';
      }

      function renderErrors(feed) {
        const blocks = [];

        if (feed.lastRefreshError) {
          blocks.push(\`<div class="error-box"><strong>最近一次源级错误</strong><div>\${escapeHtml(feed.lastRefreshError)}</div></div>\`);
        }

        if (Array.isArray(feed.recentEntryErrors) && feed.recentEntryErrors.length) {
          blocks.push(\`<div class="error-box"><strong>最近文章抓取失败</strong><ol class="error-list">\${feed.recentEntryErrors.map((entry) => \`<li><div>\${escapeHtml(entry.title)}</div><div>\${escapeHtml(entry.error || '未知错误')}</div><div>\${escapeHtml(entry.refreshedAt || '')}</div><div><a href="\${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">查看原文</a></div></li>\`).join('')}</ol></div>\`);
        }

        if (!blocks.length) {
          return '';
        }

        return \`<div class="errors">\${blocks.join('')}</div>\`;
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function normalizeFolder(value) {
        return String(value || '')
          .normalize('NFKC')
          .replace(/[\s\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/g, ' ')
          .replace(/[\\/]+/g, '/')
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean)
          .join('/');
      }
    </script>
  </body>
</html>`;
}

module.exports = {
  renderAdminPage,
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
