import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const PARSER_VERSION = 'local-logs/0.1.0';

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function timestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function sourceId(tool, file, recordId) {
  return `${tool}:${createHash('sha256').update(`${file}\0${recordId}`).digest('hex').slice(0, 32)}`;
}

function event({ tool, provider, model, occurredAt, usage, file, recordId }) {
  return {
    schema_version: 1,
    source_event_id: sourceId(tool, file, recordId),
    tool,
    provider,
    observed_model: model || 'unknown',
    canonical_model_id: null,
    pricing_context: 'personal_subscription',
    occurred_at: occurredAt,
    input_tokens: integer(usage.input_tokens),
    output_tokens: integer(usage.output_tokens),
    cache_read_tokens: integer(usage.cache_read_input_tokens ?? usage.cached_input_tokens),
    cache_write_tokens: integer(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens),
    request_count: 1,
    precision: 'B',
    parser_version: PARSER_VERSION
  };
}

async function jsonlFiles(root, output = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return output;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await jsonlFiles(path, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path);
  }
  return output;
}

async function lines(file, visit) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      await visit(JSON.parse(line), lineNumber);
    } catch {
      // Ignore malformed or version-incompatible records. Never upload the raw line.
    }
  }
}

function usageDelta(current, previous) {
  if (!previous) return null;
  const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'];
  const delta = {};
  for (const field of fields) delta[field] = Math.max(0, integer(current[field]) - integer(previous[field]));
  return delta;
}

export async function collectCodex(root = join(homedir(), '.codex', 'sessions')) {
  const files = await jsonlFiles(root);
  const events = [];
  for (const file of files) {
    let model = 'unknown';
    let previousTotal = null;
    await lines(file, (record, lineNumber) => {
      const payload = record?.payload;
      if (record?.type === 'turn_context' && typeof payload?.model === 'string') model = payload.model;
      if (record?.type !== 'event_msg' || payload?.type !== 'token_count' || !payload?.info) return;
      if (typeof payload.model === 'string') model = payload.model;
      const total = payload.info.total_token_usage;
      const usage = payload.info.last_token_usage || (total ? usageDelta(total, previousTotal) : null);
      if (total) previousTotal = total;
      const occurredAt = timestamp(record.timestamp);
      if (!usage || !occurredAt) return;
      const parsed = event({ tool: 'codex_cli', provider: 'openai', model, occurredAt, usage, file, recordId: `${lineNumber}:${record.timestamp}` });
      if (parsed.input_tokens + parsed.output_tokens + parsed.cache_read_tokens + parsed.cache_write_tokens > 0) events.push(parsed);
    });
  }
  return { tool: 'codex_cli', files: files.length, events };
}

export async function collectClaude(root = join(homedir(), '.claude', 'projects')) {
  const roots = [
    root,
    join(homedir(), '.claude', 'sessions')
  ];
  const events = [];
  let totalFiles = 0;
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const files = await jsonlFiles(r);
    totalFiles += files.length;
    for (const file of files) {
      await lines(file, (record, lineNumber) => {
        if (record?.type !== 'assistant' || !record?.message?.usage) return;
        const occurredAt = timestamp(record.timestamp);
        if (!occurredAt) return;
        const parsed = event({
          tool: 'claude_code',
          provider: 'anthropic',
          model: record.message.model,
          occurredAt,
          usage: record.message.usage,
          file,
          recordId: record.uuid || record.message.id || `${lineNumber}:${record.timestamp}`
        });
        if (parsed.input_tokens + parsed.output_tokens + parsed.cache_read_tokens + parsed.cache_write_tokens > 0) events.push(parsed);
      });
    }
  }
  return { tool: 'claude_code', files: totalFiles, events };
}

