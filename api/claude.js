import { getCached, setCached, TTL } from '../lib/cache.js';

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

    // Log what we received to help diagnose issues
    const sysLen = JSON.stringify(anthropicBody.system||'').length;
    const maxTok = anthropicBody.max_tokens;
    console.log(`[NJ] recv | model:${anthropicBody.model?.slice(-6)} max_tok:${maxTok} sys_chars:${sysLen} key:${cacheKey?.slice(0,40)||'none'}`);

    // ── 1. Redis cache check ──────────────────────────────────────────────────
    if (fullCacheKey) {
      const cached = await getCached(fullCacheKey);
      if (cached) {
        console.log(`[NJ] REDIS HIT: ${fullCacheKey}`);
        const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
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

    let fullText    = '';
    let usage       = {};
    let stopReason  = null;
    let inputTokens = 0;
    let cacheCreate = 0;  // ← track cache_creation tokens
    let cacheRead   = 0;  // ← track cache_read tokens
    let buf         = '';

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
            console.warn('[NJ] SSE parse warn:', parseErr.message.slice(0,60), '|', raw.slice(0,60));
          }
        }
      }

      // Flush remaining buffer
      if (buf.startsWith('data: ')) {
        try {
          const evt = JSON.parse(buf.slice(6).trim());
          if (evt.type === 'content_block_delta' && evt.delta?.text) fullText += evt.delta.text;
          if (evt.type === 'message_delta') stopReason = evt.delta?.stop_reason;
        } catch (_) {}
      }
    } finally {
      reader.releaseLock();
    }

    // ── 5. Build response ─────────────────────────────────────────────────────
    const finalResponse = {
      content:     [{ type: 'text', text: fullText }],
      usage,
      stop_reason: stopReason,
      model:       anthropicBody.model,
      _cacheHit:   false,
    };

    // ── 6. Redis write ────────────────────────────────────────────────────────
    // Only cache complete responses (stop:end_turn, not max_tokens)
    if (fullCacheKey && stopReason === 'end_turn' && fullText.trim().length > 10) {
      const slim = { content: finalResponse.content, usage, model: finalResponse.model, stop_reason: stopReason };
      setCached(fullCacheKey, slim, ttl)
        .then(() => console.log(`[NJ] REDIS WRITE: ${fullCacheKey} | TTL:${ttl}s`))
        .catch(e => console.error('[NJ] Redis write error:', e.message));
    } else if (fullCacheKey && stopReason !== 'end_turn') {
      console.log(`[NJ] SKIP REDIS: stop:${stopReason} — won't cache truncated response`);
    }

    // ── 7. Log with full token breakdown ─────────────────────────────────────
    // in = non-cached input | created = new cache tokens | read = cache hit tokens | out = output
    console.log(`[NJ] done | in:${inputTokens} created:${cacheCreate} read:${cacheRead} out:${usage.output_tokens||0} | stop:${stopReason}`);

    sendEvent({ type: 'done', response: finalResponse });
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
    bodyParser:    { sizeLimit: '2mb' },  // increased from 1mb for safety
    responseLimit: false,
  },
};
