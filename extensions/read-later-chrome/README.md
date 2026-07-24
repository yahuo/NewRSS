# NewRSS Read Later Chrome 扩展

这是一个给 NewRSS 自用的 Chrome unpacked 扩展。

- 点击工具栏图标，就会把当前 `http/https` 页面保存到 `Read Later`
- 默认连接 `http://newrss.local:8787`，可在扩展详情页的“扩展程序选项”中修改
- 默认发送 `mode=auto`、`translate=true`
- 每次点击生成一个 `Idempotency-Key`，提交响应丢失时使用同一个 key 重试；该 key 只用于幂等，不是鉴权凭据
- 先提交异步任务，再持久化任务编号并定期查询；Chrome 重启后会继续恢复未完成任务
- 成功通知可直接打开 NewRSS 生成的文章页

## 安装

1. 打开 `chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前目录：`extensions/read-later-chrome`
5. 如需使用其他 NewRSS 地址，打开扩展详情页里的“扩展程序选项”并保存服务地址

## 使用

1. 打开任意普通网页或 `x.com` 页面
2. 点击浏览器工具栏里的扩展图标
3. 等待右上角通知
4. 点击成功通知，直接打开 NewRSS 托管文章页

## 排查

- 提示“当前页面不支持保存”：
  当前标签页不是 `http/https` 页面，比如 `chrome://`、扩展页、空白页
- 提示“无法连接到 NewRSS 服务”：
  检查扩展选项中的服务地址是否可访问，服务是否正在运行
- 提示接口错误：
  打开 NewRSS 服务的 `/admin` 页面确认服务正常；如果是 X 页面，再检查服务端 X 登录态配置

## 目录文件

- `manifest.json`：Manifest V3 配置
- `background.mjs`：工具栏点击、请求发送、通知跳转
- `helpers.mjs`：可测试的 URL 校验、payload 和错误消息逻辑
- `options.html` / `options.mjs`：NewRSS 服务地址设置
