# Token 潮汐（Token Tide）

公司内部大模型 Token 用量看板与趣味排行榜。采集 Claude Code、Codex CLI 等工具的本地日志，聚合到一个海洋主题排行榜，并能把实时用量注入飞书签名展示。

> 看看今天谁在深蓝里掀起浪花。

## 功能

- **飞书动态签名**：在飞书里点签名链接，自动显示 🐠 小丑鱼 Lv.4｜今日消耗token 2960.58万｜≈¥172.03 等实时数据
- **Token 排行榜**：今日 / 累计双榜，按消耗量换算海洋动物等级（章鱼、蓝鲸…）
- **飞书 OAuth 登录**：扫码或跳转即可绑定身份，不需要单独注册
- **自动定时采集**：macOS launchd 每 30 分钟自动触发，无需手动操作
- **本机持久化**：SQLite 存储，重启数据不丢，支持多设备合并

## 快速文档

| 文档 | 说明 |
|---|---|
| [部署指南](docs/deployment.md) | 从零开始的完整部署流程（macOS + cpolar + launchd） |
| [飞书配置指南](docs/feishu-setup.md) | 飞书开放平台配置、签名调试、OAuth 设置 |
| [开发指南](docs/development.md) | 本地开发、目录结构、数据库说明 |
| [产品与技术设计](docs/product-and-technical-design.md) | 架构决策和设计文档 |

## 架构一览

```
Claude Code / Codex CLI  →  Collector CLI  →  Server (Node.js)  →  Web UI
                                                     ↓
                                              SQLite (本地持久化)
                                                     ↓
                                          飞书 WebSocket 长连接
                                         （url.preview.get 回调）
                                                     ↓
                                           飞书签名实时文字预览
```

## 依赖

- Node.js 22+（内置 `node:sqlite`，无额外 npm 包）
- cpolar 或同类内网穿透工具（飞书回调必须 HTTPS）
- macOS（launchd 自动启动；其他平台可改用 systemd/pm2）

## 快速启动（开发模式）

```bash
# 1. 克隆并进入目录
git clone git@github.com:world-tian/token_usage.git
cd token_usage

# 2. 复制并填写环境变量
cp .env.example .env
# 编辑 .env，填写 PORT、PUBLIC_BASE_URL、FEISHU_APP_ID 等

# 3. 启动服务
node --env-file-if-exists=.env apps/server/src/server.mjs

# 4. 首次配对采集器（在另一个终端）
node apps/collector/src/cli.mjs sync --server http://127.0.0.1:8787 --code <页面上显示的配对码>
```

完整的生产部署（含 launchd 自动启动和 cpolar 域名）见 [部署指南](docs/deployment.md)。
