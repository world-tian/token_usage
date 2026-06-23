# 飞书个性签名「定时刷新归零 / 待自动采集」问题排查记录

记录 2026-06-23 修复的一组飞书签名显示问题。现象表现各异，但都指向链接预览（url.preview）这条链路。

## 现象

1. 网页「签名预览」框：刚加载有数据，再次刷新变成「今日消耗 token 0」。
2. 飞书个性签名卡片：刚把链接粘过去有数据，过一会 / 再点一次就变「待自动采集」。
3. 聊天里粘同一条链接预览正常有数据，唯独个性签名是空的。
4. 「立即刷新飞书签名」按钮报「刷新失败，请查看服务日志」。

## 根因与修复

### 1. `leaderboard()` 给空口径伪造「零行」→ 显示「token 0」

`leaderboard(items)` 的 `seedDeviceIds` 默认用**全部**设备播种，会先建出 `total_tokens:0` 的行。
当按 `metric:'today'/'total'` 过滤后 `items` 为空时，`.find()` 仍命中这个幽灵零行，于是渲染成
「今日消耗 token 0」而不是「暂无用量」占位。

- 修复：新增 `signatureRow(items, match)`，只用 `items` 内真实出现过的设备播种；空口径返回
  `null` → 由 `buildSignatureText` 渲染「今日暂无大模型用量 🌊 待自动采集」。
- 涉及三个签名出口：`signatureConfigResponseForDevice` / `generateLinkPreviewResponse` / `GET /signature`。

### 2. 前端竞态把已显示的数据刷回 0

`#refresh-now` 里 `loadSignatureConfig()`（Bearer token，可靠）与 `renderSignatureForMetric()`
（依赖 cookie session 的 `/api/v1/leaderboard`，会 401）并发写同一个签名框，后返回者覆盖前者。

- 修复：以后端 `config.preview` 为权威值渲染，去掉并发的 `renderSignatureForMetric`；
  `renderSignatureForMetric` 对 `total_tokens=0` 的行也按「暂无」处理。

### 3. 「立即刷新飞书签名」失败：脏 token 污染整批

飞书 `im.v2.urlPreview.batchUpdate` 是**整批校验**：批次里有一个**格式非法**的 token（库里混进过
一个 `'test'`）就整批拒绝。注意：格式合法但已过期/未知的 token 飞书会**容忍**（静默忽略）。

- 修复：`isLikelyPreviewToken` 过滤非法 token；并把飞书真实错误（code/msg/log_id）透出到日志与前端。
- 兜底：整批失败时逐个重试并剔除失效 token（`removePreviewTokens`），自愈。

### 4. 定时刷新把签名刷成空：推送了「指向空数据 URL」的旧 token

`addPreviewToken` 只存了 token、没存它对应的 URL，`refreshFeishuPreview` 把所有 token 一股脑推给飞书。
其中历史脏链接（`?device_id=default`、主页 `/`、旧 cpolar 域名）解析出来是空数据，刷新它们就把签名刷成
「待自动采集」。

- 修复：token 连同其 URL 一起存（`{t,url,at}`，兼容旧的纯字符串）；`refreshFeishuPreview` **只刷新
  指向本账号正确签名 URL（`feishu_id` 匹配本人 union_id/open_id）的 token**。
- 同时**不要按 URL 去重**：个性签名和每条聊天消息是「同一 URL、不同 token」的独立预览实例，
  各自的 token 都要保留，否则聊天里的新 token 会顶掉签名的 token，导致签名永远刷不到。

### 5.（关键）点击签名变「待自动采集」：`inline.url` 指向空主页

`generateLinkPreviewResponse` 把卡片点击地址 `inline.url` 设成了主页 `/`。点击签名时飞书会去解析这个
目标，而主页没有 `feishu_id` → 解析成空 → 卡片被刷成「待自动采集」。

> 为什么「以前不是这样」：`inline.url=主页` 是初版就有的，但以前主页 `/` 会回退显示「榜首用户数据」
> （非空）。后来登录改动让 `default` 设备被写入了 `feishu_identity`，主页 `/` 的解析从「榜首数据」变成
> 了「空」，于是点击就翻车了。

- 修复：`inline.url` 改为指向**签名 URL 本身**（带 `feishu_id`），点击/解析目标时仍是本人实时数据。
  引导他人配置自己签名的入口，放在 `/signature` 页面正文里。

## 验证要点

- `GET /signature?feishu_id=<union_id>` 连续多次请求结果稳定一致（服务端无随机性）。
- webhook 应答里 `inline.url` 指向 `…/signature?feishu_id=…` 而非主页。
- 「立即刷新飞书签名」返回 `{status:"success", count:N}`，日志 `Batch refresh success`。
- 修改 `inline.url` 后需在飞书**重新保存一次个性签名**，让卡片换上新的点击地址。

## 运维备注

- 飞书密钥不入库：`compose.yaml` 用 `${FEISHU_APP_SECRET}` 等占位，真实值放在被忽略的 `.env`
  （compose 自动读取插值）。本地调试脚本 `inspect_server_db.mjs` / `test_signature.mjs` 也不入库。
