# Token 潮汐 · 部署指南（macOS 本机版）

本文档覆盖从零开始在 macOS 上完整部署 Token 潮汐的所有步骤：cpolar 内网穿透、飞书平台配置、launchd 自动启动。

---

## 目录

1. [前置条件](#前置条件)
2. [第一步：获取代码和配置](#第一步获取代码和配置)
3. [第二步：启动 cpolar 内网穿透](#第二步启动-cpolar-内网穿透)
4. [第三步：配置 .env](#第三步配置-env)
5. [第四步：配置飞书开放平台](#第四步配置飞书开放平台)
6. [第五步：首次运行和采集器配对](#第五步首次运行和采集器配对)
7. [第六步：配置 launchd 自动启动（不用手动管理进程）](#第六步配置-launchd-自动启动)
8. [验证全链路](#验证全链路)
9. [日常管理命令](#日常管理命令)
10. [换域名流程](#换域名流程)
11. [常见问题](#常见问题)

---

## 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | 23.4+ 推荐，22+ 可用 | 22 需加 `--experimental-sqlite` flag |
| cpolar | 任意版本 | 免费版够用但域名随机；付费版可固定域名 |
| 飞书开放平台 | 企业自建应用 | 需要「链接预览」能力和 OAuth 登录 |

---

## 第一步：获取代码和配置

```bash
git clone git@github.com:world-tian/token_usage.git
cd token_usage
cp .env.example .env
```

---

## 第二步：启动 cpolar 内网穿透

飞书的 `url.preview.get` 回调**必须 HTTPS**，需要把本机 `127.0.0.1:8787` 穿透到公网。

### 安装 cpolar

```bash
# macOS（Homebrew 方式）
brew install cpolar

# 或直接下载：https://www.cpolar.com/download
```

首次下载可能被 macOS Gatekeeper 拦截，处理方法：
> 系统设置 → 隐私与安全性 → 下方出现「仍然允许 cpolar」→ 点击允许

### 启动隧道

```bash
cpolar http 8787
```

输出类似：

```
Forwarding  https://xxxx.r11.cpolar.top -> http://localhost:8787
```

记下这个 `https://xxxx.r11.cpolar.top`，后面配置 `.env` 和飞书平台都要用。

> **注意**：cpolar 免费档的域名在**每次重启后会变**。换了域名后要更新 `.env` 和飞书平台，见 [换域名流程](#换域名流程)。
> 付费版可绑定固定域名（推荐长期使用）。

---

## 第三步：配置 .env

编辑项目根目录的 `.env`（从 `.env.example` 复制而来）：

```dotenv
PORT=8787
HOST=127.0.0.1

# cpolar 给你的公网 HTTPS 域名
PUBLIC_BASE_URL=https://xxxx.r11.cpolar.top

ORG_TIMEZONE=Asia/Shanghai
USD_CNY_RATE=7.2

# 飞书开放平台的 Token 潮汐 应用凭据
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 必须和飞书平台「安全设置 → 重定向 URL」完全一致
FEISHU_REDIRECT_URI=https://xxxx.r11.cpolar.top/api/v1/auth/feishu/callback
```

---

## 第四步：配置飞书开放平台

以下配置需在 [飞书开放平台](https://open.feishu.cn) 对应应用里完成。详细说明见 [飞书配置指南](feishu-setup.md)，这里是最小步骤：

### 4.1 链接预览（飞书动态签名必须）

1. **能力** → 添加「链接预览」
2. **事件订阅 → 请求网址配置**：`https://<DOMAIN>/api/v1/feishu/link-preview`
3. **事件订阅 → 添加事件**：「拉取链接预览数据」(`url.preview.get`)
4. **链接预览 → URL 规则**：填 `<DOMAIN>`（不含 https://）
5. **发布**版本，可用范围设「全部成员」

### 4.2 飞书登录（OAuth）

1. **安全设置 → 重定向 URL**：加白名单 `https://<DOMAIN>/api/v1/auth/feishu/callback`
2. 开启**网页应用**能力（「登录」tab）

> 两处的 `<DOMAIN>` 都和 `.env` 里 `PUBLIC_BASE_URL` 保持一致。

---

## 第五步：首次运行和采集器配对

### 手动启动服务（验证阶段用）

```bash
node --env-file-if-exists=.env apps/server/src/server.mjs
```

打开 `http://127.0.0.1:8787`，页面会显示一个配对码（如 `ABC123`）。

### 首次配对采集器

```bash
node apps/collector/src/cli.mjs sync \
  --server http://127.0.0.1:8787 \
  --code ABC123
```

成功后 `~/.token-tide/credentials.json` 里会保存 device_token，之后的 sync 不需要 `--code`：

```bash
node apps/collector/src/cli.mjs sync --server http://127.0.0.1:8787
# 输出类似: Accepted 63 events; 1574 duplicates skipped
```

---

## 第六步：配置 launchd 自动启动

这步只需要把服务端变成**系统级后台任务**：开机登录后自动启动，崩溃/被杀后自动重启。服务端内置真实调度器，会读取网页中设置的「开启自动采集」和采集间隔，不要再额外创建独立的 collector launchd 任务，否则两套任务会重复上传并触发飞书刷新防抖。

### 关键点：中文路径不能直接传给 launchd

launchd 在 `ProgramArguments` 里传递包含中文的路径时会乱码（exit code 78 / EX_CONFIG），必须使用 ASCII 路径的包装脚本。

### 6.1 创建 ASCII 路径目录和包装脚本

```bash
mkdir -p ~/.token-tide
```

**`~/.token-tide/start-server.sh`**：

```zsh
#!/bin/zsh
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
cd "/Users/<你的用户名>/token_usage" || exit 1
exec /opt/homebrew/bin/node --env-file-if-exists=.env apps/server/src/server.mjs
```

```bash
chmod +x ~/.token-tide/start-server.sh
```

### 6.2 创建 launchd 服务配置

**`~/Library/LaunchAgents/com.tokentide.server.plist`**（服务端，KeepAlive 守活）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tokentide.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>/Users/<你的用户名>/.token-tide/start-server.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/<你的用户名>/.token-tide/server.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<你的用户名>/.token-tide/server.log</string>
</dict>
</plist>
```

如果旧版本曾安装 `com.tokentide.collector`，升级后执行一次
`launchctl bootout gui/$(id -u)/com.tokentide.collector` 停用它。网页中的调度设置将成为唯一来源。

### 6.3 加载服务

```bash
launchctl load ~/Library/LaunchAgents/com.tokentide.server.plist
```

### 6.4 验证

```bash
launchctl list | grep tokentide
# 输出类似:
# 90826  0  com.tokentide.server

curl http://127.0.0.1:8787/healthz
# 期望: {"status":"ok",...}
```

---

## 验证全链路

```bash
# 1. 本地服务通
curl -s http://127.0.0.1:8787/healthz

# 2. 公网通（用 cpolar 域名）
curl -s https://<DOMAIN>/healthz

# 3. 飞书 challenge 校验
curl -s -X POST https://<DOMAIN>/api/v1/feishu/link-preview \
  -H 'content-type: application/json' \
  -d '{"type":"url_verification","challenge":"abc123","token":"t"}'
# 期望: {"challenge":"abc123"}

# 4. 采集器 sync
node apps/collector/src/cli.mjs sync --server http://127.0.0.1:8787
# 期望: Accepted N events; M duplicates skipped

# 5. 飞书签名：把这个 URL 放进飞书个人签名
# https://<DOMAIN>/signature?device_id=<你的设备ID>
# 在飞书消息里发送该链接，hover 或 inline 应显示 Token 用量文字
```

---

## 日常管理命令

```bash
# 查看状态
launchctl list | grep tokentide

# 查看日志（实时）
tail -f ~/.token-tide/server.log

# 重启服务端（修改 .env 或代码后用）
launchctl unload ~/Library/LaunchAgents/com.tokentide.server.plist
launchctl load   ~/Library/LaunchAgents/com.tokentide.server.plist

# 立即触发一次采集（也可在网页点击“立即刷新数据”）
node apps/collector/src/cli.mjs sync --server http://127.0.0.1:8787
```

---

## 换域名流程

每次 cpolar 重启后域名会变（免费版），或你切到固定域名时，只需改 **3 处**，不用动代码：

| 位置 | 改什么 |
|---|---|
| `.env` `PUBLIC_BASE_URL` | 新 HTTPS 域名 |
| `.env` `FEISHU_REDIRECT_URI` | `https://<新域名>/api/v1/auth/feishu/callback` |
| 飞书平台「URL 规则」 | 新域名 |
| 飞书平台「事件回调地址」 | `https://<新域名>/api/v1/feishu/link-preview` |
| 飞书平台「安全设置 → 重定向 URL」 | `https://<新域名>/api/v1/auth/feishu/callback` |

改完后重启服务端：

```bash
launchctl unload ~/Library/LaunchAgents/com.tokentide.server.plist
launchctl load   ~/Library/LaunchAgents/com.tokentide.server.plist
```

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| launchd exit code 78 | plist 里有中文路径 | 改用 ASCII 路径的包装脚本（见第六步） |
| 服务起来但公网不通 | cpolar 没在跑 | 重新 `cpolar http 8787` |
| 飞书签名不显示 / 解析失败 | URL 规则或回调地址过期 | 确认 cpolar 域名 → 更新飞书平台 → 重启服务 |
| 采集器 401 | device_token 失效（DB 被清了） | `rm ~/.token-tide/credentials.json`，重新配对 |
| 今日排行榜为空（过了零点）| 当天尚无采集数据 | 手动触发一次 sync 即可显示 0 或真实数据 |
| 飞书 OAuth 报错 | 重定向 URL 未加白名单 | 飞书平台「安全设置 → 重定向 URL」补充 |
