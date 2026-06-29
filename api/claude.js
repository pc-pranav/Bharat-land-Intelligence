import { getCached, setCached, TTL } from '../lib/cache.js';

// Real Anthropic pricing (USD per million tokens)
const PRICING = {
  'claude-sonnet-4-6': { in: 3.00, cw: 3.75, cr: 0.30, out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80, cw: 1.00, cr: 0.08, out: 4.00 },
};
function calcCost(model, inTok, cwTok, crTok, outTok) {
  const p = PRICING[model] || { in:1.5, cw:1.875, cr:0.15, out:7.5 };
  return (inTok/1e6)*p.in + (cwTok/1e6)*p.cw + (crTok/1e6)*p.cr + (outTok/1e6)*p.out;
}

async function writeAnalytics(cacheType, inputTokens, cacheCreate, cacheRead, outTokens, model, stopReason, isRedisHit) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    const { Redis } = await import('@upstash/redis');
    const r = Redis.fromEnv();
    const today = new Date().toISOString().slice(0, 10);
    const costUSD = calcCost(model||'default', inputTokens, cacheCreate, cacheRead, outTokens);
    const pipe = r.pipeline();
    // Token & cost tracking
    if (!isRedisHit) {
      pipe.hincrby(`nj:stats:tokens:${today}`, 'in',           inputTokens);
      pipe.hincrby(`nj:stats:tokens:${today}`, 'cache_create', cacheCreate);
      pipe.hincrby(`nj:stats:tokens:${today}`, 'cache_read',   cacheRead);
      pipe.hincrby(`nj:stats:tokens:${today}`, 'out',          outTokens);
      pipe.hincrbyfloat(`nj:stats:tokens:${today}`, 'cost_usd', costUSD);
      pipe.expire(`nj:stats:tokens:${today}`, 60*60*24*90);
    }
    // Action counters (always)
    const ct = cacheType || 'unknown';
    pipe.hincrby(`nj:stats:actions:${today}`, ct, 1);
    pipe.hincrby(`nj:stats:actions:${today}`, 'total', 1);
    pipe.hincrby(`nj:stats:actions:${today}`, isRedisHit ? 'redis_hit' : 'redis_miss', 1);
    // Error tracking
    if (stopReason && stopReason !== 'end_turn') {
      pipe.hincrby(`nj:stats:errors:${today}`, `stop_${stopReason}`, 1);
      pipe.expire(`nj:stats:errors:${today}`, 60*60*24*90);
    }
    pipe.expire(`nj:stats:actions:${today}`, 60*60*24*90);
    await pipe.exec();
  } catch(e) {
    console.warn('[NJ Stats] Analytics write failed:', e.message);
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
    const maxTok = anthropicBody.max_tokens;
    console.log(`[NJ] recv | model:${anthropicBody.model?.slice(-6)} max_tok:${maxTok} sys_chars:${sysLen} key:${cacheKey?.slice(0,40)||'none'}`);

    // ── 1. Redis cache check ──────────────────────────────────────────────────
    if (fullCacheKey) {
      const cached = await getCached(fullCacheKey);
      if (cached) {
        console.log(`[NJ] REDIS HIT: ${fullCacheKey}`);
        const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
        // Track Redis hit
        writeAnalytics(cacheType, 0, 0, 0, 0, anthropicBody.model, 'end_turn', true).catch(()=>{});
        return res.status(200).json({ ...obj, _cacheHit: true });
      }
      console.log(`[NJ] REDIS MISS: ${fullCacheKey}`);
    }

    // ── 2. Call Anthropic with streaming ─────────────────────────────────────
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
      // Track error
      if (anthropicRes.status === 429) {
        writeAnalytics(cacheType, 0, 0, 0, 0, anthropicBody.model, 'http_429', false).catch(()=>{});
      }
      return res.status(anthropicRes.status).json(err);
    }

    // ── 3. SSE headers ────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // ── 4. Stream with line buffering ─────────────────────────────────────────
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
              cacheRead   = u.cache_read_input_tokens     || 0;
            }
            if (evt.type === 'message_delta') {
              stopReason = evt.delta?.stop_reason;
              if (evt.usage) Object.assign(usage, evt.usage);
            }
          } catch (parseErr) {
            console.warn('[NJ] SSE parse warn:', parseErr.message.slice(0,60));
          }
        }
      }
      // Flush remaining buffer
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

    // ── 5. Build response ─────────────────────────────────────────────────────
    const finalResponse = {
      content:     [{ type: 'text', text: fullText }],
      usage, stop_reason: stopReason, model: anthropicBody.model, _cacheHit: false,
    };

    // ── 6. Redis write ────────────────────────────────────────────────────────
    if (fullCacheKey && stopReason === 'end_turn' && fullText.trim().length > 10) {
      const slim = { content: finalResponse.content, usage, model: finalResponse.model, stop_reason: stopReason };
      setCached(fullCacheKey, slim, ttl)
        .then(() => console.log(`[NJ] REDIS WRITE: ${fullCacheKey} | TTL:${ttl}s`))
        .catch(e => console.error('[NJ] Redis write error:', e.message));
    } else if (fullCacheKey && stopReason !== 'end_turn') {
      console.log(`[NJ] SKIP REDIS: stop:${stopReason}`);
    }

    // ── 7. Log ────────────────────────────────────────────────────────────────
    const outTok = usage.output_tokens || 0;
    console.log(`[NJ] done | in:${inputTokens} created:${cacheCreate} read:${cacheRead} out:${outTok} | stop:${stopReason}`);

    // ── 8. Analytics ──────────────────────────────────────────────────────────
    writeAnalytics(cacheType, inputTokens, cacheCreate, cacheRead, outTok, anthropicBody.model, stopReason, false)
      .catch(() => {});

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
  api: {
    bodyParser:    { sizeLimit: '2mb' },
    responseLimit: false,
  },
};
