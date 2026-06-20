import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClaude, collectCodex, summarize } from '../src/adapters.mjs';

test('extracts Codex token counters without emitting conversation fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-tide-codex-'));
  const session = join(root, '2026', '06', '20');
  await mkdir(session, { recursive: true });
  const records = [
    { timestamp: '2026-06-20T08:00:00Z', type: 'turn_context', payload: { model: 'gpt-test', user_instructions: 'must stay local' } },
    { timestamp: '2026-06-20T08:01:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } } } }
  ];
  await writeFile(join(session, 'rollout.jsonl'), records.map(JSON.stringify).join('\n'));
  const result = await collectCodex(root);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].observed_model, 'gpt-test');
  assert.equal(result.events[0].cache_read_tokens, 40);
  assert.equal('user_instructions' in result.events[0], false);
});

test('extracts Claude Code usage and summarizes models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-tide-claude-'));
  const project = join(root, 'project-hash');
  await mkdir(project, { recursive: true });
  const record = {
    uuid: 'assistant-record-1',
    type: 'assistant',
    timestamp: '2026-06-20T08:02:00Z',
    message: {
      id: 'msg-1',
      model: 'claude-test',
      content: [{ type: 'text', text: 'must stay local' }],
      usage: { input_tokens: 80, output_tokens: 15, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }
    }
  };
  await writeFile(join(project, 'session.jsonl'), JSON.stringify(record));
  const result = await collectClaude(root);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].cache_write_tokens, 5);
  assert.equal('content' in result.events[0], false);
  assert.equal(summarize(result.events).totalTokens, 130);
});
