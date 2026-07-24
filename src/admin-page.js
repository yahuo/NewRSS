function renderAdminPage({ feeds, folders = [], baseUrl, readLaterFeedName }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NewRSS 管理</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=1" />
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
      .brand-title {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .brand-logo {
        width: clamp(2rem, 4vw, 2.8rem);
        height: auto;
        flex: none;
        color: var(--accent);
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        max-width: 760px;
        line-height: 1.7;
      }
      button, .button-like {
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
      .main-section + .main-section {
        margin-top: 24px;
        padding-top: 22px;
        border-top: 1px solid var(--line);
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
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .checkbox-row input[type="checkbox"] {
        width: auto;
        margin: 0;
      }
      input, select {
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
      .translation-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .switch-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 62px;
        padding: 4px 10px;
        border-radius: 999px;
        box-shadow: none;
        font-size: 0.84rem;
      }
      .switch-button.on {
        background: rgba(15, 92, 154, 0.09);
        color: var(--accent);
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
      .entry-list {
        display: grid;
        gap: 10px;
        margin-top: 14px;
      }
      .read-later-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        background: rgba(255, 255, 255, 0.76);
      }
      .read-later-panel {
        margin-top: 16px;
        padding-top: 14px;
        border-top: 1px solid var(--line);
      }
      .read-later-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        cursor: pointer;
        color: var(--muted);
        font-size: 0.95rem;
        font-weight: 600;
        list-style: none;
      }
      .read-later-summary::-webkit-details-marker {
        display: none;
      }
      .read-later-summary::after {
        content: '展开';
        color: var(--accent);
        font-size: 0.88rem;
        font-weight: 500;
      }
      .read-later-panel[open] .read-later-summary::after {
        content: '收起';
      }
      .read-later-summary-main {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }
      .entry-search {
        margin-top: 14px;
      }
      .entry-search input[type="search"] {
        width: 100%;
      }
      .entry-item {
        display: grid;
        gap: 8px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.78);
      }
      .entry-title {
        font-size: 0.98rem;
        font-weight: 600;
        color: var(--ink);
        text-decoration: none;
      }
      .entry-meta {
        display: grid;
        gap: 4px;
        color: var(--muted);
        font-size: 0.88rem;
        line-height: 1.5;
      }
      .entry-meta a {
        color: var(--accent);
        word-break: break-all;
      }
      .inline-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .inline-actions button,
      .inline-actions .button-like {
        padding: 8px 12px;
        box-shadow: none;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.58;
      }
      .pagination-summary {
        color: var(--muted);
        font-size: 0.88rem;
        align-self: center;
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
        <h1 class="brand-title">
          <svg class="brand-logo" viewBox="0 0 28 28" aria-hidden="true">
            <rect x="1" y="1" width="26" height="26" rx="7" fill="#fffaf4" stroke="currentColor" stroke-width="1.5" />
            <circle cx="9" cy="19" r="2.4" fill="currentColor" />
            <path d="M9 13.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
            <path d="M9 8a11 11 0 0 1 11 11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          </svg>
          <span>NewRSS Feed 管理</span>
        </h1>
        <p>维护你的源列表，按目录组织输出，并导出 OPML 给 Reeder 等阅读器。每个源会生成一个 reader-view feed，文章链接会落到本服务托管的正文页。</p>
      </section>

      <section class="layout">
        <aside class="card">
          <h2>Codex 额度保护</h2>
          <div class="stack">
            <div class="hint" id="codex-status" role="status" aria-live="polite">正在读取状态…</div>
            <button id="codex-probe" type="button">立即检测 Codex 额度</button>
          </div>
          <hr class="section-divider" />
          <h2>新增或更新源</h2>
          <form id="feed-form" class="stack">
            <label>
              名称
              <input name="name" placeholder="例如 wired" />
            </label>
            <label>
              显示标题
              <input name="title" placeholder="可选，留空则使用名称" />
            </label>
            <label>
              RSS 地址
              <input name="sourceUrl" placeholder="https://example.com/feed.xml" required />
            </label>
            <label>
              目录
              <input name="folder" placeholder="例如 AI / News / Deals" />
            </label>
            <label class="checkbox-row">
              <input name="translateEnabled" type="checkbox" value="true" />
              <span>自动翻译英文内容</span>
            </label>
            <button class="primary" type="submit">保存源</button>
            <div class="hint">名称为空时，会根据 URL 自动生成一个 slug；显示标题只用于管理页、OPML 和输出 Feed。更新现有源时，显示标题留空会保留当前值。</div>
            <div class="hint">勾选后，后续刷新这个 RSS 源时会自动把英文正文翻译成中文；需要配置 Gemini API key 或 Codex OAuth。</div>
            <div class="status" id="status" role="status" aria-live="polite"></div>
          </form>
          <hr class="section-divider" />
          <h2>保存稍后读</h2>
          <form id="read-later-form" class="stack">
            <label>
              网页地址
              <input name="url" placeholder="https://x.com/... 或文章链接" required />
            </label>
            <label>
              标题覆盖
              <input name="title" placeholder="可选，留空则自动提取" />
            </label>
            <label>
              导入方式
              <select name="mode">
                <option value="auto">自动</option>
                <option value="x-direct">X 专用导入</option>
                <option value="readability">Readability 抓正文</option>
              </select>
            </label>
            <label class="checkbox-row">
              <input name="translate" type="checkbox" value="true" checked />
              <span>自动翻译英文内容</span>
            </label>
            <button class="primary" type="submit">保存到 Read Later</button>
            <div class="hint">默认会优先用内置的 X 专用链路处理 x.com / twitter.com，失败后再回退到 Readability。取消勾选后只保存原文，不触发服务器翻译。</div>
            <div class="status" id="read-later-status" role="status" aria-live="polite"></div>
          </form>
          <hr class="section-divider" />
          <h2>导出 OPML</h2>
          <form id="export-form" class="stack">
            <label>
              导出目录
              <select name="folder">
                <option value="">全部目录</option>
                ${folders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join('')}
              </select>
            </label>
            <button class="primary" type="submit">导出 OPML</button>
            <div class="hint">不选目录时导出全部源；选择目录后只导出该目录下的源。</div>
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
            <div class="status" id="opml-status" role="status" aria-live="polite"></div>
          </form>
        </aside>

        <main class="card">
          <section class="main-section">
            <h2>Read Later</h2>
            <div id="read-later-root"></div>
          </section>
          <section class="main-section">
            <h2>源列表</h2>
            <div id="feed-root"></div>
          </section>
        </main>
      </section>
    </div>

    <script>
      const initialFeeds = ${safeJson(feeds)};
      const root = document.getElementById('feed-root');
      const readLaterRoot = document.getElementById('read-later-root');
      const form = document.getElementById('feed-form');
      const exportForm = document.getElementById('export-form');
      const status = document.getElementById('status');
      const readLaterForm = document.getElementById('read-later-form');
      const readLaterStatus = document.getElementById('read-later-status');
      const opmlForm = document.getElementById('opml-form');
      const opmlStatus = document.getElementById('opml-status');
      const codexStatus = document.getElementById('codex-status');
      const codexProbe = document.getElementById('codex-probe');
      const readLaterSubmit = readLaterForm.querySelector('button[type="submit"]');
      const readLaterFeedName = ${JSON.stringify(readLaterFeedName)};
      const appBaseUrl = ${JSON.stringify(baseUrl)};
      const maxOpmlFileBytes = 2 * 1024 * 1024;
      const readLaterPage = {
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        query: '',
        loading: true,
        error: '',
        open: false,
      };
      let currentReadLaterFeed = null;
      let readLaterSubmissionActive = false;

      render(initialFeeds);
      void loadReadLaterItems();
      void loadCodexStatus();

      codexProbe.addEventListener('click', async () => {
        codexProbe.disabled = true;
        codexStatus.textContent = '正在执行最小额度探测…';
        try {
          const response = await fetch('/api/codex/probe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const data = await response.json();
          const probeError = data.result?.error || data.error || '探测失败';
          await loadCodexStatus();
          if (!response.ok || !data.ok) codexStatus.textContent += '；检测结果：' + probeError;
        } catch (error) {
          codexStatus.textContent = error.message;
        } finally {
          codexProbe.disabled = false;
        }
      });

      async function loadCodexStatus() {
        try {
          const response = await fetch('/api/codex/status');
          const data = await readJsonResponse(response, 'Codex 状态不可用');
          if (!data.ok) {
            throw new Error(data.error || 'Codex 状态不可用');
          }
          const circuit = data.circuit || {};
          const totals = data.usage?.totals || {};
          codexStatus.textContent = [
            '熔断状态：' + (circuit.state || 'closed'),
            circuit.next_probe_at ? '下次自动探测：' + circuit.next_probe_at : '',
            '已记录请求：' + Number(totals.request_count || 0),
            'input/output/total：' + formatUsage(totals.input_tokens) + '/' + formatUsage(totals.output_tokens) + '/' + formatUsage(totals.total_tokens),
          ].filter(Boolean).join('；');
          codexProbe.disabled = false;
        } catch (error) {
          codexStatus.textContent = error.message || 'Codex 状态不可用';
          codexProbe.disabled = true;
        }
      }

      function formatUsage(value) {
        return value == null ? '不可得' : String(value);
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const title = String(formData.get('title') || '').trim();
        const payload = {
          name: String(formData.get('name') || '').trim(),
          sourceUrl: String(formData.get('sourceUrl') || '').trim(),
          folder: String(formData.get('folder') || '').trim(),
          translateEnabled: formData.get('translateEnabled') === 'true',
        };
        if (title) payload.title = title;

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

      readLaterForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (readLaterSubmissionActive) {
          return;
        }

        const formData = new FormData(readLaterForm);
        const payload = {
          url: String(formData.get('url') || '').trim(),
          title: String(formData.get('title') || '').trim(),
          mode: String(formData.get('mode') || 'auto').trim(),
          translate: formData.get('translate') === 'true',
        };

        readLaterSubmissionActive = true;
        readLaterSubmit.disabled = true;
        try {
          setReadLaterStatus('正在提交保存任务…');
          const response = await fetch('/api/read-later/jobs', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'Idempotency-Key': createIdempotencyKey(),
            },
            body: JSON.stringify(payload),
          });
          const job = await readJsonResponse(response, '提交保存任务失败');
          if (response.status !== 202 || !job.jobId) {
            throw new Error(job.error || 'NewRSS 返回了无效的保存任务');
          }

          const result = await pollReadLaterJob(job.jobId);
          readLaterForm.reset();
          readLaterPage.offset = 0;
          readLaterPage.query = '';
          setReadLaterStatus(\`已保存：\${result.title}（\${result.strategy}，\${result.translated ? '已翻译' : '原文'}）\`);
          await reload();
        } catch (error) {
          setReadLaterStatus(error.message);
        } finally {
          readLaterSubmissionActive = false;
          readLaterSubmit.disabled = false;
        }
      });

      async function pollReadLaterJob(jobId) {
        const maxAttempts = 150;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (attempt > 0) {
            await delay(2000);
          }

          const response = await fetch(\`/api/read-later/jobs/\${encodeURIComponent(jobId)}\`);
          const job = await readJsonResponse(response, '查询保存任务失败');
          if (job.jobId !== jobId) {
            throw new Error('NewRSS 返回了不匹配的保存任务');
          }
          if (job.status === 'done') {
            if (!job.result) {
              throw new Error('保存任务已完成，但没有返回结果');
            }
            return job.result;
          }
          if (job.status === 'failed') {
            throw new Error(job.error || '保存任务执行失败');
          }
          if (job.status !== 'queued' && job.status !== 'running') {
            throw new Error('NewRSS 返回了无效的保存任务状态');
          }

          setReadLaterStatus(job.status === 'queued' ? '保存任务正在排队…' : '正在抓取和处理文章…');
        }

        throw new Error('保存任务仍在处理，请稍后刷新页面确认结果');
      }

      exportForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const formData = new FormData(exportForm);
        const folder = String(formData.get('folder') || '').trim();
        const url = new URL('/opml.xml', window.location.origin);

        if (folder) {
          url.searchParams.set('folder', folder);
        }

        window.location.href = url.toString();
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
        if (file.size > maxOpmlFileBytes) {
          setOpmlStatus('OPML 文件不能超过 2 MiB');
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
          const data = await readJsonResponse(response, '导入失败');
          if (!data.ok) {
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
        const data = await readJsonResponse(response, '读取源列表失败');
        if (!data.ok) {
          throw new Error(data.error || '读取源列表失败');
        }
        render(data.feeds || []);
        await loadReadLaterItems();
      }

      function render(feeds) {
        const readLaterFeed = feeds.find((feed) => feed.isManaged && feed.name === readLaterFeedName) || null;
        const sourceFeeds = feeds.filter((feed) => !(feed.isManaged && feed.name === readLaterFeedName));

        currentReadLaterFeed = readLaterFeed;
        syncExportFolders(sourceFeeds);
        renderReadLaterSection(readLaterFeed);

        const groups = new Map();
        for (const feed of sourceFeeds) {
          const folder = normalizeFolder(feed.folder);
          const folderLabel = folder || '未分类';
          if (!groups.has(folderLabel)) groups.set(folderLabel, []);
          groups.get(folderLabel).push({ ...feed, folder });
        }

        root.innerHTML = sourceFeeds.length
          ? Array.from(groups.entries()).map(([folder, items]) => {
              return \`<section class="folder">
                <h3>\${escapeHtml(folder)}</h3>
                <div class="feed-list">
                  \${items.map((feed) => {
                    const statusClass = feed.lastRefreshStatus === 'error'
                      ? 'pill danger'
                      : feed.lastRefreshStatus === 'partial' || feed.lastRefreshStatus === 'refreshing'
                        ? 'pill warn'
                        : 'pill';
                    const statusText = feed.lastRefreshStatus === 'error'
                      ? '源失败'
                      : feed.lastRefreshStatus === 'refreshing'
                        ? '刷新中'
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
                        <div>来源：\${feed.isManaged ? '本地导入' : \`<a href="\${escapeHtml(feed.sourceUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(feed.sourceUrl)}</a>\`}</div>
                        <div>Feed：<a href="\${escapeHtml(feed.feedUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(feed.feedUrl)}</a></div>
                        <div class="translation-row">
                          <span>自动翻译英文内容：\${feed.translateEnabled ? '开启' : '关闭'}</span>
                          <button class="switch-button \${feed.translateEnabled ? 'on' : ''}" type="button" role="switch" aria-checked="\${feed.translateEnabled ? 'true' : 'false'}" data-action="toggle-translate" data-name="\${escapeHtml(feed.name)}" data-source-url="\${escapeHtml(feed.sourceUrl)}" data-folder="\${escapeHtml(feed.folder || '')}" data-translate-enabled="\${feed.translateEnabled ? 'true' : 'false'}">\${feed.translateEnabled ? '关闭' : '开启'}</button>
                        </div>
                        <div>最近刷新：\${escapeHtml(feed.lastRefreshedAt || '未刷新')}</div>
                        <div>已抓取：\${Number(feed.entryCount || 0)} 篇，最近失败：\${Number(feed.errorCount || 0)} 篇</div>
                      </div>
                      <div class="row-actions">
                        \${feed.isManaged ? '' : \`<button type="button" data-action="refresh" data-name="\${escapeHtml(feed.name)}">刷新</button>\`}
                        <a class="button-like" href="\${escapeHtml(feed.feedUrl)}" target="_blank" rel="noreferrer">查看 Feed</a>
                        <button class="danger" type="button" data-action="delete" data-name="\${escapeHtml(feed.name)}">删除</button>
                      </div>
                      \${renderErrors(feed)}
                    </article>\`;
                  }).join('')}
                </div>
              </section>\`;
            }).join('')
          : '<div class="empty">还没有配置任何源。</div>';

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
                const response = await fetch(\`/api/feeds/\${encodeURIComponent(name)}/refresh\`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.error || '刷新失败');
              } else if (action === 'toggle-translate') {
                const nextTranslateEnabled = button.dataset.translateEnabled !== 'true';
                setStatus(nextTranslateEnabled ? '正在开启自动翻译…' : '正在关闭自动翻译…');
                const response = await fetch('/api/feeds', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    name,
                    sourceUrl: button.dataset.sourceUrl || '',
                    folder: button.dataset.folder || '',
                    translateEnabled: nextTranslateEnabled,
                  }),
                });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.error || '保存翻译设置失败');
              }
              setStatus('完成');
              await reload();
            } catch (error) {
              setStatus(error.message);
            }
          });
        });
        bindReadLaterControls();
      }

      function setStatus(message) {
        status.textContent = message || '';
      }

      function setOpmlStatus(message) {
        opmlStatus.textContent = message || '';
      }

      function setReadLaterStatus(message) {
        readLaterStatus.textContent = message || '';
      }

      async function loadReadLaterItems() {
        readLaterPage.loading = true;
        readLaterPage.error = '';
        renderReadLaterSection(currentReadLaterFeed);
        bindReadLaterControls();

        try {
          const url = new URL('/api/read-later/items', window.location.origin);
          url.searchParams.set('limit', String(readLaterPage.limit));
          url.searchParams.set('offset', String(readLaterPage.offset));
          const normalizedQuery = normalizeReadLaterQuery(readLaterPage.query);
          if (normalizedQuery) {
            url.searchParams.set('q', normalizedQuery);
          }

          const response = await fetch(url.pathname + url.search);
          const data = await readJsonResponse(response, '读取 Read Later 条目失败');
          const items = Array.isArray(data.items) ? data.items : [];
          const total = Math.max(0, Number(data.total) || 0);
          const limit = Math.max(1, Number(data.limit) || readLaterPage.limit);
          const offset = Math.max(0, Number(data.offset) || 0);

          if (!items.length && total > 0 && offset >= total) {
            readLaterPage.total = total;
            readLaterPage.limit = limit;
            readLaterPage.offset = Math.floor((total - 1) / limit) * limit;
            return await loadReadLaterItems();
          }

          readLaterPage.items = items;
          readLaterPage.total = total;
          readLaterPage.limit = limit;
          readLaterPage.offset = offset;
        } catch (error) {
          readLaterPage.items = [];
          readLaterPage.error = error.message;
        } finally {
          readLaterPage.loading = false;
          renderReadLaterSection(currentReadLaterFeed);
          bindReadLaterControls();
        }
      }

      function bindReadLaterControls() {
        const panel = readLaterRoot.querySelector('.read-later-panel');
        panel?.addEventListener('toggle', () => {
          readLaterPage.open = panel.open;
        });

        const searchForm = readLaterRoot.querySelector('[data-role="read-later-search-form"]');
        searchForm?.addEventListener('submit', async (event) => {
          event.preventDefault();
          const input = searchForm.querySelector('[data-role="read-later-search"]');
          readLaterPage.query = String(input?.value || '').trim();
          readLaterPage.offset = 0;
          readLaterPage.open = true;
          await loadReadLaterItems();
        });

        readLaterRoot.querySelectorAll('button[data-action="delete-read-later-entry"]').forEach((button) => {
          button.addEventListener('click', async () => {
            if (!window.confirm('确定删除这条 Read Later 吗？')) {
              return;
            }
            button.disabled = true;
            try {
              setReadLaterStatus('正在删除条目…');
              const response = await fetch(
                \`/api/read-later/items/\${encodeURIComponent(button.dataset.entryId)}\`,
                { method: 'DELETE' }
              );
              const data = await readJsonResponse(response, '删除条目失败');
              if (!data.ok) {
                throw new Error(data.error || '删除条目失败');
              }
              setReadLaterStatus('条目已删除');
              await reload();
            } catch (error) {
              setReadLaterStatus(error.message);
              button.disabled = false;
            }
          });
        });

        readLaterRoot.querySelector('[data-action="read-later-page-prev"]')?.addEventListener('click', async () => {
          readLaterPage.offset = Math.max(0, readLaterPage.offset - readLaterPage.limit);
          readLaterPage.open = true;
          await loadReadLaterItems();
        });
        readLaterRoot.querySelector('[data-action="read-later-page-next"]')?.addEventListener('click', async () => {
          if (readLaterPage.offset + readLaterPage.limit >= readLaterPage.total) {
            return;
          }
          readLaterPage.offset += readLaterPage.limit;
          readLaterPage.open = true;
          await loadReadLaterItems();
        });
      }

      function syncExportFolders(feeds) {
        const select = exportForm.elements.folder;
        const selected = String(select.value || '');
        const folders = Array.from(new Set(
          feeds.map((feed) => normalizeFolder(feed.folder)).filter(Boolean)
        )).sort((a, b) => a.localeCompare(b));

        select.replaceChildren();
        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = '全部目录';
        select.append(allOption);
        for (const folder of folders) {
          const option = document.createElement('option');
          option.value = folder;
          option.textContent = folder;
          select.append(option);
        }
        select.value = folders.includes(selected) ? selected : '';
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

      function renderReadLaterSection(feed) {
        if (!feed) {
          readLaterRoot.innerHTML = \`<article class="read-later-card">
            <div class="meta">
              <div>Feed：<a href="\${escapeHtml(\`\${appBaseUrl}/feeds/\${encodeURIComponent(readLaterFeedName)}.xml\`)}" target="_blank" rel="noreferrer">\${escapeHtml(\`\${appBaseUrl}/feeds/\${encodeURIComponent(readLaterFeedName)}.xml\`)}</a></div>
              <div>状态：还没有保存任何 Read Later 条目</div>
            </div>
          </article>\`;
          return;
        }

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

        readLaterRoot.innerHTML = \`<article class="read-later-card">
          <header>
            <strong>\${escapeHtml(feed.title)}</strong>
            <span class="\${statusClass}">\${statusText}</span>
          </header>
          <div class="meta">
            <div>名称：\${escapeHtml(feed.name)}</div>
            <div>来源：本地导入</div>
            <div>Feed：<a href="\${escapeHtml(feed.feedUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(feed.feedUrl)}</a></div>
            <div>最近刷新：\${escapeHtml(feed.lastRefreshedAt || '未刷新')}</div>
            <div>已保存：\${Number(feed.entryCount || 0)} 篇</div>
          </div>
          <div class="row-actions">
            <a class="button-like" href="\${escapeHtml(feed.feedUrl)}" target="_blank" rel="noreferrer">查看 Feed</a>
          </div>
          \${renderReadLaterItems(feed)}
          \${renderErrors(feed)}
        </article>\`;
      }

      function renderReadLaterItems(feed) {
        if (!feed.isManaged || feed.name !== readLaterFeedName) {
          return '';
        }

        const items = readLaterPage.items;
        const start = readLaterPage.total ? readLaterPage.offset + 1 : 0;
        const end = readLaterPage.offset + items.length;
        const search = \`<form class="entry-search" data-role="read-later-search-form">
          <label>
            <span>搜索条目</span>
            <input type="search" data-role="read-later-search" value="\${escapeHtml(readLaterPage.query)}" placeholder="按标题或原文链接搜索" />
          </label>
          <button type="submit">搜索</button>
        </form>\`;
        const list = items.length
          ? \`<div class="entry-list" data-role="read-later-entry-list">\${items.map((item) => \`<div class="entry-item" data-role="read-later-entry-item">
              <a class="entry-title" href="\${escapeHtml(item.articleUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(item.title || 'Untitled')}</a>
              <div class="entry-meta">
                <div>原文：<a href="\${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(item.sourceUrl)}</a></div>
                <div>发布时间：\${escapeHtml(item.sourcePublishedAt || '未知')}</div>
                <div>导入状态：\${item.translated ? '已翻译' : '原文'}</div>
              </div>
              <div class="inline-actions">
                <a class="button-like" href="\${escapeHtml(item.articleUrl)}" target="_blank" rel="noreferrer">查看文章</a>
                <button class="danger" type="button" data-action="delete-read-later-entry" data-entry-id="\${escapeHtml(item.id)}">删除条目</button>
              </div>
            </div>\`).join('')}</div>\`
          : \`<div class="empty">\${readLaterPage.query ? '没有匹配的条目。' : 'Read Later 里还没有条目。'}</div>\`;
        const body = readLaterPage.loading
          ? '<div class="empty">正在读取 Read Later 条目…</div>'
          : readLaterPage.error
            ? \`<div class="error-box">\${escapeHtml(readLaterPage.error)}</div>\`
            : \`\${search}\${list}
              <div class="inline-actions">
                <button type="button" data-action="read-later-page-prev" \${readLaterPage.offset <= 0 ? 'disabled' : ''}>上一页</button>
                <span class="pagination-summary">\${start}-\${end} / \${readLaterPage.total}</span>
                <button type="button" data-action="read-later-page-next" \${end >= readLaterPage.total ? 'disabled' : ''}>下一页</button>
              </div>\`;

        return \`<details class="read-later-panel" \${readLaterPage.open ? 'open' : ''}>
          <summary class="read-later-summary">
            <span class="read-later-summary-main">Read Later 条目 <span class="pill">\${readLaterPage.total}</span></span>
          </summary>
          \${body}
        </details>\`;
      }

      function normalizeReadLaterQuery(value) {
        return String(value || '').trim().normalize('NFKC');
      }

      async function readJsonResponse(response, fallbackMessage) {
        let data;
        try {
          data = await response.json();
        } catch {
          const suffix = response.status ? '（HTTP ' + response.status + '）' : '';
          throw new Error(fallbackMessage + suffix);
        }

        if (!response.ok) {
          const suffix = response.status ? '（HTTP ' + response.status + '）' : '';
          throw new Error(data?.error || fallbackMessage + suffix);
        }
        return data || {};
      }

      function createIdempotencyKey() {
        if (typeof window.crypto?.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }
        return 'admin-' + Date.now() + '-' + Math.random().toString(36).slice(2, 14);
      }

      function delay(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  renderFaviconSvg,
};

function renderFaviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">
  <rect x="1" y="1" width="26" height="26" rx="7" fill="#fffaf4" stroke="#0f5c9a" stroke-width="1.5" />
  <circle cx="9" cy="19" r="2.4" fill="#0f5c9a" />
  <path d="M9 13.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="#0f5c9a" stroke-width="2.5" stroke-linecap="round" />
  <path d="M9 8a11 11 0 0 1 11 11" fill="none" stroke="#0f5c9a" stroke-width="2.5" stroke-linecap="round" />
</svg>`;
}

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
