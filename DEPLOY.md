# Deployment Reference & Troubleshooting

This file covers deeper detail beyond the main setup steps in README.md. Start there first — this is a reference for when something needs more explanation or goes wrong.

---

## How the API key stays secure

The frontend (`src/App.jsx`) never calls `api.anthropic.com` directly in the deployed build. Every AI call goes to `/api/claude`, a Vercel serverless function (`api/claude.js`) that:

1. Reads `ANTHROPIC_API_KEY` from server-side environment variables (never sent to the browser)
2. Checks the optional Redis cache first (`lib/cache.js`)
3. On a cache miss, calls Anthropic's API with the key attached server-side
4. Stores the result in cache (if configured) before returning it

This means your API key is never visible in browser DevTools, network tab, or page source — only the serverless function ever sees it.

---

## How caching works (lib/cache.js)

Each of the three call sites in `App.jsx` (Analyze, Screener, Pricer) builds a deterministic `cacheKey` from the meaningful inputs (locality name for Analyze; city + filters for Screener; locality + city + every property config field for Pricer). The raw prompt text is never used as the key, since it embeds today's date and would never repeat.

TTLs differ by endpoint:
- Analyze: 24 hours (growth scores and news don't shift hourly)
- Screener: 6 hours (more filter combinations, wants fresher data)
- Pricer: 12 hours (highly specific configs, but worth catching repeat checks)

If `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` aren't set, `getRedis()` in `lib/cache.js` returns null and every call just goes straight to Anthropic uncached — nothing breaks, you just don't get the cost savings.

Responses that hit `max_tokens` (likely truncated/broken JSON) are never cached, so a bad response can't get served repeatedly.

---

## How the Google Maps toggle works

`src/App.jsx` imports `GoogleMapView` from `src/components/GoogleMapView.jsx` and wraps both it and the built-in `IndiaMap` in a small `MapView` component. At runtime, `MapView` checks `import.meta.env.VITE_GOOGLE_MAPS_API_KEY`:

- **Not set** → renders `IndiaMap` only, no toggle button shown, zero Google Maps cost or dependency load.
- **Set** → shows a toggle button ("Live Map" / "Quick View") and defaults to the live Google Map.

This is why the `@react-google-maps/api` package is always installed (it's in `package.json`) but completely inert and unused unless you've added the key — there's no risk of broken builds either way.

See README.md section 8 for the full key-creation walkthrough.

---

## Cost reference (detailed)

| Call type | Approx input tokens | Approx output tokens | Approx cost per call |
|---|---|---|---|
| Analyze (full location report) | ~850 | ~3,000 | $0.048 |
| Screener (5 ranked results) | ~500 | ~1,800 | $0.029 |
| Pricer (property analysis) | ~1,100 | ~2,500 | $0.041 |

Pricing basis: claude-sonnet-4-6 at $3/M input tokens, $15/M output tokens. Output dominates cost because each call requests a large structured JSON response (scores, news signals, civic data, traffic intelligence, price history, comparables, etc).

See README.md's cost table for what this means at scale (1,000 users/day scenarios).

---

## Troubleshooting in depth

**"Internal Server Error" from Analyze/Pricer**
Almost always a truncated AI response — the JSON got cut off mid-object because the schema requested is large. The app already raises `max_tokens` to 8000 and has repair logic in `parseJSON()` that trims incomplete trailing fields and auto-balances brackets. If you still see this:
1. Check Vercel → Deployments → Functions → look at the `/api/claude` logs for the actual Anthropic error.
2. Confirm `ANTHROPIC_API_KEY` is valid and has available credit at console.anthropic.com.

**Map shows all states in one color / pink**
This was a historical bug (state name string compared as a number) — already fixed in the current `stateColor()` implementation, which looks up `STATE_GROWTH[name]` before comparing. If you see this again after editing the code, check you haven't reintroduced a string-vs-number comparison.

**Google Maps toggle never appears**
`VITE_GOOGLE_MAPS_API_KEY` must have the `VITE_` prefix exactly — Vite strips/ignores env vars without it for browser-side code. Confirm it's set in Vercel's Environment Variables (not just `.env.local`) and redeploy after adding it; existing deployments don't pick up new env vars without a fresh deploy.

**Google Maps loads blank / gray tiles**
Usually means the Maps JavaScript API isn't enabled on the Google Cloud project, or the key's HTTP referrer restriction doesn't match your actual deployed domain (including the trailing `/*`).

**Upstash cache not reducing costs**
Check Vercel → Storage to confirm the Upstash integration shows as connected, and that both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` appear in Environment Variables. A redeploy after first connecting Upstash is required for the function to pick up the new variables.

**Local `vercel dev` can't find environment variables**
Make sure `.env.local` exists in the project root (not `.env`) and contains the keys with no quotes around values, e.g. `ANTHROPIC_API_KEY=sk-ant-...` not `ANTHROPIC_API_KEY="sk-ant-..."`.

---

## Updating the app after deployment

```bash
git add .
git commit -m "Describe your change"
git push
```

Vercel auto-deploys on every push to `main`. No manual redeploy step needed unless you're only changing environment variables (those require a manual redeploy from the Vercel dashboard, or just push an empty commit: `git commit --allow-empty -m "Redeploy" && git push`).

---

## Custom domain

Vercel project → Settings → Domains → add your domain. SSL is automatic. If you add a custom domain, remember to update the Google Maps API key's HTTP referrer restriction to include it too.
