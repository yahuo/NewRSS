# NewRSS Read Later Chrome 扩展

这是一个给 NewRSS 自用的 Chrome unpacked 扩展。

- 点击工具栏图标，就会把当前 `http/https` 页面保存到 `Read Later`
- 固定请求 `http://macpro.sgponte:8787/api/read-later`
- 默认发送 `mode=auto`、`translate=true`
- 成功通知可直接打开 NewRSS 生成的文章页

## 安装

1. 打开 `chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前目录：`extensions/read-later-chrome`

## 使用

1. 打开任意普通网页或 `x.com` 页面
2. 点击浏览器工具栏里的扩展图标
3. 等待右上角通知
4. 点击成功通知，直接打开 NewRSS 托管文章页

## 排查

- 提示“当前页面不支持保存”：
  当前标签页不是 `http/https` 页面，比如 `chrome://`、扩展页、空白页
- 提示“无法连接到 NewRSS 服务”：
  检查 `http://macpro.sgponte:8787` 是否可访问，服务是否正在运行
- 提示接口错误：
  打开 `http://macpro.sgponte:8787/admin`，确认服务正常；如果是 X 页面，再检查服务端 X 登录态配置

## 目录文件

- `manifest.json`：Manifest V3 配置
- `background.mjs`：工具栏点击、请求发送、通知跳转
- `helpers.mjs`：可测试的 URL 校验、payload 和错误消息逻辑
