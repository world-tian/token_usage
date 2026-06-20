# Token 潮汐开发指南

## 当前实现范围

当前版本是第一条可运行纵向闭环：

- Node.js API 与静态 Web 页面。
- 一次性设备配对码。
- SSE 接入状态：等待、配对、扫描、上传、聚合。
- 隐私白名单用量事件与上传回执。
- Collector CLI 支持真实 Codex CLI 与 Claude Code 本地日志，并保留显式 `demo-sync` 测试模式。
- 内存排行榜、模型占比条、潮汐值和海洋动物等级。

已实现：飞书 OAuth 登录、SQLite 持久化、飞书签名（链接预览）——见下方「数据存储」与 [feishu-setup.md](feishu-setup.md)。

尚未实现：正式计价、原生安装包和生产级身份权限。真实 Codex/Claude 解析器已进入 PoC，仍需更多版本样本验证。

## 环境要求

- Node.js 22 或更高版本。
- npm 10 或更高版本。
- 当前闭环不依赖第三方 npm 包，无需 `npm install`。

## 本地启动

```bash
npm start
```

打开 <http://127.0.0.1:8787>，选择操作系统并点击“生成配对命令”，复制页面给出的统一安装命令，可在任意终端目录执行。macOS/Linux 安装到 `~/.token-tide/bin`，Windows 安装到 `%LOCALAPPDATA%\TokenTide\bin`，不依赖仓库或用户名路径。

也可分开验证：

```bash
npm run collector -- doctor
npm test
npm run check
```

## 目录

```text
apps/server      API、配对、回执、聚合
apps/collector   一次性 CLI 采集入口
apps/web         海洋主题接入页和排行榜
packages/contracts  统一事件 JSON Schema
docs             产品、开发、部署和任务文档
```

## 数据存储（SQLite）

持久化用 Node 内置 `node:sqlite`，零第三方依赖。数据库文件 `apps/server/src/token-tide.db`（已 gitignore），可用 `DB_FILE` 环境变量改路径。

| 表 | 字段 | 说明 |
|----|------|------|
| `device_configs` | `device_id` PK, `config_json` | 每台设备的配置、token、profile、飞书身份 |
| `events` | `event_key` PK, `device_id`, `event_json`, `occurred_at` | 用量事件；`event_key` 去重，重复上传自动忽略 |

- 排行榜/签名仍读内存，DB 只做持久化后端：启动时 `loadConfig()` / `loadEvents()` 把数据载回内存；写操作（配置变更、事件上传）write-through 落库。
- 首次启动会把旧的 `config.json` / `events.json` 一次性迁移进库（仅当表为空），老数据不丢；迁移后这两个 JSON 不再写入。
- 部署到 Node 22 时，启动命令需加 `--experimental-sqlite`（Node 23.4+ 免 flag）。

### 设备身份与采集命令

- 采集器首次 `token-tide sync --code XXXX` 配对后，把 device_token 存到 `~/.token-tide/credentials.json`；之后 `token-tide sync`（不带 code）复用 → device_id 稳定、同一用户数据累积、命令固定不变。
- token 失效（服务端重置过数据库）时采集器会收到 401，自动清掉本地凭据并提示重新用 `--code` 配对。

## API 快速检查

```bash
curl http://127.0.0.1:8787/healthz
curl -X POST http://127.0.0.1:8787/api/v1/device-codes
curl http://127.0.0.1:8787/api/v1/leaderboard
```

## 开发约束

- 真实适配器只允许输出统一事件字段，禁止上传提示词、回复、代码、文件路径、仓库地址和密钥。
- 新适配器遵循 `Detect → Preview → Collect → Normalize`。
- 模型名先保留 `observed_model`，只有注册表确认后才写 `canonical_model_id`。
- 不得将演示价格、演示模型或内存数据实现用于生产环境。