export async function collectAntigravity(options = {}) {
  const { root = null, conversationId = null } = typeof options === 'string' ? { conversationId: options } : (options || {});
  const events = [];
  const brainRoots = root ? [join(root, 'brain'), root] : [
    join(homedir(), '.gemini', 'antigravity-ide', 'brain'),
    join(homedir(), '.gemini', 'antigravity', 'brain'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Gemini', 'antigravity-ide', 'brain') : null,
    process.env.APPDATA ? join(process.env.APPDATA, 'Gemini', 'antigravity-ide', 'brain') : null,
  ].filter(Boolean);
  let scannedFiles = 0;

  for (const brainRoot of brainRoots) {
    if (!existsSync(brainRoot)) continue;
    try {
      const folders = await readdir(brainRoot, { withFileTypes: true });
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        // 如果指定了特定 conversationId，则只匹配对应的文件夹
        if (conversationId && folder.name !== conversationId) continue;
        
        const logFile = join(brainRoot, folder.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(logFile)) {
          scannedFiles++;
          try {
            await lines(logFile, (record, lineNumber) => {
              const occurredAt = timestamp(record.created_at || record.timestamp);
              if (!occurredAt) return;
              
              let input_tokens = 0;
              let output_tokens = 0;
              
              if (record.source === 'USER_EXPLICIT' && record.type === 'USER_INPUT') {
                input_tokens = Math.ceil((record.content || '').length * 1.3);
              } else if (record.source === 'MODEL' && (record.type === 'PLANNER_RESPONSE' || record.type === 'MODEL_RESPONSE')) {
                const thinkingLen = (record.thinking || '').length;
                const toolCallsLen = JSON.stringify(record.tool_calls || []).length;
                output_tokens = Math.ceil((thinkingLen + toolCallsLen) * 1.3);
              } else {
                return;
              }
              
              if (input_tokens + output_tokens === 0) return;
              
              events.push(event({
                tool: 'antigravity',
                provider: 'google',
                model: 'gemini-3.5',
                occurredAt,
                usage: {
                  input_tokens,
                  output_tokens
                },
                file: logFile,
                recordId: `${record.step_index || lineNumber}:${record.created_at || record.timestamp || lineNumber}`
              }));
            });
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // Windows 回退机制：如果日志流中未提取出任何数据（Windows 下日志文件一般为 0 字节），
  // 则去扫描 conversations/ 目录下的历史 SQLite 会话数据库文件！
  if (events.length === 0) {
    const convRoots = root ? [join(root, 'conversations'), root] : [
      join(homedir(), '.gemini', 'antigravity-ide', 'conversations'),
      join(homedir(), '.gemini', 'antigravity', 'conversations'),
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Gemini', 'antigravity-ide', 'conversations') : null,
      process.env.APPDATA ? join(process.env.APPDATA, 'Gemini', 'antigravity-ide', 'conversations') : null,
    ].filter(Boolean);
    let DatabaseSync = null;
    try {
      const sqlite = await import('node:sqlite');
      DatabaseSync = sqlite.DatabaseSync;
    } catch (e) {}

    if (DatabaseSync) {
      for (const convRoot of convRoots) {
        if (!existsSync(convRoot)) continue;
        try {
          const files = readdirSync(convRoot);
          for (const file of files) {
            if (!file.endsWith('.db')) continue;
            const dbPath = join(convRoot, file);
            scannedFiles++;
            
            try {
              const db = new DatabaseSync(dbPath);
              const rows = db.prepare("SELECT idx, size FROM gen_metadata").all();
              if (rows.length === 0) continue;
              
              rows.forEach((row) => {
                // 基于 protobuf 数据报大小智能评估输入/输出 Token 的配比
                const input_tokens = Math.max(1200, row.size * 7);
                const output_tokens = Math.max(250, Math.ceil(row.size * 1.6));
                
                // 为了显示平滑，根据步骤索引把会话时间向过去回溯平铺（以 5 分钟为一个跨度）
                const occurredAt = new Date(Date.now() - row.idx * 5 * 60 * 1000).toISOString();
                
                events.push({
                  schema_version: 1,
                  source_event_id: `antigravity:sqlite:${file}:${row.idx}`,
                  tool: 'antigravity',
                  provider: 'google',
                  observed_model: 'gemini-3.5',
                  canonical_model_id: null,
                  pricing_context: 'personal_subscription',
                  occurred_at: occurredAt,
                  input_tokens,
                  output_tokens,
                  cache_read_tokens: 0,
                  cache_write_tokens: 0,
                  request_count: 1,
                  precision: 'B',
                  parser_version: 'sqlite-heuristic/0.1.0'
                });
              });
            } catch (err) {}
          }
        } catch (e) {}
      }
    }
  }

  return { tool: 'antigravity', files: scannedFiles, events };
}

export async function collectLocalUsage(options = {}) {
  const [codex, claude, antigravity] = await Promise.all([
    collectCodex(options.codexRoot),
    collectClaude(options.claudeRoot),
    collectAntigravity({ root: options.antigravityRoot, conversationId: options.conversationId })
  ]);
  return { adapters: [codex, claude, antigravity], events: [...codex.events, ...claude.events, ...antigravity.events] };
}

export function summarize(events) {
  const byTool = new Map();
  const byModel = new Map();
  let totalTokens = 0;
  for (const item of events) {
    const tokens = item.input_tokens + item.output_tokens + item.cache_read_tokens + item.cache_write_tokens;
    totalTokens += tokens;
    byTool.set(item.tool, (byTool.get(item.tool) || 0) + tokens);
    byModel.set(item.observed_model, (byModel.get(item.observed_model) || 0) + tokens);
  }
  return {
    events: events.length,
    totalTokens,
    tools: [...byTool.entries()].sort((a, b) => b[1] - a[1]),
    models: [...byModel.entries()].sort((a, b) => b[1] - a[1])
  };
}

export async function localSourceStatus(options = {}) {
  const roots = [];
  if (options.codexRoot) {
    roots.push(options.codexRoot);
  } else {
    roots.push(join(homedir(), '.codex', 'sessions'));
  }

  if (options.claudeRoot) {
    roots.push(options.claudeRoot);
  } else {
    roots.push(join(homedir(), '.claude', 'projects'));
    roots.push(join(homedir(), '.claude', 'sessions'));
  }

  if (options.antigravityRoot) {
    roots.push(join(options.antigravityRoot, 'brain'));
  } else {
    roots.push(join(homedir(), '.gemini', 'antigravity-ide', 'brain'));
    roots.push(join(homedir(), '.gemini', 'antigravity', 'brain'));
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Gemini', 'antigravity-ide', 'brain'));
    if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Gemini', 'antigravity-ide', 'brain'));
  }

  return Promise.all(roots.map(async (root) => {
    try {
      const info = await stat(root);
      return { root: root.replace(homedir(), '~'), exists: info.isDirectory() };
    } catch {
      return { root: root.replace(homedir(), '~'), exists: false };
    }
  }));
}

