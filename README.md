# Bharat Land Intelligence

AI-powered land and property investment intelligence platform for India. Analyze any locality's growth potential, screen for investment opportunities across India, and get detailed price analysis for apartments, villas, and plots — all powered by Claude.

**Live features:** growth scoring with 9 weighted factors, civic grievance detection, traffic & crowd intelligence, price history and forecasts, an 80+ amenity property pricer with nationwide land-approval awareness, a UDS & loan calculator, and an interactive India map (with optional live Google Maps).

---

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/bharat-land-intel.git
cd bharat-land-intel
npm install
cp .env.example .env.local
# edit .env.local and add your ANTHROPIC_API_KEY
npm install -g vercel   # if you don't have it already
vercel dev
```

Open the URL `vercel dev` prints (typically `http://localhost:3000`). That's it for local testing.

The sections below walk through this in full detail, plus how to get it live on the internet.

---

## 1. Prerequisites

- **Node.js 18+** — check with `node -v`. Get it from [nodejs.org](https://nodejs.org) if needed.
- **An Anthropic API key** — Claude Pro/Max subscriptions do **not** include API access. Create a separate account at [console.anthropic.com](https://console.anthropic.com) and generate a key under API Keys. This is pay-as-you-go; see the cost section below.
- **A GitHub account** — to host the code and connect to Vercel.
- **A Vercel account** (free tier works) — [vercel.com](https://vercel.com).

---

## 2. Install Locally

```bash
git clone https://github.com/YOUR_USERNAME/bharat-land-intel.git
cd bharat-land-intel
npm install
```

If you're starting from the project zip instead of a git repo, just unzip it and `cd` into the folder before running `npm install`.

---

## 3. Environment Variables

Copy the template:

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...your-key...
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
VITE_GOOGLE_MAPS_API_KEY=
```

Only `ANTHROPIC_API_KEY` is required to run the app. The other two are optional — explained below.

`.env.local` is already in `.gitignore`, so it will never be committed.

---

## 4. Run Locally

Because the app calls a serverless function (`api/claude.js`) to keep your API key off the browser, use the Vercel CLI for local development rather than plain `vite`:

```bash
npm install -g vercel
vercel dev
```

This runs the React frontend **and** the `/api/claude` serverless function together, exactly like production. Open the printed URL — you should see the India map and the four tabs (Map, Analyze, Screener, Pricer).

If you just want to preview the frontend without API calls working, `npm run dev` also works, but Analyze/Screener/Pricer will fail without the proxy.

---

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit — Bharat Land Intelligence"
```

Create a new empty repository on [github.com](https://github.com/new), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/bharat-land-intel.git
git branch -M main
git push -u origin main
```

---

## 6. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project**.
2. Import the GitHub repository you just pushed.
3. Vercel auto-detects Vite. Leave the defaults:
   - Framework Preset: **Vite**
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Before clicking Deploy, open **Environment Variables** and add:

| Name | Value | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com | Yes |
| `UPSTASH_REDIS_REST_URL` | from Upstash (see step 7) | Optional |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash (see step 7) | Optional |
| `VITE_GOOGLE_MAPS_API_KEY` | from Google Cloud Console (see step 8) | Optional |

5. Click **Deploy**. You'll get a live URL like `https://bharat-land-intel.vercel.app` in under two minutes.

Every future `git push` to `main` auto-redeploys.

---

## 7. (Optional) Enable Response Caching

Without this, every search hits the Anthropic API fresh — fine for personal use, but costly if you expect many users searching the same popular localities repeatedly.

1. In your Vercel project dashboard → **Storage** → **Marketplace** → search **Upstash** → choose the free tier.
2. Vercel automatically injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into your project's environment variables — no manual copying needed.
3. Redeploy (or it picks up on the next deploy automatically).

The app checks for these at runtime in `lib/cache.js` and silently skips caching if they're not set — nothing breaks either way.

---

## 8. (Optional) Enable Live Google Maps

By default, the app uses a built-in lightweight SVG map of India (no API key, no cost, works everywhere). You can additionally enable a real, interactive Google Map with street view, satellite imagery, and smooth pan/zoom — a toggle button ("Live Map" / "Quick View") appears automatically once a key is configured.

**Get a key:**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (or use an existing one).
2. Enable billing on the project — Google Maps requires a billing account, though usage stays within the free tier ($200/month credit) for most personal and small-scale use.
3. Go to **APIs & Services → Library** and enable **Maps JavaScript API**.
4. Go to **APIs & Services → Credentials → Create Credentials → API Key**.
5. Restrict the key (important — prevents abuse): click the key, then under "Application restrictions" choose **HTTP referrers** and add your Vercel domain, e.g. `https://bharat-land-intel.vercel.app/*`. Under "API restrictions" choose **Restrict key** and select only **Maps JavaScript API**.

**Add it to your project:**

In Vercel → Environment Variables, add:

```
VITE_GOOGLE_MAPS_API_KEY=AIza...your-key...
```

Redeploy. The map toggle will now appear, and switching to "Live Map" loads the real Google Map.

Note: the `VITE_` prefix is required — Vite only exposes env vars to the browser bundle if they're prefixed this way. Don't rename it.

---

## Project Structure

```
bharat-land-intel/
├── api/
│   └── claude.js              Serverless proxy: keeps your API key server-side,
│                               adds response caching via lib/cache.js
├── lib/
│   └── cache.js                Upstash Redis caching layer (fails open if unset)
├── src/
│   ├── App.jsx                  The entire app, all 4 tabs, ~2,950 lines
│   ├── main.jsx                 React entry point
│   ├── index.css                Global styles, input/scrollbar styling
│   └── components/
│       └── GoogleMapView.jsx    Optional live Google Maps integration
├── index.html
├── package.json
├── vite.config.js
├── vercel.json                  Routing + CORS headers for the API route
├── .env.example                 Template for required/optional env vars
├── .gitignore
├── README.md                    This file
└── DEPLOY.md                    Deeper troubleshooting & cost reference
```

---

## How the App Is Organized

Four tabs, all in `src/App.jsx`:

- **Map** — full India map (SVG by default, or live Google Maps if configured). Click any state to jump into analysis. Zoom in past 2.2x to see named regional investment clusters within major states.
- **Analyze** — type any locality, get a full growth-intelligence report: 9 weighted scores, civic grievances, traffic and crowd intelligence, upcoming infrastructure projects, price history, and 2/5/10-year forecasts.
- **Screener** — filter by city, radius, CAGR, price, and risk to get 5 AI-ranked opportunities plotted on the map.
- **Pricer** — detailed price analysis for apartments, villas, and plots: 80+ categorized amenities, civic and infrastructure scoring, nationwide land-approval types (BBMP Khata, CMDA, GHMC, MahaRERA, etc, auto-detected from the city you type), auto-calculated maintenance, growth rate, and tax, and a UDS and loan calculator showing your undivided land share's value growth against total loan costs.

---

## Cost Estimate

Using claude-sonnet-4-6 at $3 per million input tokens and $15 per million output tokens, each AI call (Analyze, Screener, or Pricer) costs roughly $0.03 to $0.05 (about 2.5 to 4 rupees), driven mostly by the detailed JSON response each call returns.

| Usage | Calls per user per day | Daily cost at 1,000 users | Monthly cost |
|---|---|---|---|
| Light | 2 | about $78 (roughly ₹6,800) | about $2,340 (roughly ₹2,03,000) |
| Moderate | 5 | about $195 (roughly ₹16,900) | about $5,840 (roughly ₹5,08,000) |
| Heavy | 10 | about $390 (roughly ₹33,900) | about $11,700 (roughly ₹10,17,000) |

Enabling Upstash caching (step 7) typically cuts real-world cost by 50% or more, since popular localities get searched repeatedly by different users and served from cache instead of hitting the AI again.

For personal or low-traffic use, expect well under ₹500 per month.

---

## Troubleshooting

**Map not loading** — the built-in map is pure SVG with no external dependencies, so this should always work. If you've enabled Google Maps and it's stuck loading, check that the Maps JavaScript API is enabled and the key isn't over-restricted.

**"API key not configured" error** — double check ANTHROPIC_API_KEY is set in Vercel's Environment Variables (not just locally), then redeploy.

**Analysis returns a parse error** — the AI response may have been truncated. The app already has truncation-repair logic built in (the parseJSON function in App.jsx), but if it persists, check the Vercel function logs under Deployments then Functions for the actual error.

**Build fails on Vercel** — run `npm run build` locally first to catch errors before pushing.

**CORS errors** — api/claude.js sets Access-Control-Allow-Origin to allow all origins. If you're on a custom domain and want to lock this down, edit that header in api/claude.js.

See DEPLOY.md for more detail on each of these.

---

## Disclaimer

This app is for research and educational purposes. All price estimates, growth scores, and investment analysis are AI-generated approximations based on available knowledge, not guaranteed accurate, and not financial advice. Verify all information independently before making investment decisions.
