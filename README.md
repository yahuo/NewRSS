# NewRSS MVP

一个面向 Reeder 这类 RSS 阅读器的 Reader View 代理：

- 拉取原始 RSS
- 抓取文章正文并用 Readability 提取
- 生成新的 RSS
- 每条 item 指向本服务托管的干净原文网页
- 支持多源、目录分类和 OPML 导出

当前默认测试源：

- `https://www.wired.com/feed/rss`

## 输出方式

当前服务默认输出提取后的原文，不做服务端翻译：

- RSS item 的 `link` 指向本服务生成的正文网页
- RSS item 的 `content:encoded` 也是提取后的原文 HTML
- 文章页适合在 Reeder 里打开后使用内置网页翻译

## 管理功能

服务内置管理 API 和管理页面：

- 管理页：`/admin`
- 源列表 API：`/api/feeds`
- 单源刷新 API：`POST /api/feeds/:name/refresh`
- 删除源 API：`DELETE /api/feeds/:name`
- OPML 导出：`/opml.xml`

源支持一个 `folder` 字段，管理页会按目录分组显示，导出的 OPML 也会按目录分组。

## 本地运行

```bash
npm install
npm start
```

首次刷新：

```bash
curl "http://localhost:8787/refresh?name=wired&url=https://www.wired.com/feed/rss"
```

订阅地址：

- `http://localhost:8787/feeds/wired.xml`

## Docker

### 1. 准备环境文件

```bash
cp .env.example .env
```

如果你通过 Tailscale 的 MagicDNS 访问，建议把 `.env` 里的 `APP_BASE_URL` 改成：

```bash
APP_BASE_URL=http://你的机器名:8787
```

这样 RSS 里生成的文章链接会稳定指向你的 Tailscale 地址，而不是容器内部地址。

### 2. 启动服务

```bash
docker compose up -d --build
```

### 3. 检查服务

```bash
curl http://localhost:8787/healthz
curl http://localhost:8787/feeds/wired.xml
curl http://localhost:8787/api/feeds
curl http://localhost:8787/opml.xml
```

## Tailscale

推荐方式是让家里的电脑和手机都加入同一个 tailnet，然后直接在 Reeder 里订阅：

- `http://你的机器名:8787/feeds/wired.xml`

如果你管理了多个源，可以：

- 在 `/admin` 页面里逐个复制 feed 地址
- 或直接导出 `/opml.xml`，再导入阅读器

使用建议：

- 电脑端开启 Tailscale 并保持在线
- 手机端安装 Tailscale 并登录同一账号
- 在 Reeder 中添加上面的 feed 地址
- 点开文章后，使用 Reeder 内置网页翻译

## 常用环境变量

- `APP_BASE_URL`
  用于生成 RSS 中的文章链接，家庭部署建议设成 Tailscale 地址
- `DEFAULT_FEED_FOLDER`
  第一次启动自动种入默认源时使用的目录名
- `REFRESH_INTERVAL_MINUTES`
  定时刷新间隔，默认 `30`
- `REFRESH_ON_BOOT`
  启动时是否立即刷新，默认 `true`
- `MAX_ITEMS_PER_REFRESH`
  每次刷新最多处理多少条，默认 `10`
- `MAX_ITEMS_PER_FEED`
  RSS 输出最多保留多少条，默认 `50`

## 当前限制

- 某些站点的正文提取可能需要站点级规则
- 现在只做了单进程定时刷新，适合个人自用
