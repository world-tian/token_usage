import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateEventCost, priceForModel } from '../src/pricing.mjs';

const base = {
  observed_model: 'gpt-5.5',
  canonical_model_id: null,
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_tokens: 1_000_000,
  cache_write_tokens: 0
};

test('matches known model aliases', () => {
  assert.equal(priceForModel('gpt-5.5').displayName, 'GPT-5.5');
  assert.equal(priceForModel('claude-sonnet-4-6').output, 15);
  assert.equal(priceForModel('claude-opus-4-8').output, 25);
  assert.equal(priceForModel('claude-haiku-4-5-20251001').cacheRead, 0.1);
});

test('calculates API-equivalent cost by token type', () => {
  const result = estimateEventCost(base, 7.2);
  assert.equal(result.usd, 17.75);
  assert.equal(result.cny, 127.8);
});

test('leaves unknown models explicitly unpriced', () => {
  const result = estimateEventCost({ ...base, observed_model: 'unknown-model' });
  assert.equal(result.priced, false);
  assert.equal(result.usd, 0);
});
