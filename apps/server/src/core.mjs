import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const PAIRING_TTL_MS = 5 * 60 * 1000;

export function createPairing(baseUrl, now = Date.now(), platform = 'macOS') {
  const id = randomUUID();
  const code = randomBytes(4).toString('hex').toUpperCase();
  const command = platform === 'Windows'
    ? `& ([scriptblock]::Create((irm '${baseUrl}/install.ps1'))) -Server '${baseUrl}' -Code '${code}'`
    : `curl -fsSL ${baseUrl}/install.sh | sh -s -- --server ${baseUrl} --code ${code}`;
  return {
    id,
    code,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    status: 'waiting',
    events: [{ type: 'waiting', at: new Date(now).toISOString() }],
    platform,
    command
  };
}

export function validateUsageEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'event must be an object';
  const strings = ['source_event_id', 'tool', 'provider', 'observed_model', 'occurred_at', 'precision', 'parser_version'];
  for (const field of strings) {
    if (typeof event[field] !== 'string' || event[field].length === 0) return `${field} is required`;
  }
  if (event.schema_version !== 1) return 'schema_version must be 1';
  if (!['A', 'B', 'C', 'D'].includes(event.precision)) return 'precision must be A, B, C, or D';
  if (Number.isNaN(Date.parse(event.occurred_at))) return 'occurred_at must be ISO-8601';
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    if (!Number.isSafeInteger(event[field]) || event[field] < 0) return `${field} must be a non-negative integer`;
  }
  const forbidden = ['prompt', 'completion', 'code', 'file_path', 'repository_url', 'api_key', 'session_token'];
  for (const field of forbidden) {
    if (field in event) return `${field} is forbidden`;
  }
  return null;
}

export function totalTokens(event) {
  return event.input_tokens + event.output_tokens + event.cache_read_tokens + event.cache_write_tokens;
}

export function tidePoints(event) {
  return event.input_tokens + event.output_tokens + event.cache_write_tokens + Math.round(event.cache_read_tokens * 0.1);
}

export function stableEventKey(deviceId, event) {
  // Until Feishu identity is connected, source_event_id already includes a local
  // path hash and is the safest available cross-pairing idempotency key.
  return createHash('sha256').update(event.source_event_id).digest('hex');
}

export function buildReceipt(events, accepted, rejected, duplicateCount, now = new Date()) {
  const tools = [...new Set(accepted.map((event) => event.tool))].sort();
  const models = [...new Set(accepted.map((event) => event.canonical_model_id || event.observed_model))].sort();
  const dates = accepted.map((event) => event.occurred_at).sort();
  return {
    request_id: randomUUID(),
    received_at: now.toISOString(),
    received_count: events.length,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    duplicate_count: duplicateCount,
    tools,
    models,
    total_tokens: accepted.reduce((sum, event) => sum + totalTokens(event), 0),
    tide_points: accepted.reduce((sum, event) => sum + tidePoints(event), 0),
    time_range: dates.length ? { start: dates[0], end: dates.at(-1) } : null,
    pricing_coverage: 0,
    rejected
  };
}

export const ANIMAL_LEVELS = [
  { level: 10, min: 1_000_000_000, emoji: '🐳', name: '蓝鲸' },
  { level: 9, min: 500_000_000, emoji: '🐋', name: '虎鲸' },
  { level: 8, min: 200_000_000, emoji: '🦈', name: '鲨鱼' },
  { level: 7, min: 80_000_000, emoji: '🐙', name: '章鱼' },
  { level: 6, min: 30_000_000, emoji: '🐬', name: '海豚' },
  { level: 5, min: 10_000_000, emoji: '🐢', name: '海龟' },
  { level: 4, min: 3_000_000, emoji: '🐠', name: '小丑鱼' },
  { level: 3, min: 1_000_000, emoji: '🪼', name: '水母' },
  { level: 2, min: 200_000, emoji: '🫧', name: '小海马' },
  { level: 1, min: 0, emoji: '⭐', name: '小海星' }
];

export function animalLevel(points) {
  return ANIMAL_LEVELS.find((item) => points >= item.min) ?? ANIMAL_LEVELS.at(-1);
}
