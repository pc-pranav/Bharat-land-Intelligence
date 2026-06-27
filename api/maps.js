// api/maps.js — Server-side Google Maps proxy
// Handles both Places Autocomplete and Geocoding in one function.
// The API key never reaches the browser — all Google calls are server-side.
//
// Endpoints (all POST or GET to /api/maps):
//   ?type=autocomplete&q=malleshwaram    → Places autocomplete suggestions
//   ?type=geocode&place_id=ChIJ...       → Resolve place_id to coords + name
//   ?type=geocode&q=Whitefield+Bengaluru → Geocode a text query (fallback)

const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY
  || process.env.VITE_GOOGLE_MAPS_API_KEY; // fallback for existing installs

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!GOOGLE_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not configured in Vercel env vars.' });
  }

  const { type, q, place_id } = req.method === 'POST' ? req.body : req.query;

  // ── Autocomplete — called as user types ─────────────────────────────────────
  if (type === 'autocomplete') {
    if (!q || q.trim().length < 2) return res.status(200).json({ predictions: [] });

    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    url.searchParams.set('input',       q.trim());
    url.searchParams.set('types',       'geocode|establishment');
    url.searchParams.set('components',  'country:in');          // India only
    url.searchParams.set('language',    'en');
    url.searchParams.set('key',         GOOGLE_KEY);

    const gRes  = await fetch(url.toString());
    const gData = await gRes.json();

    if (gData.status !== 'OK' && gData.status !== 'ZERO_RESULTS') {
      console.error('[Maps] Autocomplete error:', gData.status, gData.error_message);
      return res.status(200).json({ predictions: [], error: gData.status });
    }

    // Return only what the frontend needs — strip billing-sensitive fields
    const predictions = (gData.predictions || []).slice(0, 6).map(p => ({
      place_id:     p.place_id,
      description:  p.description,
      main_text:    p.structured_formatting?.main_text    || p.description,
      secondary:    p.structured_formatting?.secondary_text || '',
    }));

    // Cache autocomplete in Vercel edge for 1 hour — these don't change often
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ predictions });
  }

  // ── Geocode — resolve place_id or text query to coords + canonical name ──────
  if (type === 'geocode') {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('language', 'en');
    url.searchParams.set('region',   'in');
    url.searchParams.set('key',      GOOGLE_KEY);

    if (place_id) {
      url.searchParams.set('place_id', place_id);
    } else if (q) {
      url.searchParams.set('address', q.trim() + ', India');
    } else {
      return res.status(400).json({ error: 'Provide place_id or q' });
    }

    const gRes  = await fetch(url.toString());
    const gData = await gRes.json();

    if (gData.status !== 'OK' || !gData.results?.[0]) {
      return res.status(200).json({ result: null, error: gData.status });
    }

    const r   = gData.results[0];
    const get = (type) => r.address_components
      ?.find(c => c.types.includes(type))?.long_name;

    const locality = get('sublocality_level_1') || get('sublocality') ||
                     get('locality') || get('administrative_area_level_2') || '';
    const city     = get('locality') || get('administrative_area_level_2') || '';
    const state    = get('administrative_area_level_1') || '';
    const display  = locality && city && locality !== city
      ? `${locality}, ${city}`
      : r.formatted_address.split(',').slice(0, 2).join(',').trim();

    const result = {
      place_id:   r.place_id,
      display,
      locality,
      city,
      state,
      lat:        parseFloat(r.geometry.location.lat.toFixed(6)),
      lng:        parseFloat(r.geometry.location.lng.toFixed(6)),
      formatted:  r.formatted_address,
    };

    // Cache geocode results for 7 days — place_ids are permanent
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=86400');
    return res.status(200).json({ result });
  }

  return res.status(400).json({ error: 'type must be autocomplete or geocode' });
}

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};
