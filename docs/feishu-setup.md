# 飞书签名（自定义链接预览）配置指南

本项目的「飞书动态签名」用的是飞书 **自定义链接预览（`url.preview.get` 回调）** 机制，不是 OG 抓取。
飞书在签名/消息里看到匹配 URL 规则的链接时，会向本服务发回调，本服务返回 `inline.title`，飞书把它渲染成预览文字。

参考：飞书「链接预览开发指南」与「拉取链接预览数据回调结构」官方文档。

---

## 一、前置：让本机服务有一个公网 HTTPS 域名

飞书回调**必须 HTTPS**，且 URL 规则里注册的是**固定域名**，所以需要内网穿透或云服务器把本机 `127.0.0.1:8787` 暴露出去。

- 验证/临时：**cpolar 免费档**（自带 http+https，但域名随机、重启即变）
  ```bash
  cpolar http 8787
  # Forwarding https://xxxx.r11.cpolar.top -> http://localhost:8787
  ```
- 长期/固定：cpolar 付费固定域名，或 natapp 付费「二级域名」（`xxx.nat100.top`）
- 注意：natapp **免费**的「标识域名」不提供 Web 访问，必须买二级域名；穿透时本地协议保持 **http**（公网 https 由穿透服务在边缘终止）

> ⚠️ 用免费随机域名时，**重启穿透 → 域名变 → 飞书 URL 规则失效**。长期使用务必用固定域名。

---

## 二、飞书开放平台配置（以「Token 潮汐」应用为例）

以域名 `<DOMAIN>`（如 `tide.nat100.top`）为例：

1. **能力** → 添加「链接预览」
2. **URL 规则**：`<DOMAIN>`
3. **事件回调地址**：`https://<DOMAIN>/api/v1/feishu/link-preview`
   - 保存时飞书发 challenge 校验，本服务已能正确应答 `{"challenge": "..."}`
4. **加密策略 / Encrypt Key 留空**（关键）
   - 不加密时飞书发明文、不带签名，服务跳过签名校验
   - 若启用 Encrypt Key，需改用 `SHA256(timestamp + nonce + encryptKey + body)` 算法（当前代码用的是 HMAC，未对齐，启用前要先改）
5. 订阅事件「拉取链接预览数据」(`url.preview.get`)
6. **发布版本** + 可用范围设「全部成员」（链接预览仅对可见范围内用户生效）
7. 把 `https://<DOMAIN>/signature?device_id=<设备ID>` 粘到飞书签名或消息里验证

---

## 三、换域名时只改 3 处（代码不用动）

每次换公网域名（如从 cpolar 临时域名切到固定域名），改完重启 node 服务即可：

1. `.env` 的 `PUBLIC_BASE_URL`
2. `.env` 的 `FEISHU_REDIRECT_URI`（= `https://<DOMAIN>/api/v1/auth/feishu/callback`）
3. 飞书开放平台的「URL 规则」+「事件回调地址」

```bash
# 重启服务（加载新 .env / 新代码）
# 先停掉旧进程，再：
node --env-file-if-exists=.env apps/server/src/server.mjs
```

---

## 四、验证命令（把 <DOMAIN> 换成你的域名）

```bash
# 1) 服务是否通
curl -s https://<DOMAIN>/healthz
# 期望: {"status":"ok",...}

# 2) challenge 校验是否正确应答
curl -s -X POST https://<DOMAIN>/api/v1/feishu/link-preview \
  -H 'content-type: application/json' \
  -d '{"type":"url_verification","challenge":"abc123","token":"t"}'
# 期望: {"challenge":"abc123"}

# 3) url.preview.get 回调是否返回正确格式
curl -s -X POST https://<DOMAIN>/api/v1/feishu/link-preview \
  -H 'content-type: application/json' \
  -d '{"header":{"event_type":"url.preview.get","token":"t"},"event":{"context":{"url":"https://<DOMAIN>/signature?device_id=default","preview_token":"pt_1"}}}'
# 期望: {"inline":{"title":"...签名文字..."}}
```

三条都符合预期 = 代码侧就绪，剩下看飞书平台「URL 规则 / 回调 / 发布 / 全员可用」是否配齐。

---

## 五、回调返回格式（已对齐官方）

`POST /api/v1/feishu/link-preview` 对 `url.preview.get` 的应答（见 `apps/server/src/server.mjs` 的 `generateLinkPreviewResponse`）：

```json
{ "inline": { "title": "🐠 小丑鱼 Lv.4｜今日消耗token 1.2万｜≈¥3.40｜06/20 18:30" } }
```

- `inline` 必填，`title` 为签名显示文字
- 可选 `inline.image_key`（前缀图标，需先用飞书图片上传 API 拿 key）、`inline.i18n_title`（多语言，优先级高于 `title`）

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 解析失败 / 预览不出 | 公网 URL 不可达（隧道挂了/域名变了） | `curl healthz` 确认；换固定域名 |
| 回调返回 502 | 隧道转发端口 ≠ 8787 | 穿透本地端口改 8787 |
| https 连不上 | 用了 natapp 免费标识域名 | 买二级域名；本地协议保持 http |
| challenge 不过 / 回调被拒 | 配了 Encrypt Key 但签名算法没对齐 | Encrypt Key 留空 |
| 预览只对自己生效 | 应用未发布或可用范围不是全员 | 发布 + 可用范围「全部成员」 |
| 飞书登录报错 | 授权 host/参数错、或重定向 URL 未加白名单 | 见下方第七节 |

---

## 七、飞书登录（OAuth）

「飞书登录」按钮走 OAuth 授权码模式，正确地址（已在代码里修好）：

- 授权页：`https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=<APPID>&redirect_uri=<URI>&state=...`（host 是 `accounts.feishu.cn`，参数是 `client_id`，**不是** `open.feishu.cn` / `app_id`）
- 换 token：`POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`
- 取用户信息：`GET https://open.feishu.cn/open-apis/authen/v1/user_info`（字段在返回的 `data` 下）

飞书开放平台需要配齐（否则登录会报错）：

1. **安全设置 → 重定向 URL** 加白名单：`https://<DOMAIN>/api/v1/auth/feishu/callback`
   （域名变了这里也要同步改，和 URL 规则一样）
2. 开启**网页应用 / 登录**能力
3. 如 `user_info` 取不到信息：给应用加「获取用户基本信息」权限，并在 `.env` 设 `FEISHU_OAUTH_SCOPE`（如 `contact:user.base:readonly`）

> 未配 `FEISHU_APP_ID/SECRET` 时，登录按钮会走 `/mock-feishu-auth.html` 本地演示身份，不连飞书。

### 授权页显示的名字（容易看错）

飞书 OAuth 授权确认页：

- **顶部的应用名/图标** = 发起授权的**应用**，由 `.env` 里 `FEISHU_APP_ID` 指向的那个 app 决定。想让这里显示「Token 潮汐」，就把 Token 潮汐 应用的 app_id/secret 填进 `.env`（而不是别的 app）。
- **下方卡片** = 当前**登录的飞书账号**（个人账号 + 所在企业），点「使用其他账号」可切换。

每个用户**首次**会看到一次「授权」确认页，点一次即可，之后不再询问。这一步是 OAuth 用户身份授权的固有环节，**无法用 app secret 跳过**（secret 是应用身份，不代表"用户是谁"）。应用发布且可用范围=全员后，任何飞书用户都能扫码/跳转登录。
