import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { animalLevel, buildReceipt, createPairing, stableEventKey, tidePoints, totalTokens, validateUsageEvent } from './core.mjs';
import { estimateEventCost, priceForModel } from './pricing.mjs';

// 全局兜底：飞书长连接/网络等异步错误不得拖垮 HTTP 服务（尤其 launchd 启动时网络未就绪会 ENOTFOUND）
process.on('unhandledRejection', (reason) => console.error('[Process] Unhandled rejection (kept alive):', reason?.message || reason));
process.on('uncaughtException', (err) => console.error('[Process] Uncaught exception (kept alive):', err?.message || err));

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const baseUrl = process.env.PUBLIC_BASE_URL || `http://${host}:${port}`;
const usdCnyRate = Number(process.env.USD_CNY_RATE || 7.2);
const organizationTimeZone = process.env.ORG_TIMEZONE || 'Asia/Shanghai';
const feishuAppId = process.env.FEISHU_APP_ID || '';
const feishuAppSecret = process.env.FEISHU_APP_SECRET || '';
const feishuRedirectUri = process.env.FEISHU_REDIRECT_URI || `${baseUrl}/api/v1/auth/feishu/callback`;
const feishuOAuthScope = process.env.FEISHU_OAUTH_SCOPE || '';
const oauthStateSecret = process.env.OAUTH_STATE_SECRET || feishuAppSecret || randomUUID();
let feishuClientPromise = null;
const webRoot = fileURLToPath(new URL('../../web/public/', import.meta.url));
const collectorSource = fileURLToPath(new URL('../../collector/src/cli.mjs', import.meta.url));
const adaptersSource = fileURLToPath(new URL('../../collector/src/adapters.mjs', import.meta.url));

const dbFile = process.env.DB_FILE || fileURLToPath(new URL('./token-tide.db', import.meta.url));
const configFile = fileURLToPath(new URL('./config.json', import.meta.url)); // 旧 JSON，仅用于一次性迁移
const eventsFile = fileURLToPath(new URL('./events.json', import.meta.url));  // 旧 JSON，仅用于一次性迁移

