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

    // ── 1. Redis cache check ──────────────────────────────────────────────────
    if (fullCacheKey) {
      const cached = await getCached(fullCacheKey);
      if (cached) {
        console.log(`[NJ] CACHE HIT: ${fullCacheKey}`);
        const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return res.status(200).json({ ...obj, _cacheHit: true });
      }
      console.log(`[NJ] CACHE MISS: ${fullCacheKey}`);
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
      return res.status(anthropicRes.status).json(err);
    }

    // ── 3. Set SSE headers ────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // ── 4. Read stream with line buffering ───────────────────────────────────
    // CRITICAL: SSE lines from Anthropic can be split across TCP chunks.
    // Must buffer incomplete lines and only process complete \n-terminated ones.
    const reader  = anthropicRes.body.getReader();
    const decoder = new TextDecoder();

    let fullText   = '';
    let usage      = {};
    let stopReason = null;
    let inputTokens = 0;
    let buf        = '';   // accumulates incomplete SSE lines across chunks

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append new chunk to buffer
        buf += decoder.decode(value, { stream: true });

        // Process only complete lines (split on \n, keep last incomplete chunk)
        const lines = buf.split('\n');
        buf = lines.pop(); // last element may be incomplete — keep in buffer

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

            if (evt.type === 'message_delta') {
              stopReason = evt.delta?.stop_reason;
              if (evt.usage) Object.assign(usage, evt.usage);
            }

            if (evt.type === 'message_start' && evt.message?.usage) {
              Object.assign(usage, evt.message.usage);
              inputTokens = evt.message.usage.input_tokens || 0;
            }
          } catch (parseErr) {
            // Log but don't crash — malformed SSE lines shouldn't kill the request
            console.warn('[NJ] SSE parse warn:', parseErr.message, '| line:', raw.slice(0, 80));
          }
        }
      }

      // Flush any remaining buffer content
      if (buf.startsWith('data: ')) {
        try {
          const raw = buf.slice(6).trim();
          if (raw && raw !== '[DONE]') {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.text) fullText += evt.delta.text;
            if (evt.type === 'message_delta') stopReason = evt.delta?.stop_reason;
          }
        } catch (_) {}
      }
    } finally {
      reader.releaseLock();
    }

    // ── 5. Build final response ───────────────────────────────────────────────
    const finalResponse = {
      content:     [{ type: 'text', text: fullText }],
      usage,
      stop_reason: stopReason,
      model:       anthropicBody.model,
      _cacheHit:   false,
    };

    // ── 6. Write to Redis cache ───────────────────────────────────────────────
    if (fullCacheKey && fullText.trim().length > 10) {
      const slim = {
        content:     finalResponse.content,
        usage,
        model:       finalResponse.model,
        stop_reason: stopReason,
      };
      setCached(fullCacheKey, slim, ttl)
        .then(() => console.log(`[NJ] CACHE WRITE: ${fullCacheKey} | stop:${stopReason} | out:${usage.output_tokens||0} | TTL:${ttl}s`))
        .catch(e => console.error('[NJ] Cache write error:', e.message));
    } else if (fullCacheKey) {
      console.log(`[NJ] SKIP CACHE: ${fullCacheKey} — text too short (${fullText.length} chars)`);
    }

    // ── 7. Send done event and close ─────────────────────────────────────────
    const cacheRead = usage.cache_read_input_tokens || 0;
    console.log(`[NJ] ${cacheType||'?'} | in:${inputTokens} cached:${cacheRead} out:${usage.output_tokens||0} | stop:${stopReason}`);

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
    bodyParser:    { sizeLimit: '1mb' },
    responseLimit: false,
  },
};
