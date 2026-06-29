import { getCached, setCached, TTL } from '../lib/cache.js';

// Real Anthropic pricing (USD per million tokens)
const PRICING = {
  'claude-sonnet-4-6':        { in: 3.00, cw: 3.75, cr: 0.30, out: 15.00 },
  'claude-haiku-4-5-20251001':{ in: 0.80, cw: 1.00, cr: 0.08, out: 4.00  },
};
function calcCost(model, inTok, cwTok, crTok, outTok) {
  const p = PRICING[model] || { in:1.5, cw:1.875, cr:0.15, out:7.5 };
  return (inTok/1e6)*p.in + (cwTok/1e6)*p.cw + (crTok/1e6)*p.cr + (outTok/1e6)*p.out;
}

// Reuse single Redis connection per function instance
let _redis = null;
async function getStatsRedis() {
  if (_redis) return _redis;
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    _redis = Redis.fromEnv();
    return _redis;
  } catch(e) {
    console.warn('[NJ Stats] Redis init failed:', e.message);
    return null;
  }
}

// Write analytics — called BEFORE res.end() so Vercel doesn't kill it
async function writeAnalytics(cacheType, inTok, cwTok, crTok, outTok, model, stopReason, isHit) {
  const r = await getStatsRedis();
  if (!r) return;
  const today = new Date().toISOString().slice(0, 10);
  const costUSD = calcCost(model || 'default', inTok, cwTok, crTok, outTok);
  try {
    // Use individual commands instead of pipeline to avoid Upstash version issues
    const ct = cacheType || 'unknown';
    if (!isHit) {
      await r.hincrby(`nj:stats:tokens:${today}`, 'in',           inTok);
      await r.hincrby(`nj:stats:tokens:${today}`, 'cache_create', cwTok);
      await r.hincrby(`nj:stats:tokens:${today}`, 'cache_read',   crTok);
      await r.hincrby(`nj:stats:tokens:${today}`, 'out',          outTok);
      // Store cost as integer millicents to avoid float issues
      await r.hincrby(`nj:stats:tokens:${today}`, 'cost_millicents', Math.round(costUSD * 100000));
      await r.expire(`nj:stats:tokens:${today}`, 60 * 60 * 24 * 90);
    }
    await r.hincrby(`nj:stats:actions:${today}`, ct, 1);
    await r.hincrby(`nj:stats:actions:${today}`, 'total', 1);
    await r.hincrby(`nj:stats:actions:${today}`, isHit ? 'redis_hit' : 'redis_miss', 1);
    await r.expire(`nj:stats:actions:${today}`, 60 * 60 * 24 * 90);
    if (stopReason && stopReason !== 'end_turn') {
      await r.hincrby(`nj:stats:errors:${today}`, `stop_${stopReason}`, 1);
      await r.expire(`nj:stats:errors:${today}`, 60 * 60 * 24 * 90);
    }
    console.log(`[NJ Stats] wrote: ${ct} in:${inTok} out:${outTok} cost:$${costUSD.toFixed(5)} hit:${isHit}`);
  } catch(e) {
    console.warn('[NJ Stats] write error:', e.message);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(200).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });
    }

    const { cacheKey, cacheType, ...anthropicBody } = req.body;
    const fullCacheKey = cacheKey ? `nj:${cacheType||'generic'}:${cacheKey}` : null;
    const ttl = TTL[cacheType] || TTL.analyze;

    const sysLen = JSON.stringify(anthropicBody.system||'').length;
    console.log(`[NJ] recv | model:${anthropicBody.model?.slice(-6)} max_tok:${anthropicBody.max_tokens} sys_chars:${sysLen} key:${cacheKey?.slice(0,40)||'none'}`);

    // ── 1. Redis cache check ──────────────────────────────────────────────────
    if (fullCacheKey) {
      const cached = await getCached(fullCacheKey);
      if (cached) {
        console.log(`[NJ] REDIS HIT: ${fullCacheKey}`);
        const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
        // Analytics: track hit BEFORE returning
        await writeAnalytics(cacheType, 0, 0, 0, 0, anthropicBody.model, 'end_turn', true);
        return res.status(200).json({ ...obj, _cacheHit: true });
      }
      console.log(`[NJ] REDIS MISS: ${fullCacheKey}`);
    }

    // ── 2. Call Anthropic ─────────────────────────────────────────────────────
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({ ...anthropicBody, stream: true }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({ error: { message: 'Anthropic error' } }));
      console.error(`[NJ] Anthropic error ${anthropicRes.status}:`, JSON.stringify(err).slice(0,200));
      if (anthropicRes.status === 429) {
        await writeAnalytics(cacheType, 0, 0, 0, 0, anthropicBody.model, 'http_429', false);
      }
      return res.status(anthropicRes.status).json(err);
    }

    // ── 3. SSE headers ────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // ── 4. Stream ─────────────────────────────────────────────────────────────
    const reader  = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', usage = {}, stopReason = null;
    let inputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullText += evt.delta.text;
              sendEvent({ type: 'delta', text: evt.delta.text });
            }
            if (evt.type === 'message_start' && evt.message?.usage) {
              const u = evt.message.usage;
              Object.assign(usage, u);
              inputTokens = u.input_tokens || 0;
              cacheCreate = u.cache_creation_input_tokens || 0;
              cacheRead   = u.cache_read_input_tokens || 0;
            }
            if (evt.type === 'message_delta') {
              stopReason = evt.delta?.stop_reason;
              if (evt.usage) Object.assign(usage, evt.usage);
            }
          } catch (_) {}
        }
      }
      if (buf.trim()) {
        const raw = buf.startsWith('data: ') ? buf.slice(6).trim() : buf.trim();
        if (raw && raw !== '[DONE]') {
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.text) fullText += evt.delta.text;
            if (evt.type === 'message_delta') stopReason = evt.delta?.stop_reason;
          } catch (_) {}
        }
      }
    } finally { reader.releaseLock(); }

    // ── 5. Redis write ────────────────────────────────────────────────────────
    if (fullCacheKey && stopReason === 'end_turn' && fullText.trim().length > 10) {
      const slim = { content: [{ type: 'text', text: fullText }], usage, model: anthropicBody.model, stop_reason: stopReason };
      setCached(fullCacheKey, slim, ttl)
        .then(() => console.log(`[NJ] REDIS WRITE: ${fullCacheKey} | TTL:${ttl}s`))
        .catch(e => console.error('[NJ] Redis write error:', e.message));
    } else if (fullCacheKey && stopReason !== 'end_turn') {
      console.log(`[NJ] SKIP REDIS: stop:${stopReason}`);
    }

    // ── 6. Log ────────────────────────────────────────────────────────────────
    const outTok = usage.output_tokens || 0;
    console.log(`[NJ] done | in:${inputTokens} created:${cacheCreate} read:${cacheRead} out:${outTok} | stop:${stopReason}`);

    // ── 7. Analytics — BEFORE res.end() so Vercel doesn't kill it ────────────
    await writeAnalytics(cacheType, inputTokens, cacheCreate, cacheRead, outTok, anthropicBody.model, stopReason, false);

    sendEvent({ type: 'done', text: fullText, stop: stopReason });
    res.end();

  } catch (error) {
    console.error('[NJ] Handler error:', error.message);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } catch (_) {
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' }, responseLimit: false },
};