// SQLite 数据库：设备配置 + 用量事件持久化，重启不丢
const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS device_configs (
    device_id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    event_key TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    occurred_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
  CREATE TABLE IF NOT EXISTS sessions (
    session_token TEXT PRIMARY KEY,
    feishu_open_id TEXT NOT NULL,
    union_id TEXT NOT NULL DEFAULT '',
    tenant_key TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_open_id ON sessions(feishu_open_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_union_id ON sessions(union_id);
`);

let dbConfig = { devices: {} };

// 旧 JSON 文件 → SQLite 的一次性迁移（仅当对应表为空时执行），保证升级前的数据不丢
function migrateJsonIfNeeded() {
  try {
    if (db.prepare('SELECT COUNT(*) AS n FROM device_configs').get().n === 0 && existsSync(configFile)) {
      const data = JSON.parse(readFileSync(configFile, 'utf8'));
      const devices = data.devices || (data.metric ? { default: { ...data, profile: data.profile || { display_name: '本机用户', avatar: '👤' } } } : {});
      const stmt = db.prepare('INSERT OR REPLACE INTO device_configs (device_id, config_json) VALUES (?, ?)');
      for (const [id, cfg] of Object.entries(devices)) stmt.run(id, JSON.stringify(cfg));
      console.log(`[Persistence] Migrated ${Object.keys(devices).length} device config(s) from config.json`);
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0 && existsSync(eventsFile)) {
      const items = JSON.parse(readFileSync(eventsFile, 'utf8')).events || [];
      const stmt = db.prepare('INSERT OR IGNORE INTO events (event_key, device_id, event_json, occurred_at) VALUES (?, ?, ?, ?)');
      let n = 0;
      for (const item of items) {
        if (!item?.deviceId || !item?.event) continue;
        stmt.run(stableEventKey(item.deviceId, item.event), item.deviceId, JSON.stringify(item.event), item.event.occurred_at || null);
        n++;
      }
      console.log(`[Persistence] Migrated ${n} usage event(s) from events.json`);
    }
  } catch (e) {
    console.error('JSON→SQLite migration failed:', e);
  }
}

function loadConfig() {
  try {
    migrateJsonIfNeeded();
    dbConfig = { devices: {} };
    for (const row of db.prepare('SELECT device_id, config_json FROM device_configs').all()) {
      try { dbConfig.devices[row.device_id] = JSON.parse(row.config_json); } catch {}
    }
  } catch (e) {
    console.error('Failed to load config from DB:', e);
  }
}

function saveConfig() {
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO device_configs (device_id, config_json) VALUES (?, ?)');
    for (const [id, cfg] of Object.entries(dbConfig.devices)) stmt.run(id, JSON.stringify(cfg));
  } catch (e) {
    console.error('Failed to save config to DB:', e);
  }
}

// 启动时把历史用量事件载回内存（排行榜/签名仍读内存，DB 只做持久化后端）
function loadEvents() {
  try {
    for (const row of db.prepare('SELECT event_key, device_id, event_json FROM events ORDER BY rowid').all()) {
      try {
        const event = JSON.parse(row.event_json);
        state.events.push({ deviceId: row.device_id, event });
        state.eventKeys.add(row.event_key ?? stableEventKey(row.device_id, event));
      } catch {}
    }
    console.log(`[Persistence] Restored ${state.events.length} usage event(s) from SQLite`);
  } catch (e) {
    console.error('Failed to load events from DB:', e);
  }
}

// 单条事件落库（去重靠 event_key 主键）
function persistEvent(deviceId, event, key) {
  try {
    db.prepare('INSERT OR IGNORE INTO events (event_key, device_id, event_json, occurred_at) VALUES (?, ?, ?, ?)')
      .run(key, deviceId, JSON.stringify(event), event.occurred_at || null);
  } catch (e) {
    console.error('Failed to persist event:', e);
  }
}

function getDeviceConfig(deviceId) {
  const id = deviceId || 'default';
  if (!dbConfig.devices[id]) {
    dbConfig.devices[id] = {
      metric: 'today',
      interval_minutes: 30,
      auto_collect_enabled: true,
      delivery: 'dynamic_url',
      feishu_status: 'not_connected',
      profile: { display_name: '本机用户', avatar: '👤' },
      updated_at: new Date().toISOString()
    };
    saveConfig();
  }
  return dbConfig.devices[id];
}

function saveDeviceConfig(deviceId, configUpdate, profileUpdate) {
  const id = deviceId || 'default';
  const current = getDeviceConfig(id);
  
  if (configUpdate) {
    const { metric, interval_minutes, auto_collect_enabled } = configUpdate;
    if (metric !== undefined) current.metric = metric;
    if (interval_minutes !== undefined) current.interval_minutes = interval_minutes;
    if (auto_collect_enabled !== undefined) current.auto_collect_enabled = auto_collect_enabled;
  }
  
  if (profileUpdate) {
    const { display_name, avatar } = profileUpdate;
    if (!current.profile) current.profile = { display_name: '本机用户', avatar: '👤' };
    if (display_name !== undefined) current.profile.display_name = display_name;
    if (avatar !== undefined) current.profile.avatar = avatar;
  }
  
  current.updated_at = new Date().toISOString();
  dbConfig.devices[id] = current;
  saveConfig();
}

// ── Session 管理（30 天 Cookie，存 SQLite）──────────────────────────────────
function createSession(feishu_open_id, union_id, tenant_key, profile) {
  const token = randomUUID() + randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  try { db.exec("ALTER TABLE sessions ADD COLUMN union_id TEXT NOT NULL DEFAULT ''"); } catch {}
  db.prepare('INSERT INTO sessions (session_token,feishu_open_id,union_id,tenant_key,profile_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(token, feishu_open_id, union_id || '', tenant_key || '', JSON.stringify(profile), now, expires);
  return token;
}

function getSession(token) {
  if (!token) return null;
  try {
    const row = db.prepare('SELECT * FROM sessions WHERE session_token=? AND expires_at>?').get(token, new Date().toISOString());
    if (!row) return null;
    return { feishu_open_id: row.feishu_open_id, union_id: row.union_id || '', tenant_key: row.tenant_key, profile: JSON.parse(row.profile_json) };
  } catch { return null; }
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE session_token=?').run(token);
}

function getSessionFromRequest(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)tt_session=([^;]+)/);
  return match ? getSession(decodeURIComponent(match[1])) : null;
}

function sessionCookie(token, maxAge = 2592000) {
  return `tt_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

// 按 union_id（优先）或 open_id 找第一个匹配设备
function findDeviceByFeishuId(feishuId, isUnionId = false) {
  if (!feishuId) return null;
  for (const [did, cfg] of Object.entries(dbConfig.devices)) {
    const fi = cfg.feishu_identity;
    if (!fi) continue;
    if (isUnionId ? fi.union_id === feishuId : fi.open_id === feishuId) return did;
  }
  // 如果按 union_id 找不到，再试 open_id
  if (isUnionId) {
    for (const [did, cfg] of Object.entries(dbConfig.devices)) {
      if (cfg.feishu_identity?.open_id === feishuId) return did;
    }
  }
  return null;
}

function addPreviewToken(deviceId, previewToken) {
  if (!previewToken) return;
  const config = getDeviceConfig(deviceId || 'default');
  const tokens = new Set(config.preview_tokens || []);
  tokens.add(previewToken);
  config.preview_tokens = [...tokens].slice(-100);
  config.preview_registered_at = new Date().toISOString();
  config.updated_at = new Date().toISOString();
  saveConfig();
}

async function getFeishuClient() {
  if (!feishuAppId || !feishuAppSecret) return null;
  if (!feishuClientPromise) {
    feishuClientPromise = import('@larksuiteoapi/node-sdk').then((lark) => new lark.Client({
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      appType: lark.AppType.SelfBuild
    }));
  }
  return feishuClientPromise;
}

const _previewCooldown = new Map(); // deviceId → last push timestamp
async function refreshFeishuPreview(deviceId, reason = 'usage_updated') {
  const config = getDeviceConfig(deviceId || 'default');
  const previewTokens = [...new Set(config.preview_tokens || [])];
  if (!previewTokens.length) return { status: 'waiting_for_preview_token', count: 0 };
  // 飞书 batchUpdate 有频率限制，2 分钟内同一设备只推一次
  const now = Date.now();
  const last = _previewCooldown.get(deviceId) || 0;
  if (now - last < 2 * 60_000) return { status: 'rate_limited_local', count: previewTokens.length };
  _previewCooldown.set(deviceId, now);
  if (!feishuAppId || !feishuAppSecret) {
    config.preview_refresh_status = 'waiting_for_app_credentials';
    config.preview_refresh_error = 'FEISHU_APP_ID / FEISHU_APP_SECRET not configured';
    saveConfig();
    return { status: config.preview_refresh_status, count: previewTokens.length };
  }
  try {
    const client = await getFeishuClient();
    const result = await client.im.v2.urlPreview.batchUpdate({ data: { preview_tokens: previewTokens } });
    if (result?.code) throw new Error(`${result.code}: ${result.msg || 'unknown Feishu error'}`);
    config.preview_refresh_status = 'success';
    config.preview_refresh_error = null;
    config.preview_last_refreshed_at = new Date().toISOString();
    config.preview_refresh_reason = reason;
    saveConfig();
    return { status: 'success', count: previewTokens.length };
  } catch (error) {
    const apiError = error.response?.data;
    const errorDetail = apiError?.msg ? `${apiError.code || 'Feishu'}: ${apiError.msg}` : error.message;
    config.preview_refresh_status = 'failed';
    config.preview_refresh_error = errorDetail;
    saveConfig();
    console.error('[Feishu Preview] Batch refresh failed:', errorDetail);
    return { status: 'failed', count: previewTokens.length, error: errorDetail };
  }
}
loadConfig();
const state = {
  pairings: new Map(),
  pairingsByCode: new Map(),
  devices: new Map(),
  receipts: new Map(),
  eventKeys: new Set(),
  events: [],
  streams: new Map(),
  signatureRequests: [],
  previewEvents: [],
  get signatureConfig() {
    return getDeviceConfig('default');
  },
  get profile() {
    return getDeviceConfig('default').profile;
  }
};

// 恢复已配置设备的 token 映射，防止服务重启失效
for (const [deviceId, dev] of Object.entries(dbConfig.devices)) {
  if (dev.token) {
    state.devices.set(dev.token, {
      id: deviceId,
      token: dev.token,
      platform: dev.platform || 'unknown',
      createdAt: dev.createdAt || Date.now()
    });
  }
}

// 恢复历史用量事件，重启后排行榜/签名不清零
loadEvents();

function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function remember(list, item, limit = 50) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function publicOriginForRequest(request) {
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || request.headers.host;
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (request.headers['cf-ray'] || request.socket.encrypted ? 'https' : 'http');
  return requestHost ? `${protocol}://${requestHost}` : baseUrl;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function bearer(request) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}

function encodeOAuthState(deviceId) {
  const payload = Buffer.from(JSON.stringify({ device_id: deviceId || 'default', nonce: randomUUID(), expires_at: Date.now() + 10 * 60_000 })).toString('base64url');
  const signature = createHmac('sha256', oauthStateSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeOAuthState(value) {
  if (!value || !value.includes('.')) return null;
  const [payload, signature] = value.split('.');
  const expected = createHmac('sha256', oauthStateSecret).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return decoded.expires_at > Date.now() ? decoded : null;
}

async function feishuJson(url, options) {
  const result = await fetch(url, options);
  const body = await result.json();
  if (!result.ok || body.code) throw new Error(body.error_description || body.msg || `Feishu HTTP ${result.status}`);
  return body;
}

function emitPairing(pairing, type, data = {}) {
  if (!pairing) return; // 复用已保存 token 的设备没有配对会话，跳过 SSE 推送
  const event = { type, at: new Date().toISOString(), ...data };
  pairing.status = type;
  pairing.events.push(event);
  for (const stream of state.streams.get(pairing.id) || []) {
    stream.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

function pairingSummary(pairing) {
  return {
    id: pairing.id,
    code: pairing.code,
    status: pairing.status,
    expires_at: new Date(pairing.expiresAt).toISOString(),
    command: pairing.command
  };
}

// leaderboard：按 feishu_open_id 合并多设备，可按 tenantKey 过滤
// seedDeviceIds：历史上传过的所有设备，保证过 0 点今日榜不空
function leaderboard(items = state.events, seedDeviceIds = [...new Set(state.events.map((e) => e.deviceId))], tenantKey = null) {
  // 规范 key：优先 union_id（跨应用稳定），其次 open_id，最后 device_id
  const canonicalOf = (deviceId) => {
    const fi = getDeviceConfig(deviceId).feishu_identity;
    return fi?.union_id || fi?.open_id || deviceId;
  };
  const isAllowed = (deviceId) => {
    if (!tenantKey) return true;
    const cfg = getDeviceConfig(deviceId);
    const hasFeishu = cfg.feishu_identity?.open_id || cfg.feishu_identity?.union_id;
    if (!hasFeishu) return false;
    const devTenant = cfg.feishu_identity?.tenant_key;
    return !devTenant || devTenant === tenantKey;
  };

  const byKey = new Map();
  const newRow = (key, deviceId) => {
    const cfg = getDeviceConfig(deviceId);
    return { canonical_key: key, device_id: deviceId, feishu_open_id: cfg.feishu_identity?.open_id || null, feishu_union_id: cfg.feishu_identity?.union_id || null, display_name: cfg.profile?.display_name || '本机用户', avatar: cfg.profile?.avatar || '👤', total_tokens: 0, tide_points: 0, tools: new Set(), models: new Map(), cost_usd: 0, cost_cny: 0, priced_tokens: 0, last_sync_at: null };
  };
  const getOrCreate = (deviceId) => {
    const key = canonicalOf(deviceId);
    if (!byKey.has(key)) byKey.set(key, newRow(key, deviceId));
    return byKey.get(key);
  };

  for (const deviceId of seedDeviceIds) {
    if (isAllowed(deviceId)) getOrCreate(deviceId);
  }
  for (const item of items) {
    if (!isAllowed(item.deviceId)) continue;
    const row = getOrCreate(item.deviceId);
    row.total_tokens += totalTokens(item.event);
    row.tide_points += tidePoints(item.event);
    row.tools.add(item.event.tool);
    const model = item.event.canonical_model_id || item.event.observed_model;
    const estimate = estimateEventCost(item.event, usdCnyRate);
    const modelRow = row.models.get(model) || { model, display_name: priceForModel(model)?.displayName || model, tokens: 0, cost_usd: 0, cost_cny: 0, priced_tokens: 0 };
    modelRow.tokens += totalTokens(item.event);
    modelRow.cost_usd += estimate.usd;
    modelRow.cost_cny += estimate.cny;
    if (estimate.priced) modelRow.priced_tokens += totalTokens(item.event);
    row.models.set(model, modelRow);
    row.cost_usd += estimate.usd;
    row.cost_cny += estimate.cny;
    if (estimate.priced) row.priced_tokens += totalTokens(item.event);
    if (!row.last_sync_at || item.event.occurred_at > row.last_sync_at) row.last_sync_at = item.event.occurred_at;
  }
  return [...byKey.values()].map((row) => ({
    ...row,
    tools: [...row.tools],
    models: [...row.models.values()].sort((a, b) => b.tokens - a.tokens).map((item) => ({ ...item, ratio: row.total_tokens ? item.tokens / row.total_tokens : 0 })),
    pricing_coverage: row.total_tokens ? row.priced_tokens / row.total_tokens : 0,
    currency: 'CNY', usd_cny_rate: usdCnyRate, cost_type: 'api_equivalent',
    animal: animalLevel(row.tide_points)
  })).sort((a, b) => b.total_tokens - a.total_tokens).map((row, index) => ({ rank: index + 1, ...row }));
}

function dateKey(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: organizationTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

// 统一构造签名文字：今日 → 「今日消耗token X」，累计 → 「累计token消耗 X」；不带"更新"二字
function buildSignatureText(row, metric) {
  if (!row) return metric === 'today' ? '今日暂无大模型用量 🌊 待自动采集' : '暂无大模型用量 🌊 待自动采集';
  const tokens = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(row.total_tokens || 0);
  const cost = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(row.cost_cny || 0);
  const usage = metric === 'today' ? `今日消耗token ${tokens}` : `累计token消耗 ${tokens}`;
  const timePart = row.last_sync_at ? `｜${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(row.last_sync_at))}` : '';
  return `${row.animal.emoji} ${row.animal.name} Lv.${row.animal.level}｜${usage}｜≈${cost}${timePart}`;
}

function signatureConfigResponseForDevice(deviceId, session = null) {
  const devConfig = getDeviceConfig(deviceId);
  const today = dateKey(new Date());
  // 用 feishu_open_id 找到所有属于该用户的设备事件（多设备合并）
  const feishuId = session?.feishu_open_id || devConfig.feishu_identity?.open_id;
  const deviceEvents = feishuId
    ? state.events.filter(item => (getDeviceConfig(item.deviceId).feishu_identity?.open_id || item.deviceId) === feishuId)
    : state.events.filter(item => item.deviceId === deviceId);
  const items = devConfig.metric === 'today' ? deviceEvents.filter((item) => dateKey(item.event.occurred_at) === today) : deviceEvents;
  const canonicalKey = feishuId || deviceId;
  const preview = leaderboard(items).find(row => row.canonical_key === canonicalKey || row.device_id === deviceId) || null;
  const latestReceipt = [...state.receipts.values()].at(-1);
  const nextAt = devConfig.auto_collect_enabled ? new Date(Date.now() + devConfig.interval_minutes * 60_000).toISOString() : null;
  // 签名 URL：优先用 union_id（跨应用稳定），否则 open_id，最后 device_id
  const unionId = session?.union_id || devConfig.feishu_identity?.union_id;
  const signatureUrl = new URL('/signature', baseUrl);
  if (unionId) signatureUrl.searchParams.set('feishu_id', unionId);
  else if (feishuId) signatureUrl.searchParams.set('feishu_id', feishuId);
  else signatureUrl.searchParams.set('device_id', deviceId);
  return { ...devConfig, preview, signature_url: signatureUrl.toString(), feishu_open_id: feishuId || null, feishu_union_id: unionId || null, public_base_url: baseUrl, timezone: organizationTimeZone, last_collect_at: latestReceipt?.received_at || null, next_collect_at: nextAt, scheduler_status: devConfig.auto_collect_enabled ? 'configured' : 'not_enabled', cache_delay_minutes: '5-10' };
}

function getDeviceByRequest(request) {
  const token = bearer(request);
  if (!token) return null;
  return state.devices.get(token) || null;
}

function generateLinkPreviewResponse(targetUrlStr, previewToken) {
  let deviceId = null;
  let feishuId = null;
  try {
    const targetUrl = new URL(targetUrlStr);
    deviceId = targetUrl.searchParams.get('device_id');
    feishuId = targetUrl.searchParams.get('feishu_id');
  } catch (e) {
    console.error('[Link Preview] Failed to parse target URL:', targetUrlStr, e);
  }
  // feishu_id 参数可以是 union_id 或 open_id，优先按 union_id 查
  if (feishuId && !deviceId) {
    deviceId = findDeviceByFeishuId(feishuId, true) || findDeviceByFeishuId(feishuId, false);
  }

  const config = deviceId ? getDeviceConfig(deviceId) : state.signatureConfig;
  const today = dateKey(new Date());
  const canonicalKey = feishuId || deviceId;
  const sourceEvents = canonicalKey
    ? state.events.filter(item => feishuId
        ? (getDeviceConfig(item.deviceId).feishu_identity?.open_id || item.deviceId) === feishuId
        : item.deviceId === deviceId)
    : state.events;
  const items = config.metric === 'today' ? sourceEvents.filter((item) => dateKey(item.event.occurred_at) === today) : sourceEvents;

  const row = canonicalKey
    ? (leaderboard(items).find(r => r.canonical_key === canonicalKey || r.device_id === deviceId) || null)
    : (leaderboard(items)[0] || null);
    
  const text = buildSignatureText(row, config.metric);

  // 飞书 url.preview.get 应答：inline 必填，title 为签名要显示的文字（i18n_title 优先级更高，这里用单语言 title 即可）
  // inline.url 指向主页：别人点我的签名预览，直接跳到主页去登录并配置他自己的签名
  let homeUrl = null;
  try { homeUrl = new URL('/', targetUrlStr).toString(); } catch {}
  const inline = { title: text };
  if (homeUrl) inline.url = { copy_url: homeUrl, pc: homeUrl, ios: homeUrl, android: homeUrl, web: homeUrl };
  return { inline };
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok', service: 'token-tide', version: '0.1.0' });

  if (request.method === 'POST' && url.pathname === '/api/v1/device-codes') {
    const body = await readJson(request);
    const platform = ['macOS', 'Windows', 'Linux'].includes(body.platform) ? body.platform : 'macOS';
    const pairing = createPairing(publicOriginForRequest(request), Date.now(), platform);
    state.pairings.set(pairing.id, pairing);
    state.pairingsByCode.set(pairing.code, pairing.id);
    return json(response, 201, pairingSummary(pairing));
  }

  const streamMatch = url.pathname.match(/^\/api\/v1\/device-codes\/([^/]+)\/events$/);
  if (request.method === 'GET' && streamMatch) {
    const pairing = state.pairings.get(streamMatch[1]);
    if (!pairing) return json(response, 404, { error: 'pairing not found' });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`event: snapshot\ndata: ${JSON.stringify({ type: pairing.status, events: pairing.events })}\n\n`);
    const streams = state.streams.get(pairing.id) || new Set();
    streams.add(response);
    state.streams.set(pairing.id, streams);
    request.on('close', () => streams.delete(response));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/devices/exchange') {
    const body = await readJson(request);
    const pairingId = state.pairingsByCode.get(String(body.code || '').toUpperCase());
    const pairing = pairingId ? state.pairings.get(pairingId) : null;
    if (!pairing || pairing.expiresAt < Date.now()) return json(response, 400, { error: 'invalid or expired device code' });
    const token = randomUUID() + randomUUID();
    const deviceId = randomUUID();
    const device = { id: deviceId, token, pairingId, platform: body.platform || 'unknown', createdAt: Date.now() };
    state.devices.set(token, device);
    
    // 初始化并持久化该设备专属配置，支持重启后通过 token 恢复
    saveDeviceConfig(deviceId, {
      metric: 'today',
      interval_minutes: 30,
      auto_collect_enabled: true
    }, {
      display_name: '本机用户',
      avatar: '👤'
    });
    dbConfig.devices[deviceId].token = token;
    dbConfig.devices[deviceId].platform = device.platform;
    dbConfig.devices[deviceId].createdAt = device.createdAt;
    saveConfig();

    emitPairing(pairing, 'paired', { platform: device.platform, device_id: device.id, device_token: token });
    return json(response, 200, { device_id: device.id, device_token: token, expires_in: 3600 });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/usage-events/batch') {
    const device = state.devices.get(bearer(request));
    if (!device) return json(response, 401, { error: 'invalid device token' });
    const pairing = state.pairings.get(device.pairingId);
    emitPairing(pairing, 'scanning');
    const body = await readJson(request);
    const events = Array.isArray(body.events) ? body.events : [];
    const accepted = [];
    const rejected = [];
    let duplicateCount = 0;
    events.forEach((event, index) => {
      const error = validateUsageEvent(event);
      if (error) return rejected.push({ index, source_event_id: event?.source_event_id || null, error });
      const key = stableEventKey(device.id, event);
      if (state.eventKeys.has(key)) return duplicateCount++;
      state.eventKeys.add(key);
      accepted.push(event);
      state.events.push({ deviceId: device.id, event });
      persistEvent(device.id, event, key);
    });
    const receipt = buildReceipt(events, accepted, rejected, duplicateCount);
    state.receipts.set(receipt.request_id, receipt);
    emitPairing(pairing, 'uploaded', { request_id: receipt.request_id, receipt });
    emitPairing(pairing, 'aggregated', { request_id: receipt.request_id });
    refreshFeishuPreview(device.id, 'usage_uploaded').then((result) => {
      console.log(`[Feishu Preview] Refresh after upload: ${result.status} (${result.count} token(s))`);
    });
    return json(response, rejected.length ? 207 : 202, receipt);
  }

  const receiptMatch = url.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/receipt$/);
  if (request.method === 'GET' && receiptMatch) {
    const receipt = state.receipts.get(receiptMatch[1]);
    return receipt ? json(response, 200, receipt) : json(response, 404, { error: 'receipt not found' });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/me') {
    const session = getSessionFromRequest(request);
    if (!session) return json(response, 401, { error: 'not_logged_in' });
    return json(response, 200, { feishu_open_id: session.feishu_open_id, union_id: session.union_id, tenant_key: session.tenant_key, profile: session.profile });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
    const cookie = request.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)tt_session=([^;]+)/);
    if (match) deleteSession(decodeURIComponent(match[1]));
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie('', 0) });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  // 已登录用户把当前设备和飞书账号关联（前端在 feishu_login=success 后自动调）
  if (request.method === 'POST' && url.pathname === '/api/v1/devices/feishu-link') {
    const session = getSessionFromRequest(request);
    if (!session) return json(response, 401, { error: 'not_logged_in' });
    const device = getDeviceByRequest(request);
    if (device) {
      const cfg = getDeviceConfig(device.id);
      // 总是更新（不同 app 的 open_id 不同，union_id 稳定）
      cfg.feishu_identity = { mode: 'session_link', open_id: session.feishu_open_id, union_id: session.union_id, tenant_key: session.tenant_key };
      cfg.profile = session.profile;
      cfg.feishu_status = 'connected';
      saveConfig();
    }
    return json(response, 200, { linked: !!device, feishu_open_id: session.feishu_open_id, union_id: session.union_id });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/leaderboard') {
    const session = getSessionFromRequest(request);
    // 配置了飞书时必须登录；未配置飞书时（本地开发）允许不登录
    if (!session && feishuAppId) return json(response, 401, { error: 'login_required' });
    const tenantKey = session?.tenant_key || null;
    const period = url.searchParams.get('period') || 'total';
    const today = dateKey(new Date());
    const items = period === 'today' ? state.events.filter((item) => dateKey(item.event.occurred_at) === today) : state.events;
    return json(response, 200, { data: leaderboard(items, undefined, tenantKey), generated_at: new Date().toISOString() });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/feishu/diagnostics') {
    const deviceId = url.searchParams.get('device_id');
    return json(response, 200, {
      public_base_url: baseUrl,
      app_configured: Boolean(feishuAppId && feishuAppSecret),
      webhook_path: '/api/v1/feishu/link-preview',
      signature_requests: state.signatureRequests.filter((item) => !deviceId || item.device_id === deviceId).slice(-10),
      preview_events: state.previewEvents.filter((item) => !deviceId || item.device_id === deviceId).slice(-10),
      preview_registration: deviceId ? {
        token_count: getDeviceConfig(deviceId).preview_tokens?.length || 0,
        refresh_status: getDeviceConfig(deviceId).preview_refresh_status || 'not_started',
        last_refreshed_at: getDeviceConfig(deviceId).preview_last_refreshed_at || null,
        error: getDeviceConfig(deviceId).preview_refresh_error || null
      } : null,
      diagnosis: state.previewEvents.length ? 'preview_event_received' : state.signatureRequests.length ? 'page_fetched_but_no_preview_event' : 'no_public_request_received'
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/signature/config') {
    const session = getSessionFromRequest(request);
    const device = getDeviceByRequest(request);
    // 找到与当前用户关联的设备（session 登录用户 > 设备 token > 默认）
    let effectiveDeviceId = device?.id;
    if (!effectiveDeviceId && session?.feishu_open_id) effectiveDeviceId = findDeviceByFeishuId(session.feishu_open_id);
    if (!effectiveDeviceId && !session && feishuAppId) return json(response, 401, { error: 'not_authenticated' });
    return json(response, 200, signatureConfigResponseForDevice(effectiveDeviceId || 'default', session));
  }

  if (request.method === 'PUT' && url.pathname === '/api/v1/signature/config') {
    const device = getDeviceByRequest(request);
    if (!device) return json(response, 401, { error: 'invalid or missing device token' });
    const body = await readJson(request);
    const metric = ['today', 'total'].includes(body.metric) ? body.metric : 'today';
    const interval = [30, 360, 1440].includes(Number(body.interval_minutes)) ? Number(body.interval_minutes) : 30;
    const auto_collect_enabled = typeof body.auto_collect_enabled === 'boolean' ? body.auto_collect_enabled : true;
    
    saveDeviceConfig(device.id, { metric, interval_minutes: interval, auto_collect_enabled }, null);
    return json(response, 200, signatureConfigResponseForDevice(device.id));
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/feishu/preview/refresh') {
    const device = getDeviceByRequest(request);
    if (!device) return json(response, 401, { error: 'invalid or missing device token' });
    const result = await refreshFeishuPreview(device.id, 'manual');
    return json(response, result.status === 'failed' ? 502 : 200, result);
  }

  if (request.method === 'PUT' && url.pathname === '/api/v1/profile') {
    const device = getDeviceByRequest(request);
    if (!device) return json(response, 401, { error: 'invalid or missing device token' });
    const body = await readJson(request);
    if (typeof body.display_name === 'string' && body.display_name.trim().length > 0) {
      saveDeviceConfig(device.id, null, { display_name: body.display_name.trim() });
    }
    return json(response, 200, { profile: getDeviceConfig(device.id).profile });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/feishu/login') {
    const stateValue = encodeOAuthState(url.searchParams.get('device_id') || 'default');
    if (!feishuAppId || !feishuAppSecret) {
      response.writeHead(302, { location: `/mock-feishu-auth.html?state=${encodeURIComponent(stateValue)}&reason=not_configured` });
      response.end();
      return true;
    }
    // 飞书 OAuth 授权页：host 必须是 accounts.feishu.cn，参数用 client_id（不是 app_id）
    const authorizeUrl = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    authorizeUrl.searchParams.set('client_id', feishuAppId);
    authorizeUrl.searchParams.set('redirect_uri', feishuRedirectUri);
    authorizeUrl.searchParams.set('state', stateValue);
    if (feishuOAuthScope) authorizeUrl.searchParams.set('scope', feishuOAuthScope);
    response.writeHead(302, { location: authorizeUrl.toString() });
    response.end();
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/feishu/callback') {
    const oauthState = decodeOAuthState(url.searchParams.get('state'));
    if (!oauthState) {
      response.writeHead(302, { location: '/?feishu_error=invalid_state' });
      response.end();
      return true;
    }
    const deviceId = oauthState.device_id || 'default';
    const code = url.searchParams.get('code');
    const mock = url.searchParams.get('mock') === '1';
    try {
      let profile = { display_name: '本地演示用户', avatar: '👤' };
      let identity = { mode: 'mock' };
      if (!mock) {
        if (!code || !feishuAppId || !feishuAppSecret) throw new Error('missing OAuth code or Feishu app configuration');
        const tokenResult = await feishuJson('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: feishuAppId, client_secret: feishuAppSecret, code, redirect_uri: feishuRedirectUri })
        });
        const userResult = await feishuJson('https://open.feishu.cn/open-apis/authen/v1/user_info', {
          headers: { authorization: `Bearer ${tokenResult.access_token}` }
        });
        // user_info 的字段在 data 下（v1 接口包了一层 {code, msg, data}）
        const userData = userResult.data || userResult;
        profile = { display_name: userData.name || userData.en_name || '飞书用户', avatar: userData.avatar_thumb || userData.avatar_url || '👤' };
        identity = { mode: 'oauth', open_id: userData.open_id, union_id: userData.union_id, tenant_key: userData.tenant_key };
      }
      saveDeviceConfig(deviceId, null, profile);
      const config = getDeviceConfig(deviceId);
      config.feishu_status = 'connected';
      config.feishu_identity = identity;
      config.updated_at = new Date().toISOString();
      saveConfig();
      // 创建 30 天 Session Cookie（用 union_id 作为跨应用稳定标识）
      const sessionToken = createSession(identity.open_id || randomUUID(), identity.union_id || '', identity.tenant_key || '', profile);
      response.writeHead(302, { location: '/?feishu_login=success', 'set-cookie': sessionCookie(sessionToken) });
    } catch (error) {
      console.error('[Feishu OAuth] Login failed:', error.message);
      response.writeHead(302, { location: `/?feishu_error=${encodeURIComponent(error.message)}` });
    }
    response.end();
    return true;
  }

  // 处理飞书链接预览回调事件与 Challenge 校验
  if (request.method === 'POST' && (url.pathname === '/api/feishu/link-preview' || url.pathname === '/api/v1/feishu/link-preview')) {
    // 读取原始请求体（字符串）用于签名校验
    let rawBody = '';
    for await (const chunk of request) {
      rawBody += chunk;
    }

    // ---------- Feishu 签名校验 ----------
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuAppSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuAppSecret) {
      const timestamp = request.headers['x-lark-request-timestamp'];
      const signature = request.headers['x-lark-signature'];
      if (!timestamp || !signature) {
        console.warn('[Feishu Event] Signature headers missing, skipping verification (development mode)');
        // Continue without verification
      } else {
        const hmac = createHmac('sha256', feishuAppSecret);
        hmac.update(`${timestamp}\n${rawBody}`);
        const expected = hmac.digest('base64');
        if (expected !== signature) {
          console.error('[Feishu Event] Signature mismatch');
          return json(response, 401, { error: 'invalid signature' });
        }
      }
    }

    // 解析 JSON
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      console.error('[Feishu Event] Invalid JSON:', e);
      return json(response, 400, { error: 'invalid json body' });
    }

    // 1. 处理 Challenge 校验挑战事件 (url_verification)
    if (body.type === 'url_verification') {
      remember(state.previewEvents, { type: 'url_verification', at: new Date().toISOString() });
      console.log('[Feishu Event] Challenge verified successfully');
      return json(response, 200, { challenge: body.challenge });
    }

    // 2. 处理拉取链接预览数据 (url.preview.get)
    if (body.header && body.header.event_type === 'url.preview.get') {
      const event = body.event;
      if (event && event.context) {
        const previewToken = event.context.preview_token;
        const targetUrlStr = event.context.url;
        let previewDeviceId = null;
        try { previewDeviceId = new URL(targetUrlStr).searchParams.get('device_id'); } catch {}
        addPreviewToken(previewDeviceId || 'default', previewToken);
        remember(state.previewEvents, { type: 'url.preview.get', at: new Date().toISOString(), device_id: previewDeviceId, url: targetUrlStr });
        const responseData = generateLinkPreviewResponse(targetUrlStr, previewToken);
        console.log(`[Link Preview - Webhook] Replied successfully | Text: ${responseData.inline.title}`);
        return json(response, 200, responseData);
      }
    }

    return json(response, 400, { error: 'unsupported feishu event type' });
  }

  // 立即触发采集：spawn 本地 collector，采集完后主动刷新飞书签名
  if (request.method === 'POST' && url.pathname === '/api/v1/collect') {
    const device = getDeviceByRequest(request);
    if (!device) return json(response, 401, { error: 'invalid or missing device token' });
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      let output = '';
      const proc = spawn(process.execPath, [collectorSource, 'sync', '--server', `http://127.0.0.1:${port}`], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('error', (err) => resolve(json(response, 500, { ok: false, output: err.message })));
      const timer = setTimeout(() => { proc.kill(); resolve(json(response, 504, { ok: false, output: 'collector timeout after 60s' })); }, 60_000);
      proc.on('close', async (code) => {
        clearTimeout(timer);
        const match = output.match(/Accepted (\d+) events/);
        const accepted = match ? Number(match[1]) : 0;
        // 采集完成后主动推送飞书签名
        const pushResult = await refreshFeishuPreview(device.id, 'manual_collect').catch(() => ({ status: 'skipped' }));
        console.log(`[Collect] done code=${code} accepted=${accepted} feishu=${pushResult.status}`);
        resolve(json(response, code === 0 ? 200 : 500, { ok: code === 0, accepted, output: output.trim(), feishu_push: pushResult.status }));
      });
    });
  }

  return false;
}

function staticFile(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(webRoot, safe);
  if (!file.startsWith(webRoot) || !existsSync(file)) return false;
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
  response.writeHead(200, { 'content-type': mime, 'cache-control': mime.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' });
  createReadStream(file).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, baseUrl);
    if (request.method === 'GET' && url.pathname === '/signature') {
      console.log(`[Signature Request] URL requested at ${new Date().toISOString()} | User-Agent: ${request.headers['user-agent'] || 'unknown'}`);
      let deviceId = url.searchParams.get('device_id');
      const feishuId = url.searchParams.get('feishu_id');
      if (feishuId && !deviceId) deviceId = findDeviceByFeishuId(feishuId, true) || findDeviceByFeishuId(feishuId, false);
      remember(state.signatureRequests, { at: new Date().toISOString(), device_id: deviceId, feishu_id: feishuId, user_agent: request.headers['user-agent'] || 'unknown', cf_ray: request.headers['cf-ray'] || null });
      const config = deviceId ? getDeviceConfig(deviceId) : state.signatureConfig;
      const today = dateKey(new Date());
      const canonicalKey = feishuId || deviceId;
      const sourceEvents = canonicalKey
        ? state.events.filter(item => feishuId
            ? (getDeviceConfig(item.deviceId).feishu_identity?.open_id || item.deviceId) === feishuId
            : item.deviceId === deviceId)
        : state.events;
      const items = config.metric === 'today' ? sourceEvents.filter((item) => dateKey(item.event.occurred_at) === today) : sourceEvents;
      const row = canonicalKey
        ? (leaderboard(items).find(r => r.canonical_key === canonicalKey || r.device_id === deviceId) || null)
        : (leaderboard(items)[0] || null);
        
      const text = buildSignatureText(row, config.metric);

      const requestPublicOrigin = publicOriginForRequest(request);
      const canonicalUrl = new URL('/signature', requestPublicOrigin);
      if (deviceId) canonicalUrl.searchParams.set('device_id', deviceId);
      const imageUrl = new URL('/signature-card.svg', requestPublicOrigin);
      if (deviceId) imageUrl.searchParams.set('device_id', deviceId);
      const safeText = escapeHtml(text);
      const safeCanonicalUrl = escapeHtml(canonicalUrl.toString());
      const safeImageUrl = escapeHtml(imageUrl.toString());
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        'x-robots-tag': 'index, follow'
      });
      response.end(`<!DOCTYPE html>
<html lang="zh-CN" prefix="og: https://ogp.me/ns#">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${safeText}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Token 潮汐">
  <meta property="og:url" content="${safeCanonicalUrl}">
  <meta property="og:title" content="${safeText}">
  <meta property="og:description" content="${safeText}">
  <meta property="og:image" content="${safeImageUrl}">
  <meta property="og:image:type" content="image/svg+xml">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeText}">
  <meta name="twitter:description" content="${safeText}">
  <meta name="twitter:image" content="${safeImageUrl}">
  <link rel="canonical" href="${safeCanonicalUrl}">
  <title>${safeText}</title>
</head>
<body>
  <main><h1>${safeText}</h1><p>Token 潮汐 · 大模型用量海洋段位</p><p><a href="/?from=signature">进入 Token 潮汐主页，配置你自己的签名 →</a></p></main>
</body>
</html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/signature-card.svg') {
      const svgDeviceId = url.searchParams.get('device_id');
      const svgFeishuId = url.searchParams.get('feishu_id');
      const resolvedDeviceId = svgDeviceId || (svgFeishuId ? (findDeviceByFeishuId(svgFeishuId, true) || findDeviceByFeishuId(svgFeishuId, false)) : null);
      const svgKey = svgFeishuId || resolvedDeviceId;
      const sourceEvents = svgKey
        ? state.events.filter(item => {
            const fi = getDeviceConfig(item.deviceId).feishu_identity;
            return svgFeishuId
              ? (fi?.union_id === svgFeishuId || fi?.open_id === svgFeishuId || item.deviceId === resolvedDeviceId)
              : item.deviceId === resolvedDeviceId;
          })
        : state.events;
      const row = svgKey ? (leaderboard(sourceEvents).find(r => r.canonical_key === svgKey || r.device_id === resolvedDeviceId) || null) : (leaderboard(sourceEvents)[0] || null);
      const title = row ? `${row.animal.emoji} ${row.animal.name} Lv.${row.animal.level}` : '🌊 Token 潮汐';
      const subtitle = row ? `${new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(row.total_tokens)} Token · ≈¥${row.cost_cny.toFixed(2)}` : '等待首次采集';
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="o" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#073b4c"/><stop offset="1" stop-color="#061b2b"/></linearGradient></defs><rect width="1200" height="630" rx="48" fill="url(#o)"/><circle cx="1040" cy="110" r="220" fill="#2dd4bf" opacity=".16"/><text x="80" y="250" fill="#ecfeff" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="72" font-weight="700">${escapeHtml(title)}</text><text x="80" y="350" fill="#67e8f9" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="46">${escapeHtml(subtitle)}</text><text x="80" y="510" fill="#94a3b8" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="30">Token 潮汐 · 让每次 AI 调用汇成海洋</text></svg>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/mock-feishu-auth.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>飞书授权登录 - Token 潮汐</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f6f7;
      display: grid;
      place-items: center;
      min-height: 100vh;
    }
    .auth-card {
      width: 420px;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      padding: 32px;
      text-align: center;
    }
    .feishu-logo {
      font-size: 48px;
      margin-bottom: 16px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 20px;
      color: #1f2329;
    }
    .desc {
      font-size: 14px;
      color: #646a73;
      margin: 0 0 24px;
      line-height: 1.5;
    }
    .scope-list {
      text-align: left;
      background: #f5f6f7;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 28px;
    }
    .scope-title {
      font-size: 13px;
      font-weight: 700;
      color: #1f2329;
      margin-bottom: 10px;
    }
    .scope-item {
      font-size: 13px;
      color: #646a73;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 6px 0;
    }
    .scope-item::before {
      content: "✓";
      color: #3370ff;
      font-weight: 700;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .btn {
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      border: none;
    }
    .btn-cancel {
      background: #e4e6eb;
      color: #1f2329;
    }
    .btn-primary {
      background: #3370ff;
      color: #ffffff;
    }
    .btn-primary:hover {
      background: #2559cc;
    }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="feishu-logo">🕊️</div>
    <h2>Token 潮汐 申请授权</h2>
    <p class="desc">应用将获取您飞书的部分身份信息，用于生成专属的大模型用量排行榜及签名。</p>
    <div class="scope-list">
      <div class="scope-title">该服务将获取以下权限：</div>
      <div class="scope-item">获取您的飞书姓名、头像和基本资料</div>
      <div class="scope-item">绑定您的唯一身份以支持跨设备排行数据同步</div>
    </div>
    <div class="actions">
      <button class="btn btn-cancel" onclick="window.location.href='/'">取消</button>
      <button class="btn btn-primary" onclick="window.location.href='/api/v1/auth/feishu/callback?mock=1&state=' + encodeURIComponent(new URLSearchParams(location.search).get('state') || '')">使用本地演示身份</button>
    </div>
    <p class="desc" style="margin-top:20px;margin-bottom:0;color:#8f959e">当前未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，因此不会向飞书发送数据。配置后此按钮将自动切换为真实飞书授权。</p>
  </div>
</body>
</html>`);
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const handled = await api(request, response, url);
      if (handled === false) json(response, 404, { error: 'not found' });
      return;
    }
    if (request.method === 'GET' && ['/install/collector.mjs', '/install/adapters.mjs'].includes(url.pathname)) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      createReadStream(url.pathname.endsWith('adapters.mjs') ? adaptersSource : collectorSource).pipe(response);
      return;
    }
    if (!staticFile(response, url.pathname)) json(response, 404, { error: 'not found' });
  } catch (error) {
    json(response, error.message === 'request body too large' ? 413 : 400, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Token Tide listening on ${baseUrl}`);
});

// 启动飞书事件长连接 (WebSocket)
const appId = feishuAppId;
const appSecret = feishuAppSecret;

if (appId && appSecret) {
  try {
    console.log(`[Feishu WSClient] Attempting to connect Lark WebSocket with App ID: ${appId}`);
    // 动态引入 SDK，避免在未安装 SDK 时启动报错
    import('@larksuiteoapi/node-sdk').then((lark) => {
      const wsClient = new lark.WSClient({
        appId,
        appSecret
      });
      
      const eventDispatcher = new lark.EventDispatcher({})
        .register({
          'url.preview.get': async (data) => {
            console.log('[Feishu WSClient] Received link preview event:', JSON.stringify(data));
            const event = data.event;
            if (event && event.context) {
              const previewToken = event.context.preview_token;
              const targetUrlStr = event.context.url;
              let previewDeviceId = null;
              try { previewDeviceId = new URL(targetUrlStr).searchParams.get('device_id'); } catch {}
              addPreviewToken(previewDeviceId || 'default', previewToken);
              const responseData = generateLinkPreviewResponse(targetUrlStr, previewToken);
              console.log(`[Link Preview - WebSocket] Replied successfully | Text: ${responseData.inline.title}`);
              return responseData;
            }
          }
        });
        
      wsClient.start({ eventDispatcher });
      console.log('[Feishu WSClient] WebSocket client started successfully');
    }).catch(err => {
      console.error('[Feishu WSClient] Failed to import @larksuiteoapi/node-sdk. WebSocket connection disabled.', err);
    });
  } catch (err) {
    console.error('[Feishu WSClient] Failed to initialize WebSocket client:', err);
  }
} else {
  console.log('[Feishu WSClient] FEISHU_APP_ID or FEISHU_APP_SECRET environment variables not configured. WebSocket connection disabled.');
}

export { server, state };
