export const MODEL_PRICES = [
  {
    match: /^(?:gemini-3\.5|gemini-2\.5|gemini-2\.0|gemini-1\.5-flash)$/i,
    displayName: 'Gemini 3.5 Flash',
    input: 0.075,
    cacheRead: 0.0075,
    cacheWrite: 0.075,
    output: 0.30,
    source: 'https://ai.google.dev/pricing'
  },
  {
    match: /^deepseek-(?:chat|coder|v3)$/i,
    displayName: 'DeepSeek-V3',
    input: 0.14,
    cacheRead: 0.014,
    cacheWrite: 0.14,
    output: 0.28,
    source: 'https://api.deepseek.com/pricing'
  },
  {
    match: /^deepseek-(?:reasoner|r1)$/i,
    displayName: 'DeepSeek-R1',
    input: 0.55,
    cacheRead: 0.14,
    cacheWrite: 0.55,
    output: 2.19,
    source: 'https://api.deepseek.com/pricing'
  },
  {
    match: /^gpt-4o$/i,
    displayName: 'GPT-4o',
    input: 2.50,
    cacheRead: 0.25,
    cacheWrite: 2.50,
    output: 10.00,
    source: 'https://openai.com/api/pricing/'
  },
  {
    match: /^gpt-4o-mini$/i,
    displayName: 'GPT-4o Mini',
    input: 0.15,
    cacheRead: 0.015,
    cacheWrite: 0.15,
    output: 0.60,
    source: 'https://openai.com/api/pricing/'
  },
  {
    match: /^claude-3-5-sonnet/i,
    displayName: 'Claude 3.5 Sonnet',
    input: 3.00,
    cacheRead: 0.30,
    cacheWrite: 3.75,
    output: 15.00,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing'
  },
  {
    match: /^gpt-5\.5$/i,
    displayName: 'GPT-5.5',
    input: 2.5,
    cacheRead: 0.25,
    cacheWrite: 2.5,
    output: 15,
    source: 'https://developers.openai.com/api/docs/pricing'
  },
  {
    match: /^claude-sonnet-4-6$/i,
    displayName: 'Claude Sonnet 4.6',
    input: 3,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing'
  },
  {
    match: /^claude-opus-4-8$/i,
    displayName: 'Claude Opus 4.8',
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    output: 25,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing'
  },
  {
    match: /^claude-haiku-4-5(?:-|$)/i,
    displayName: 'Claude Haiku 4.5',
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing'
  }
];

export function priceForModel(model) {
  return MODEL_PRICES.find((item) => item.match.test(model)) || null;
}

export function estimateEventCost(event, usdCnyRate = 7.2) {
  const model = event.canonical_model_id || event.observed_model;
  const price = priceForModel(model);
  if (!price) return { priced: false, model, tokens: tokenTotal(event), usd: 0, cny: 0, price: null };
  const usd = (
    event.input_tokens * price.input +
    event.output_tokens * price.output +
    event.cache_read_tokens * price.cacheRead +
    event.cache_write_tokens * price.cacheWrite
  ) / 1_000_000;
  return { priced: true, model, displayName: price.displayName, tokens: tokenTotal(event), usd, cny: usd * usdCnyRate, price };
}

function tokenTotal(event) {
  return event.input_tokens + event.output_tokens + event.cache_read_tokens + event.cache_write_tokens;
}
