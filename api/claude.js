import { getCached, setCached, TTL } from '../lib/cache.js';

export default async function handler(req, res) {
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

  // cacheKey/cacheType are sent by the frontend (see App.jsx) and describe the
  // *meaningful* parameters of the request (e.g. locality name, property config)
  // rather than the raw prompt, which embeds today's date and would never repeat.
  // They are stripped before forwarding to Anthropic — Anthropic never sees them.
  const { cacheKey, cacheType, ...anthropicBody } = req.body;
  const fullCacheKey = cacheKey ? `bharat-land:${cacheType || 'generic'}:${cacheKey}` : null;
  const ttl = TTL[cacheType] || TTL.analyze;

  if (fullCacheKey) {
    const cached = await getCached(fullCacheKey);
    if (cached) {
      // Mark cache hits so the frontend/devtools can confirm caching is working.
      return res.status(200).json({ ...cached, _cacheHit: true });
    }
  }

  try {
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

    // Only cache successful, complete responses — never cache errors or
    // responses that hit the token limit (stop_reason "max_tokens" usually
    // means the JSON was truncated and might fail to parse on the client).
    if (
      fullCacheKey &&
      response.ok &&
      !data.error &&
      data.stop_reason !== 'max_tokens'
    ) {
      await setCached(fullCacheKey, data, ttl);
    }

    return res.status(response.status).json({ ...data, _cacheHit: false });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};
