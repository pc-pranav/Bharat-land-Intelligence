// lib/cache.js
// Shared caching utilities for the Anthropic API proxy.
// Uses Upstash Redis (HTTP-based, serverless-friendly — works in Vercel functions
// without persistent connections). Vercel KV was deprecated; this is the current
// correct path (Vercel's own Marketplace Redis integration is Upstash under the hood).

// Dynamic import instead of static — Upstash only loads if env vars are present.
// Static top-level import runs at module load time before any function code,
// and if the package has any initialization side effects that fail, it crashes
// the entire function before the handler even starts (FUNCTION_INVOCATION_FAILED).
let redis = null;
async function getRedis() {
  if (redis) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null; // Caching disabled if not configured — app still works, just uncached.
  }
  try {
    const { Redis } = await import('@upstash/redis');
    redis = Redis.fromEnv();
    return redis;
  } catch (e) {
    console.error('Upstash Redis failed to initialize:', e.message);
    return null;
  }
}

// Normalize a locality string into a stable cache key.
// "Whitefield, Bengaluru" and "whitefield bengaluru" and "  Whitefield,Bengaluru "
// should all hit the same cache entry.
export function normalizeKey(...parts) {
  return parts
    .filter(Boolean)
    .join('|')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9|]+/g, '_')    // collapse punctuation/spaces
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// TTL strategy — all set to 1 week.
// Real estate growth scores, infrastructure data, and pricing signals
// are stable enough over a week that cache hits are always valid.
// This maximises cache efficiency and minimises Anthropic API costs.
const ONE_WEEK = 60 * 60 * 24 * 7; // 604800 seconds

export const TTL = {
  analyze:  ONE_WEEK,   // 7 days
  screener: ONE_WEEK,   // 7 days
  pricer:   ONE_WEEK,   // 7 days
};

export async function getCached(key) {
  const r = await getRedis();
  if (!r) {
    console.log('[Cache] Redis not available — UPSTASH env vars missing?');
    return null;
  }
  try {
    const val = await r.get(key);
    if(val) console.log('[Cache] HIT:', key.slice(0, 60));
    else console.log('[Cache] MISS:', key.slice(0, 60));
    return val || null;
  } catch (e) {
    console.error('[Cache] Read error:', e.message);
    return null;
  }
}

export async function setCached(key, value, ttlSeconds) {
  const r = await getRedis();
  if (!r) return;
  try {
    // Upstash has a 1MB limit — store only the essential response fields
    const slim = typeof value === 'object' ? {
      content: value.content,
      usage: value.usage,
      model: value.model,
      stop_reason: value.stop_reason,
    } : value;
    await r.set(key, slim, { ex: ttlSeconds });
    console.log('[Cache] WRITE:', key.slice(0, 60), '| TTL:', ttlSeconds + 's');
  } catch (e) {
    console.error('[Cache] Write error:', e.message);
  }
}

export function isCachingEnabled() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
