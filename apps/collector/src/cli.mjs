#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectLocalUsage, localSourceStatus, summarize } from './adapters.mjs';

// 本地凭据：按 server 保存 device_token / device_id，保证同一终端身份稳定，不必每次换配对码
const credentialsDir = join(homedir(), '.token-tide');
const credentialsFile = join(credentialsDir, 'credentials.json');

function loadCredentials() {
  try {
    if (existsSync(credentialsFile)) return JSON.parse(readFileSync(credentialsFile, 'utf8'));
  } catch {}
  return {};
}

function saveCredential(server, cred) {
  try {
    if (!existsSync(credentialsDir)) mkdirSync(credentialsDir, { recursive: true });
    const all = loadCredentials();
    if (cred) all[server] = cred; else delete all[server];
    writeFileSync(credentialsFile, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.warn(`(warning) failed to update credentials: ${e.message}`);
  }
}

function args(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (!item.startsWith('--')) continue;
    options[item.slice(2)] = rest[index + 1]?.startsWith('--') ? true : rest[++index] ?? true;
  }
  return { command, options };
}

function usage() {
  console.log(`Token Tide Collector v0.1.0

Usage:
  token-tide sync --server http://127.0.0.1:8787 --code ABCD1234   # first time only
  token-tide sync --server http://127.0.0.1:8787                    # afterwards (token reused)
  token-tide scan --preview
  token-tide doctor --server http://127.0.0.1:8787

Commands:
  sync        Scan real local Codex/Claude usage and upload counters only.
              First run needs --code to pair; the device token is saved to
              ~/.token-tide/credentials.json and reused so your identity stays stable.
  scan        Preview real local usage without uploading
  demo-sync   Upload synthetic data for development testing only
  doctor      Check runtime and server connectivity
  help        Show this help

The collector parses local JSONL files but only emits timestamps, tools, model names,
and token counters. It never uploads prompts, responses, code, file paths, or API keys.`);
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 207) throw new Error(`${response.status} ${data.error || response.statusText}`);
  return data;
}

function demoEvents() {
  const now = new Date();
  const samples = [
    { tool: 'codex_cli', provider: 'openai', observed_model: 'gpt-demo', input_tokens: 120_000, output_tokens: 28_000, cache_read_tokens: 36_000, cache_write_tokens: 4_000 },
    { tool: 'claude_code', provider: 'anthropic', observed_model: 'claude-demo', input_tokens: 78_000, output_tokens: 19_500, cache_read_tokens: 24_000, cache_write_tokens: 2_500 },
    { tool: 'model_gateway', provider: 'zhipu', observed_model: 'glm-demo', input_tokens: 41_000, output_tokens: 12_000, cache_read_tokens: 5_000, cache_write_tokens: 0 }
  ];
  return samples.map((sample, index) => {
    const occurredAt = new Date(now.getTime() - index * 60 * 60 * 1000).toISOString();
    const source = `${sample.tool}\0${sample.observed_model}\0${occurredAt}`;
    return {
      schema_version: 1,
      source_event_id: `demo:${createHash('sha256').update(source).digest('hex').slice(0, 24)}`,
      canonical_model_id: null,
      pricing_context: 'demo',
      occurred_at: occurredAt,
      request_count: 1,
      precision: 'B',
      parser_version: 'demo/0.1.0',
      ...sample
    };
  });
}

async function doctor(server) {
  console.log(`Platform: ${platform()}`);
  console.log(`Node: ${process.version}`);
  const health = await requestJson(`${server}/healthz`);
  console.log(`Server: ${health.status} (${health.version})`);
  const sources = await localSourceStatus();
  sources.forEach((source) => console.log(`Source ${source.root}: ${source.exists ? 'found' : 'not found'}`));
  console.log('Privacy check: only usage counters are eligible for upload.');
}

function printSummary(result) {
  const summary = summarize(result.events);
  console.log(`Files: ${result.adapters.reduce((sum, adapter) => sum + adapter.files, 0)}`);
  console.log(`Events: ${summary.events.toLocaleString('en-US')}`);
  console.log(`Tokens: ${summary.totalTokens.toLocaleString('en-US')}`);
  console.log('Tools:');
  summary.tools.forEach(([name, tokens]) => console.log(`  ${name}: ${tokens.toLocaleString('en-US')}`));
  console.log('Models:');
  summary.models.slice(0, 12).forEach(([name, tokens]) => console.log(`  ${name}: ${tokens.toLocaleString('en-US')}`));
  if (summary.models.length > 12) console.log(`  +${summary.models.length - 12} more`);
  return summary;
}

