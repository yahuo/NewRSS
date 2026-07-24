# NewRSS

中文 | [English](#english)

NewRSS 是一个面向 `Reeder` 等 RSS 阅读器的自托管 Reader View 工具。

它会拉取原始 RSS，抓取文章正文并做 Readability 提取，然后重新生成适合阅读器订阅的新 RSS。每条条目都会指向本服务托管的干净网页，你可以直接在阅读器里打开并使用内置网页翻译。

## 功能

- 多 RSS 源管理
- 目录分组
- OPML 导入
- OPML 导出
- 自动刷新
- 抓取失败状态展示
- 代理支持
- 自托管正文页输出
- 持久化 Read Later 任务与 Chrome 扩展断点恢复
- HTML 白名单净化、CSP、出站 SSRF/响应大小保护
- SQLite 在线备份（默认保留最近 7 份）

## 工作方式

默认模式是“提取原文，不做服务端翻译”：

- RSS item 的 `link` 指向本服务生成的正文网页
- RSS item 的 `content:encoded` 也是提取后的原文 HTML
- 文章页适合在 Reeder 中打开后再用网页翻译
- 普通 Feed 和 Read Later 条目永久保留；`MAX_ITEMS_PER_FEED` 只控制每次 RSS 输出数量，不会删除历史条目

## 管理入口

- 管理页：`/admin`
- 源列表 API：`GET /api/feeds`
- 新增或更新源：`POST /api/feeds`
- 保存单条稍后读：`POST /api/read-later`
- 创建异步稍后读任务：`POST /api/read-later/jobs`
- 查询异步任务：`GET /api/read-later/jobs/:id`
- 分页搜索稍后读：`GET /api/read-later/items?limit=50&offset=0&q=...`
- 删除源：`DELETE /api/feeds/:name`
- 单源刷新：`POST /api/feeds/:name/refresh`
- 全部刷新：`POST /refresh`
- OPML 导入：`POST /api/opml/import`
- OPML 导出：`GET /opml.xml`

新增或更新源时，可以额外传 `title` 作为管理页、OPML 和输出 Feed 使用的显示标题；新源留空时默认使用 `name`，更新现有源时留空会保留当前标题，后续刷新也不会用上游 RSS 标题覆盖它。也可以传 `translateEnabled: true`，让后续刷新自动把英文正文翻译成中文；没有配置翻译 provider 时会保留原文。

## 快速开始

### 本地运行

```bash
npm install
npm start
```

需要 Node.js `^22.13.0` 或 `>=24.0.0`。

默认地址：

- 管理页：`http://localhost:8787/admin`
- 默认 feed：`http://localhost:8787/feeds/wired.xml`

首次手动刷新：

```bash
curl -X POST http://localhost:8787/refresh \
  -H 'content-type: application/json' \
  -d '{"name":"wired","url":"https://www.wired.com/feed/rss"}'
```

### Docker Compose

1. 准备环境变量

```bash
cp .env.example .env
mkdir -p data backups
```

2. 启动

```bash
docker compose up -d --build
```

如宿主机端口不是 `8787`，设置 `HOST_PORT`；容器内部端口固定为 `8787`，避免原先同时修改 `PORT` 后端口映射失效。

镜像现在以非 root 的 `node` 用户（uid 1000）运行。升级已有的 Linux bind-mount 部署前，先停止旧容器并确认数据、备份目录对 uid 1000 可写；旧版 root 容器创建的文件可一次性处理：

```bash
docker compose down
sudo chown -R 1000:1000 ./data ./backups
```

如果修改过 `BACKUP_HOST_DIR`，把命令中的 `./backups` 换成真实目录。macOS Docker Desktop 通常会映射 bind mount 权限，但升级前仍建议先备份数据库，并用 `docker compose run --rm --user node --entrypoint sh newrss -c 'test -w /app/data && test -w /app/backups'` 验证。

使用 `codex-oauth` 时，不要直接挂载个人 `~/.codex/auth.json`。应把一份标准 Codex auth 文件安装到 NewRSS 专用的可写目录；`data` 已由 Compose 持久化，并被 Git 和镜像构建排除：

```bash
install -d -m 700 data/codex-auth
install -m 600 /path/to/normalized-auth.json data/codex-auth/auth.json
```

然后在 `.env` 中配置：

```bash
TRANSLATION_PROVIDER=codex-oauth
CODEX_AUTH_FILE=/app/data/codex-auth/auth.json
```

必须保证 `codex-auth` 目录可写，因为 OAuth Token 刷新会在同目录生成临时文件，再原子替换 `auth.json`。不要使用只读挂载或只挂载单个 `auth.json` 文件。

3. 检查

```bash
curl http://localhost:8787/admin
curl http://localhost:8787/api/feeds
curl http://localhost:8787/opml.xml
```

## 家庭部署

如果你在家里的 Mac 上长期运行，可以把 `APP_BASE_URL` 配成你自己的内网访问地址，例如：

```bash
APP_BASE_URL=http://your-device-name.sgponte:8787
```

或者任何你实际可访问到这台机器的地址。

这样生成出来的 feed 链接和文章页链接都会稳定指向该地址，而不是容器内部地址。

### 访问边界

NewRSS 按当前自用场景保持**无登录、无 API Token**，并继续监听 `0.0.0.0`。因此只应通过你信任的 Surge Ponte 网络、主机防火墙或同等 ACL 暴露；不要把 `8787` 直接发布到公网。应用会拒绝跨站简单写请求，并对抓取目标执行协议、DNS/IP、逐跳重定向和响应大小检查，但这些保护不等同于入站身份认证。

默认禁止抓取 loopback、私网、link-local、CGNAT 和 metadata 地址。如确实要订阅某个私有站点，可在 `OUTBOUND_ALLOWED_HOSTS` 中按**精确 hostname**列出例外（逗号分隔）；不要配置宽泛域名。

## OPML

### 导入

管理页支持直接上传 `OPML` 文件：

- 可以保留 OPML 原有目录结构
- 也可以指定一个目录，把导入的所有源统一放进去

导入时会按 `source_url` 去重，避免把同一个源导入多份。

### 导出

管理页支持导出：

- 全部目录
- 单个目录

也可以直接请求：

```text
/opml.xml
/opml.xml?folder=TECH
```

## Read Later

你可以把任意网页 URL 直接推送进固定的 `read-later` feed：

```bash
curl -X POST http://localhost:8787/api/read-later \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://x.com/dotey/status/2031231856071372830"
  }'
```

返回结果会包含：

- `articleUrl`：NewRSS 托管的文章页
- `feedUrl`：固定的 `read-later` RSS 地址
- `strategy`：实际采用的导入策略

同步接口为兼容现有调用保留。管理页和 Chrome 扩展使用持久化异步任务，提交会快速返回 `202`：

```bash
curl -X POST http://localhost:8787/api/read-later/jobs \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: my-save-001' \
  -d '{"url":"https://example.com/article","mode":"auto","translate":true}'

curl http://localhost:8787/api/read-later/jobs/JOB_ID
```

任务的 `queued/running/done/failed` 状态保存在 SQLite；进程重启时，未完成的 `running` 任务会恢复为 `queued`。相同 `Idempotency-Key` 不会重复抓取和翻译；未显式传 key 的失败任务允许在同一个五分钟窗口内重新提交。

可选字段：

- `title`
  手动覆盖标题
- `mode`
  `auto` / `x-direct` / `readability`
- `translate`
  是否翻译，默认 `true`；同一条目正文未变化时会保留已有的成功译文

其中：

- `auto`
  对 `x.com` / `twitter.com` 优先走内置的 X 专用导入链路，失败再回退
- `x-direct`
  强制走内置的 X 专用导入链路
- `readability`
  强制走当前内置的 Readability 抓取逻辑

管理页会把这个 managed feed 固定放到 `Read Later` 目录下，并支持逐条删除 read-later 条目。
管理页的历史列表使用服务端分页和搜索，因此超过 RSS 输出上限的旧条目仍可查找和删除。

### Chrome 一键保存扩展

仓库里附带了一个可直接加载的 Chrome unpacked 扩展，目录在 `extensions/read-later-chrome`。

- 点击工具栏图标就会把当前 `http/https` 页面保存到 `Read Later`
- 默认参数固定为 `mode=auto`、`translate=true`
- 安装步骤和排查说明见 `extensions/read-later-chrome/README.md`

## 永久保留与备份

条目不会自动清理。这样旧文章链接长期有效，但数据库和备份会持续增长；`MAX_ITEMS_PER_FEED` 只是 RSS 视图上限。当前实现通过查询索引、轻量分页、正文复查间隔、带总内存预算的 LRU XML 缓存和 gzip 降低永久保留的运行成本。Read Later 翻译失败会按退避时间自动重试，不会永久停留在首次失败状态。

在线备份命令：

```bash
npm run backup:database
```

- 默认输出：`data/backups`
- Docker Compose 会改为容器内 `/app/backups`，宿主路径由 `BACKUP_HOST_DIR` 指定，默认 `./backups`
- 默认保留：最近 7 份成功备份
- 可通过 `BACKUP_OUTPUT_DIR` 指向另一块磁盘或独立挂载，避免数据库和备份同盘损坏
- 可通过 `BACKUP_RETENTION_COUNT` 调整代数
- 备份会做 SQLite 完整性、外键、校验和、可用空间与跨进程互斥检查

生产环境建议将 `BACKUP_OUTPUT_DIR` 放到独立卷，并按数据库增长量预留至少 7 代空间。

## 订阅站点 Cookie

如果某些站点的 RSS 能看见标题，但正文抓取会被 `403` 或登录墙拦住，可以给 NewRSS 配置文章抓取 cookie。这样服务端抓正文时会只对匹配域名带上这些 cookie。

推荐方式是提供一个 JSON 文件：

```json
{
  "domains": {
    "nytimes.com": {
      "NYT-S": "your-value",
      "nyt-a": "your-value"
    }
  }
}
```

然后设置：

```bash
ARTICLE_COOKIE_FILE=./data/article-cookies.json
```

也支持直接给单个域名传 cookie header：

```bash
ARTICLE_COOKIE_DOMAIN=nytimes.com
ARTICLE_COOKIE_HEADER="NYT-S=...; nyt-a=..."
```

`ARTICLE_COOKIE_FILE` 也兼容常见的浏览器 cookie 导出 JSON 数组格式，只要里面包含 `domain` / `name` / `value` 字段即可。

## 常用环境变量

- `APP_BASE_URL`
  用于生成 RSS 和文章页链接
- `HOST_PORT`
  Docker Compose 暴露到宿主机的端口；容器内部固定使用 `8787`
- `DEFAULT_FEED_NAME`
  默认种子源名称
- `DEFAULT_FEED_URL`
  默认种子源地址
- `DEFAULT_FEED_FOLDER`
  默认种子源目录
- `READ_LATER_FEED_NAME`
  固定稍后读 feed 名称，默认 `read-later`
- `READ_LATER_FEED_TITLE`
  固定稍后读 feed 标题，默认 `Read Later`
- `READ_LATER_FEED_FOLDER`
  固定稍后读 feed 目录，默认 `Read Later`
- `READ_LATER_STORAGE_PATH`
  稍后读导入文件落盘目录，默认 `data/read-later`
- `X_AUTH_TOKEN`
  X 登录态 cookie 中的 `auth_token`
- `X_CT0`
  X 登录态 cookie 中的 `ct0`
- `X_COOKIE_FILE`
  可选，指向一份 JSON cookie 文件；提供后可代替直接写 `X_AUTH_TOKEN` / `X_CT0`
- `X_USER_AGENT`
  可选，覆盖内置的 X 请求 User-Agent
- `X_BEARER_TOKEN`
  可选，覆盖内置的 X 请求 Bearer Token
- `TRANSLATION_PROVIDER`
  可选，翻译 provider，默认 `gemini`；可设为 `codex-oauth` 使用 Codex OAuth 登录态
- `READ_LATER_TRANSLATION_PROVIDER`
  可选，单独指定稍后读翻译 provider；留空时继承 `TRANSLATION_PROVIDER`
- `GEMINI_API_KEY`
  可选，设置后会自动把英文的 read-later 内容以及开启 `translateEnabled` 的 RSS 源内容翻译为中文
- `GEMINI_MODEL`
  可选，Gemini 模型名，默认 `gemini-2.5-flash`
- `CODEX_AUTH_FILE`
  可选，使用 `codex-oauth` 时读取并写回的 Codex auth 文件；直接运行默认 `~/.codex/auth.json`，Compose 示例使用专用的 `/app/data/codex-auth/auth.json`
- `CODEX_MODEL`
  可选，Codex OAuth 模型名，默认 `openai-codex/gpt-5.5`
- `TRANSLATE_TARGET_LANGUAGE`
  可选，目标语言，默认 `Simplified Chinese`
- `REFRESH_INTERVAL_MINUTES`
  自动刷新间隔，默认 `30`
- `REFRESH_ON_BOOT`
  启动时是否立即刷新，默认 `true`
- `MAX_ITEMS_PER_REFRESH`
  每次刷新最多处理多少条，默认 `10`
- `MAX_ITEMS_PER_FEED`
  每次生成的 RSS 最多输出多少条，默认 `50`；不删除数据库历史
- `FEED_REFRESH_CONCURRENCY` / `ITEM_REFRESH_CONCURRENCY`
  Feed 和文章的有界刷新并发，默认 `2` / `3`
- `ARTICLE_RECHECK_HOURS`
  已有正文再次抓取的最短间隔，默认 `24` 小时；新 GUID 始终立即处理
- `HTTP_TIMEOUT_MS`
  上游抓取超时
- `RSS_MAX_BYTES` / `ARTICLE_MAX_BYTES` / `X_MAX_BYTES`
  三类上游响应的流式字节硬上限
- `RSS_CACHE_MAX_BYTES`
  RSS XML 进程内 LRU 缓存总预算，默认 `67108864`（64 MiB）；单份 XML 超过预算时不缓存
- `OUTBOUND_MAX_REDIRECTS`
  上游逐跳校验后的最大重定向次数，默认 `5`
- `OUTBOUND_ALLOWED_HOSTS`
  允许访问私网地址的精确 hostname 例外列表，逗号分隔；默认空
- `READ_LATER_JOB_CONCURRENCY`
  持久稍后读任务并发数，默认 `1`
- `READ_LATER_RATE_LIMIT_PER_MINUTE`
  每个来源 IP 每分钟可提交的稍后读请求数，默认 `20`
- `USER_AGENT`
  可选，覆盖文章页抓取默认使用的浏览器 User-Agent；默认会使用内置浏览器 UA，兼容 `archive.md` 这类会拦截脚本 UA 的站点
- `UPSTREAM_PROXY_URL`
  给 RSS 抓取和文章页抓取统一走代理，支持 `http://` 和 `socks5://`
- `ARTICLE_COOKIE_FILE`
  可选，文章页抓取 cookie 文件；按域名匹配后只发送到对应站点，适合 NYT 这类订阅站点
- `ARTICLE_COOKIE_DOMAIN`
  可选，配合 `ARTICLE_COOKIE_HEADER` 使用，指定这份 cookie 对哪个域名生效
- `ARTICLE_COOKIE_HEADER`
  可选，给单个域名直接设置 `Cookie` 请求头
- `BACKUP_OUTPUT_DIR` / `BACKUP_RETENTION_COUNT`
  在线备份输出目录和保留代数，默认 `data/backups` / `7`

## 本地验证

```bash
npm test
npm run test:coverage
npm audit --omit=dev --registry=https://registry.npmjs.org
```

GitHub Actions 会在 Node 22.13 和 Node 24 上执行测试，并检查覆盖率、安全审计和 Docker 启动；Dependabot 每周检查 npm 与 Docker 更新。

## 当前限制

- 某些站点会拦截正文页抓取，可能返回 `401` 或 `403`
- 某些站点只适合摘要模式，不适合全文抓取
- 少数站点可能需要额外的站点级提取规则
- X 页面依赖你自己的登录态 cookie；如果没有提供，X 专用导入会失败
- 某些订阅站点需要你额外提供文章页 cookie，否则服务端正文抓取仍可能返回 `403`
- 配置翻译 provider 后，英文内容会在导入或刷新时额外调用模型翻译，速度会变慢一些
- 当前是单进程服务，适合个人或家庭自用
- 没有应用层登录或 API Token，必须依赖 Surge Ponte/防火墙等可信入站网络边界
- 条目永久保留，需自行监控数据库与 7 代备份的磁盘增长

---

## English

NewRSS is a self-hosted Reader View tool for RSS readers such as `Reeder`.

It pulls original RSS feeds, fetches article pages, extracts readable content with Readability, and republishes a cleaner RSS feed for your reader. Each item points to a reader-friendly page hosted by this service, so you can open it in your RSS app and use built-in webpage translation if needed.

## Features

- Multi-feed management
- Folder grouping
- OPML import
- OPML export
- Automatic refresh
- Refresh error visibility
- Proxy support
- Self-hosted article pages
- Persistent read-later jobs with Chrome extension recovery
- HTML allowlist sanitization, CSP, SSRF controls, and upstream byte limits
- Online SQLite backups retaining the latest seven successful generations

## How It Works

The default mode is “extract original content, no server-side translation”:

- RSS item `link` points to a hosted reader page
- RSS item `content:encoded` contains extracted original HTML
- The hosted page is designed to work well with in-app webpage translation
- Regular and read-later entries are retained permanently; `MAX_ITEMS_PER_FEED` limits RSS output only

## Management Endpoints

- Admin page: `GET /admin`
- Feed list API: `GET /api/feeds`
- Create or update a feed: `POST /api/feeds`
- Save one read-later URL: `POST /api/read-later`
- Create/query read-later jobs: `POST /api/read-later/jobs`, `GET /api/read-later/jobs/:id`
- Search read-later history: `GET /api/read-later/items?limit=50&offset=0&q=...`
- Delete a feed: `DELETE /api/feeds/:name`
- Refresh one feed: `POST /api/feeds/:name/refresh`
- Refresh all feeds: `POST /refresh`
- Import OPML: `POST /api/opml/import`
- Export OPML: `GET /opml.xml`

When creating or updating a feed, you can additionally send `title` as the display title used by the admin page, OPML, and the generated feed. A new feed defaults to `name` when the title is blank; an existing feed keeps its current title when the value is blank, and refreshes do not overwrite it with the upstream RSS title. You can also send `translateEnabled: true` to automatically translate English article content on future refreshes; if no translation provider is configured, the original content is kept.

## Quick Start

### Run locally

```bash
npm install
npm start
```

Requires Node.js `^22.13.0` or `>=24.0.0`.

Default endpoints:

- Admin page: `http://localhost:8787/admin`
- Default feed: `http://localhost:8787/feeds/wired.xml`

Manual first refresh:

```bash
curl -X POST http://localhost:8787/refresh \
  -H 'content-type: application/json' \
  -d '{"name":"wired","url":"https://www.wired.com/feed/rss"}'
```

### Docker Compose

1. Prepare environment variables

```bash
cp .env.example .env
mkdir -p data backups
```

2. Start the service

```bash
docker compose up -d --build
```

The image now runs as the non-root `node` user (uid 1000). Before upgrading an existing Linux bind-mount deployment created by the former root image, stop it and make both mounts writable:

```bash
docker compose down
sudo chown -R 1000:1000 ./data ./backups
```

Replace `./backups` when `BACKUP_HOST_DIR` points elsewhere. Docker Desktop on macOS normally maps bind-mount permissions, but back up first and verify with `docker compose run --rm --user node --entrypoint sh newrss -c 'test -w /app/data && test -w /app/backups'` before the upgrade.

When using `codex-oauth`, do not mount your personal `~/.codex/auth.json`. Install a standard Codex auth file in NewRSS's dedicated writable directory instead. Compose already persists `data`, and both Git and the image build exclude it:

```bash
install -d -m 700 data/codex-auth
install -m 600 /path/to/normalized-auth.json data/codex-auth/auth.json
```

Then configure `.env`:

```bash
TRANSLATION_PROVIDER=codex-oauth
CODEX_AUTH_FILE=/app/data/codex-auth/auth.json
```

The `codex-auth` directory must be writable because OAuth refresh writes a temporary file beside `auth.json` and atomically replaces it. Do not use a read-only mount or bind-mount only the `auth.json` file.

3. Verify

```bash
curl http://localhost:8787/admin
curl http://localhost:8787/api/feeds
curl http://localhost:8787/opml.xml
```

## Home Deployment

For a home Mac deployment, set `APP_BASE_URL` to the real address your phone or reader can reach, for example:

```bash
APP_BASE_URL=http://your-device-name.sgponte:8787
```

You can replace it with any reachable private-network address that fits your setup.

NewRSS intentionally has no login or API token for this personal deployment. Keep port 8787 behind a trusted Surge Ponte network, host firewall, or equivalent ACL; do not expose it directly to the public internet. Outbound fetches still reject non-HTTP schemes, private/metadata targets, unsafe redirects, and oversized responses. Exact private-host exceptions can be listed in `OUTBOUND_ALLOWED_HOSTS`.

## OPML

### Import

The admin page supports uploading an `OPML` file:

- Keep the folder structure from the OPML file
- Or override everything into a single target folder

Import is deduplicated by `source_url` to avoid duplicate feeds.

### Export

The admin page supports exporting:

- All folders
- A single folder

You can also call:

```text
/opml.xml
/opml.xml?folder=TECH
```

## Read Later

You can push any page URL into the fixed `read-later` feed:

```bash
curl -X POST http://localhost:8787/api/read-later \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://x.com/dotey/status/2031231856071372830"
  }'
```

Optional fields:

- `title` to override the detected title
- `mode` with `auto`, `x-direct`, or `readability`
- `translate` as `true` or `false`, default `true`

For X/Twitter URLs, `auto` prefers NewRSS's built-in X importer and falls back only when needed.
When `translate` is `false`, new or changed content is stored without a new translation; an existing successful translation is retained when the source content is unchanged.
The admin page keeps this managed feed under the `Read Later` folder and supports deleting individual read-later items.

The synchronous endpoint remains for compatibility. The admin page and extension use persistent jobs: submission returns `202`, the client polls job state, and interrupted `running` jobs are re-queued after restart. `Idempotency-Key` prevents duplicate fetches when a response is lost; automatically keyed failed submissions can be retried within the same five-minute window.

### Chrome One-Click Extension

The repo also includes an unpacked Chrome extension under `extensions/read-later-chrome`.

- Click the toolbar icon to save the current `http/https` page into `Read Later`
- It always sends `mode=auto` and `translate=true`
- Installation and troubleshooting are documented in `extensions/read-later-chrome/README.md`

## Permanent Retention and Backups

Entries are not pruned automatically, so old article links remain valid while the database and its backups grow over time. Query indexes, paginated history, delayed article rechecks, a byte-bounded LRU RSS cache, and gzip reduce the runtime cost. Failed read-later translations are retried with backoff.

Run an online backup with `npm run backup:database`. It defaults to `data/backups`, retains the newest seven validated backups, checks free space and SQLite integrity, and serializes concurrent processes. Compose maps `/app/backups` from `BACKUP_HOST_DIR` (default `./backups`). Put that path on an independent disk or mount for real disk-failure protection; adjust generations with `BACKUP_RETENTION_COUNT`.

## Subscriber Cookies

If a site exposes an RSS feed but blocks article-page fetching behind a `403` or login wall, NewRSS can send article-fetch cookies only to matching domains.

The preferred option is a JSON file:

```json
{
  "domains": {
    "nytimes.com": {
      "NYT-S": "your-value",
      "nyt-a": "your-value"
    }
  }
}
```

Then configure:

```bash
ARTICLE_COOKIE_FILE=./data/article-cookies.json
```

You can also pass a single-domain cookie header directly:

```bash
ARTICLE_COOKIE_DOMAIN=nytimes.com
ARTICLE_COOKIE_HEADER="NYT-S=...; nyt-a=..."
```

`ARTICLE_COOKIE_FILE` also accepts common browser-export JSON arrays when entries include `domain`, `name`, and `value`.

## Common Environment Variables

- `APP_BASE_URL`
  Base URL used in generated feed and article links
- `HOST_PORT`
  Docker Compose host port; the container always listens on `8787`
- `DEFAULT_FEED_NAME`
  Default seed feed name
- `DEFAULT_FEED_URL`
  Default seed feed URL
- `DEFAULT_FEED_FOLDER`
  Default seed folder
- `READ_LATER_FEED_NAME`
  Fixed read-later feed name, default `read-later`
- `READ_LATER_FEED_TITLE`
  Fixed read-later feed title, default `Read Later`
- `READ_LATER_FEED_FOLDER`
  Fixed read-later feed folder, default `Read Later`
- `READ_LATER_STORAGE_PATH`
  Storage path for imported read-later entries, default `data/read-later`
- `X_AUTH_TOKEN`
  `auth_token` from an authenticated X session
- `X_CT0`
  `ct0` from an authenticated X session
- `X_COOKIE_FILE`
  Optional JSON cookie file path; can be used instead of inline `X_AUTH_TOKEN` / `X_CT0`
- `X_USER_AGENT`
  Optional override for the built-in X request user agent
- `X_BEARER_TOKEN`
  Optional override for the built-in X request bearer token
- `TRANSLATION_PROVIDER`
  Optional translation provider, default `gemini`; set to `codex-oauth` to use Codex OAuth credentials
- `READ_LATER_TRANSLATION_PROVIDER`
  Optional provider override for read-later translation; inherits `TRANSLATION_PROVIDER` when empty
- `GEMINI_API_KEY`
  Optional. When set, English read-later articles and feeds with `translateEnabled=true` are automatically translated
- `GEMINI_MODEL`
  Optional Gemini model name, default `gemini-2.5-flash`
- `CODEX_AUTH_FILE`
  Optional Codex auth file read and updated by `codex-oauth`; direct runs default to `~/.codex/auth.json`, while the Compose example uses dedicated `/app/data/codex-auth/auth.json`
- `CODEX_MODEL`
  Optional Codex OAuth model name, default `openai-codex/gpt-5.5`
- `TRANSLATE_TARGET_LANGUAGE`
  Optional target language, default `Simplified Chinese`
- `REFRESH_INTERVAL_MINUTES`
  Auto-refresh interval, default `30`
- `REFRESH_ON_BOOT`
  Whether to refresh immediately on startup, default `true`
- `MAX_ITEMS_PER_REFRESH`
  Max items processed per refresh, default `10`
- `MAX_ITEMS_PER_FEED`
  Max items emitted per RSS response, default `50`; stored history is not deleted
- `FEED_REFRESH_CONCURRENCY` / `ITEM_REFRESH_CONCURRENCY`
  Bounded feed/article refresh concurrency, defaults `2` / `3`
- `ARTICLE_RECHECK_HOURS`
  Minimum re-fetch interval for an existing article body, default `24`; new GUIDs are immediate
- `HTTP_TIMEOUT_MS`
  Upstream fetch timeout
- `RSS_MAX_BYTES` / `ARTICLE_MAX_BYTES` / `X_MAX_BYTES`
  Streamed upstream response limits
- `RSS_CACHE_MAX_BYTES`
  Total in-process LRU budget for rendered RSS XML, default `67108864` (64 MiB); oversized single XML responses are not cached
- `OUTBOUND_MAX_REDIRECTS` / `OUTBOUND_ALLOWED_HOSTS`
  Redirect limit and exact private-host exception list
- `READ_LATER_JOB_CONCURRENCY` / `READ_LATER_RATE_LIMIT_PER_MINUTE`
  Persistent job concurrency and per-IP submission limit
- `USER_AGENT`
  Optional override for the browser-style User-Agent used for article-page fetches; by default NewRSS uses a built-in browser UA so sites like `archive.md` do not reject the request as a script client
- `UPSTREAM_PROXY_URL`
  Proxy used for RSS fetches and article-page fetches; supports `http://` and `socks5://`
- `ARTICLE_COOKIE_FILE`
  Optional article-fetch cookie file. Cookies are matched by domain and only sent to matching sites
- `ARTICLE_COOKIE_DOMAIN`
  Optional domain used together with `ARTICLE_COOKIE_HEADER`
- `ARTICLE_COOKIE_HEADER`
  Optional raw `Cookie` header for a single article domain
- `BACKUP_OUTPUT_DIR` / `BACKUP_RETENTION_COUNT`
  Online backup directory and generations, defaults `data/backups` / `7`

## Local Verification

Run `npm test`, `npm run test:coverage`, and `npm audit --omit=dev --registry=https://registry.npmjs.org`. GitHub Actions covers Node 22.13/24, coverage, audit, and a Docker smoke test; Dependabot checks npm and Docker weekly.

## Current Limitations

- Some publishers block article-page fetching and may return `401` or `403`
- Some feeds are only practical in summary mode
- A few sites may require additional site-specific extraction rules
- X importing depends on your own authenticated X cookies
- Some subscriber-only publishers still need you to provide article cookies, otherwise server-side extraction may return `403`
- Importing or refreshing English content is slower when Gemini translation is enabled
- The current runtime model is a single-process service intended for personal or home use
- There is no application login or API token; a trusted Ponte/firewall boundary is required
- Permanent retention requires monitoring database and backup disk growth
