// api/stats.js — NammaJaga Analytics endpoint
// GET /api/stats?days=7   → aggregated stats for last N days
// POST /api/stats          → write an event (called from client)

import { getCached, setCached } from '../lib/cache.js';

let redis = null;
async function getRedis() {
  if (redis) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    redis = Redis.fromEnv();
    return redis;
  } catch(e) { return null; }
}

// Real Anthropic pricing (per million tokens, USD)
const PRICING = {
  'claude-sonnet-4-6': { in: 3.00, cache_write: 3.75, cache_read: 0.30, out: 15.00 },
  'claude-haiku-4-5':  { in: 0.80, cache_write: 1.00, cache_read: 0.08, out: 4.00  },
  default:             { in: 1.50, cache_write: 1.875,cache_read: 0.15, out: 7.50  },
};

export function calcCostUSD(model, inTok, cacheCreateTok, cacheReadTok, outTok) {
  const p = PRICING[model] || PRICING.default;
  return (
    (inTok          / 1e6) * p.in +
    (cacheCreateTok / 1e6) * p.cache_write +
    (cacheReadTok   / 1e6) * p.cache_read +
    (outTok         / 1e6) * p.out
  );
}

function dateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const r = await getRedis();
  if (!r) return res.status(503).json({ error: 'Redis not available' });

  // ── POST: write event from client ──────────────────────────────────────────
  if (req.method === 'POST') {
    const { event, data = {} } = req.body || {};
    if (!event) return res.status(400).json({ error: 'event required' });

    const today = dateStr();
    try {
      const pipe = r.pipeline();
      // Action counter
      pipe.hincrby(`nj:stats:actions:${today}`, event, 1);
      pipe.hincrby(`nj:stats:actions:${today}`, 'total', 1);
      // If it's a query event, track the locality
      if (data.locality && (event === 'analyze' || event === 'screener')) {
        pipe.zincrby(`nj:stats:top_queries:${today}`, 1, data.locality.slice(0, 60));
        pipe.expire(`nj:stats:top_queries:${today}`, 60 * 60 * 24 * 90);
      }
      // Expire after 90 days
      pipe.expire(`nj:stats:actions:${today}`, 60 * 60 * 24 * 90);
      await pipe.exec();
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('[NJ Stats] POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET: read stats ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const days = Math.min(90, parseInt(req.query.days || '7'));
    const dates = Array.from({ length: days }, (_, i) => dateStr(i)).reverse(); // oldest first

    try {
      // Batch fetch all keys using pipeline
      const pipe = r.pipeline();
      dates.forEach(d => {
        pipe.hgetall(`nj:stats:tokens:${d}`);
        pipe.hgetall(`nj:stats:actions:${d}`);
        pipe.hgetall(`nj:stats:errors:${d}`);
      });
      // Top queries — just fetch last 7 days merged
      const last7 = Array.from({ length: Math.min(7, days) }, (_, i) => dateStr(i));
      last7.forEach(d => pipe.zrange(`nj:stats:top_queries:${d}`, 0, 9, { rev: true, withScores: true }));

      const results = await pipe.exec();

      // Parse results — 3 hgetall per date, then zrange results
      const dailyData = dates.map((date, i) => {
        const tok  = results[i * 3]     || {};
        const act  = results[i * 3 + 1] || {};
        const err  = results[i * 3 + 2] || {};

        const inTok          = parseInt(tok.in           || 0);
        const cacheCreateTok = parseInt(tok.cache_create || 0);
        const cacheReadTok   = parseInt(tok.cache_read   || 0);
        const outTok         = parseInt(tok.out          || 0);

        // Estimate model split: P1 is Sonnet (~30% of in tokens), P2-P5 Haiku (~70%)
        const sonnetIn  = Math.round(inTok * 0.30);
        const haikuIn   = inTok - sonnetIn;
        const sonnetOut = Math.round(outTok * 0.25);
        const haikuOut  = outTok - sonnetOut;

        const costUSD =
          calcCostUSD('claude-sonnet-4-6', sonnetIn,  cacheCreateTok, Math.round(cacheReadTok * 0.3),  sonnetOut) +
          calcCostUSD('claude-haiku-4-5',  haikuIn,   0,               Math.round(cacheReadTok * 0.7), haikuOut);

        const totalActions = parseInt(act.total || 0);
        const cacheHits    = parseInt(act.redis_hit || 0);
        const cacheMisses  = parseInt(act.redis_miss || 0);

        return {
          date,
          tokens: { in: inTok, cache_create: cacheCreateTok, cache_read: cacheReadTok, out: outTok },
          actions: {
            total:       totalActions,
            analyze:     parseInt(act.analyze     || 0),
            screener:    parseInt(act.screener    || 0),
            pricer:      parseInt(act.pricer      || 0),
            redis_hit:   cacheHits,
            redis_miss:  cacheMisses,
            preview:     parseInt(act.preview     || 0),
          },
          errors: {
            max_tokens:   parseInt(err.stop_max_tokens || 0),
            http_429:     parseInt(err.http_429        || 0),
            http_500:     parseInt(err.http_500        || 0),
            parse_fail:   parseInt(err.parse_fail      || 0),
          },
          cost: {
            usd:    parseFloat(costUSD.toFixed(4)),
            inr:    parseFloat((costUSD * 84).toFixed(2)), // ~₹84/USD
          },
          cache_hit_rate: (cacheHits + cacheMisses) > 0
            ? parseFloat((cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1))
            : null,
        };
      });

      // Aggregate top queries
      const queryMap = {};
      const topQueryResults = results.slice(dates.length * 3);
      topQueryResults.forEach(zr => {
        if (!Array.isArray(zr)) return;
        for (let i = 0; i < zr.length; i += 2) {
          const loc = zr[i], score = parseFloat(zr[i + 1] || 0);
          queryMap[loc] = (queryMap[loc] || 0) + score;
        }
      });
      const topQueries = Object.entries(queryMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([locality, count]) => ({ locality, count }));

      // Totals
      const totals = dailyData.reduce((acc, d) => ({
        tokens_in:      acc.tokens_in      + d.tokens.in,
        tokens_out:     acc.tokens_out     + d.tokens.out,
        cache_create:   acc.cache_create   + d.tokens.cache_create,
        cache_read:     acc.cache_read     + d.tokens.cache_read,
        actions:        acc.actions        + d.actions.total,
        analyze:        acc.analyze        + d.actions.analyze,
        screener:       acc.screener       + d.actions.screener,
        pricer:         acc.pricer         + d.actions.pricer,
        redis_hits:     acc.redis_hits     + d.actions.redis_hit,
        redis_misses:   acc.redis_misses   + d.actions.redis_miss,
        errors:         acc.errors         + Object.values(d.errors).reduce((a,b)=>a+b,0),
        cost_usd:       acc.cost_usd       + d.cost.usd,
        cost_inr:       acc.cost_inr       + d.cost.inr,
      }), { tokens_in:0, tokens_out:0, cache_create:0, cache_read:0,
            actions:0, analyze:0, screener:0, pricer:0,
            redis_hits:0, redis_misses:0, errors:0, cost_usd:0, cost_inr:0 });

      totals.cost_usd = parseFloat(totals.cost_usd.toFixed(4));
      totals.cost_inr = parseFloat(totals.cost_inr.toFixed(2));
      totals.cache_hit_rate = (totals.redis_hits + totals.redis_misses) > 0
        ? parseFloat((totals.redis_hits / (totals.redis_hits + totals.redis_misses) * 100).toFixed(1))
        : null;

      return res.status(200).json({ days, dates, daily: dailyData, totals, topQueries });
    } catch(e) {
      console.error('[NJ Stats] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };
