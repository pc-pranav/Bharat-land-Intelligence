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

// TTL strategy:
// - Analyze (location reports): 24 hours. Growth scores, news signals, and civic
//   data don't meaningfully change within a day, and this is the highest-traffic,
//   most-cacheable endpoint (popular localities get searched repeatedly).
// - Screener (ranked opportunity list): 6 hours. More parameter combinations
//   (city + radius + filters), so cache hit rate is naturally lower; shorter TTL
//   keeps results fresher since filters can shift what's "best".
// - Pricer (property-specific estimate): 12 hours. Property configs are highly
//   specific (BHK, floor, amenities, approval type...) so exact-match cache hits
//   are rarer, but still worth catching repeat checks on the same listing.
export const TTL = {
  analyze: 60 * 60 * 24,      // 24h
  screener: 60 * 60 * 6,      // 6h
  pricer: 60 * 60 * 12,       // 12h
};

export async function getCached(key) {
  const r = await getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    return val || null;
  } catch (e) {
    console.error('Cache read error:', e.message);
    return null; // Fail open — cache errors should never break the app.
  }
}

export async function setCached(key, value, ttlSeconds) {
  const r = await getRedis();
  if (!r) return;
  try {
    await r.set(key, value, { ex: ttlSeconds });
  } catch (e) {
    console.error('Cache write error:', e.message);
    // Fail silently — caching is an optimization, not a requirement.
  }
}

export function isCachingEnabled() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
