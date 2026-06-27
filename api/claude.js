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

    // ── 1. Redis cache check — instant return if hit ─────────────────────────
    if (fullCacheKey) {
      const cached = await getCached(fullCacheKey);
      if (cached) {
        console.log(`[NJ] CACHE HIT: ${fullCacheKey}`);
        const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return res.status(200).json({ ...obj, _cacheHit: true });
      }
      console.log(`[NJ] CACHE MISS: ${fullCacheKey}`);
    }

    // ── 2. Stream from Anthropic — avoids Vercel 10s timeout ─────────────────
    // Streaming keeps the HTTP connection open while tokens arrive,
    // so the function never times out even on long responses.
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':  'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({ ...anthropicBody, stream: true }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({ error: { message: 'Anthropic error' } }));
      return res.status(anthropicRes.status).json(err);
    }

    // ── 3. Collect stream + forward as SSE to client ──────────────────────────
    // We collect the full text while streaming so we can:
    //  a) Cache the completed response in Redis
    //  b) Return a single JSON blob (simpler client-side handling)
    // The client sees data arriving progressively via SSE events.

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();

    let fullText = '';
    let usage    = {};
    let stopReason = null;
    let inputTokens = 0;

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const evt = JSON.parse(data);

            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullText += evt.delta.text;
              // Forward text deltas to client for real-time display (optional)
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
          } catch (_) { /* skip malformed SSE lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // ── 4. Build the final response object ────────────────────────────────────
    const finalResponse = {
      content:     [{ type: 'text', text: fullText }],
      usage,
      stop_reason: stopReason,
      model:       anthropicBody.model,
      _cacheHit:   false,
    };

    // ── 5. Cache the completed response ───────────────────────────────────────
    if (fullCacheKey && stopReason !== 'max_tokens') {
      const slim = { content: finalResponse.content, usage, model: finalResponse.model, stop_reason: stopReason };
      setCached(fullCacheKey, slim, ttl)
        .then(() => console.log(`[NJ] CACHE WRITE: ${fullCacheKey} TTL:${ttl}s`))
        .catch(e => console.error('[NJ] Cache write error:', e.message));
    }

    // ── 6. Send final complete event then close ────────────────────────────────
    const type = cacheType || 'unknown';
    const cacheRead = usage.cache_read_input_tokens || 0;
    console.log(`[NJ] ${type} | in:${inputTokens} cache_read:${cacheRead} out:${usage.output_tokens||0}`);

    sendEvent({ type: 'done', response: finalResponse });
    res.end();

  } catch (error) {
    console.error('[NJ] Handler error:', error);
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
    bodyParser:       { sizeLimit: '1mb' },
    responseLimit:    false,  // required for streaming
  },
};
