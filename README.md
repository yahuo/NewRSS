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

## 工作方式

默认模式是“提取原文，不做服务端翻译”：

- RSS item 的 `link` 指向本服务生成的正文网页
- RSS item 的 `content:encoded` 也是提取后的原文 HTML
- 文章页适合在 Reeder 中打开后再用网页翻译

## 管理入口

- 管理页：`/admin`
- 源列表 API：`GET /api/feeds`
- 新增或更新源：`POST /api/feeds`
- 保存单条稍后读：`POST /api/read-later`
- 删除源：`DELETE /api/feeds/:name`
- 单源刷新：`POST /api/feeds/:name/refresh`
- OPML 导入：`POST /api/opml/import`
- OPML 导出：`GET /opml.xml`

## 快速开始

### 本地运行

```bash
npm install
npm start
```

默认地址：

- 管理页：`http://localhost:8787/admin`
- 默认 feed：`http://localhost:8787/feeds/wired.xml`

首次手动刷新：

```bash
curl "http://localhost:8787/refresh?name=wired&url=https://www.wired.com/feed/rss"
```

### Docker Compose

1. 准备环境变量

```bash
cp .env.example .env
```

2. 启动

```bash
docker compose up -d --build
```

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

可选字段：

- `title`
  手动覆盖标题
- `mode`
  `auto` / `x-direct` / `readability`

其中：

- `auto`
  对 `x.com` / `twitter.com` 优先走内置的 X 专用导入链路，失败再回退
- `x-direct`
  强制走内置的 X 专用导入链路
- `readability`
  强制走当前内置的 Readability 抓取逻辑

## 常用环境变量

- `APP_BASE_URL`
  用于生成 RSS 和文章页链接
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
- `GEMINI_API_KEY`
  可选，设置后会自动把英文的 read-later 内容翻译为中文
- `GEMINI_MODEL`
  可选，Gemini 模型名，默认 `gemini-2.5-flash`
- `TRANSLATE_TARGET_LANGUAGE`
  可选，目标语言，默认 `Simplified Chinese`
- `REFRESH_INTERVAL_MINUTES`
  自动刷新间隔，默认 `30`
- `REFRESH_ON_BOOT`
  启动时是否立即刷新，默认 `true`
- `MAX_ITEMS_PER_REFRESH`
  每次刷新最多处理多少条，默认 `10`
- `MAX_ITEMS_PER_FEED`
  输出 feed 最多保留多少条，默认 `50`
- `HTTP_TIMEOUT_MS`
  上游抓取超时
- `UPSTREAM_PROXY_URL`
  给 RSS 抓取和文章页抓取统一走代理，支持 `http://` 和 `socks5://`

## 当前限制

- 某些站点会拦截正文页抓取，可能返回 `401` 或 `403`
- 某些站点只适合摘要模式，不适合全文抓取
- 少数站点可能需要站点级规则或浏览器抓取回退
- X 页面依赖你自己的登录态 cookie；如果没有提供，X 专用导入会失败
- 配置 `GEMINI_API_KEY` 后，英文内容会在导入时额外调用 Gemini 翻译，导入速度会变慢一些
- 当前是单进程服务，适合个人或家庭自用

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

## How It Works

The default mode is “extract original content, no server-side translation”:

- RSS item `link` points to a hosted reader page
- RSS item `content:encoded` contains extracted original HTML
- The hosted page is designed to work well with in-app webpage translation

## Management Endpoints

- Admin page: `GET /admin`
- Feed list API: `GET /api/feeds`
- Create or update a feed: `POST /api/feeds`
- Save one read-later URL: `POST /api/read-later`
- Delete a feed: `DELETE /api/feeds/:name`
- Refresh one feed: `POST /api/feeds/:name/refresh`
- Import OPML: `POST /api/opml/import`
- Export OPML: `GET /opml.xml`

## Quick Start

### Run locally

```bash
npm install
npm start
```

Default endpoints:

- Admin page: `http://localhost:8787/admin`
- Default feed: `http://localhost:8787/feeds/wired.xml`

Manual first refresh:

```bash
curl "http://localhost:8787/refresh?name=wired&url=https://www.wired.com/feed/rss"
```

### Docker Compose

1. Prepare environment variables

```bash
cp .env.example .env
```

2. Start the service

```bash
docker compose up -d --build
```

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
When `translate` is `false`, the item is stored as original content only even if Gemini translation is configured.

## Common Environment Variables

- `APP_BASE_URL`
  Base URL used in generated feed and article links
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
- `GEMINI_API_KEY`
  Optional. When set, English read-later articles are automatically translated
- `GEMINI_MODEL`
  Optional Gemini model name, default `gemini-2.5-flash`
- `TRANSLATE_TARGET_LANGUAGE`
  Optional target language, default `Simplified Chinese`
- `REFRESH_INTERVAL_MINUTES`
  Auto-refresh interval, default `30`
- `REFRESH_ON_BOOT`
  Whether to refresh immediately on startup, default `true`
- `MAX_ITEMS_PER_REFRESH`
  Max items processed per refresh, default `10`
- `MAX_ITEMS_PER_FEED`
  Max items kept in generated feeds, default `50`
- `HTTP_TIMEOUT_MS`
  Upstream fetch timeout
- `UPSTREAM_PROXY_URL`
  Proxy used for RSS fetches and article-page fetches; supports `http://` and `socks5://`

## Current Limitations

- Some publishers block article-page fetching and may return `401` or `403`
- Some feeds are only practical in summary mode
- A few sites may require site-specific rules or browser-based fallback
- X importing depends on your own authenticated X cookies
- Importing English content is slower when Gemini translation is enabled
- The current runtime model is a single-process service intended for personal or home use
