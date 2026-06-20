import test from 'node:test';
import assert from 'node:assert/strict';
import { animalLevel, buildReceipt, createPairing, tidePoints, totalTokens, validateUsageEvent } from '../src/core.mjs';

const event = {
  schema_version: 1,
  source_event_id: 'fixture:event:1',
  tool: 'codex_cli',
  provider: 'openai',
  observed_model: 'gpt-demo',
  canonical_model_id: null,
  pricing_context: 'demo',
  occurred_at: '2026-06-20T08:00:00.000Z',
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 50,
  cache_write_tokens: 10,
  request_count: 1,
  precision: 'B',
  parser_version: 'fixture/1.0.0'
};

test('validates privacy-safe usage event', () => {
  assert.equal(validateUsageEvent(event), null);
  assert.match(validateUsageEvent({ ...event, prompt: 'secret' }), /forbidden/);
});

test('calculates raw tokens and weighted tide points', () => {
  assert.equal(totalTokens(event), 180);
  assert.equal(tidePoints(event), 135);
});

test('assigns ocean animal growth levels', () => {
  assert.equal(animalLevel(0).name, '小海星');
  assert.equal(animalLevel(30_000_000).name, '海豚');
  assert.equal(animalLevel(1_000_000_000).name, '蓝鲸');
});

test('builds an auditable upload receipt', () => {
  const receipt = buildReceipt([event], [event], [], 0, new Date('2026-06-20T09:00:00.000Z'));
  assert.equal(receipt.accepted_count, 1);
  assert.equal(receipt.total_tokens, 180);
  assert.deepEqual(receipt.tools, ['codex_cli']);
  assert.deepEqual(receipt.models, ['gpt-demo']);
});

test('builds a directory-independent macOS and Linux install command', () => {
  const pairing = createPairing('http://127.0.0.1:8787', 0, 'macOS');
  assert.match(pairing.command, /^curl -fsSL http:\/\/127\.0\.0\.1:8787\/install\.sh \| sh -s --/);
  assert.match(pairing.command, /--code [A-F0-9]{8}$/);
});

test('builds a directory-independent Windows PowerShell command', () => {
  const pairing = createPairing('http://127.0.0.1:8787', 0, 'Windows');
  assert.match(pairing.command, /install\.ps1/);
  assert.match(pairing.command, /-Code '[A-F0-9]{8}'$/);
});
