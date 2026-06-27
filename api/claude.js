import { getCached, setCached, TTL } from '../lib/cache.js';

export default async function handler(req, res) {
  // Top-level try/catch — catches anything that escapes the inner handler,
  // including import-time errors, body parse failures, and unexpected throws
  // from the cache layer that previously caused FUNCTION_INVOCATION_FAILED
  // instead of a clean 500 JSON response.
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured. Add it in Vercel Environment Variables.' });
    }

    const { cacheKey, cacheType, ...anthropicBody } = req.body;
    const fullCacheKey = cacheKey ? `bharat-land:${cacheType || 'generic'}:${cacheKey}` : null;
    const ttl = TTL[cacheType] || TTL.analyze;

    // Cache check — now inside the top-level try/catch so any Redis
    // exception produces a clean JSON error instead of crashing the function.
    if (fullCacheKey) {
      const cached = await getCached(fullCacheKey);
      if (cached) {
        return res.status(200).json({ ...cached, _cacheHit: true });
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',   // Anthropic caches SYS prompt on their servers for 5 mins (ephemeral_5m in usage) — this is expected and correct. Redis cache handles our 7-day response caching.
      },
      body: JSON.stringify({ ...anthropicBody, stream: false }),
    });

    const data = await response.json();

    if (
      fullCacheKey &&
      response.ok &&
      !data.error &&
      data.stop_reason !== 'max_tokens'
    ) {
      // Cache write failure should never surface to the user — fire and forget
      setCached(fullCacheKey, data, ttl).catch(e =>
        console.error('Cache write error (non-fatal):', e.message)
      );
    }

    // Log token usage to Vercel function logs — view at vercel.com → project → logs
    if(data.usage) {
      const u = data.usage;
      const cached = u.cache_read_input_tokens || 0;
      const fresh  = u.input_tokens || 0;
      const out    = u.output_tokens || 0;
      const type   = req.body.cacheType || 'unknown';
      console.log(`[NJ] ${type} | in:${fresh} cached:${cached} out:${out} | total:${fresh+cached+out} tokens`);
    }
    return res.status(response.status).json({ ...data, _cacheHit: false });

  } catch (error) {
    // Log full error for Vercel function logs, return clean JSON to client
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};
