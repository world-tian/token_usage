import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
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
  const files = await jsonlFiles(root);
  const events = [];
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
  return { tool: 'claude_code', files: files.length, events };
}

export async function collectAntigravity(conversationId = '0f0fd82a-2306-4026-b197-dc74bd1067e8') {
  const logFile = join(homedir(), '.gemini', 'antigravity', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  const events = [];
  try {
    await lines(logFile, (record, lineNumber) => {
      const occurredAt = timestamp(record.created_at);
      if (!occurredAt) return;
      
      let input_tokens = 0;
      let output_tokens = 0;
      
      if (record.source === 'USER_EXPLICIT' && record.type === 'USER_INPUT') {
        input_tokens = Math.ceil((record.content || '').length * 1.3);
      } else if (record.source === 'MODEL' && record.type === 'PLANNER_RESPONSE') {
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
        recordId: `${record.step_index}:${record.created_at || lineNumber}`
      }));
    });
  } catch (error) {
    // 忽略异常，确保采集器健壮
  }
  return { tool: 'antigravity', files: events.length ? 1 : 0, events };
}

export async function collectLocalUsage(options = {}) {
  const [codex, claude, antigravity] = await Promise.all([
    collectCodex(options.codexRoot),
    collectClaude(options.claudeRoot),
    collectAntigravity(options.conversationId)
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

export async function localSourceStatus() {
  const roots = [
    join(homedir(), '.codex', 'sessions'),
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.gemini', 'antigravity', 'brain', '0f0fd82a-2306-4026-b197-dc74bd1067e8', '.system_generated', 'logs')
  ];
  return Promise.all(roots.map(async (root) => {
    try {
      const info = await stat(root);
      return { root: root.replace(homedir(), '~'), exists: info.isDirectory() };
    } catch {
      return { root: root.replace(homedir(), '~'), exists: false };
    }
  }));
}

