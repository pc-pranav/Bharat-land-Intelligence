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