async function scan() {
  console.log('Scanning real local Codex and Claude Code usage…');
  const result = await collectLocalUsage();
  printSummary(result);
  console.log('Preview only: nothing was uploaded.');
  return result;
}

async function uploadEvents(server, token, events) {
  const receipts = [];
  for (let offset = 0; offset < events.length; offset += 250) {
    const batch = events.slice(offset, offset + 250);
    receipts.push(await requestJson(`${server}/api/v1/usage-events/batch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: batch })
    }));
  }
  return receipts;
}

async function sync(server, code) {
  console.log('1/3 Scanning real local Codex and Claude Code usage…');
  const result = await collectLocalUsage();
  const summary = printSummary(result);
  if (summary.events === 0) throw new Error('no supported usage events found; run doctor to inspect source availability');

  // 优先复用已保存的设备身份；只有首次（无凭据）才需要 --code 配对
  const stored = loadCredentials()[server];
  let token = stored?.device_token || null;
  if (!token) {
    if (!code) throw new Error('first run needs --code from the /connect page; afterwards just run "token-tide sync" (no code)');
    console.log('2/3 Pairing device (first time)…');
    const device = await requestJson(`${server}/api/v1/devices/exchange`, {
      method: 'POST',
      body: JSON.stringify({ code, platform: platform(), client_nonce: randomUUID() })
    });
    token = device.device_token;
    saveCredential(server, { device_token: device.device_token, device_id: device.device_id, paired_at: new Date().toISOString() });
    console.log(`    Paired; identity saved to ${credentialsFile}`);
  } else {
    console.log(`2/3 Reusing saved device identity (${stored.device_id})…`);
  }

  console.log('3/3 Uploading usage counters only…');
  let receipts;
  try {
    receipts = await uploadEvents(server, token, result.events);
  } catch (error) {
    if (String(error.message).startsWith('401')) {
      saveCredential(server, null); // 凭据失效（服务端重置过），清掉以便重新配对
      throw new Error('saved device token was rejected; re-run with --code to pair again');
    }
    throw error;
  }
  const accepted = receipts.reduce((sum, item) => sum + item.accepted_count, 0);
  const duplicates = receipts.reduce((sum, item) => sum + item.duplicate_count, 0);
  console.log(`✓ Accepted ${accepted.toLocaleString('en-US')} events; ${duplicates.toLocaleString('en-US')} duplicates skipped`);
  console.log(`  Tokens scanned: ${summary.totalTokens.toLocaleString('en-US')}`);
  console.log(`  Last receipt: ${receipts.at(-1).request_id}`);
}

async function demoSync(server, code) {
  if (!code) throw new Error('--code is required; create one on the /connect page');
  console.log('1/3 Pairing device…');
  const device = await requestJson(`${server}/api/v1/devices/exchange`, {
    method: 'POST',
    body: JSON.stringify({ code, platform: platform(), client_nonce: randomUUID() })
  });
  console.log('2/3 Preparing privacy-safe demo usage…');
  const events = demoEvents();
  console.log(`    ${events.length} events; no prompts, code, or file paths`);
  console.log('3/3 Uploading…');
  const receipt = await requestJson(`${server}/api/v1/usage-events/batch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${device.device_token}` },
    body: JSON.stringify({ events })
  });
  console.log(`✓ Accepted ${receipt.accepted_count}/${receipt.received_count} events`);
  console.log(`  Tools: ${receipt.tools.join(', ')}`);
  console.log(`  Models: ${receipt.models.join(', ')}`);
  console.log(`  Tokens: ${receipt.total_tokens.toLocaleString('en-US')}`);
  console.log(`  Receipt: ${receipt.request_id}`);
}

const { command, options } = args(process.argv.slice(2));
const server = String(options.server || process.env.TOKEN_TIDE_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '');

try {
  if (command === 'help' || command === '--help' || command === '-h') usage();
  else if (command === 'doctor') await doctor(server);
  else if (command === 'scan') await scan();
  else if (command === 'sync') await sync(server, String(options.code || ''));
  else if (command === 'demo-sync') await demoSync(server, String(options.code || ''));
  else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Token Tide: ${error.message}`);
  process.exitCode = 1;
}

export { args, demoEvents, scan, sync };
